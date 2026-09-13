# dsh-api-gateway

DeepSeek Harness (DSH) 宿主插件：一个**带鉴权、fail-closed 的网关**，把宿主机进程内的
Remote API 暴露给另一台机器上的客户端（典型：`dsh-agent-manager`）。

> v0.3.0 目标：**DSH 0.1.5-rc.2**。插件跑在 DSH 进程内，所有请求进程内派发；对外只暴露
> **鉴权、白名单、传输** 三件事。

## 为什么需要它

DSH 0.1.5 的 `/api` 路由有两道栅栏：Host/Origin 检查 **和** 浏览器会话 cookie
（`browserAuth`）。因此普通 loopback HTTP fetch 根本到不了 `/api`——即使请求来自宿主机自己的
进程。DSH 为此提供了受支持的进程内入口：

- `ctx.connection.createSharedFetchHandler('/api')` —— `/api` 路由背后的 Fetch handler，
  **不含**鉴权栅栏；
- `ctx.typertGateway.wireStream.open(endpoint, payload, signal)` —— 任意 Remote 流，
  包括承载审批/提问转发事件的 Gateway 自有 `$events` 流。

本插件把这两个入口包装成带 API Key 鉴权的 HTTP/WebSocket 对外面。

## 环境要求

- DSH **0.1.5-rc.2**（peer 依赖 `^0.1.5-rc.2`）。
- 宿主组合需提供 `webServer`、`connection`、`typertGateway`（`dsh-web-app` bundle 已包含）。
- 插件发布跨会话 HTTP 服务，必须挂在**宿主组合**，不能放进任何 agent preset。

> 0.1.1-rc.2 的旧 wire 协议（`session.list` 点号端点、`events.mux` 单向下行、`respond`）
> **不受 0.3.x 支持**。

## 安装

```powershell
dsh plugin --profile web add github:litestartup-com/dsh-api-gateway
```

在宿主组合里加一行（见 `examples/cordis.yml`），重启 DSH；profile 配置了
`patchReload: live` 时可热生效、无需重启。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `prefix` | `/api-gw/v1` | 路由前缀 |
| `enabled` | `true` | 主开关（可经 admin 运行时切换） |
| `apiKeys` | `[]` | 静态 API 密钥 |
| `provisionedKey` | — | `POST {prefix}/key` 发放的密钥（持久化在 settings） |
| `allowKeyProvision` | `true` | 允许首次无鉴权自助发放 |
| `adminKey` | — | 设置后启用 admin 端点 |
| `corsOrigin` | `*` | CORS 来源（`'*'`、单个域或数组） |
| `exposeErrors` | `true` | 错误响应是否带内部细节 |
| `proxyWhitelist` | 见下 | unary 端点白名单覆盖 |
| `muxWhitelist` | 见下 | 流端点白名单覆盖 |

## 端点

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| GET | `{prefix}/health` | 无 |
| POST | `{prefix}/key` | 仅首次（自助发放） |
| POST | `{prefix}/admin/enable` | `X-Admin-Key` |
| POST | `{prefix}/admin/rotate-key` | `X-Admin-Key` |
| POST | `{prefix}/proxy/<namespace>/<method>` | `X-API-Key` / Bearer |
| POST | `{prefix}/sessions/{id}/sandbox-mode` | `X-API-Key` / Bearer |
| GET | `{prefix}/events.mux`（WebSocket） | `X-API-Key` / Bearer |
| GET | `{prefix}/proxy/events.mux` | `events.mux` 的别名 |

## Wire 契约

网关不解析 RPC 包络，只把字节转发给宿主，由宿主按生成的 descriptor 校验 `args`。

**Unary** —— 请求与响应沿用宿主包络：

```jsonc
// POST {prefix}/proxy/session/create
{ "type": "client-request", "rpcId": "c1", "method": "session/create",
  "payload": { "args": { "request": { "cwd": "E:/work/demo" } } } }

// -> { "type": "server-response", "rpcId": "c1",
//      "result": { "ok": true, "value": { "sessionId": "session-..." } } }
```

参数名来自宿主 descriptor：`session/create` 是 `request`，`session/list` 是 `_request`，
`session/modelCatalog` 无参数（`{ "args": {} }`）。

**Mux** —— 单条 WebSocket 复用多个逻辑流：

