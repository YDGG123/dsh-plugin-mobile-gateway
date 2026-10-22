import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import plugin from '../lib/index.mjs'
import { createTestConnection } from './helpers/peer.mjs'

function bootCtx() {
  const routes = []
  const upgrades = []
  const listeners = {}
  let disposer = null
  const webServer = {
    port: 54321,
    register(route) { routes.push(route); return () => {} },
    registerUpgrade(route) { upgrades.push(route); return () => {} },
  }
  const ctx = {
    get(name) { return name === 'webServer' ? webServer : undefined },
    on(name, fn) { listeners[name] = fn; return () => {} },
    effect(fn) { disposer = fn() },
    connection: createTestConnection(),
    webServer,
    typertGateway: { async invoke() { return {} }, async stream() { return (async function* () {})() } },
    agentDefaultModel: { currentSelection() { return null }, async saveSelection() {} },
  }
  return { ctx, routes, upgrades, dispose: () => { try { disposer?.() } catch {} } }
}

test('enabling mobile-v1 must not abort plugin apply or drop legacy routes', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-wiring-'))
  const { ctx, routes, upgrades, dispose } = bootCtx()
  try {
    assert.doesNotThrow(() => plugin.apply(ctx, {
      gatewayEnabled: false,
      mobileV1Enabled: true,
      mobileV1Prefix: '/mobile-v1-test',
      mobileV1Home: path.join(tmp, 'home'),
      deviceFile: path.join(tmp, 'devices.json'),
      publicUrlFile: path.join(tmp, 'public-url'),
    }))
    const paths = routes.map(route => route.path)
    const upgradePaths = upgrades.map(route => route.path)
    // mobile-v1 区块之后注册的旧协议路由必须仍在位。
    assert.ok(paths.includes('/mgw'), '/mgw 管理路由缺失')
    assert.ok(paths.includes('/mobile-v1-test'), 'mobile-v1 前缀未注册')
    assert.ok(upgradePaths.includes('/ws/mobile'), '旧网关 upgrade 路由缺失（apply 被中断）')
    assert.ok(upgradePaths.includes('/mobile-v1-test/events'), 'mobile-v1 upgrade 未注册')
  } finally { dispose() }
})

test('mobile-v1 disabled keeps legacy-only composition', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-wiring-'))
  const { ctx, routes, upgrades, dispose } = bootCtx()
  try {
    plugin.apply(ctx, {
      gatewayEnabled: false,
      mobileV1Enabled: false,
      mobileV1Home: path.join(tmp, 'home'),
      deviceFile: path.join(tmp, 'devices.json'),
      publicUrlFile: path.join(tmp, 'public-url'),
    })
    assert.ok(!routes.some(route => route.path.startsWith('/mobile-v1') || route.path.startsWith('/mgw/mobile-v1')))
    assert.ok(upgrades.some(route => route.path === '/ws/mobile'))
  } finally { dispose() }
})
