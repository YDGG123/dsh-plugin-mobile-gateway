import os from 'node:os'
import path from 'node:path'
import { createAdapter } from './adapter.mjs'
import { createMobileV1 } from './server.mjs'

/**
 * 把 `/mobile/v1`（原 ds-bot-mobile-bridge 协议）挂到本插件的 webServer 上。
 * 协议与 dsh-mobile Docs/bot-team-port-design.md v1.2 §2 保持逐字节兼容：
 * 路由表、错误码、鉴权与 WS 事件形状都来自 bridge 0.0.6 源码的移植。
 *
 * 数据源抽象：团队状态目前经 ds-bot RPC（bridge.describe/submit/redact）取得，
 * 与 bridge 插件一致；未来若宿主直读可用，只替换 adapter.mjs 一处。
 */
export async function startMobileV1({ connection, webServer, publicUrl = '', resolvePublicUrl = null, home = '', log = () => {} }) {
  if (typeof connection?.createSharedFetchHandler !== 'function') {
    throw new Error('mobile-v1 requires the DSH Connection dispatcher (0.2.1-rc.2 or later).')
  }
  const directory = home && home.trim() ? path.resolve(home.trim()) : path.join(os.homedir(), '.dsh', 'mobile-v1')
  const adapter = createAdapter({ connection })
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
  const disposeHttp = webServer.register({
    kind: 'prefix',
    path: '/mobile/v1',
    handler: (req, res) => server.handleHttp(req, res),
  })
  const disposeUpgrade = webServer.registerUpgrade({
    path: '/mobile/v1/events',
    handler: (req, socket, head) => server.handleUpgrade(req, socket, head),
  })
  log(`mobile-v1 registered: /mobile/v1 protocolVersion=1 serverId=${server.serverId} home=${directory}`)
  return {
    ...server,
    home: directory,
    async dispose() {
      try { disposeHttp?.() } catch {}
      try { disposeUpgrade?.() } catch {}
      await server.close()
    },
  }
}
