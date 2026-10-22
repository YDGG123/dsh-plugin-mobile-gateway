import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMobileV1Origin } from '../lib/mobile-v1/public-url.mjs'

// App 侧 validateServerUrl（镜像 packages/mobile-sdk）唯一接受的形态。
const APP_URL = /^(https?):\/\/([A-Za-z0-9.\-\[\]:]+)(\/|\/mobile\/v1\/?)?$/

test('tunnel wss url collapses to the https origin the app requires', () => {
  const value = normalizeMobileV1Origin('wss://recycling-phil-letters-refer.trycloudflare.com/ws/mobile')
  assert.equal(value, 'https://recycling-phil-letters-refer.trycloudflare.com')
  assert.match(value, APP_URL)
})

test('https url with ws or mobile path collapses to origin', () => {
  assert.equal(normalizeMobileV1Origin('https://pair.example.test/ws/mobile'), 'https://pair.example.test')
  assert.equal(normalizeMobileV1Origin('https://pair.example.test/mobile/v1'), 'https://pair.example.test')
  assert.equal(normalizeMobileV1Origin('https://pair.example.test:8443/'), 'https://pair.example.test:8443')
  assert.equal(normalizeMobileV1Origin('https://pair.example.test'), 'https://pair.example.test')
})

test('loopback ws keeps http but drops the path', () => {
  assert.equal(normalizeMobileV1Origin('ws://127.0.0.1:3081/ws/mobile'), 'http://127.0.0.1:3081')
})

test('unusable values normalize to empty so callers can fall back', () => {
  for (const value of ['', '   ', null, undefined, 42, 'not a url', 'ftp://pair.example.test', 'https://user:secret@pair.example.test']) {
    assert.equal(normalizeMobileV1Origin(value), '', `expected empty for ${String(value)}`)
  }
})