```jsonc
// 客户端 -> 宿主
{ "type": "open", "streamId": "s1", "endpoint": "session/follow", "payload": { "args": { "request": { "address": { "kind": "session", "sessionId": "session-..." } } } } }
{ "type": "cancel", "streamId": "s1" }

// 宿主 -> 客户端
{ "type": "item",  "streamId": "s1", "value": ... }
{ "type": "error", "streamId": "s1", "error": { "code": "...", "message": "...", "details": {} } }
{ "type": "end",   "streamId": "s1" }
```

服务端每 2s 发 ping，连续 2 次未收到 pong 即断开。

**审批与提问** 在 `$events` 流上到达（以 `{ "args": {} }` 打开）；首帧是
`{ "type": "ready", "clientId": "...", "host": { "home": "..." } }`，随后是
`emit` / `waterfall` / `cancel` 帧。回答案经 unary 代理：

```jsonc
// POST {prefix}/proxy/$events/result
{ "type": "client-request", "rpcId": "a1", "method": "$events/result",
  "payload": { "args": { "clientId": "...", "eventId": "...", "outcome": { "kind": "result", "value": ... } } } }
```

`outcome.kind` 为 `result`（给出答案）、`next`（交给下一个 answerer）或 `rejected`。
无人应答的审批会 fail-closed 为 `unavailable`。

## 白名单（默认）

Unary（`proxyWhitelist`）：

```
session/list, session/create, session/page,
session/prompt, session/cancel, session/rename,
session/fork, session/updateQueue, session/attachment,
session/modelCatalog, session/selectModel,
$events/result
```

流（`muxWhitelist`）：

```
$events, session/follow, session/control
```

白名单外一律在触达宿主前拒绝：unary 返回 `403 method_not_allowed`，流返回 `error` 帧
（`gateway/endpoint-not-allowed`）。特权面——`credentials/*`、`settings/*`、`workspace/*`、
`agentPresets/*`、`goals/*`、`subagents/*`、`llm/discoverModels`、`session/search`——默认不可达。

`sessions/{id}/sandbox-mode`：请求体 `{ "mode": "read-only" | "workspace-write" }`，给**活会话**
写入 `sandbox/mode` 覆盖（冷醒 replay 后仍生效）。冷/未知会话返回 `409 session_not_live`；
`danger-full-access` 不可经 wire 授予。

## 安全模型

- 鉴权不可退化：常量时间比较、CSPRNG 密钥、一次性自助发放（首次签发后永久关闭，密钥仅在内存
  时也一样）、轮换真正吊销旧钥。
- 白名单 fail-closed，且在**鉴权之后**检查，未认证调用者无法探测端点是否存在。
- 网关不解析、不改写 RPC 包络；wire 契约与错误形状的唯一所有者始终是宿主。
- 密钥绝不写日志；`apiKeys` / `adminKey` / `provisionedKey` 带 `role('secret')`，settings 面自动脱敏。

## 部署步骤

1. 构建并测试：`pnpm build && pnpm test`（`lib/` 需同步提交，部署加载的就是它）。
2. 更新宿主安装：`dsh plugin update`（或 profile 下 `pnpm install`）。
3. 重启 DSH（用 patch 行挂载且 `patchReload: live` 时无需重启）。
4. 跑下面的验收。

## 验收

网关挂载后（挂载方式见 `scripts/acceptance.mjs` 头部注释）：

```powershell
$env:DSH_AGW_KEY = 'acceptance-key'
node scripts/acceptance.mjs            # 只读检查
$env:DSH_AGW_MUTATE = '1'              # 可选：真实创建一个会话、
node scripts/acceptance.mjs            # 设置其沙箱模式并重命名
```

环境变量：`DSH_AGW_BASE`（默认 `http://127.0.0.1:3080`）、`DSH_AGW_PREFIX`
（默认 `/api-gw/v1`）、`DSH_AGW_KEY`（必填）、`DSH_AGW_MUTATE` / `DSH_AGW_CWD`（可选写路径检查）。

## 卸载

删除组合里的插件行（可选 `dsh plugin remove dsh-api-gateway`），重启。

## 文档范围

本仓库只保留使用者需要的内容：README、`openapi.yaml`、示例与测试。
内部设计与重构计划不在本仓库——代码、接口契约与示例即完整的可运行、可自托管交付物。

## License

MIT
