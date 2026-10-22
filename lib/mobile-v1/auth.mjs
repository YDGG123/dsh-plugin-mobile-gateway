import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class BridgeError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const digest = value => createHash('sha256').update(value).digest('hex')
const token = () => randomBytes(32).toString('base64url')
const matches = (value, hash) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(hash ?? '')
  && timingSafeEqual(Buffer.from(digest(value)), Buffer.from(hash))

export async function createAuthStore(home, { now = Date.now, onRevoke = () => {}, issueGatewayDevice = null } = {}) {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const path = join(home, 'bridge.json')
  let data
  try {
    data = JSON.parse(await readFile(path, 'utf8'))
    if (data.version !== 1 || typeof data.serverId !== 'string' || !Array.isArray(data.devices)
      || !data.submissions || !data.uploads || !data.readMarkers) throw new Error('Invalid mobile bridge state')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    data = { version: 1, serverId: randomUUID(), devices: [], submissions: {}, uploads: {}, readMarkers: {} }
  }
  let writes = Promise.resolve()
  function save() {
    const json = JSON.stringify(data)
    const write = async () => {
      const temporary = `${path}.${randomUUID()}.tmp`
      await writeFile(temporary, json, { mode: 0o600 })
      await rename(temporary, path)
    }
    const result = writes.then(write, write)
    writes = result.catch(() => {})
    return result
  }
  await save()
  const codes = new Map()
  const claims = new Map()
  function prunePairings() {
    for (const [id, item] of codes) if (item.expiresAt <= now()) codes.delete(id)
    for (const [id, item] of claims) if (item.expiresAt <= now()) claims.delete(id)
  }
  const publicDevice = device => ({ id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, revokedAt: device.revokedAt ?? null })
  function verifyAccess(value) {
    const device = data.devices.find(item => !item.revokedAt && item.accessExpiresAt > now() && matches(value, item.accessHash))
    if (!device) throw new BridgeError(401, 'UNAUTHORIZED', 'Pair this device again or refresh its session.')
    return device
  }
  async function issueSession(device) {
    const accessToken = token()
    const refreshToken = token()
    Object.assign(device, { accessHash: digest(accessToken), refreshHash: digest(refreshToken), accessExpiresAt: now() + 15 * 60_000, refreshExpiresAt: now() + 30 * 86400_000, lastSeenAt: now() })
    await save()
    return { accessToken, refreshToken, deviceId: device.id, serverId: data.serverId, expiresAt: device.accessExpiresAt }
  }
  return {
    data,
    save,
    verifyAccess,
    devices: () => data.devices.map(publicDevice),
    createPairing(url) {
      prunePairings()
      codes.clear()
      const code = randomBytes(9).toString('base64url')
      const expiresAt = now() + 120_000
      codes.set(digest(code), { expiresAt })
      return { url, code, serverId: data.serverId, expiresAt }
    },
    beginPairing({ code, deviceName }) {
      prunePairings()
      const key = typeof code === 'string' ? digest(code) : ''
      if (!codes.has(key)) throw new BridgeError(400, 'INVALID_PAIRING_CODE', 'The pairing code is invalid or has expired.')
      if (typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 100) throw new BridgeError(400, 'INVALID_DEVICE_NAME', 'Enter a device name of at most 100 characters.')
      if (claims.size >= 20) throw new BridgeError(429, 'PAIRING_LIMIT', 'Too many pending pairing requests.')
      codes.delete(key)
      const claimToken = token()
      const requestId = randomUUID()
      claims.set(requestId, { requestId, claimHash: digest(claimToken), deviceName: deviceName.trim(), status: 'pending', createdAt: now(), expiresAt: now() + 300_000 })
      return { claimToken, requestId, status: 'pending' }
    },
    pending() {
      prunePairings()
      return [...claims.values()].filter(item => item.status === 'pending').map(({ requestId, deviceName, createdAt, expiresAt }) => ({ requestId, deviceName, createdAt, expiresAt }))
    },
    async decidePairing(requestId, approve) {
      prunePairings()
      const claim = claims.get(requestId)
      if (!claim || claim.status !== 'pending') throw new BridgeError(404, 'PAIRING_NOT_FOUND', 'This pairing request is no longer pending.')
      claim.status = approve ? 'approved' : 'denied'
      if (!approve) return { requestId, status: claim.status }
      // U5：批准那一刻顺带签发网关设备凭证，随后随 session 一起下发。
      // 签发失败只记一次空值，不能让 bridge 配对本身失败。
      if (typeof issueGatewayDevice === 'function' && claim.gateway === undefined) {
        try {
          const gateway = await issueGatewayDevice({ requestId, deviceName: claim.deviceName })
          claim.gateway = gateway && typeof gateway.token === 'string' && gateway.token ? gateway : null
        } catch {
          claim.gateway = null
        }
      }
      return { requestId, status: claim.status }
    },
    async completePairing(claimToken) {
      prunePairings()
      const claim = [...claims.values()].find(item => matches(claimToken, item.claimHash))
      if (!claim) throw new BridgeError(404, 'PAIRING_NOT_FOUND', 'The pairing request has expired.')
      if (claim.status === 'pending') return { status: 'pending', requestId: claim.requestId }
      if (claim.status === 'denied') throw new BridgeError(403, 'PAIRING_DENIED', 'The computer declined this device.')
      const withGateway = session => claim.gateway ? { ...session, gateway: claim.gateway } : session
      if (claim.session) return withGateway(claim.session)
      if (claim.issuing) return claim.issuing
      if (data.devices.filter(item => !item.revokedAt).length >= 100) throw new BridgeError(409, 'DEVICE_LIMIT', 'Revoke an unused device before pairing another.')
      const device = { id: randomUUID(), name: claim.deviceName, createdAt: now(), lastSeenAt: now() }
      data.devices.push(device)
      claim.issuing = issueSession(device).then(session => {
        claim.session = session
        claim.expiresAt = now() + 60_000
        return withGateway(session)
      })
      return claim.issuing
    },
    /**
     * U5 对称配对：网关自己的配对流程成功时，也顺手签发一条 mobile-v1 session，
     * 让用户走哪条配对路径都是「一次配对、两套凭证」。
     * 设备按名字去重：同一台手机重复加网关不会被建出两条 mobile-v1 设备。
     */
    async issueSessionForName(name, { serverUrl = '' } = {}) {
      const deviceName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : '手机'
      let device = data.devices.find(item => !item.revokedAt && item.name === deviceName)
      if (!device) {
        if (data.devices.filter(item => !item.revokedAt).length >= 100) throw new BridgeError(409, 'DEVICE_LIMIT', 'Revoke an unused device before pairing another.')
        device = { id: randomUUID(), name: deviceName, createdAt: now(), lastSeenAt: now() }
        data.devices.push(device)
      }
      device.lastSeenAt = now()
      const session = await issueSession(device)
      // 反向路径：把公网 https origin 一并写进 session，App 的旧版本也能直接重建 transport。
      return typeof serverUrl === 'string' && serverUrl ? { ...session, serverUrl } : session
    },
    async refresh(refreshToken) {
      const device = data.devices.find(item => !item.revokedAt && item.refreshExpiresAt > now() && matches(refreshToken, item.refreshHash))
      if (!device) throw new BridgeError(401, 'UNAUTHORIZED', 'This session has expired or was revoked. Pair the device again.')
      return issueSession(device)
    },
    async revoke(id) {
      const device = data.devices.find(item => item.id === id)
      if (!device) throw new BridgeError(404, 'DEVICE_NOT_FOUND', 'The device does not exist.')
      device.revokedAt = now()
      delete device.accessHash
      delete device.refreshHash
      onRevoke(id)
      await save()
      return { id, revoked: true }
    },
    async close() { await writes },
  }
}
