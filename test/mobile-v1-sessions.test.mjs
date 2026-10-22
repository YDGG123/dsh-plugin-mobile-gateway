import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter } from '../lib/mobile-v1/adapter.mjs'
import { fixtureConnection } from './mobile-v1-fixtures.mjs'

// U4：普通会话行（kind:"session"）。数据源 = 插件内 api.sessions.list()，不产生第二套凭证。
const SESSIONS = [
  // 团队已覆盖的会话（bot 本体、bot 的 parts、群聊）必须排除，避免重复行。
  { sessionId: 's-chief', updatedAt: 10, projections: { values: { title: 'Chief session' } } },
  { sessionId: 's-chief-2', updatedAt: 11, projections: { values: { title: 'Chief part' } } },
  { sessionId: 'room-1', updatedAt: 12, projections: { values: { title: '开发组' } } },
  // 子代理会话不上手机主列表。
  { sessionId: 's-sub', updatedAt: 999, origin: 'subagent', parentSessionId: 's-chief', projections: { values: { title: 'child' } } },
  // 真正的普通会话。
  { sessionId: 's-alpha', updatedAt: 100, cwd: '/Users/somebody/work/alpha/', running: true, projections: { values: { title: 'Alpha work' } } },
  { sessionId: 's-beta', updatedAt: 200, cwd: '/Users/somebody/work/beta', projections: { values: {} } },
]

async function boot(loadSessions) {
  const adapter = createAdapter({ connection: fixtureConnection(), loadSessions })
  await adapter.initialize()
  return adapter
}

test('session rows exclude team sessions and subagents, newest first', async () => {
  const adapter = await boot(async () => SESSIONS)
  const state = await adapter.state()
  assert.deepEqual(state.sessions.map(row => row.id), ['s-beta', 's-alpha'])
  assert.deepEqual(state.sessions.map(row => row.kind), ['session', 'session'])
  // lastActiveAt 来自 updatedAt，供 App 统一排序。
  assert.equal(state.sessions[0].lastActiveAt, 200)
  assert.equal(state.sessions[1].lastActiveAt, 100)
  assert.equal(state.sessions[1].busy, true)
})

test('session titles and workspace labels are redacted like team rows', async () => {
  const adapter = await boot(async () => SESSIONS)
  const state = await adapter.state()
  const alpha = state.sessions.find(row => row.id === 's-alpha')
  // fixture 的 redaction 通道会把文本包成 [R]…，说明会话行确实走了同一套口径。
  assert.equal(alpha.name, '[R]Alpha work')
  assert.equal(alpha.workspace, '[R]alpha')
  const beta = state.sessions.find(row => row.id === 's-beta')
  assert.equal(beta.name, '[R]未命名会话')
  assert.equal(beta.workspace, '[R]beta')
  // 不下发完整 cwd（只给工作区名）。
  for (const row of state.sessions) assert.equal(row.cwd, undefined)
})

test('/conversations carries session rows and /info advertises the capability', async () => {
  const adapter = await boot(async () => SESSIONS)
  const page = await adapter.conversations()
  const kinds = page.conversations.map(row => row.kind)
  assert.ok(kinds.includes('bot') && kinds.includes('room') && kinds.includes('session'))
  assert.equal(adapter.capabilities().sessions, true)
})

test('without a session provider the feature is off (capability fail-closed)', async () => {
  const adapter = await boot(null)
  const state = await adapter.state()
  assert.deepEqual(state.sessions, [])
  assert.equal(adapter.capabilities().sessions, false)
  assert.ok(!(await adapter.conversations()).conversations.some(row => row.kind === 'session'))
})

test('a failing session provider degrades to an empty list, never breaks the team view', async () => {
  const adapter = await boot(async () => { throw new Error('sessions.list unavailable') })
  const state = await adapter.state()
  assert.deepEqual(state.sessions, [])
  assert.equal(state.bots.length, 2, '团队视图不受影响')
})
