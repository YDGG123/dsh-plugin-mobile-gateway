import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BRIDGE_DESCRIBE, createHostTeamService } from '../lib/mobile-v1/host-service.mjs'
import { MOBILE_ACTIONS } from '../lib/mobile-v1/actions.mjs'

const STATE = {
  readOnly: null,
  bots: [{ id: 'chief', sessionId: 's-chief' }],
  rooms: [{ id: 'room-1', sessionId: 'room-1', members: ['chief'], admin: 'chief', mode: 'admin' }],
}

async function withSecrets(secrets, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mobile-v1-secrets-'))
  const file = path.join(dir, 'secrets.json')
  await writeFile(file, JSON.stringify({ version: 1, secrets }))
  try { return await run(file) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('describe is the static bridge contract', () => {
  const service = createHostTeamService()
  assert.deepEqual(service.describe(), BRIDGE_DESCRIBE)
  assert.equal(BRIDGE_DESCRIBE.version, 1)
  assert.equal(BRIDGE_DESCRIBE.stableRequestId, true)
  assert.equal(BRIDGE_DESCRIBE.redactedText, true)
})

test('redact replaces raw, JSON-escaped and URL-encoded secret forms', async () => {
  const value = 'hunter2-very-secret'
  await withSecrets({ GH_TOKEN: { name: 'GH_TOKEN', value, scope: 'all' } }, async file => {
    const service = createHostTeamService({ secretsFile: file })
    const escaped = JSON.stringify(value).slice(1, -1)
    const encoded = encodeURIComponent(value)
    const { texts } = await service.redact({ texts: [`token=${value}`, `{"k":"${escaped}"}`, `https://x/?t=${encoded}`, 'no secret here'] })
    assert.equal(texts[0], 'token=[secret:GH_TOKEN]')
    assert.ok(texts[1].includes('[secret:GH_TOKEN]'))
    assert.equal(texts[2], 'https://x/?t=[secret:GH_TOKEN]')
    assert.equal(texts[3], 'no secret here')
  })
})

test('redact keeps short values word-bounded', async () => {
  await withSecrets({ PIN: { name: 'PIN', value: '1234' } }, async file => {
    const service = createHostTeamService({ secretsFile: file })
    const { texts } = await service.redact({ texts: ['pin 1234 now', 'x1234y', '1234'] })
    assert.equal(texts[0], 'pin [secret:PIN] now')
    assert.equal(texts[1], 'x1234y')
    assert.equal(texts[2], '[secret:PIN]')
  })
})

test('submit validates target and forwards to sessionController.prompt', async () => {
  const calls = []
  const service = createHostTeamService({ sessionController: { async prompt(payload) { calls.push(payload); return { accepted: true } } } })
  const result = await service.submit(
    { conversationId: 'chief', expectedSessionId: 's-chief', requestId: 'r-1', content: [{ type: 'text', text: 'hi' }] },
    AbortSignal.timeout(1000),
    { loadState: async () => STATE }
  )
  assert.deepEqual(result, { accepted: true, requestId: 'r-1', sessionId: 's-chief' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].mode, 'queue')
  assert.equal(calls[0].requestId, 'r-1')
})

test('submit rejects stale target, read-only team and empty content', async () => {
  const service = createHostTeamService({ sessionController: { async prompt() { return { accepted: true } } } })
  const deps = { loadState: async () => STATE }
  await assert.rejects(
    service.submit({ conversationId: 'chief', expectedSessionId: 'other', requestId: 'r-2', content: [{ type: 'text', text: 'hi' }] }, AbortSignal.timeout(1000), deps),
    error => error.code === 'TARGET_CHANGED'
  )
  await assert.rejects(
    service.submit({ conversationId: 'ghost', expectedSessionId: 's', requestId: 'r-3', content: [{ type: 'text', text: 'hi' }] }, AbortSignal.timeout(1000), deps),
    error => error.code === 'TARGET_CHANGED'
  )
  const readOnlyService = createHostTeamService({ sessionController: { async prompt() { return { accepted: true } } } })
  await assert.rejects(
    readOnlyService.submit({ conversationId: 'chief', expectedSessionId: 's-chief', requestId: 'r-4', content: [{ type: 'text', text: 'hi' }] }, AbortSignal.timeout(1000), { loadState: async () => ({ ...STATE, readOnly: 'maintenance' }) }),
    error => error.code === 'READ_ONLY'
  )
  await assert.rejects(
    service.submit({ conversationId: 'chief', expectedSessionId: 's-chief', requestId: 'r-5', content: [] }, AbortSignal.timeout(1000), deps),
    error => error.code === 'INVALID_CONTENT'
  )
})

test('queue actions are no longer advertised', () => {
  assert.ok(!MOBILE_ACTIONS.includes('queue'))
  assert.ok(!MOBILE_ACTIONS.includes('queue-remove'))
  assert.ok(MOBILE_ACTIONS.includes('set-flags'))
})
