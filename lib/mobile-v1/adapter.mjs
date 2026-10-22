import { projectAvatar } from './project-avatar.mjs'
import { BridgeError } from './auth.mjs'
import { projectRecords, detail } from './projection.mjs'
import { createTeamActions, MOBILE_ACTIONS } from './actions.mjs'
import { projectGroupRecords } from './group-projection.mjs'

const error = (status, code, text) => new BridgeError(status, code, text)
const unsupported = () => { throw error(501, 'UNSUPPORTED', 'This bridge capability is unavailable.') }
const validSeq = value => Number.isSafeInteger(value) && value >= -1
export function createAdapter({ connection, sessionController = {}, hostService = null, fixtureText = false, loadSessions = null }) {
  sessionController = sessionController ?? {}
  if (typeof connection?.createSharedFetchHandler !== 'function') throw error(503, 'CONNECTION_UNAVAILABLE', 'The public Connection dispatcher is unavailable.')
  const dispatcher = connection.createSharedFetchHandler('/api')
  const peer = connection.createPeer?.({ principal: { kind: 'owner' } })
  let disposed = false
  let description = {}
  const shutdown = new AbortController()
  // This allowlist is entirely internal. No mobile-supplied endpoint reaches it.
  const allowed = new Set(['state', 'bridge.describe', 'bridge.submit', 'bridge.redact', ...MOBILE_ACTIONS])
  // 原版 ds-bot（无桥接补丁）时自动切到本地宿主服务；补丁版仍在时继续走 RPC。
  let localBridge = false
  const isBridgeEndpoint = endpoint => endpoint === 'bridge.describe' || endpoint === 'bridge.redact' || endpoint === 'bridge.submit'
  async function call(endpoint, payload = {}, signal = AbortSignal.timeout(30_000)) {
    if (disposed) throw error(503, 'DISPOSED', 'The bridge has stopped.')
    if (!allowed.has(endpoint)) throw error(403, 'ACTION_NOT_ALLOWED', 'Unsupported team operation.')
    if (localBridge && hostService && isBridgeEndpoint(endpoint)) {
      if (endpoint === 'bridge.describe') return hostService.describe()
      if (endpoint === 'bridge.redact') return hostService.redact(payload)
      return hostService.submit(payload, signal, {
        loadState: providerSignal => call('state', {}, providerSignal),
        prompt: sessionController?.prompt?.bind(sessionController),
      })
    }
    const response = await dispatcher.fetch(new Request('http://bridge.invalid/api/bot', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }), signal,
    }), peer)
    if (!response.ok) throw error(503, 'TEAM_UNAVAILABLE', 'The existing DS Bot channel is unavailable.')
    const result = await response.json()
    if (result?.ok !== true) {
      const code = result?.error?.code ?? 'TEAM_REFUSED'
      const status = ({ 'bot/not-found': 501, 'bot/invalid': 400, 'bot/stale': 409, 'bot/read-only': 409 })[code] ?? 503
      throw error(status, code, 'The existing team could not confirm the operation.')
    }
    return result.value
  }
  const redact = text => detail(String(text), Number.MAX_SAFE_INTEGER).text
  /**
   * 普通会话行（kind: "session"）：先排除已经以 bot/room 形式出现的会话（含 parts），
   * 再排除子代理会话（手机主列表不展示）。标题与工作区名一律走同一套 redaction。
   * 失败只记空列表：会话列表是增量能力，不能影响团队视图。
   */
  async function projectSessions(teamRows, signal) {
    if (typeof loadSessions !== 'function') return []
    let items
    try {
      items = await loadSessions(signal)
    } catch {
      return []
    }
    if (!Array.isArray(items)) return []
    const taken = new Set()
    for (const row of teamRows) {
      if (typeof row.sessionId === 'string') taken.add(row.sessionId)
      for (const part of row.parts ?? []) taken.add(part)
    }
    const rows = []
    for (const item of items) {
      const sessionId = typeof item?.sessionId === 'string' ? item.sessionId : ''
      if (!sessionId || taken.has(sessionId)) continue
      if (typeof item.parentSessionId === 'string' || item.origin === 'subagent') continue
      const title = item?.projections?.values?.title
      const cwd = typeof item.cwd === 'string' ? item.cwd.replace(/[\\/]+$/, '') : ''
      const workspace = cwd ? redact(cwd.split(/[\\/]/).pop() || cwd) : ''
      rows.push({
        id: sessionId, kind: 'session', sessionId,
        name: redact(typeof title === 'string' && title.trim() ? title : '未命名会话'),
        lastActiveAt: Number.isSafeInteger(item.updatedAt) ? item.updatedAt : 0,
        ...(workspace ? { workspace } : {}),
        ...(item.running === true ? { busy: true } : {}),
        parts: [],
      })
    }
    rows.sort((left, right) => right.lastActiveAt - left.lastActiveAt)
    return rows
  }
  async function snapshot(signal) {
    const state = await call('state', {}, signal)
    const hidden = new Set((state.rooms ?? []).flatMap(room => room.parts ?? []))
    const conversations = (state.bots ?? []).filter(bot => !hidden.has(bot.sessionId)).map(bot => ({
      id: bot.id, kind: 'bot', name: redact(bot.name), sessionId: bot.sessionId,
      ...Object.fromEntries(['role', 'model', 'effort'].filter(key => typeof bot[key] === 'string').map(key => [key, redact(bot[key])])),
      ...projectAvatar(bot),
      ...Object.fromEntries(['waiting', 'pinned', 'hidden'].filter(key => typeof bot[key] === 'boolean').map(key => [key, bot[key]])),
      parts: (bot.parts ?? []).filter(id => id !== bot.sessionId && !hidden.has(id)),
    }))
    if (description.groups === true && description.groupProjection === 1) {
      const botIds = new Set(conversations.map(bot => bot.id))
      for (const room of state.rooms ?? []) {
        if (typeof room.id !== 'string' || hidden.has(room.id) || botIds.has(room.id)) continue
        conversations.push({ id: room.id, kind: 'room', name: redact(room.name), sessionId: room.id, parts: [],
          members: (room.members ?? []).filter(id => botIds.has(id)), admin: botIds.has(room.admin) ? room.admin : null,
          mode: room.mode === 'everyone' ? 'everyone' : 'admin',
          ...Object.fromEntries(['pinned', 'hidden'].filter(key => typeof room[key] === 'boolean').map(key => [key, room[key]])) })
      }
    }
    // U4：把「非团队的普通会话」也投进手机列表（顶部分段「会话」页）。
    // 数据源是插件内已有的 api.sessions.list()，不再要第二套凭证。
    // 放在 redaction 批次之前，标题/工作区名和 bot/room 行走同一套 bridge.redact 口径。
    const sessions = await projectSessions(conversations, signal)
    conversations.push(...sessions)
    const models = (state.models ?? []).filter(model => typeof model.ref === 'string').map(model => ({
      ref: redact(model.ref), name: redact(typeof model.name === 'string' ? model.name : model.ref),
      ...(typeof model.providerName === 'string' ? { providerName: redact(model.providerName) } : {}),
    }))
    if (description.version === 1 && description.redactedText === true && conversations.length) {
      const anchor = conversations.find(item => item.kind === 'bot') ?? conversations[0]
      // workspace 只有 session 行有；加进来让它与 name/role 走同一套 redaction。
      const labels = [...conversations.flatMap(item => ['name', 'role', 'workspace'].filter(key => typeof item[key] === 'string').map(key => ({ item, key }))), ...models.flatMap(item => ['name', 'providerName'].filter(key => typeof item[key] === 'string').map(key => ({ item, key })))]
      for (let offset = 0; offset < labels.length; offset += 100) {
        const batch = labels.slice(offset, offset + 100)
        const result = await call('bridge.redact', { conversationId: anchor.id, expectedSessionId: anchor.sessionId, ...(anchor.kind === 'room' ? { expectedMembers: anchor.members } : {}), texts: batch.map(({ item, key }) => item[key]) }, signal)
        if (!Array.isArray(result.texts) || result.texts.length !== batch.length || result.texts.some(text => typeof text !== 'string')) throw error(503, 'REDACTION_UNAVAILABLE', 'The host redaction result is invalid.')
        batch.forEach(({ item, key }, index) => { item[key] = result.texts[index] })
      }
    }
    const visible = new Set(conversations.map(item => item.id))
    const mainBotIds = (state.mainBotIds ?? []).filter(id => visible.has(id))
    return { revision: state.revision, readOnly: state.readOnly != null, conversations, sessions, models, mainBotIds,
      defaultModel: typeof state.defaultModel === 'string' ? redact(state.defaultModel) : null,
      hiddenTurns: state.exchangeTurns ?? {} }
  }
  async function target(id, signal) {
    const view = await snapshot(signal)
    const item = view.conversations.find(item => item.id === id)
    if (!item) throw error(404, 'CONVERSATION_NOT_FOUND', 'This conversation is unavailable.')
    return { ...item, revision: view.revision, hiddenTurns: view.hiddenTurns, readOnly: view.readOnly }
  }
  function requireSession(item, id) {
    if (![item.sessionId, ...item.parts].includes(id)) throw error(403, 'SESSION_DENIED', 'This Session does not belong to the conversation.')
  }
  function textAllowed() {
    // Unknown key values cannot be removed by regular expressions. Production
    // must obtain a DS Bot-owned redacted projection before enabling transcript.
    if (!fixtureText && (description.version !== 1 || description.redactedText !== true)) throw error(501, 'REDACTED_PROJECTION_REQUIRED', 'A DS Bot-owned redacted transcript is required.')
  }
  const options = (item, sessionId) => ({ sessionId, kind: item.kind, hiddenTurns: item.hiddenTurns[sessionId] ?? [], redact })
  // Only plain human and assistant text is released: no tools, reasoning, paths,
  // attachment metadata, secret requests or raw Session projection objects.
  async function primeGroupCalls(records, item, sessionId, signal, calls) {
    const projectCalls = rows => projectGroupRecords(rows.filter(row => row.event?.type === 'tool/call'), { sessionId, members: item.members, calls, redact })
    projectCalls(records)
    const missing = () => records.some(row => row.event?.type === 'tool/result' && !calls.has(row.event.data?.message?.source?.callId ?? row.event.data?.message?.toolCallId))
    let beforeSeq = records[0]?.event?.seq
    const throughSeq = records.at(-1)?.event?.seq
    // A message-count page can start at a result. Only same-room public history
    // may prove its tool name; dependency text is never included in this page.
    for (let attempt = 0; missing() && beforeSeq > 0 && attempt < 3; attempt++) {
      const page = await requireController('page').page({ address: { kind: 'session', sessionId }, throughSeq, beforeSeq, maxMessages: 50 }, signal)
      projectCalls(page.records ?? [])
      const next = page.records?.[0]?.event?.seq
      if (!page.hasMore || !Number.isSafeInteger(next) || next >= beforeSeq) break
      beforeSeq = next
    }
  }
  async function messages(records, item, sessionId, signal, calls = new Map()) {
    if (item.kind === 'room') await primeGroupCalls(records, item, sessionId, signal, calls)
    const filtered = records.filter(record => ['user/message', 'assistant/message'].includes(record.event?.type))
    const projected = (item.kind === 'room' ? projectGroupRecords(records, { sessionId, members: item.members, calls, redact }) : projectRecords(filtered, options(item, sessionId))).filter(row => ['user', 'assistant'].includes(row.role)).map(row => ({
      id: row.id, sessionId, seq: row.seq, createdAt: row.createdAt, role: row.role, text: row.text,
      ...(row.requestId ? { requestId: row.requestId } : {}),
      ...(row.author ? { author: row.author } : {}),
      ...(row.groupReplyId ? { groupReplyId: row.groupReplyId } : {}),
    })).filter(row => row.text.length > 0)
    if (!fixtureText && projected.length) {
      for (let offset = 0; offset < projected.length; offset += 50) {
        const batch = projected.slice(offset, offset + 50)
        const result = await call('bridge.redact', { conversationId: item.id, expectedSessionId: item.sessionId, ...(item.kind === 'room' ? { expectedMembers: item.members } : {}), texts: batch.flatMap(row => [row.text, row.author?.name ?? '']) }, signal)
        if (!Array.isArray(result.texts) || result.texts.length !== batch.length * 2 || result.texts.some(text => typeof text !== 'string')) throw error(503, 'REDACTION_UNAVAILABLE', 'The host redaction result is invalid.')
        batch.forEach((row, index) => { row.text = result.texts[index * 2]; if (row.author) row.author.name = result.texts[index * 2 + 1] })
      }
    }
    return projected
  }
  // sessionController 是可选服务：缺失时给出可读的 503，而不是 TypeError → 500。
  function requireController(method) {
    if (typeof sessionController?.[method] !== 'function') {
      throw error(503, 'SESSION_CONTROLLER_UNAVAILABLE', `The host did not expose sessionController.${method}; conversation history is unavailable.`)
    }
    return sessionController
  }
  async function opening(sessionId, limit, signal) {
    const controller = new AbortController()
    const scoped = AbortSignal.any([signal ?? AbortSignal.timeout(30_000), controller.signal, shutdown.signal])
    const iterator = requireController('follow').follow({ address: { kind: 'session', sessionId }, maxMessages: limit }, scoped)[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      if (first.value?.type !== 'snapshot') throw error(503, 'HISTORY_UNAVAILABLE', 'The host did not supply a history snapshot.')
      return first.value
    } finally { controller.abort(); await iterator.return?.() }
  }
  function cursorFor(item, sessionId, page, throughSeq) {
    let cut
    if (page.hasMore && page.records?.length) cut = { sessionId, throughSeq, beforeSeq: page.records[0].event.seq }
    else {
      const ids = [...item.parts, item.sessionId]
      const previous = ids[ids.indexOf(sessionId) - 1]
      if (previous) cut = { sessionId: previous }
    }
    return cut ? Buffer.from(JSON.stringify({ v: 1, conversationId: item.id, ...cut })).toString('base64url') : null
  }
  async function history(id, { cursor, limit = 50 } = {}, signal) {
    textAllowed()
    const item = await target(id, signal)
    let cut = { sessionId: item.sessionId }
    if (cursor) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 2048) throw Error()
        cut = JSON.parse(Buffer.from(cursor, 'base64url').toString())
        if (cut.v !== 1 || cut.conversationId !== id || typeof cut.sessionId !== 'string'
          || (cut.throughSeq !== undefined && !validSeq(cut.throughSeq))
          || (cut.beforeSeq !== undefined && (!validSeq(cut.beforeSeq) || cut.beforeSeq < 0 || cut.throughSeq === undefined || cut.beforeSeq > cut.throughSeq))) throw Error()
      } catch { throw error(400, 'INVALID_CURSOR', 'Invalid conversation history cursor.') }
    }
    requireSession(item, cut.sessionId)
    const page = cut.throughSeq === undefined ? await opening(cut.sessionId, limit, signal)
      : await requireController('page').page({ address: { kind: 'session', sessionId: cut.sessionId }, throughSeq: cut.throughSeq, beforeSeq: cut.beforeSeq, maxMessages: limit }, signal)
    return { sessionId: cut.sessionId, messages: await messages(page.records ?? [], item, cut.sessionId, signal), cursor: cursorFor(item, cut.sessionId, page, cut.throughSeq ?? page.cursor) }
  }
  const teamActions = createTeamActions({
    callTeam: call, snapshot, sessionController,
    redactTexts: async (body, signal) => {
      textAllowed()
      return (await call('bridge.redact', body, signal)).texts
    },
  })
  const actionCapabilities = () => description.version === 1 && description.redactedText === true
    ? teamActions.capabilities() : { actions: [], modelSelection: false, queue: false, cancel: false }
  return {
    async initialize() {
      for (let attempt = 0; ; attempt++) {
        try { await snapshot(); break }
        catch (error) {
          if (error.code !== 'TEAM_UNAVAILABLE' || attempt >= 49) throw error
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      try {
        const value = await call('bridge.describe')
        description = value?.version === 1 ? value : {}
      } catch (error) {
        if (error.status !== 501) throw error
        if (hostService) {
          localBridge = true
          description = hostService.describe()
        }
      }
    },
    compatibility: () => ({ protocolVersion: description.version ?? null,
      missing: [...(description.version === 1 ? [] : ['bridge.describe v1']), ...(description.stableRequestId === true ? [] : ['bridge.submit (stable request ID)']), ...(description.redactedText === true ? [] : ['bridge.redact (known-value redaction)'])],
      message: description.version === 1 && description.stableRequestId === true && description.redactedText === true
        ? 'Text chat is available through the DS Bot-owned bridge contract.'
        : 'This DS Bot version does not provide the required mobile chat interfaces. Pairing and team summaries are available; chat controls must remain disabled.' }),
    capabilities: () => ({ discovery: true, pairing: true, conversations: true, history: fixtureText || (description.version === 1 && description.redactedText === true), stream: fixtureText || (description.version === 1 && description.redactedText === true),
      send: description.version === 1 && description.stableRequestId === true, attachments: false, cancel: false,
      actions: [], images: false, files: false, transcription: false, attachmentDownloads: [], audioStreaming: false,
      approvals: false, groups: description.groups === true && description.groupProjection === 1, notifications: false, browser: false, settings: false, secrets: false,
      modelSelection: false, queue: false, parts: false, search: false, context: false, tools: false, reasoning: false,
      assistantDeltas: false, exactParts: false, receiptReconciliation: false, historyResume: 'snapshot-merge',
      ...actionCapabilities(), botProfileEditing: false, botEditableFields: ['model', 'effort'],
      memory: actionCapabilities().actions.includes('memory-view'), memorySummary: false, memoryTeam: false,
      schedules: actionCapabilities().actions.includes('schedules'), usage: actionCapabilities().actions.includes('usage'),
      // U4：会话列表能力（kind:"session" 行 + lastActiveAt）。
      sessions: typeof loadSessions === 'function' }),
    async state(signal) {
      const view = await snapshot(signal)
      // The original App gates its composer on readOnly, not discovery.send.
      const readOnly = view.readOnly ? 'The team is read-only on this host.'
        : description.version !== 1 || description.stableRequestId !== true ? 'Reliable chat requires the upstream bridge submit extension.' : null
      return { revision: view.revision, readOnly, bots: view.conversations.filter(row => row.kind === 'bot'), rooms: view.conversations.filter(row => row.kind === 'room'), sessions: view.sessions ?? [], agents: [], capabilities: [],
        models: view.models, defaultModel: view.defaultModel, mainBotIds: view.mainBotIds, mainBotId: view.mainBotIds[0] ?? null,
        questions: {}, activity: {}, work: { bots: {}, rooms: {}, approvals: [], waiting: {} }, memory: actionCapabilities().actions.includes('memory-view'), browser: false }
    },
    async conversations(signal) { return { conversations: (await snapshot(signal)).conversations } },
    async target(id, signal) { const item = await target(id, signal); return { conversationId: id, sessionId: item.sessionId, revision: item.revision, kind: item.kind } },
    history,
    async submit({ conversationId, sessionId, requestId, text, attachments }, signal) {
      if (description.version !== 1 || description.stableRequestId !== true) throw error(501, 'STABLE_SUBMIT_REQUIRED', 'DS Bot 0.1.7 needs the reviewed bridge submit extension for reliable sending.')
      const item = await target(conversationId, signal)
      if (item.sessionId !== sessionId || item.readOnly) throw error(409, 'TARGET_CHANGED', 'Refresh the writable conversation target.')
      if (attachments?.length || !text?.trim() || text.includes('dsh-session:')) throw error(400, 'INVALID_CONTENT', 'Only plain text without Session references is supported.')
      const result = await call('bridge.submit', { version: 1, conversationId, expectedSessionId: sessionId, ...(item.kind === 'room' ? { expectedMembers: item.members } : {}), requestId, content: [{ type: 'text', text }] }, signal)
      if (result?.accepted !== true || result.sessionId !== sessionId || result.requestId !== requestId) throw error(503, 'ADMISSION_UNCONFIRMED', 'The upstream admission receipt is unconfirmed.')
      return result
    },
    async *follow(id, _options, signal) {
      textAllowed()
      const item = await target(id, signal)
      const sessionId = item.sessionId
      const scoped = AbortSignal.any([signal, shutdown.signal])
      const calls = new Map()
      // Reconnect always obtains a fresh bounded reset snapshot; no claim of
      // exactly-once delta delivery or full historical catch-up is made.
      for await (const frame of sessionController.follow({ address: { kind: 'session', sessionId }, maxMessages: 100 }, scoped)) {
        const current = await target(id, scoped)
        if (current.sessionId !== sessionId) return
        if (frame.type === 'snapshot') yield { type: 'reset', conversationId: id, sessionId, eventSeq: frame.cursor, messages: await messages(frame.records ?? [], current, sessionId, scoped, calls), cursor: cursorFor(current, sessionId, frame, frame.cursor) }
        if (frame.type === 'event') {
          for (const message of await messages([{ event: frame.event }], current, sessionId, scoped, calls)) yield { type: 'message', conversationId: id, sessionId, message }
          if (['turn/start', 'turn/end'].includes(frame.event.type)) {
            const busy = frame.event.type === 'turn/start'
            yield { type: 'status', conversationId: id, sessionId, busy, phase: busy ? 'running' : 'idle', eventSeq: frame.event.seq }
          }
        }
      }
    },
    upload: unsupported, transcribe: unsupported, attachment: unsupported,
    async action(name, payload, signal) {
      if (!actionCapabilities().actions.includes(name)) throw error(403, 'ACTION_NOT_ALLOWED', 'This mobile action is unavailable.')
      return teamActions.action(name, payload, signal)
    },
    async cancel(id, signal) {
      if (!actionCapabilities().cancel) return unsupported()
      const item = await target(id, signal)
      return teamActions.cancel({ conversationId: id, sessionId: item.sessionId }, signal)
    },
    async dispose() { if (disposed) return; disposed = true; shutdown.abort(); await peer?.dispose() },
  }
}
