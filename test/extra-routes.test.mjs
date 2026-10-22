import test from 'node:test'
import assert from 'node:assert/strict'
import { createExtraRouteTable } from '../lib/extra-routes.mjs'

const fakeRequest = url => ({ url, headers: {}, method: 'GET', socket: { remoteAddress: '127.0.0.1' } })
const fakeResponse = () => {
  const res = { statusCode: 0, body: '', ended: false }
  res.writeHead = code => { res.statusCode = code; return res }
  res.setHeader = () => res
  res.end = chunk => { res.ended = true; if (chunk) res.body += chunk; return res }
  res.write = chunk => { if (chunk) res.body += chunk; return res }
  return res
}

test('prefix routes are served and unmatched paths fall through', () => {
  const table = createExtraRouteTable()
  const seen = []
  table.register({ kind: 'prefix', path: '/mobile/v1', handler: (req, res) => { seen.push(req.url); res.end('ok') } })
  for (const url of ['/mobile/v1/info', '/mobile/v1', '/mobile/v1/state?x=1']) {
    const res = fakeResponse()
    assert.equal(table.handleHttp(fakeRequest(url), res), true, url)
    assert.equal(res.body, 'ok')
  }
  const res = fakeResponse()
  assert.equal(table.handleHttp(fakeRequest('/mobile/v1x/info'), res), false, '前缀不能跨段误匹配')
  assert.equal(table.handleHttp(fakeRequest('/mgw/status'), res), false)
  assert.deepEqual(seen.length, 3)
})

test('longest prefix wins, mirroring the host web server', () => {
  const table = createExtraRouteTable()
  const hits = []
  table.register({ path: '/mobile/v1', handler: () => hits.push('short') })
  table.register({ path: '/mobile/v1/admin', handler: () => hits.push('long') })
  table.handleHttp(fakeRequest('/mobile/v1/admin/status'), fakeResponse())
  table.handleHttp(fakeRequest('/mobile/v1/info'), fakeResponse())
  assert.deepEqual(hits, ['long', 'short'])
})

test('upgrade routes match by exact path and fall through otherwise', () => {
  const table = createExtraRouteTable()
  const hits = []
  table.registerUpgrade({ path: '/mobile/v1/events', handler: (req) => hits.push(req.url) })
  assert.equal(table.handleUpgrade(fakeRequest('/mobile/v1/events'), { end() {} }, null), true)
  assert.deepEqual(hits, ['/mobile/v1/events'])
  assert.equal(table.handleUpgrade(fakeRequest('/ws/mobile'), { end() {} }, null), false)
  assert.equal(table.handleUpgrade(fakeRequest('/mobile/v1/events/x'), { end() {} }, null), false)
})

test('disposers detach routes so a reload cannot double-register', () => {
  const table = createExtraRouteTable()
  const dispose = table.register({ path: '/mobile-v1-test', handler: () => {} })
  assert.equal(table.handleHttp(fakeRequest('/mobile-v1-test/info'), fakeResponse()), true)
  dispose()
  assert.equal(table.handleHttp(fakeRequest('/mobile-v1-test/info'), fakeResponse()), false)
})
