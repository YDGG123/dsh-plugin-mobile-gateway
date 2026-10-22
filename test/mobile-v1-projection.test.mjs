import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter } from '../lib/mobile-v1/adapter.mjs'
import { fixtureConnection, TEAM_STATE } from './mobile-v1-fixtures.mjs'

test('mobile-v1 projection exposes bots and rooms with redacted names', async () => {
  const adapter = createAdapter({ connection: fixtureConnection() })
  await adapter.initialize()
  const state = await adapter.state()
  assert.equal(state.bots.length, 2)
  assert.equal(state.rooms.length, 1)
  assert.deepEqual(state.mainBotIds, ['chief'])
  // bridge.redact fixture 给每个文本加 [R]，证明确实走了 redaction。
  assert.equal(state.bots[0].name, '[R]Chief')
  assert.equal(state.rooms[0].name, '[R]开发组')
  // 被 room.parts 隐藏的 session 不应出现在 conversations 里。
  const conversations = await adapter.conversations()
  assert.equal(conversations.conversations.length, 3)
  assert.ok(!conversations.conversations.some(item => item.sessionId === 's-chief-2'))
  assert.equal(adapter.capabilities().history, true)
  assert.equal(adapter.capabilities().send, true)
  assert.equal(adapter.capabilities().groups, true)
  const compatibility = adapter.compatibility()
  assert.equal(compatibility.protocolVersion, 1)
  assert.deepEqual(compatibility.missing, [])
  await adapter.dispose()
})

test('mobile-v1 projection degrades when describe contract is missing', async () => {
  const adapter = createAdapter({ connection: fixtureConnection({ describe: {} }) })
  await adapter.initialize()
  const capabilities = adapter.capabilities()
  assert.equal(capabilities.history, false)
  assert.equal(capabilities.send, false)
  assert.equal(capabilities.groups, false)
  assert.equal(adapter.compatibility().protocolVersion, null)
  assert.ok(adapter.compatibility().missing.length >= 3)
  await adapter.dispose()
})
