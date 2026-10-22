import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import WebSocket from 'ws'
import { createCloudflareTunnel } from '../lib/cloudflare-tunnel.mjs'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cloudflare-test-'))
const file = path.join(temp, 'cloudflare.json')
const token = 'eyJ.test-token'
const children = []
const spawnProcess = (command, args, options) => {
  const child = new EventEmitter()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => { child.killed = true; child.emit('exit', 0, 'SIGTERM') }
  children.push({ command, args, options, child })
  queueMicrotask(() => {
    if (args.includes('--url')) child.stderr.write(`https://quick-${children.length}.trycloudflare.com\n`)
    child.stderr.write('Registered tunnel connection')
  })
  return child
}
const probe = net.createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = probe.address().port
probe.close()
await once(probe, 'close')

let gatewayEnabled = true
let acceptedUpgrades = 0
const create = () => createCloudflareTunnel({
  file, port, wsPath: '/ws/mobile', supported: true, spawnProcess,
  prepareExecutable: async () => '/fake/cloudflared',
  probeEndpoint: async () => ({ state: 'reachable', message: 'mock route verified' }),
  isGatewayEnabled: () => gatewayEnabled,
  onUpgrade: (_req, socket, _head, transport) => {
    acceptedUpgrades += 1
    assert.equal(transport.lan, true)
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
  },
})
const tunnel = create()
assert.equal(tunnel.snapshot().state, 'disabled')
await assert.rejects(tunnel.configure({ enabled: true, hostname: 'bad/url', token }), /hostname/)
await assert.rejects(tunnel.configure({ enabled: true, mode: 'named', hostname: 'gateway.example.com' }), /Token/)
const active = await tunnel.configure({ enabled: true, mode: 'named', hostname: 'gateway.example.com', token })
assert.equal(active.publicUrl, 'wss://gateway.example.com/ws/mobile')
assert.equal(active.configured, true)
await new Promise((resolve) => setImmediate(resolve))
assert.equal(tunnel.snapshot().state, 'online')
assert.equal(children.length, 1)
assert.deepEqual(children[0].args, ['tunnel', '--no-autoupdate', '--loglevel', 'info', 'run'])
assert.equal(children[0].options.env.TUNNEL_TOKEN, token)
assert.equal(children[0].args.join(' ').includes(token), false)
assert.equal(fs.statSync(file).mode & 0o777, 0o600)
assert.equal(JSON.stringify(tunnel.snapshot()).includes(token), false)

const base = `http://127.0.0.1:${port}`
assert.equal((await fetch(`${base}/mgw/status`)).status, 404)
assert.equal((await fetch(`${base}/`)).status, 404)
const wrong = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/wrong`)
  ws.once('unexpected-response', (_request, response) => resolve(response.statusCode))
  ws.on('error', () => {})
})
assert.equal(wrong, 404)
const denied = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/mobile`)
  ws.once('unexpected-response', (_request, response) => resolve(response.statusCode))
  ws.on('error', () => {})
})
assert.equal(denied, 401)
assert.equal(acceptedUpgrades, 1)

gatewayEnabled = false
await tunnel.reconcile()
assert.equal(children[0].child.killed, true)
assert.equal(tunnel.snapshot().state, 'waiting-for-gateway')
gatewayEnabled = true
await tunnel.reconcile()
assert.equal(children.length, 2)
await tunnel.configure({ enabled: false })
assert.equal(children[1].child.killed, true)
assert.equal(tunnel.snapshot().state, 'disabled')
await tunnel.configure({ enabled: true, mode: 'quick' })
await new Promise((resolve) => setImmediate(resolve))
assert.equal(children.length, 3)
assert.equal(tunnel.snapshot().publicUrl, 'wss://quick-3.trycloudflare.com/ws/mobile')
assert.equal(children[2].args.includes('--url'), true)
assert.equal(children[2].options.env.TUNNEL_TOKEN, undefined)
await tunnel.configure({ enabled: true, mode: 'quick' })
assert.equal(children.length, 3)
await tunnel.restart()
await new Promise((resolve) => setImmediate(resolve))
assert.equal(children[2].child.killed, true)
assert.equal(children.length, 4)
assert.equal(tunnel.snapshot().publicUrl, 'wss://quick-4.trycloudflare.com/ws/mobile')
tunnel.dispose()

const restored = create()
assert.equal(restored.snapshot().enabled, true)
await restored.reconcile()
await new Promise((resolve) => setImmediate(resolve))
assert.equal(children.length, 5)
assert.equal(restored.snapshot().mode, 'quick')
assert.equal(restored.snapshot().publicUrl, 'wss://quick-5.trycloudflare.com/ws/mobile')
await restored.configure({ enabled: false })
await assert.rejects(restored.restart(), /请先开启/)
restored.dispose()

// ---- mobile-v1 必须也能经隧道回环监听器访问（否则公网 404）----
{
  const freePort = async () => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const value = probe.address().port
    probe.close()
    await once(probe, 'close')
    return value
  }
  const rawUpgrade = (port, target) => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let buffer = ''
    socket.on('connect', () => socket.write(
      'GET ' + target + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
      'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'))
    socket.on('data', chunk => { buffer += chunk.toString('utf8') })
    socket.on('end', () => resolve(buffer))
    socket.on('close', () => resolve(buffer))
    socket.on('error', reject)
  })
  const v1File = path.join(temp, 'cloudflare-mobile-v1.json')
  const v1Port = await freePort()
  const v1 = createCloudflareTunnel({
    file: v1File, port: v1Port, wsPath: '/ws/mobile', supported: true, spawnProcess,
    prepareExecutable: async () => '/fake/cloudflared',
    probeEndpoint: async () => ({ state: 'reachable', message: 'mock route verified' }),
    isGatewayEnabled: () => true,
    onUpgrade: (_req, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'),
    onHttp: (req, res) => {
      if (!req.url.startsWith('/mobile/v1')) return false
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"protocolVersion":1}')
      return true
    },
    onExtraUpgrade: (req, socket) => {
      if (req.url !== '/mobile/v1/events') return false
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return true
    },
  })
  await v1.configure({ enabled: true, mode: 'named', hostname: 'gateway.example.com', token })
  await new Promise((resolve) => setImmediate(resolve))
  const info = await fetch('http://127.0.0.1:' + v1Port + '/mobile/v1/info')
  assert.equal(info.status, 200)
  assert.equal((await info.json()).protocolVersion, 1)
  // 其它路径仍然是 404，不得借机把 WebUI/管理面暴露出去
  assert.equal((await fetch('http://127.0.0.1:' + v1Port + '/mgw/status')).status, 404)
  assert.equal((await fetch('http://127.0.0.1:' + v1Port + '/')).status, 404)
  // WS：旧协议路径仍走网关，mobile-v1 的 /events 也要能到我们自己的处理器
  assert.match(await rawUpgrade(v1Port, '/mobile/v1/events'), /401 Unauthorized/)
  assert.match(await rawUpgrade(v1Port, '/ws/mobile'), /401 Unauthorized/)
  assert.match(await rawUpgrade(v1Port, '/zzz'), /404 Not Found/)
  await v1.dispose()
}

fs.rmSync(temp, { recursive: true, force: true })
console.log('CLOUDFLARE TUNNEL TESTS PASSED')
