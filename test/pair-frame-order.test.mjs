import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import plugin from '../lib/index.mjs'
import { createTestConnection } from './helpers/peer.mjs'

const TEAM_STATE = { revision: 1, readOnly: null, models: [], defaultModel: null, mainBotIds: [], bots: [], rooms: [], exchangeTurns: {} }
function connectionWithDispatcher() {
  return {
    ...createTestConnection(),
    createSharedFetchHandler() {
      return {
        async fetch(request) {
          const body = JSON.parse(await request.text())
          const value = body.endpoint === 'state'
            ? TEAM_STATE
            : body.endpoint === 'bridge.describe'
              ? { version: 1, stableRequestId: true, redactedText: true }
              : {}
          return new Response(JSON.stringify({ ok: true, value }), { status: 200, headers: { 'content-type': 'application/json' } })
        },
      }
    },
    createPeer() {
      const abort = new AbortController()
      return { id: 'test-peer', ctx: {}, principal: { kind: 'owner' }, interactions: 'none', signal: abort.signal, async dispose() { abort.abort() } }
    },
  }
}
import { cordisLikeContext } from './helpers/cordis-context.mjs'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

process.env.DSH_MOBILE_GATEWAY_LOG = path.join(mkdtempSync(path.join(os.tmpdir(), 'pair-frame-log-')), 'test.log')

// 真网关配对：走 WS 配对子协议，录制帧序。
// 回归点：App 的判据是「配对中收到 hello = 没拿到长期凭据」，
// 所以 paired 必须早于 hello —— 早前 hello 抢跑导致真机报「配对未返回长期凭据」。
async function boot() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pair-frame-'))
  const httpRoutes = new Map()
  const upgradeRoutes = new Map()
  const webServer = {
    port: 0,
    register(route) { httpRoutes.set(route.path, route); return () => {} },
    registerUpgrade(route) { upgradeRoutes.set(route.path, route); return () => {} },
  }
  const services = {
    webServer,
    typertGateway: { async invoke() { return {} }, async stream() { return (async function* () {})() } },
    connection: connectionWithDispatcher(),
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
    // 打开 mobile-v1：paired 帧要走「等签发 → 发 paired → 再发 hello」这条异步路径
    mobileV1Enabled: true,
    mobileV1Prefix: '/mobile-v1-test',
    mobileV1Home: path.join(tmp, 'home'),
    mobileV1PublicUrl: 'https://ydgg.dpdns.org',
    deviceFile: path.join(tmp, 'devices.json'),
    publicUrlFile: path.join(tmp, 'public-url'),
  })
  const server = http.createServer((req, res) => {
    const mgw = httpRoutes.get('/mgw')
    if (mgw) { mgw.handler(req, res); return }
    res.writeHead(404); res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    const route = upgradeRoutes.get('/ws/mobile')
    if (!route) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return }
    route.handler(req, socket, head, { port: server.address().port })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    ws: `ws://127.0.0.1:${server.address().port}/ws/mobile`,
    close: async () => {
      await new Promise(resolve => server.close(resolve))
      try { disposer?.() } catch {}
    },
  }
}

async function pairingCode(base) {
  const response = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'frame-order-phone', publicUrl: 'wss://ydgg.dpdns.org/ws/mobile' }),
  })
  assert.equal(response.status, 201)
  return (await response.json()).payload.pairingCode
}

test('paired frame is sent before hello (App treats early hello as "no credential")', async () => {
  const ctx = await boot()
  try {
    const code = await pairingCode(ctx.base)
    const kinds = []
    const paired = await new Promise((resolve, reject) => {
      const socket = new WebSocket(ctx.ws, [`dsh-pair.${code}`, 'dsh-mobile-v1'], {
        headers: { 'X-DSH-Device-ID': 'frame-order-0001', 'X-DSH-Device-Name': 'frame-order-phone' },
      })
      const timer = setTimeout(() => reject(new Error(`timeout, saw ${kinds.join('>')}`)), 8000)
      socket.on('message', data => {
        const frame = JSON.parse(data.toString())
        kinds.push(frame.kind)
        if (frame.kind === 'hello') {
          clearTimeout(timer)
          socket.close()
          resolve({ kinds: [...kinds] })
          return
        }
        if (kinds.length > 6) { clearTimeout(timer); reject(new Error(`no hello, saw ${kinds.join('>')}`)) }
      })
      socket.on('error', reject)
    })
    // 关键断言：hello 出现时，paired 必须已经在它前面
    const pairedIndex = paired.kinds.indexOf('paired')
    const helloIndex = paired.kinds.indexOf('hello')
    assert.ok(pairedIndex >= 0, `paired 缺失：${paired.kinds.join('>')}`)
    assert.ok(helloIndex > pairedIndex, `paired 必须早于 hello，实际：${paired.kinds.join('>')}`)
  } finally {
    await ctx.close()
  }
})

test('paired frame still carries the bridge session (symmetric pairing)', async () => {
  const ctx = await boot()
  try {
    const code = await pairingCode(ctx.base)
    const pairedFrame = await new Promise((resolve, reject) => {
      const socket = new WebSocket(ctx.ws, [`dsh-pair.${code}`, 'dsh-mobile-v1'], {
        headers: { 'X-DSH-Device-ID': 'frame-order-0002', 'X-DSH-Device-Name': 'frame-order-phone' },
      })
      const timer = setTimeout(() => reject(new Error('timeout waiting for paired')), 8000)
      socket.on('message', data => {
        const frame = JSON.parse(data.toString())
        if (frame.kind === 'paired') { clearTimeout(timer); socket.close(); resolve(frame) }
      })
      socket.on('error', reject)
    })
    assert.equal(typeof pairedFrame.token, 'string')
    assert.ok(pairedFrame.bridgeSession, 'paired 帧必须带 bridgeSession')
    assert.equal(pairedFrame.bridgeSession.serverUrl, 'https://ydgg.dpdns.org')
  } finally {
    await ctx.close()
  }
})
