import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createMobileV1Admin } from '../lib/mobile-v1/admin.mjs'

function stubService() {
  const calls = []
  return {
    calls,
    async operator(endpoint, payload) {
      calls.push([endpoint, payload])
      switch (endpoint) {
        case 'status': return { enabled: true, url: 'https://x', serverId: 's-1', pending: [{ requestId: 'r-1', deviceName: 'iPhone' }], devices: [] }
        case 'pairing.create': return { url: 'https://x', code: 'c-1', serverId: 's-1', expiresAt: Date.now() + 120000 }
        case 'pairing.approve': return { requestId: payload.requestId, approved: true }
        case 'pairing.deny': return { requestId: payload.requestId, denied: true }
        case 'device.revoke': return { id: payload.id, revoked: true }
        default: throw new Error('unexpected endpoint')
      }
    },
  }
}

async function boot(service) {
  const handler = createMobileV1Admin({ resolveService: () => service })
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/mgw/mobile-v1`
  return { base, close: () => new Promise(resolve => server.close(resolve)) }
}

test('panel page is served as self-contained HTML with approve controls', async () => {
  const service = stubService()
  const ctx = await boot(service)
  try {
    const response = await fetch(`${ctx.base}/panel`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/html/)
    const html = await response.text()
    assert.ok(html.includes('待批准设备'))
    assert.ok(html.includes('批准'))
    assert.ok(html.includes("'/mgw/mobile-v1' + path"))
    assert.ok(html.includes('setInterval(refresh, 2000)'))
    // 根路径同样返回面板
    assert.equal((await fetch(`${ctx.base}/`)).status, 200)
  } finally { await ctx.close() }
})

test('admin API forwards status, pairing create/approve/deny and device revoke', async () => {
  const service = stubService()
  const ctx = await boot(service)
  try {
    const status = await (await fetch(`${ctx.base}/status`)).json()
    assert.equal(status.pending.length, 1)

    const pairing = await (await fetch(`${ctx.base}/pairing`, { method: 'POST' })).json()
    assert.equal(pairing.code, 'c-1')

    const approve = await (await fetch(`${ctx.base}/pairing/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'r-1' }),
    })).json()
    assert.equal(approve.approved, true)

    const deny = await (await fetch(`${ctx.base}/pairing/deny`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'r-2' }),
    })).json()
    assert.equal(deny.denied, true)

    const revoke = await (await fetch(`${ctx.base}/devices/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'dev-1' }),
    })).json()
    assert.equal(revoke.revoked, true)

    assert.deepEqual(service.calls.map(([endpoint]) => endpoint), [
      'status', 'pairing.create', 'pairing.approve', 'pairing.deny', 'device.revoke',
    ])
  } finally { await ctx.close() }
})

test('non-loopback callers and unready service are refused', async () => {
  // 直接调用 handler 伪造非 loopback 地址。
  const service = stubService()
  const handler = createMobileV1Admin({ resolveService: () => service })
  const responses = []
  const fakeResponse = status => ({
    writeHead(code) { this.statusCode = code },
    end(body) { responses.push({ status: this.statusCode, body }) },
  })
  await handler(
    { method: 'GET', url: '/mgw/mobile-v1/status', socket: { remoteAddress: '10.0.0.9' } },
    fakeResponse()
  )
  assert.equal(responses[0].status, 403)

  const unready = createMobileV1Admin({ resolveService: () => null })
  await unready(
    { method: 'GET', url: '/mgw/mobile-v1/status', socket: { remoteAddress: '127.0.0.1' } },
    fakeResponse()
  )
  assert.equal(responses[1].status, 503)
})
