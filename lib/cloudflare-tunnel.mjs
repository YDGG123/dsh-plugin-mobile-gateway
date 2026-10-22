import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { ensureCloudflared } from './cloudflared-binary.mjs'
import { checkPublicEndpoint } from './public-endpoint-check.mjs'

function hostnameOf(value) {
  if (typeof value !== 'string') throw new TypeError('Cloudflare hostname is required')
  const hostname = value.trim().toLowerCase()
  if (hostname.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) ||
      !hostname.includes('.') || hostname.includes('..') ||
      hostname.split('.').some((label) => label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    throw new TypeError('Cloudflare hostname must be a domain name, for example gateway.example.com')
  }
  return hostname
}

function tokenOf(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /\s/.test(value)) {
    throw new TypeError('Cloudflare Tunnel Token must be a nonempty token without whitespace')
  }
  return value
}

function readState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (value?.version !== 1 || typeof value.enabled !== 'boolean' ||
        typeof value.hostname !== 'string' || typeof value.token !== 'string') {
      throw new TypeError('invalid Cloudflare Tunnel settings')
    }
    if (value.hostname) hostnameOf(value.hostname)
    if (value.token) tokenOf(value.token)
    value.mode ??= 'named'
    if (!['named', 'quick'].includes(value.mode)) throw new TypeError('invalid Cloudflare Tunnel mode')
    if (value.enabled && value.mode === 'named' && (!value.hostname || !value.token)) {
      throw new TypeError('enabled named tunnel has no hostname or token')
    }
    fs.chmodSync(file, 0o600)
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, enabled: false, mode: 'quick', hostname: '', token: '' }
    throw new Error(`failed to load Cloudflare Tunnel settings ${file}: ${error.message}`, { cause: error })
  }
}

function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
    fs.chmodSync(file, 0o600)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

