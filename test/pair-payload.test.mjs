import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import plugin from '../lib/index.mjs'
import { createTestConnection } from './helpers/peer.mjs'
import { cordisLikeContext } from './helpers/cordis-context.mjs'

process.env.DSH_MOBILE_GATEWAY_LOG = path.join(mkdtempSync(path.join(os.tmpdir(), 'pair-log-')), 'test.log')

// 起一个只捕获路由的 ctx：/mgw 的 handler 直接调用即可（loopback + same-origin 语义由请求头模拟）。
function boot() {
  const routes = new Map()
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pair-payload-'))
  const webServer = {
    port: 65090,
    register(route) { routes.set(route.path, route); return () => {} },
    registerUpgrade() { return () => {} },
  }
  const services = {
    webServer,
    typertGateway: { async invoke() { return {} }, async stream() { return (async function* () {})() } },
    connection: createTestConnection(),
    agentDefaultModel: { currentSelection() { return null }, async saveSelection() {} },
  }
  let disposer = null
  const target = {
    ...services,
    get(name) { return services[name] },
    on() { return () => {} },
    effect(fn) { disposer = fn(); return () => {} },
  }
  plugin.apply(cordisLikeContext(target, plugin.inject ?? []), {
    gatewayEnabled: true,
    lanEnabled: false,
    mobileV1Enabled: false,
    deviceFile: path.join(tmp, 'devices.json'),
    publicUrlFile: path.join(tmp, 'public-url'),
  })
  return { routes, tmp, dispose: () => { try { disposer?.() } catch {} } }
}

function fakeResponse() {
  const res = { statusCode: 0, headers: {}, body: '', ended: false }
  res.writeHead = code => { res.statusCode = code; return res }
  res.setHeader = () => res
  res.end = chunk => { res.ended = true; if (chunk) res.body += chunk; return res }
  res.write = chunk => { if (chunk) res.body += chunk; return res }
  res.on = () => res
  Object.defineProperty(res, 'writableEnded', { get: () => res.ended })
  return res
}

async function pair(routes, body) {
  const route = routes.get('/mgw')
  assert.ok(route, '/mgw 路由未注册')
  const res = fakeResponse()
  const listeners = {}
  const payload = JSON.stringify(body ?? {})
  const req = {
    url: '/mgw/pair',
    method: 'POST',
    headers: { host: '127.0.0.1:65090', origin: 'http://127.0.0.1:65090', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      (listeners[event] ??= []).push(cb)
      if (event === 'end') setTimeout(() => {
        for (const handler of listeners.data ?? []) handler(Buffer.from(payload))
        for (const handler of listeners.end ?? []) handler()
      }, 0)
      return req
    },
  }
  await route.handler(req, res)
  await new Promise(resolve => setTimeout(resolve, 50))
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') }
}

test('loopback default pairing payload carries a warning the panel can surface', async () => {
  const { routes, dispose } = boot()
  try {
    const { status, body } = await pair(routes, {})
    assert.equal(status, 201)
    assert.match(body.payload.publicUrl, /^ws:\/\/127\.0\.0\.1[:/]/)
    assert.equal(typeof body.warning, 'string', '回环地址必须带 warning，否则手机扫码连不上还不知道原因')
  } finally { dispose() }
})

test('explicit publicUrl is honored and never warns', async () => {
  const { routes, dispose } = boot()
  const { status, body } = await pair(routes, { publicUrl: 'wss://ydgg.dpdns.org/ws/mobile' })
  assert.equal(status, 201)
  assert.equal(body.payload.publicUrl, 'wss://ydgg.dpdns.org/ws/mobile')
  assert.equal('warning' in body, false)
  // 二维码串能被 App 的规则解回同一份 payload。
  const decoded = JSON.parse(Buffer.from(body.qrPayload, 'base64url').toString('utf8'))
  assert.equal(decoded.version, 2)
  assert.equal(decoded.publicUrl, 'wss://ydgg.dpdns.org/ws/mobile')
  dispose()
})

test('pairing record honors the requested device name', async () => {
  const { routes, dispose } = boot()
  try {
    const { status, body } = await pair(routes, { name: '厨房 iPad', publicUrl: 'wss://ydgg.dpdns.org/ws/mobile' })
    assert.equal(status, 201)
    assert.equal(body.pairing.name, '厨房 iPad')
  } finally { dispose() }
})
