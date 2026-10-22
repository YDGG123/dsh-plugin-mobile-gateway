import os from 'node:os'
import path from 'node:path'
import { createAdapter } from './adapter.mjs'
import { createMobileV1 } from './server.mjs'
import { createHostTeamService } from './host-service.mjs'

/**
 * 把 `/mobile/v1`（原 ds-bot-mobile-bridge 协议）挂到本插件的 webServer 上。
 * 协议与 dsh-mobile Docs/bot-team-port-design.md v1.2 §2 保持逐字节兼容：
 * 路由表、错误码、鉴权与 WS 事件形状都来自 bridge 0.0.6 源码的移植。
 *
 * 数据源抽象：团队状态目前经 ds-bot RPC（bridge.describe/submit/redact）取得，
 * 与 bridge 插件一致；未来若宿主直读可用，只替换 adapter.mjs 一处。
 */
export function normalizeMobileV1Prefix(value) {
  let prefix = String(value ?? '/mobile/v1').trim()
  if (!prefix) prefix = '/mobile/v1'
  if (!prefix.startsWith('/')) prefix = `/${prefix}`
  if (prefix.length > 1 && prefix.endsWith('/')) prefix = prefix.slice(0, -1)
  // 共存模式：正式前缀，或 /mobile-v1-* 的测试前缀（避免误挂到其它路由空间）。
  if (prefix !== '/mobile/v1' && !/^\/mobile-v1-[A-Za-z0-9._-]+$/.test(prefix)) {
    throw new Error('mobileV1Prefix must be /mobile/v1 or /mobile-v1-<name> for coexistence testing.')
  }
  return prefix
}

async function startMobileV1Core({ connection, sessionController = null, publicUrl = '', resolvePublicUrl = null, home = '', loopbackPort = 0, secretsFile = '', log = () => {} }) {
  if (typeof connection?.createSharedFetchHandler !== 'function') {
    throw new Error('mobile-v1 requires the DSH Connection dispatcher (0.2.1-rc.2 or later).')
  }
  const directory = home && home.trim() ? path.resolve(home.trim()) : path.join(os.homedir(), '.dsh', 'mobile-v1')
  const hostService = createHostTeamService({ sessionController, secretsFile, log })
  const adapter = createAdapter({ connection, sessionController: sessionController ?? {}, hostService })
  log('mobile-v1: initializing adapter (DS Bot RPC)')
  await withTimeout(adapter.initialize(), 20_000, 'adapter.initialize timed out')
  log('mobile-v1: adapter ready')
  let server
  try {
    log(`mobile-v1: creating server home=${directory}`)
    server = await createMobileV1({
      home: directory,
      config: { devAllowInsecure: true, loopbackPort },
      adapter,
      publicUrl,
      resolvePublicUrl,
    })
  } catch (error) {
    await adapter.dispose?.()
    throw error
  }
  log(`mobile-v1 ready: serverId=${server.serverId} home=${directory}`)
  return { ...server, home: directory }
}

/**
 * 同步注册、延迟就绪：宿主 webServer 的路由表在 apply 阶段建立，
 * 异步注册会被丢弃（真机实测 /info 404 的根因）。因此路由必须同步挂上，
 * 服务初始化在后台完成，未就绪期间返回 503。
 */
export function startMobileV1({ connection, sessionController = null, webServer, publicUrl = '', resolvePublicUrl = null, home = '', prefix = '/mobile/v1', secretsFile = '', log = () => {} }) {
  const normalizedPrefix = normalizeMobileV1Prefix(prefix)
  const rewrite = req => {
    if (normalizedPrefix === '/mobile/v1') return
    req.url = '/mobile/v1' + String(req.url ?? '').slice(normalizedPrefix.length)
  }
  let inner = null
  let failure = null
  const ready = startMobileV1Core({
    connection, sessionController, publicUrl, resolvePublicUrl, home, loopbackPort: webServer.port, secretsFile, log,
  }).then(handle => {
    inner = handle
    log(`mobile-v1 ready: serverId=${handle.serverId}`)
    return handle
  }).catch(error => {
    failure = error
    log(`mobile-v1 startup failed: ${error && error.stack ? error.stack : String(error)}`)
    throw error
  })
  ready.catch(() => {})
  const unavailable = res => {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ error: { code: failure ? 'CONNECTION_UNAVAILABLE' : 'STARTING', message: failure ? String(failure.message) : 'mobile-v1 is starting' } }))
  }
  const disposeHttp = webServer.register({
    kind: 'prefix',
    path: normalizedPrefix,
    handler: (req, res) => {
      if (!inner) { unavailable(res); return }
      rewrite(req)
      inner.handleHttp(req, res)
    },
  })
  const disposeUpgrade = webServer.registerUpgrade({
    path: `${normalizedPrefix}/events`,
    handler: (req, socket, head) => {
      if (!inner) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      rewrite(req)
      inner.handleUpgrade(req, socket, head)
    },
  })
  log(`mobile-v1 routes registered synchronously: ${normalizedPrefix}`)
  return {
    prefix: normalizedPrefix,
    ready,
    async dispose() {
      try { disposeHttp?.() } catch {}
      try { disposeUpgrade?.() } catch {}
      try { await ready } catch {}
      await inner?.close()
    },
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}
