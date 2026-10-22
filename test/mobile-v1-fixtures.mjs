// 团队投影 fixtures：形状取自 bridge 0.0.6 的 state 契约（测试共用）。
export const TEAM_STATE = {
  revision: 42,
  readOnly: null,
  models: [{ ref: 'mock/model', name: 'Mock', providerName: 'Mock Inc' }],
  defaultModel: 'mock/model',
  mainBotIds: ['chief'],
  bots: [
    { id: 'chief', name: 'Chief', sessionId: 's-chief', role: 'Main', model: 'mock/model', effort: 'low', waiting: false, pinned: true, hidden: false, parts: ['s-chief-2'] },
    { id: 'coder', name: 'Coder', sessionId: 's-coder', waiting: true, pinned: false, hidden: false, parts: [] },
  ],
  rooms: [
    { id: 'room-1', name: '开发组', sessionId: 'room-1', members: ['chief', 'coder'], admin: 'chief', mode: 'admin', pinned: false, hidden: false, parts: [] },
  ],
}

export const DESCRIBE = { version: 1, stableRequestId: true, redactedText: true, groups: true, groupProjection: 1 }

// 最小 Connection 替身：按 endpoint 返回 fixture 值。
export function fixtureConnection({ describe = DESCRIBE, state = TEAM_STATE } = {}) {
  return {
    createSharedFetchHandler() {
      return {
        async fetch(request) {
          const body = JSON.parse(await request.text())
          const value = fixtureValue(body.endpoint, body.payload ?? {}, { describe, state })
          return new Response(JSON.stringify({ ok: true, value }), { status: 200, headers: { 'content-type': 'application/json' } })
        },
      }
    },
  }
}

function fixtureValue(endpoint, payload, { describe, state }) {
  switch (endpoint) {
    case 'state': return state
    case 'bridge.describe': return describe
    case 'bridge.redact': return { texts: (payload.texts ?? []).map(text => `[R]${text}`) }
    case 'bridge.submit': return { accepted: true, requestId: payload.requestId }
    case 'models': return { models: state.models, defaultModel: state.defaultModel }
    case 'efforts': return { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], default: 'low' }
    case 'set-flags': return { id: payload.id, ...(payload.pinned !== undefined ? { pinned: payload.pinned } : {}), ...(payload.hidden !== undefined ? { hidden: payload.hidden } : {}) }
    case 'update-bot': return { id: payload.id, changed: true }
    default: return {}
  }
}
