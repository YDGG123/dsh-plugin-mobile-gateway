import { MOBILE_V1_PANEL_HTML } from './panel.mjs'

/**
 * loopback-only 管理面：/mgw/mobile-v1/*
 * - GET  /panel            单文件 HTML（生成配对资料 / 批准 / 拒绝 / 撤销设备，2s 轮询）
 * - GET  /status           operator('status')
 * - POST /pairing          operator('pairing.create')
 * - POST /pairing/approve  { requestId }
 * - POST /pairing/deny     { requestId }
 * - POST /devices/revoke   { id }
 * 零依赖、可单测（不依赖宿主 webServer）。
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress
  return typeof address === 'string' && LOOPBACK.has(address)
}

export function createMobileV1Admin({ resolveService, adminLoopbackOnly = true, isLoopback = isLoopbackRequest }) {
  return async function handle(req, res) {
    try {
      if (adminLoopbackOnly && !isLoopback(req)) {
        sendJson(res, 403, { error: 'forbidden', message: 'mobile-v1 admin is loopback-only' })
        return
      }
      const url = new URL(req.url || '/', 'http://x')
      const action = url.pathname.slice('/mgw/mobile-v1'.length) || '/panel'
      if (req.method === 'GET' && (action === '/panel' || action === '/')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(MOBILE_V1_PANEL_HTML)
        return
      }
      const service = resolveService ? resolveService() : null
      if (!service) {
        sendJson(res, 503, { error: 'starting', message: 'mobile-v1 is not ready yet' })
        return
      }
      if (req.method === 'GET' && action === '/status') {
        sendJson(res, 200, await service.operator('status'))
        return
      }
      if (req.method === 'POST' && action === '/pairing') {
        sendJson(res, 200, await service.operator('pairing.create'))
        return
      }
      if (req.method === 'POST' && (action === '/pairing/approve' || action === '/pairing/deny')) {
        const body = await readJsonBody(req)
        sendJson(res, 200, await service.operator(action === '/pairing/approve' ? 'pairing.approve' : 'pairing.deny', body))
        return
      }
      if (req.method === 'POST' && action === '/devices/revoke') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await service.operator('device.revoke', body))
        return
      }
      sendJson(res, 404, { error: 'not-found' })
    } catch (error) {
      const status = Number.isInteger(error && error.status) ? error.status : 400
      sendJson(res, status, { error: { code: (error && error.code) || 'INVALID_REQUEST', message: error && error.message ? error.message : String(error) } })
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 64 * 1024) { reject(Object.assign(new Error('Body too large'), { status: 413 })); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
      } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(body)
}
