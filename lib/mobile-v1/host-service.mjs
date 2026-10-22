import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BridgeError } from './auth.mjs'

/**
 * 宿主侧团队服务：让 `/mobile/v1` 在原版 ds-bot（无 bridge.* 补丁）上也能工作。
 *
 * - `bridge.describe`：静态契约（原版插件自己产出即可）
 * - `bridge.redact`：复刻 ds-bot `src/host/secrets.js` 的通用替换器
 *   **密钥唯一来源**：默认 `~/.dsh/bot/secrets.json`（可用 config `mobileV1SecretsFile` 覆盖），
 *   与 ds-bot 共用同一份文件，不另建密钥库。
 * - `bridge.submit`：调用宿主 `sessionController.prompt({requestId, sessionId, mode:'queue', content})`，
 *   外围身份/stale 校验按 state 重写（§2.5 语义）。
 *
 * 若宿主仍是补丁版 ds-bot（存在 bridge.* 端点），adapter 会优先走 RPC，本服务作为回退。
 */

export const BRIDGE_DESCRIBE = Object.freeze({
  version: 1,
  stableRequestId: true,
  redactedText: true,
  groups: true,
  groupProjection: 1,
  attachments: false,
})

// ---- 复刻 ds-bot secrets.js 的 redactor（含 JSON 转义与 URL 编码形态）----
export const MIN_VALUE = 4
export const WHOLE_VALUE = 8

const encodeUrlComponent = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

export function redactor(entries) {
  const pairs = []
  for (const { name, value } of entries) {
    if (typeof value !== 'string' || value.length < MIN_VALUE) continue
    const label = `[secret:${name}]`
    const short = value.length < WHOLE_VALUE
    pairs.push([value, label, short])
    const escaped = JSON.stringify(value).slice(1, -1)
    if (escaped !== value) pairs.push([escaped, label, short])
    const encoded = value.isWellFormed() ? encodeUrlComponent(value) : value
    if (encoded !== value && encoded !== escaped) pairs.push([encoded, label, short])
  }
  pairs.sort((a, b) => b[0].length - a[0].length)
  if (pairs.length === 0) return text => text
  const labels = new Map()
  for (const [value, label] of pairs) if (!labels.has(value)) labels.set(value, label)
  const quote = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(pairs.map(([value, , short]) => (short ? `(?<![\\p{L}\\p{N}])${quote(value)}(?![\\p{L}\\p{N}])` : quote(value))).join('|'), 'gu')
  return (text) => {
    if (typeof text !== 'string' || !pairs.some(([value]) => text.includes(value))) return text
    return text.replace(pattern, match => labels.get(match) ?? match)
  }
}

export function defaultSecretsFile() {
  return path.join(os.homedir(), '.dsh', 'bot', 'secrets.json')
}

async function readSecretsEntries(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'))
    const map = data && typeof data === 'object' && data.secrets && typeof data.secrets === 'object' ? data.secrets : data
    const entries = []
    for (const [name, item] of Object.entries(map ?? {})) {
      if (item && typeof item === 'object' && typeof item.value === 'string') entries.push({ name, value: item.value })
      else if (typeof item === 'string') entries.push({ name, value: item })
    }
    return entries
  } catch {
    return []
  }
}

export function createHostTeamService({ sessionController = null, secretsFile = '', log = () => {} } = {}) {
  const file = secretsFile || defaultSecretsFile()
  let cache = { at: 0, redact: text => text }
  async function redactFn() {
    if (Date.now() - cache.at < 5000) return cache.redact
    const entries = await readSecretsEntries(file)
    cache = { at: Date.now(), redact: redactor(entries) }
    return cache.redact
  }
  const fail = (status, code, message) => { throw new BridgeError(status, code, message) }

  return {
    describe: () => BRIDGE_DESCRIBE,

    async redact({ texts = [] } = {}) {
      const fn = await redactFn()
      return { texts: texts.map(text => fn(String(text ?? ''))) }
    },

    /**
     * state 由调用方注入（adapter 的 state RPC），避免这里再持一份数据源。
     * stale 判定：conversationId 不在可见团队 → TARGET_CHANGED；session 不一致 → TARGET_CHANGED；
     * room 成员/管理员/模式与 expectedMembers 不一致 → TARGET_CHANGED。
     */
    async submit(payload, signal, { loadState, prompt } = {}) {
      const { conversationId, expectedSessionId, expectedMembers, requestId, content } = payload ?? {}
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9._:-]{1,256}$/.test(requestId)) fail(400, 'INVALID_REQUEST', 'Invalid request ID.')
      if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text'
        || typeof content[0].text !== 'string' || !content[0].text.trim()
        || content[0].text.length > 100_000 || content[0].text.includes('dsh-session:')) {
        fail(400, 'INVALID_CONTENT', 'Plain text required.')
      }
      const promptFn = typeof prompt === 'function'
        ? prompt
        : (sessionController && typeof sessionController.prompt === 'function' ? sessionController.prompt.bind(sessionController) : null)
      if (!promptFn) {
        fail(501, 'STABLE_SUBMIT_REQUIRED', 'The host does not expose sessionController.prompt.')
      }
      if (typeof loadState !== 'function') fail(503, 'TEAM_UNAVAILABLE', 'No team state provider is available.')
      const state = await loadState(signal)
      if (state?.readOnly) fail(409, 'READ_ONLY', 'The team is read-only.')
      const bots = state?.bots ?? []
      const rooms = state?.rooms ?? []
      const room = rooms.find(item => item.id === conversationId)
      const bot = bots.find(item => item.id === conversationId)
      if (!room && !bot) fail(409, 'TARGET_CHANGED', 'Refresh the conversation list.')
      if (room) {
        // 原版 ds-bot 的 rooms 只有 id、没有 sessionId（群会话就是 room.id）。
        // 旧实现拿 room.sessionId 比较，undefined !== expectedSessionId 恒真 → 群聊必 409。
        const roomSession = typeof room.sessionId === 'string' && room.sessionId ? room.sessionId : room.id
        if (roomSession !== expectedSessionId || room.id !== conversationId) fail(409, 'TARGET_CHANGED', 'Refresh the group.')
        if (expectedMembers !== undefined) {
          // 与投影口径一致：只比较可见成员（投影会过滤掉非 bot 的成员）。
          const botIds = new Set(bots.map(item => item.id))
          const visibleMembers = (room.members ?? []).filter(id => botIds.has(id))
          const same = JSON.stringify(expectedMembers) === JSON.stringify(visibleMembers)
          if (!same) fail(409, 'TARGET_CHANGED', 'Refresh the group membership.')
        }
      } else if (bot.sessionId !== expectedSessionId) {
        fail(409, 'TARGET_CHANGED', 'Refresh the conversation.')
      }
      const result = await promptFn({
        requestId,
        sessionId: expectedSessionId,
        mode: 'queue',
        content,
      }, signal)
      if (result?.accepted !== true) fail(503, 'ADMISSION_UNCONFIRMED', 'The host has not confirmed this message.')
      return { accepted: true, requestId, sessionId: expectedSessionId }
    },
  }
}
