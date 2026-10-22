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

export async function startMobileV1({ connection, sessionController = null, webServer, publicUrl = '', resolvePublicUrl = null, home = '', prefix = '/mobile/v1', secretsFile = '', log = () => {} }) {
  if (typeof connection?.createSharedFetchHandler !== 'function') {
    throw new Error('mobile-v1 requires the DSH Connection dispatcher (0.2.1-rc.2 or later).')
  }
  const directory = home && home.trim() ? path.resolve(home.trim()) : path.join(os.homedir(), '.dsh', 'mobile-v1')
  const normalizedPrefix = normalizeMobileV1Prefix(prefix)
  const hostService = createHostTeamService({ sessionController, secretsFile, log })
  const adapter = createAdapter({ connection, sessionController: sessionController ?? {}, hostService })
  await adapter.initialize()
  let server
  try {
    server = await createMobileV1({
      home: directory,
      config: { devAllowInsecure: true, loopbackPort: webServer.port },
      adapter,
      publicUrl,
      resolvePublicUrl,
    })
  } catch (error) {
    await adapter.dispose?.()
    throw error
  }
  // 共存模式：测试前缀内部重写回协议固定前缀，server 逻辑零分支。
  const rewrite = req => {
    if (normalizedPrefix === '/mobile/v1') return
    req.url = '/mobile/v1' + String(req.url ?? '').slice(normalizedPrefix.length)
  }
  const disposeHttp = webServer.register({
    kind: 'prefix',
    path: normalizedPrefix,
    handler: (req, res) => { rewrite(req); server.handleHttp(req, res) },
  })
  const disposeUpgrade = webServer.registerUpgrade({
    path: `${normalizedPrefix}/events`,
    handler: (req, socket, head) => { rewrite(req); server.handleUpgrade(req, socket, head) },
  })
  log(`mobile-v1 registered: ${normalizedPrefix} protocolVersion=1 serverId=${server.serverId} home=${directory}`)
  return {
    ...server,
    home: directory,
    prefix: normalizedPrefix,
    async dispose() {
      try { disposeHttp?.() } catch {}
      try { disposeUpgrade?.() } catch {}
      await server.close()
    },
  }
}