// A separate loopback listener exposes only the mobile WebSocket. In particular,
// Cloudflare can never reach the DSH WebUI or the /mgw management API through it.
export function createCloudflareTunnel({ file, port = 3082, wsPath, executable = 'cloudflared',
  supported = true, isGatewayEnabled, onUpgrade, onHttp = null, onExtraUpgrade = null,
  // 即便不跑插件自管的 cloudflared，也保持 cloudflarePort 回环入口。
  // 外部命名隧道（如 launchd 常驻的 cloudflared）就指向这个固定端口，宿主重启也不变。
  serveLoopback = false,
  log = () => {}, spawnProcess = spawn,
  // quick 隧道刚上线时公网 DNS 可能还没生效：这类可重试失败要自动复检，
  // 否则一次抖动就把面板的 publicReady 挂在红色上不动（真机踩过）。
  healthRetryDelays = [15_000, 30_000, 60_000],
  prepareExecutable = ensureCloudflared, probeEndpoint = checkPublicEndpoint }) {
  let settings = supported ? readState(file) : { version: 1, enabled: false, mode: 'quick', hostname: '', token: '' }
  let server = null
  let child = null
  let preparing = null
  let retryTimer = null
  let disposed = false
  let phase = 'disabled'
  let error = null
  let quickUrl = null
  let queue = Promise.resolve()
  const sockets = new Set()
  let endpointHealth = { state: 'unchecked', message: '尚未检测公网 DNS、TLS 和 WebSocket 路由。' }
  let healthGeneration = 0
  let healthPending = null
  let healthRetryTimer = null
  let healthRetryTries = 0
  const RETRYABLE_HEALTH = new Set(['dns-error', 'network-error', 'route-error'])
  const clearHealthRetry = () => {
    if (healthRetryTimer) clearTimeout(healthRetryTimer)
    healthRetryTimer = null
    healthRetryTries = 0
  }
  const scheduleHealthRetry = () => {
    if (disposed || healthRetryTimer) return
    const delay = healthRetryDelays[healthRetryTries]
    if (delay == null) return
    healthRetryTries += 1
    healthRetryTimer = setTimeout(() => {
      healthRetryTimer = null
      if (!disposed && phase === 'online') void checkEndpoint()
    }, delay)
    healthRetryTimer.unref?.()
  }
  const checkEndpoint = () => {
    const endpoint = publicUrl()
    if (!shouldRun() || !endpoint || phase !== 'online') return Promise.resolve(snapshot())
    if (healthPending) return healthPending
    const generation = healthGeneration
    endpointHealth = { state: 'checking', message: '正在检测公网 DNS、TLS 和 WebSocket 路由…' }
    const pending = Promise.resolve().then(() => probeEndpoint(endpoint)).catch(() => ({ state: 'network-error', message: '公网检测失败，请稍后重试。', checkedAt: new Date().toISOString() })).then((health) => {
      if (generation === healthGeneration) {
        endpointHealth = health
        if (health.state === 'reachable') {
          healthRetryTries = 0
        } else if (RETRYABLE_HEALTH.has(health.state)) {
          scheduleHealthRetry()
        }
      }
      return snapshot()
    }).finally(() => { if (healthPending === pending) healthPending = null })
    healthPending = pending
    return pending
  }

  const shouldRun = () => supported && !disposed && settings.enabled && isGatewayEnabled()
  const shouldServe = () => supported && !disposed && isGatewayEnabled() && (settings.enabled || serveLoopback)
  const publicUrl = () => settings.mode === 'quick'
    ? quickUrl
    : settings.hostname ? `wss://${settings.hostname}${wsPath}` : null
  const snapshot = () => ({
    supported,
    enabled: settings.enabled,
    mode: settings.mode,
    configured: !!(settings.hostname && settings.token),
    hostname: settings.hostname || null,
    publicUrl: settings.enabled ? publicUrl() : null,
    port,
    state: !settings.enabled ? 'disabled' : !isGatewayEnabled() ? 'waiting-for-gateway' : phase,
    error,
    endpointHealth,
    loopbackListening: server != null,
    publicReady: phase === 'online' && shouldRun() && endpointHealth.state === 'reachable',
  })

  /**
   * 结束插件自己 spawn 的 cloudflared。
   * 只发 SIGTERM 不够：真机出现过「配置已 disabled、进程仍在、父进程还是宿主」的泄漏，
   * 所以等 5 秒不退出就升级 SIGKILL，并把升级写进日志。
   */
  const terminateChild = (proc) => new Promise((resolve) => {
    if (!proc || proc.exitCode != null || proc.signalCode != null) { resolve(false); return }
    let settled = false
    let timer
    const finish = escalated => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(escalated)
    }
    proc.once?.('exit', () => finish(false))
    try { proc.kill('SIGTERM') } catch {}
    timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      log(`cloudflared did not exit after SIGTERM; escalated to SIGKILL (pid=${proc.pid ?? 'unknown'})`)
      finish(true)
    }, 5_000)
    timer.unref?.()
  })

  const stop = async () => {
    healthGeneration += 1
    healthPending = null
    clearHealthRetry()
    endpointHealth = { state: 'unchecked', message: '尚未检测公网 DNS、TLS 和 WebSocket 路由。' }
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    const previous = child
    child = null
    await terminateChild(previous)
    quickUrl = null
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    const listener = server
    server = null
    phase = 'disabled'
    error = null
    if (listener) await new Promise((resolve) => listener.close(resolve))
  }

  const startChild = () => {
    if (!shouldRun() || !server || child || preparing) return
    phase = 'preparing'
    error = null
    preparing = prepareExecutable({ cacheDir: path.join(path.dirname(file), 'cloudflared-bin'), executable })
      .then((binary) => {
        preparing = null
        if (!shouldRun() || !server || child) return
        phase = 'connecting'
        const quick = settings.mode === 'quick'
        const args = quick
          ? ['tunnel', '--no-autoupdate', '--loglevel', 'info', '--url', `http://127.0.0.1:${port}`]
          : ['tunnel', '--no-autoupdate', '--loglevel', 'info', 'run']
        const childEnv = { ...process.env }
        delete childEnv.TUNNEL_TOKEN
        if (!quick) childEnv.TUNNEL_TOKEN = settings.token
        const running = spawnProcess(binary, args, {
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        child = running
        let diagnostics = ''
        let outputTail = ''
        let registered = false
        const onOutput = (chunk) => {
          if (child !== running) return
          const lines = chunk.toString().slice(0, 4096)
          outputTail = (outputTail + lines).slice(-4096)
          if (quick) {
            const match = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/i.exec(outputTail)
            if (match) {
              const next = `wss://${match[1].toLowerCase()}.trycloudflare.com${wsPath}`
              if (next !== quickUrl) {
                quickUrl = next
                // 同一进程内换域名：旧域名（可能已被 Cloudflare 回收）的检测结论必须作废。
                if (phase === 'online') {
                  healthGeneration += 1
                  endpointHealth = { state: 'unchecked', message: '公网域名已更换，正在重新检测。' }
                  clearHealthRetry()
                  void checkEndpoint()
                }
              }
            }
          }
          if (/Registered tunnel connection/i.test(outputTail)) {
            registered = true
            outputTail = ''
          } else if (/ERR|error/i.test(lines)) {
            diagnostics = (settings.token ? outputTail.replaceAll(settings.token, '[redacted]') : outputTail)
              .replace(/eyJ[A-Za-z0-9._=-]+/g, '[redacted]').trim().slice(-500)
          }
          if (registered && (!quick || quickUrl)) {
            const firstOnline = phase !== 'online'
            phase = 'online'
            error = null
            if (firstOnline) void checkEndpoint()
          }
        }
        running.stderr?.on('data', onOutput)
        running.stdout?.on('data', onOutput)
        const exited = (reason) => {
          if (child !== running) return
          child = null
          healthGeneration += 1
          healthPending = null
          clearHealthRetry()
          endpointHealth = { state: 'unchecked', message: '隧道已断开，需重新检测公网入口。' }
          quickUrl = null
          phase = 'error'
          error = reason || diagnostics || 'cloudflared exited unexpectedly'
          log(`Cloudflare Tunnel stopped: ${error}`)
          if (shouldRun()) retryTimer = setTimeout(() => { retryTimer = null; startChild() }, 10_000)
        }
        running.once('error', (cause) => exited(cause.code === 'ENOENT'
          ? 'cloudflared is not installed or is not on PATH'
          : `cloudflared failed: ${cause.message}`))
        running.once('exit', (code, signal) => exited(diagnostics || `cloudflared exited (${signal || code})`))
      })
      .catch((cause) => {
        preparing = null
        if (!shouldRun()) return
        phase = 'error'
        error = `Cloudflare binary preparation failed: ${cause.message}`
        log(error)
        retryTimer = setTimeout(() => { retryTimer = null; startChild() }, 30_000)
      })
  }

  const start = async () => {
    if (server || !shouldServe()) return
    const managed = settings.enabled
    if (managed) phase = 'starting'
    error = null
    const listener = http.createServer((req, res) => {
      // 手机经隧道访问的 mobile-v1 HTTP 端点（/info、/state…）由这里分发。
      if (onHttp && onHttp(req, res) === true) return
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      res.end('Not found')
    })
    listener.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    listener.on('upgrade', (req, socket, head) => {
      let pathname
      try { pathname = new URL(req.url || '/', 'http://localhost').pathname } catch { pathname = '' }
      if (pathname !== wsPath) {
        // mobile-v1 的 WS（<prefix>/events）同样要能过隧道。
        if (onExtraUpgrade && onExtraUpgrade(req, socket, head) === true) return
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        return
      }
      onUpgrade(req, socket, head, { lan: true, port })
    })
    try {
      await new Promise((resolve, reject) => {
        listener.once('error', reject)
        listener.listen(port, '127.0.0.1', () => {
          listener.off('error', reject)
          resolve()
        })
      })
      if (!shouldServe()) {
        listener.close()
        return
      }
      server = listener
      listener.on('error', (cause) => {
        const message = `Cloudflare origin listener failed: ${cause.message}`
        void stop().then(() => {
          if (!shouldRun()) return
          phase = 'error'
          error = message
          log(message)
          retryTimer = setTimeout(() => { retryTimer = null; void reconcile() }, 10_000)
        })
      })
      // 仅回环入口模式：外部隧道自己连这里，插件不启 cloudflared。
      if (managed) startChild()
    } catch (cause) {
      try { listener.close() } catch { /* The listener never opened. */ }
      if (shouldRun()) {
        phase = 'error'
        error = `Cloudflare origin listener failed: ${cause.message}`
        log(error)
        retryTimer = setTimeout(() => { retryTimer = null; void reconcile() }, 10_000)
      }
    }
  }

  const reconcile = () => {
    queue = queue.catch(() => {}).then(async () => {
      if (shouldServe()) await start()
      else await stop()
    })
    return queue
  }

  const configure = async ({ enabled, mode, hostname, token }) => {
    if (!supported) throw new TypeError('Cloudflare Tunnel is available on PC only')
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    const next = {
      version: 1,
      enabled,
      mode: mode === undefined ? settings.mode : mode,
      hostname: hostname === undefined ? settings.hostname : hostnameOf(hostname),
      token: token === undefined || token === '' ? settings.token : tokenOf(token),
    }
    if (!['named', 'quick'].includes(next.mode)) throw new TypeError('mode must be named or quick')
    if (enabled && next.mode === 'named' && (!next.hostname || !next.token)) {
      throw new TypeError('hostname and Tunnel Token are required')
    }
    const changed = next.mode !== settings.mode || next.hostname !== settings.hostname || next.token !== settings.token
    writeState(file, next)
    settings = next
    if (changed) await stop()
    await reconcile()
    return snapshot()
  }

  const restart = () => {
    queue = queue.catch(() => {}).then(async () => {
      if (!shouldRun()) {
        const cause = new Error('请先开启移动网关和 Cloudflare Tunnel')
        cause.status = 409
        throw cause
      }
      await stop()
      await start()
      return snapshot()
    })
    return queue
  }

  const dispose = () => { disposed = true; clearHealthRetry(); void stop() }
  return { snapshot, configure, reconcile, restart, checkEndpoint, dispose }
}
