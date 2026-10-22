# `/mobile/v1`（原 ds-bot-mobile-bridge 协议）集成说明

本插件在原有移动网关协议（`/ws/mobile`，完整会话/工作区投影）之外，**同时**提供
ds-bot-mobile-bridge 的 `/mobile/v1` 协议（团队投影 / 配对 / 动作 / WS 订阅），
两条协议共用一个端口、一套进程与一条公网入口。

移植自 `MuQY1818/ds-bot-mobile-app` 的 `bridge/`（v0.0.6），协议形状与
`dsh-mobile` 设计文档 v1.2 §2 逐字节兼容：移动端 App 的 bridge 客户端无需改动。

## 端点（前缀 `/mobile/v1`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/mobile/v1/info` | 免认证：protocolVersion/serverId/name/capabilities/compatibility |
| POST | `/mobile/v1/pairings` | `{code, deviceName}` → `{claimToken, requestId, status}` |
| POST | `/mobile/v1/pairings/complete` | `{claimToken}` → pending 或 Session |
| POST | `/mobile/v1/auth/refresh` | `{refreshToken}` → 新 Session |
| GET | `/mobile/v1/state` | TeamState（bots/rooms/models/mainBotIds/work…） |
| GET | `/mobile/v1/conversations` | 会话列表（bots+群聊） |
| GET | `/mobile/v1/conversations/{id}/messages?limit&cursor` | 历史分页 |
| GET | `/mobile/v1/conversations/{id}/target` | 会话目标与 revision |
| POST | `/mobile/v1/conversations/{id}/cancel` | 停止生成（能力允许时） |
| POST | `/mobile/v1/submissions` | `{conversationId, sessionId, requestId, text}` 幂等发送 |
| GET | `/mobile/v1/submissions/{requestId}` | 回执恢复 |
| POST | `/mobile/v1/actions` | `{endpoint, payload}` 动作白名单 |
| GET | `/mobile/v1/devices` | 设备列表 + currentDeviceId |
| DELETE | `/mobile/v1/devices/{id}` | 撤销设备 |
| POST | `/mobile/v1/read-markers` | `{conversationId, seq}` 按设备已读 |
| WS | `/mobile/v1/events` | 首帧 `{"type":"auth",token,conversationId,after?}`，事件 reset/delta/message/status/error/ready |

错误信封、限流、WS 关闭码与 bridge 0.0.6 一致（见设计文档 §2.1/§2.7/§2.9）。

## 数据源

团队状态经 `connection.createSharedFetchHandler('/api')` 调用 ds-bot RPC
（`bridge.describe` / `state` / `bridge.submit` / `bridge.redact`），与独立 bridge 插件相同。
数据源封装在 `lib/mobile-v1/adapter.mjs`，未来宿主直读可用时只需替换该文件。

**原版 ds-bot（无桥接补丁）回退**：`lib/mobile-v1/host-service.mjs` 提供等价实现——
`bridge.describe` 为静态契约、`bridge.redact` 复刻 ds-bot secrets 替换器
（密钥唯一来源：`~/.dsh/bot/secrets.json`，可用 `mobileV1SecretsFile` 覆盖，**不要另建密钥库**）、
`bridge.submit` 走 `sessionController.prompt({requestId, sessionId, mode:'queue', content})`
并按 state 做 TARGET_CHANGED/READ_ONLY 校验。adapter 检测到 RPC 缺 `bridge.*`（501）时自动切换。

**共存模式**：`mobileV1Prefix: /mobile-v1-test` 可与独立 bridge 插件并行服务，
逐端点 diff 一致后再切回 `/mobile/v1` 并卸载三件套。

**队列动作**：`queue` / `queue-remove` 在原版与补丁版 ds-bot 均未实现，按裁决**不再宣告**（App 无 queue UI）。

## 配置（插件 config）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mobileV1Enabled` | `true` | 是否启用 `/mobile/v1` |
| `mobileV1Home` | `''` | 设备/回执存储目录，空则用 `~/.dsh/mobile-v1` |
| `mobileV1PublicUrl` | `''` | 配对资料里的公网地址；空则取隧道/`publicUrl` |
| `mobileV1Prefix` | `/mobile/v1` | 挂载前缀；共存测试可设 `/mobile-v1-<name>`（只允许这两类） |
| `mobileV1SecretsFile` | `''` | 脱敏密钥文件；空则 `~/.dsh/bot/secrets.json`（与 ds-bot 同一份） |

## 桌面配对管理（loopback-only）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/mgw/mobile-v1/panel` | **单文件配对面板**（生成配对资料 / 批准 / 拒绝 / 撤销，2s 轮询，零依赖） |
| GET | `/mgw/mobile-v1/status` | 服务状态（含 pending 配对、设备列表） |
| POST | `/mgw/mobile-v1/pairing` | 生成配对资料 `{url, code, serverId, expiresAt}` |
| POST | `/mgw/mobile-v1/pairing/approve` | `{requestId}` 批准 |
| POST | `/mgw/mobile-v1/pairing/deny` | `{requestId}` 拒绝 |
| POST | `/mgw/mobile-v1/devices/revoke` | `{id}` 撤销设备 |

配对码 120 秒有效；claim 300 秒；完整流程见设计文档 §2.8。

面板地址：`http://127.0.0.1:<webPort>/mgw/mobile-v1/panel`（仅本机可访问）。
卸载 companion 后，手机配对流程 = 面板「生成配对资料」→ 复制 JSON → App 粘贴 → 面板「批准」。

## 测试

```bash
node --test test/mobile-v1-projection.test.mjs
node --test test/mobile-v1-server.test.mjs
```

- projection：bots/rooms 投影、parts 隐藏过滤、redaction 生效、describe 缺失时的 fail-closed 降级
- server：`/info` 免认证、配对三态（申请→批准→complete）、`/state` 鉴权、设备列表与撤销、错误码
