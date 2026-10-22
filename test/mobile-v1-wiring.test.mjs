import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import plugin from '../lib/index.mjs'
import { createTestConnection } from './helpers/peer.mjs'
import { cordisLikeContext } from './helpers/cordis-context.mjs'

// 测试日志不得写进宿主运行日志（/tmp/mobile-gateway.log），否则真机排查会被测试栈污染。
process.env.DSH_MOBILE_GATEWAY_LOG = path.join(mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-log-')), 'test.log')

// 与宿主一致的注入面：sessionController 故意不在 inject 里——
// 它是可选依赖，只能经 ctx.get() 取，属性访问必须抛错（cordis 语义）。
function bootCtx({ withSessionController = false } = {}) {
  const routes = []
  const upgrades = []
  const listeners = {}
  let disposer = null
  const webServer = {
    port: 54321,
    register(route) { routes.push(route); return () => {} },
    registerUpgrade(route) { upgrades.push(route); return () => {} },
  }
  const services = {
    webServer,
    typertGateway: { async invoke() { return {} }, async stream() { return (async function* () {})() } },
    connection: createTestConnection(),
    agentDefaultModel: { currentSelection() { return null }, async saveSelection() {} },
  }
  if (withSessionController) {
    services.sessionController = { async prompt() { return { accepted: true } } }
  }
  const target = {
    ...services,
    // cordis 的 reflect.get：免 inject，缺失返回 undefined。
    get(name) { return services[name] },
    on(name, fn) { listeners[name] = fn; return () => {} },
    effect(fn) { disposer = fn() },
  }
  const ctx = cordisLikeContext(target, plugin.inject ?? [])
  return { ctx, routes, upgrades, dispose: () => { try { disposer?.() } catch {} } }
}

const baseConfig = (tmp, overrides = {}) => ({
  gatewayEnabled: false,
  deviceFile: path.join(tmp, 'devices.json'),
  publicUrlFile: path.join(tmp, 'public-url'),
  ...overrides,
})

test('enabling mobile-v1 must not abort plugin apply or drop legacy routes', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-wiring-'))
  const { ctx, routes, upgrades, dispose } = bootCtx()
  try {
    assert.doesNotThrow(() => plugin.apply(ctx, baseConfig(tmp, {
      mobileV1Enabled: true,
      mobileV1Prefix: '/mobile-v1-test',
      mobileV1Home: path.join(tmp, 'home'),
    })))
    const paths = routes.map(route => route.path)
    const upgradePaths = upgrades.map(route => route.path)
    // mobile-v1 区块之后注册的旧协议路由必须仍在位。
    assert.ok(paths.includes('/mgw'), '/mgw 管理路由缺失')
    assert.ok(paths.includes('/mobile-v1-test'), 'mobile-v1 前缀未注册')
    assert.ok(paths.includes('/mgw/mobile-v1'), 'mobile-v1 管理/面板路由未注册（装配块中途抛错）')
    assert.ok(upgradePaths.includes('/ws/mobile'), '旧网关 upgrade 路由缺失（apply 被中断）')
    assert.ok(upgradePaths.includes('/mobile-v1-test/events'), 'mobile-v1 upgrade 未注册')
  } finally { dispose() }
})

test('absent sessionController is optional: mobile-v1 still applies on a cordis context', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-wiring-'))
  const { ctx, routes, upgrades, dispose } = bootCtx()
  try {
    // 真机失败点：ctx.sessionController 抛 `cannot get property "sessionController" without inject`。
    // mobile-v1 必须把 sessionController 当可选依赖（回退到 connection RPC）。
    plugin.apply(ctx, baseConfig(tmp, {
      mobileV1Enabled: true,
      mobileV1Prefix: '/mobile-v1-test',
      mobileV1Home: path.join(tmp, 'home'),
    }))
    assert.ok(routes.some(route => route.path === '/mobile-v1-test'))
    assert.ok(upgrades.some(route => route.path === '/ws/mobile'))
  } finally { dispose() }
})

test('present sessionController is picked up reflectively without being injected', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-wiring-'))
  const { ctx, routes, dispose } = bootCtx({ withSessionController: true })
  try {
    assert.ok(!(plugin.inject ?? []).includes('sessionController'), 'sessionController 不应成为硬依赖')
    plugin.apply(ctx, baseConfig(tmp, {
      mobileV1Enabled: true,
      mobileV1Prefix: '/mobile-v1-test',
      mobileV1Home: path.join(tmp, 'home'),
    }))
    assert.ok(routes.some(route => route.path === '/mobile-v1-test'))
  } finally { dispose() }
})

test('mobile-v1 disabled keeps legacy-only composition', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-wiring-'))
  const { ctx, routes, upgrades, dispose } = bootCtx()
  try {
    plugin.apply(ctx, baseConfig(tmp, { mobileV1Enabled: false, mobileV1Home: path.join(tmp, 'home') }))
    assert.ok(!routes.some(route => route.path.startsWith('/mobile-v1') || route.path.startsWith('/mgw/mobile-v1')))
    assert.ok(upgrades.some(route => route.path === '/ws/mobile'))
  } finally { dispose() }
})

// 静态守卫：任何 ctx.<服务> 属性访问都必须是 inject 声明过的，或走反射口。
// 守的是「本地全绿、宿主一装就挂」那一整类 bug。
test('every ctx service access is injected or read reflectively', () => {
  const source = readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8')
  const inject = new Set(plugin.inject ?? [])
  // cordis 内建、不需要 inject 的上下文方法/字段。
  const builtins = new Set([
    'get', 'set', 'provide', 'accessor', 'mixin', 'on', 'once', 'parallel', 'emit', 'serial', 'bail',
    'waterfall', 'effect', 'fiber', 'runtime', 'inject', 'plugin', 'registry', 'reflect', 'logger', 'root',
  ])
  const offenders = new Set()
  for (const match of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    const name = match[1]
    if (builtins.has(name) || inject.has(name)) continue
    offenders.add(name)
  }
  assert.deepEqual([...offenders], [], `未 inject 的服务被属性访问：${[...offenders].join(', ')}`)
})
