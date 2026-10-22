/**
 * LAN / 公网（隧道）监听器的附加路由表。
 *
 * 宿主 webServer 只在 loopback 上；手机实际走的是网关自己的两个对外监听器：
 * - LAN 监听器（`lanPort`，伺候 `/ws/mobile`）
 * - 隧道回环监听器（`cloudflarePort`，cloudflared 的后端）
 * 这两者原本只放行旧协议的 WS 路径，`/mobile/v1` 因此公网 404。
 *
 * 这里提供一张活表：插件在 apply 早期就注册（此时两个监听器还没创建），
 * 监听器在请求期查表分发。前缀语义与宿主 webServer 对齐（longest-prefix-wins），
 * upgrade 按精确路径匹配。
 */
const pathnameOf = request => {
  try {
    return new URL(request.url || '/', 'http://mount.invalid').pathname
  } catch {
    return ''
  }
}

const detach = (list, route) => () => {
  const index = list.indexOf(route)
  if (index >= 0) list.splice(index, 1)
}

export function createExtraRouteTable() {
  const httpRoutes = []
  const upgradeRoutes = []
  return {
    /** 与 webServer.register 同形：{ kind, path, handler }。 */
    register(route) {
      httpRoutes.push(route)
      return detach(httpRoutes, route)
    },
    /** 与 webServer.registerUpgrade 同形：{ path, handler(req, socket, head) }。 */
    registerUpgrade(route) {
      upgradeRoutes.push(route)
      return detach(upgradeRoutes, route)
    },
    /** 返回 true 表示已处理（调用方不要再兜 404）。 */
    handleHttp(request, response) {
      const pathname = pathnameOf(request)
      if (!pathname) return false
      let best = null
      for (const route of httpRoutes) {
        const prefix = String(route.path ?? '')
        if (!prefix) continue
        const matched = pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
        if (!matched) continue
        if (!best || prefix.length > String(best.path).length) best = route
      }
      if (!best) return false
      best.handler(request, response)
      return true
    },
    /** 返回 true 表示已处理。 */
    handleUpgrade(request, socket, head) {
      const pathname = pathnameOf(request)
      if (!pathname) return false
      const route = upgradeRoutes.find(item => String(item.path) === pathname)
      if (!route) return false
      route.handler(request, socket, head)
      return true
    },
  }
}
