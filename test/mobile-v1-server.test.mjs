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
  // 路由同步注册（宿主 webServer 的路由是活表，但初始化可能较慢，未就绪应 503）。
  await handle.ready

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

test('routes answer 503 until the service is ready, then 200', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mobile-v1-slow-'))
  const base = fixtureConnection()
  const slow = {
    createSharedFetchHandler() {
      const handler = base.createSharedFetchHandler()
      return { fetch: async (request, peer) => { await new Promise(r => setTimeout(r, 300)); return handler.fetch(request, peer) } }
    },
  }
  const routes = []
  const webServer = {
    port: 0,
    register(route) { routes.push(route); return () => {} },
    registerUpgrade() { return () => {} },
  }
  const handle = startMobileV1({ connection: slow, webServer, home, prefix: '/mobile-v1-test', publicUrl: 'http://127.0.0.1:3082' })
  const server = http.createServer((req, res) => routes[0].handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const early = await fetch(`http://127.0.0.1:${port}/mobile-v1-test/info`)
    assert.equal(early.status, 503)
    await handle.ready
    const ready = await fetch(`http://127.0.0.1:${port}/mobile-v1-test/info`)
    assert.equal(ready.status, 200)
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

test('pairing url is normalized to an https origin even when the tunnel reports a wss url', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mobile-v1-test-'))
  const adapter = createAdapter({ connection: fixtureConnection() })
  await adapter.initialize()
  const server = await createMobileV1({
    home,
    config: { devAllowInsecure: true },
    adapter,
    publicUrl: 'https://pair.example.test',
    // 真机现场形态：隧道快照给的是旧网关 WS 地址。
    resolvePublicUrl: () => 'wss://recycling-phil-letters-refer.trycloudflare.com/ws/mobile',
  })
  try {
    const pairing = await server.operator('pairing.create')
    assert.equal(pairing.url, 'https://recycling-phil-letters-refer.trycloudflare.com')
    // 镜像 App 的 validateServerUrl：https 根 origin 才通过。
    assert.match(pairing.url, /^(https?):\/\/([A-Za-z0-9.\-\[\]:]+)(\/|\/mobile\/v1\/?)?$/)
    const status = await server.operator('status')
    assert.equal(status.url, pairing.url)
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('unusable resolved url falls back to the configured public origin', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mobile-v1-test-'))
  const adapter = createAdapter({ connection: fixtureConnection() })
  await adapter.initialize()
  const server = await createMobileV1({
    home,
    config: { devAllowInsecure: true },
    adapter,
    publicUrl: 'https://pair.example.test',
    resolvePublicUrl: () => 'not a url',
  })
  try {
    const pairing = await server.operator('pairing.create')
    assert.equal(pairing.url, 'https://pair.example.test')
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('mobile-v1 mounts on the gateway LAN/public listener, not only the host web server', async () => {
  const { createExtraRouteTable } = await import('../lib/extra-routes.mjs')
  const home = await mkdtemp(path.join(os.tmpdir(), 'mobile-v1-test-'))
  const extra = createExtraRouteTable()
  const hostRoutes = []
  const hostUpgrades = []
  const host = {
    port: 0,
    register(route) { hostRoutes.push(route.path); return () => {} },
    registerUpgrade(route) { hostUpgrades.push(route.path); return () => {} },
  }
  const handle = startMobileV1({
    connection: fixtureConnection(),
    webServer: host,
    extraServers: [extra],
    home,
    prefix: '/mobile-v1-test',
    publicUrl: 'https://pair.example.test',
  })
  // 与隧道/LAN 监听器同构：请求期查附加路由表，未命中才 404。
  const listener = http.createServer((req, res) => {
    if (extra.handleHttp(req, res)) return
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found')
  })
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  try {
    let response
    for (let attempt = 0; attempt < 50; attempt++) {
      response = await fetch(`http://127.0.0.1:${port}/mobile-v1-test/info`)
      if (response.status === 200) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(response.status, 200, '经对外监听器访问 /info 必须 200（公网路径）')
    const body = await response.json()
    assert.equal(body.protocolVersion, 1)
    // 宿主 webServer 仍要注册（本机管理与 diff 用它）。
    assert.ok(hostRoutes.includes('/mobile-v1-test'))
    assert.ok(hostUpgrades.includes('/mobile-v1-test/events'))
    // 前缀不能跨段吞掉邻居路径。
    assert.equal((await fetch(`http://127.0.0.1:${port}/mobile-v1-testx/info`)).status, 404)
  } finally {
    await new Promise(resolve => listener.close(resolve))
    await handle.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

test('history without sessionController reports a readable 503 instead of a 500', async () => {
  const adapter = createAdapter({ connection: fixtureConnection() })
  await adapter.initialize()
  // 真机 S5：宿主没把 sessionController 交给插件时，历史接口曾以 TypeError → INTERNAL_ERROR(500)
  // 的形式失败，日志里还看不到栈。现在必须是明确的 503 + 错误码。
  await assert.rejects(() => adapter.history('chief'), (error) => {
    assert.equal(error.status, 503)
    assert.equal(error.code, 'SESSION_CONTROLLER_UNAVAILABLE')
    return true
  })
})

test('sessionController is resolved per call, so a late-provisioned service is picked up', async () => {
  const { createExtraRouteTable } = await import('../lib/extra-routes.mjs')
  const home = await mkdtemp(path.join(os.tmpdir(), 'mobile-v1-test-'))
  const extra = createExtraRouteTable()
  // 真机 S5 的根因：宿主在 apply 之后才提供 sessionController，
  // 旧实现把 null 固化进 adapter → 历史接口 TypeError → 500。
  let controller = null
  const handle = startMobileV1({
    connection: fixtureConnection(),
    resolveSessionController: () => controller,
    webServer: { port: 0, register: () => () => {}, registerUpgrade: () => () => {} },
    extraServers: [extra],
    home,
    prefix: '/mobile-v1-test',
    publicUrl: 'https://pair.example.test',
  })
  const listener = http.createServer((req, res) => {
    if (extra.handleHttp(req, res)) return
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${listener.address().port}/mobile-v1-test`
  try {
    const waitReady = async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const response = await fetch(`${base}/info`)
        if (response.status === 200) return response.json()
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('mobile-v1 never became ready')
    }
    assert.equal((await waitReady()).capabilities.cancel, false)
    // 服务晚到：能力面必须立刻反映出来（代理按调用解析，不再固化 null）。
    controller = { cancel() {}, async prompt() { return { accepted: true } } }
    assert.equal((await waitReady()).capabilities.cancel, true)
  } finally {
    await new Promise(resolve => listener.close(resolve))
    await handle.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

test('approval issues the gateway credential once and ships it with the session', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mobile-v1-test-'))
  const adapter = createAdapter({ connection: fixtureConnection() })
  await adapter.initialize()
  const issued = []
  const server = await createMobileV1({
    home,
    config: { devAllowInsecure: true },
    adapter,
    publicUrl: 'https://pair.example.test',
    issueGatewayDevice: async ({ deviceName }) => {
      issued.push(deviceName)
      return { deviceId: 'gw-1', token: 'gateway-token', wsPath: '/ws/mobile' }
    },
  })
  try {
    const pairing = await server.operator('pairing.create')
    // 走真实状态机：claim → approve → complete
    const http = (await import('node:http')).createServer(server.handleHttp)
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${http.address().port}/mobile/v1`
    try {
      const started = await (await fetch(`${base}/pairings`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: pairing.code, deviceName: 'iPhone 15' }),
      })).json()
      // 批准前不得签发（只有批准那一刻才发）
      assert.deepEqual(issued, [])
      await server.operator('pairing.approve', { requestId: started.requestId })
      assert.deepEqual(issued, ['iPhone 15'], '批准时应签发一次网关凭证')
      const session = await (await fetch(`${base}/pairings/complete`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claimToken: started.claimToken }),
      })).json()
      assert.equal(typeof session.accessToken, 'string')
      assert.deepEqual(session.gateway, { deviceId: 'gw-1', token: 'gateway-token', wsPath: '/ws/mobile' })
      // 再次 complete 走缓存路径，gateway 依然在，且不会重复签发
      const again = await (await fetch(`${base}/pairings/complete`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claimToken: started.claimToken }),
      })).json()
      assert.deepEqual(again.gateway, session.gateway)
      assert.deepEqual(issued, ['iPhone 15'])
    } finally {
      await new Promise(resolve => http.close(resolve))
    }
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('no issuance hook keeps the gateway field absent (old clients unaffected)', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mobile-v1-test-'))
  const adapter = createAdapter({ connection: fixtureConnection() })
  await adapter.initialize()
  const server = await createMobileV1({ home, config: { devAllowInsecure: true }, adapter, publicUrl: 'https://pair.example.test' })
  const http = (await import('node:http')).createServer(server.handleHttp)
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${http.address().port}/mobile/v1`
  try {
    const pairing = await server.operator('pairing.create')
    const started = await (await fetch(`${base}/pairings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, deviceName: 'Old App' }),
    })).json()
    await server.operator('pairing.approve', { requestId: started.requestId })
    const session = await (await fetch(`${base}/pairings/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimToken: started.claimToken }),
    })).json()
    assert.equal(session.gateway, undefined)
    assert.equal(typeof session.accessToken, 'string')
  } finally {
    await new Promise(resolve => http.close(resolve))
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('symmetric pairing: a gateway pairing can mint the mobile-v1 session too', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mobile-v1-test-'))
  const adapter = createAdapter({ connection: fixtureConnection() })
  await adapter.initialize()
  const server = await createMobileV1({ home, config: { devAllowInsecure: true }, adapter, publicUrl: 'https://pair.example.test' })
  try {
    const first = await server.issueSessionForDevice({ name: 'iPhone 15', serverUrl: 'https://ydgg.dpdns.org' })
    // 反向路径要带 serverUrl：老版 App 只能从 session.serverUrl 重建 transport。
    assert.equal(first.serverUrl, 'https://ydgg.dpdns.org')
    assert.equal(typeof first.accessToken, 'string')
    assert.equal(typeof first.refreshToken, 'string')
    assert.equal(typeof first.deviceId, 'string')
    // 签发的 session 可直接用于 /state（重新配对会轮换 token，所以先验再用）。
    const http = (await import('node:http')).createServer(server.handleHttp)
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${http.address().port}/mobile/v1`
    try {
      const state = await fetch(`${base}/state`, { headers: { authorization: `Bearer ${first.accessToken}` } })
      assert.equal(state.status, 200)
    } finally {
      await new Promise(resolve => http.close(resolve))
    }
    const second = await server.issueSessionForDevice({ name: 'iPhone 15' })
    // 同名重复配对复用同一条设备，不制造重复记录。
    assert.equal(second.deviceId, first.deviceId)
    const third = await server.issueSessionForDevice({ name: 'iPad' })
    assert.notEqual(third.deviceId, first.deviceId)
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})
