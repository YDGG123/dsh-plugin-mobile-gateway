/**
 * 配对地址归一化。
 *
 * App 侧（镜像 `packages/mobile-sdk` 的 validateServerUrl）只接受
 * `https://host`（或 `https://host/mobile/v1`）这种根 origin，并且强制 HTTPS；
 * 而旧网关/隧道快照给出的是 `wss://host/ws/mobile` 这种 WS 形态。
 * 直接把它塞进配对资料，真机会先撞 `insecure_url` 再撞 `invalid_url`。
 *
 * 因此这里统一把各类来源折成 https 根 origin：
 * - `wss://` → `https://`、`ws://` → `http://`
 * - 丢掉路径/查询/片段（`/ws/mobile`、`/mobile/v1` 都折成 origin）
 * - 带凭据的地址不接受
 * 无法解析或不支持的协议返回空串，由调用方回退。
 */
export function normalizeMobileV1Origin(raw) {
  if (typeof raw !== 'string') return ''
  const value = raw.trim()
  if (!value) return ''
  const upgraded = value.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')
  let parsed
  try {
    parsed = new URL(upgraded)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
  if (parsed.username || parsed.password) return ''
  return parsed.origin
}
