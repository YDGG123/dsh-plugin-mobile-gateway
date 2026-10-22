import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAdapter } from '../lib/mobile-v1/adapter.mjs'
import { createMobileV1 } from '../lib/mobile-v1/server.mjs'
import { normalizeMobileV1Prefix, startMobileV1 } from '../lib/mobile-v1/index.mjs'
import { fixtureConnection } from './mobile-v1-fixtures.mjs'

async function boot() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mobile-v1-test-'))
  const adapter = createAdapter({ connection: fixtureConnection() })
  await adapter.initialize()
  const server = await createMobileV1({ home, config: { devAllowInsecure: true }, adapter, publicUrl: 'http://127.0.0.1:3082' })
  const httpServer = http.createServer(server.handleHttp)
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const port = httpServer.address().port
  return {
    server,
    adapter,
    home,
    base: `http://127.0.0.1:${port}/mobile/v1`,
    async close() {
      await new Promise(resolve => httpServer.close(resolve))
      await server.close()
      await rm(home, { recursive: true, force: true })
    },
  }
}

test('mobile-v1 /info is unauthenticated and advertises protocol 1', async () => {
  const ctx = await boot()
  try {
    const response = await fetch(`${ctx.base}/info`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.protocolVersion, 1)
    assert.equal(typeof body.serverId, 'string')
    assert.equal(body.capabilities.history, true)
  } finally { await ctx.close() }
})

test('mobile-v1 pairing issues a session and gates /state', async () => {
  const ctx = await boot()
  try {
    // 无凭证访问 /state → 401。
    assert.equal((await fetch(`${ctx.base}/state`)).status, 401)

    const pairing = await ctx.server.operator('pairing.create')
    assert.equal(typeof pairing.code, 'string')
    assert.equal(typeof pairing.url, 'string')

    const begin = await fetch(`${ctx.base}/pairings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, deviceName: 'Test iPhone' }),
    })
    assert.equal(begin.status, 200)
    const claim = await begin.json()
    assert.equal(claim.status, 'pending')

    // 桌面批准（本插件里由 loopback 管理路由调用）。
    await ctx.server.operator('pairing.approve', { requestId: claim.requestId })

    const complete = await fetch(`${ctx.base}/pairings/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimToken: claim.claimToken }),
    })
    assert.equal(complete.status, 200)
    const session = await complete.json()
    assert.equal(typeof session.accessToken, 'string')
    assert.equal(typeof session.deviceId, 'string')

    const state = await fetch(`${ctx.base}/state`, { headers: { authorization: `Bearer ${session.accessToken}` } })
    assert.equal(state.status, 200)
    const team = await state.json()
    assert.equal(team.bots.length, 2)
    assert.equal(team.rooms.length, 1)

    const devices = await fetch(`${ctx.base}/devices`, { headers: { authorization: `Bearer ${session.accessToken}` } })
    assert.equal(devices.status, 200)
    const list = await devices.json()
    assert.equal(list.devices.length, 1)
    assert.equal(list.currentDeviceId, session.deviceId)

    // 配对第二台设备，撤销「另一台」（撤销自己会让当前请求按契约 401）。
    const secondPairing = await ctx.server.operator('pairing.create')
    const secondBegin = await (await fetch(`${ctx.base}/pairings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: secondPairing.code, deviceName: 'Second iPhone' }),
    })).json()
    await ctx.server.operator('pairing.approve', { requestId: secondBegin.requestId })
    const secondSession = await (await fetch(`${ctx.base}/pairings/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimToken: secondBegin.claimToken }),
    })).json()

    const revoke = await fetch(`${ctx.base}/devices/${secondSession.deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session.accessToken}` },
    })
    assert.equal(revoke.status, 200)
    assert.equal((await revoke.json()).revoked, true)
    // 第一台设备仍然可用；被撤销的第二台被拒绝。
    assert.equal((await fetch(`${ctx.base}/state`, { headers: { authorization: `Bearer ${session.accessToken}` } })).status, 200)
    assert.equal((await fetch(`${ctx.base}/state`, { headers: { authorization: `Bearer ${secondSession.accessToken}` } })).status, 401)
  } finally { await ctx.close() }
})

test('coexistence prefix serves the same protocol under /mobile-v1-test', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mobile-v1-prefix-'))
  const routes = []
  const upgrades = []
  const webServer = {
    port: 0,
    register(route) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
    registerUpgrade(route) { upgrades.push(route); return () => { upgrades.splice(upgrades.indexOf(route), 1) } },
  }
  const handle = await startMobileV1({
    connection: fixtureConnection(),
    webServer,
    home,
    prefix: '/mobile-v1-test',
    publicUrl: 'http://127.0.0.1:3082',
  })
  assert.equal(handle.prefix, '/mobile-v1-test')
  assert.equal(routes[0].path, '/mobile-v1-test')
  assert.equal(upgrades[0].path, '/mobile-v1-test/events')

  const server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/mobile-v1-test')) routes[0].handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const info = await fetch(`http://127.0.0.1:${port}/mobile-v1-test/info`)
    assert.equal(info.status, 200)
    assert.equal((await info.json()).protocolVersion, 1)
    assert.equal((await fetch(`http://127.0.0.1:${port}/mobile/v1/info`)).status, 404)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await handle.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

test('normalizeMobileV1Prefix only accepts the official or coexistence prefixes', () => {
  assert.equal(normalizeMobileV1Prefix(''), '/mobile/v1')
  assert.equal(normalizeMobileV1Prefix('mobile-v1-test/'), '/mobile-v1-test')
  assert.throws(() => normalizeMobileV1Prefix('/mgw'))
  assert.throws(() => normalizeMobileV1Prefix('/ws/mobile'))
})

test('mobile-v1 rejects invalid pairing codes and bad bodies', async () => {
  const ctx = await boot()
  try {
    const invalid = await fetch(`${ctx.base}/pairings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'nope', deviceName: 'Test iPhone' }),
    })
    assert.equal(invalid.status, 400)
    const error = await invalid.json()
    assert.equal(error.error.code, 'INVALID_PAIRING_CODE')

    const malformed = await fetch(`${ctx.base}/pairings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(malformed.status, 400)
    assert.equal((await malformed.json()).error.code, 'INVALID_JSON')
  } finally { await ctx.close() }
})
