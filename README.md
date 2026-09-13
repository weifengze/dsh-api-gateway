# dsh-api-gateway

DeepSeek Harness (DSH) host plugin: an **authenticated, fail-closed gateway**
that exposes the harness's in-process Remote API to clients on other machines
(typically `dsh-agent-manager`).

> v0.3.0 target: **DSH 0.1.5-rc.2**. The plugin runs inside the DSH process and
> dispatches everything in-process; it only ever exposes **authentication,
> whitelists, and transport** to the outside.

## Why it exists

DSH 0.1.5's `/api` route is fenced twice: a Host/Origin check **and** a
browser-session cookie (`browserAuth`). A plain loopback HTTP fetch therefore
cannot reach `/api` — not even from the host's own process. DSH exposes
supported in-process seams instead:

- `ctx.connection.createSharedFetchHandler('/api')` — the Fetch handler behind
  the `/api` route **without** its auth fence;
- `ctx.typertGateway.wireStream.open(endpoint, payload, signal)` — any Remote
  stream, including the Gateway-owned `$events` stream that carries forwarded
  approvals and user questions.

This plugin wraps those seams in an API-key-authenticated HTTP/WebSocket
surface for remote clients.

## Requirements

- DSH **0.1.5-rc.2** (`^0.1.5-rc.2` peer dependencies).
- The host composition must provide `webServer`, `connection`, and
  `typertGateway` (the `dsh-web-app` bundle does).
- The gateway publishes a cross-session HTTP surface, so it belongs in the
  **host composition** — never inside an agent preset.

> The 0.1.1-rc.2 wire protocol (dot endpoints like `session.list`, the
> `events.mux` downlink pipe, `respond`) is **not** supported by 0.3.x.

## Install

```powershell
dsh plugin --profile web add github:litestartup-com/dsh-api-gateway
```

Add one row to the host composition (see `examples/cordis.yml`) and restart.
Profiles with `patchReload: live` hot-apply the row without a restart.

## Configuration

| Field | Default | Description |
| --- | --- | --- |
| `prefix` | `/api-gw/v1` | Route prefix |
| `enabled` | `true` | Master switch (runtime-toggleable through admin) |
| `apiKeys` | `[]` | Static API keys |
| `provisionedKey` | — | Key minted by `POST {prefix}/key`, persisted via settings |
| `allowKeyProvision` | `true` | Allow the first unauthenticated self-service mint |
| `adminKey` | — | Enables the admin endpoints when set |
| `corsOrigin` | `*` | CORS origin (`'*'`, one origin, or a list) |
| `exposeErrors` | `true` | Include internal error details in responses |
| `proxyWhitelist` | see below | Unary endpoint whitelist override |
| `muxWhitelist` | see below | Stream endpoint whitelist override |

## Endpoints

| Method | Path | Auth |
| --- | --- | --- |
| GET | `{prefix}/health` | none |
| POST | `{prefix}/key` | first call only (self-service mint) |
| POST | `{prefix}/admin/enable` | `X-Admin-Key` |
| POST | `{prefix}/admin/rotate-key` | `X-Admin-Key` |
| POST | `{prefix}/proxy/<namespace>/<method>` | `X-API-Key` / Bearer |
| POST | `{prefix}/sessions/{id}/sandbox-mode` | `X-API-Key` / Bearer |
| GET | `{prefix}/events.mux` (WebSocket) | `X-API-Key` / Bearer |
| GET | `{prefix}/proxy/events.mux` | alias of `events.mux` |

## Wire contract

The gateway does not parse RPC bodies; it forwards bytes to the host, which
validates `args` against its generated descriptors.

**Unary** — request and response keep the host envelope:

```jsonc
// POST {prefix}/proxy/session/create
{ "type": "client-request", "rpcId": "c1", "method": "session/create",
  "payload": { "args": { "request": { "cwd": "E:/work/demo" } } } }

// -> { "type": "server-response", "rpcId": "c1",
//      "result": { "ok": true, "value": { "sessionId": "session-..." } } }
```

Argument names come from the host descriptor: `session/create` takes
`request`, `session/list` takes `_request`, `session/modelCatalog` takes no
arguments (`{ "args": {} }`).

**Mux** — one WebSocket multiplexes logical streams:

```jsonc
// client -> host
{ "type": "open", "streamId": "s1", "endpoint": "session/follow", "payload": { "args": { "request": { "address": { "kind": "session", "sessionId": "session-..." } } } } }
{ "type": "cancel", "streamId": "s1" }

// host -> client
{ "type": "item",  "streamId": "s1", "value": ... }
{ "type": "error", "streamId": "s1", "error": { "code": "...", "message": "...", "details": {} } }
{ "type": "end",   "streamId": "s1" }
```

The server pings every 2s and terminates a socket after 2 missed pongs.

**Approvals and questions** arrive on the `$events` stream (open it with
payload `{ "args": {} }`); the first frame is
`{ "type": "ready", "clientId": "...", "host": { "home": "..." } }`, followed by
`emit` / `waterfall` / `cancel` frames. Answer a `waterfall` frame through the
unary proxy:

```jsonc
// POST {prefix}/proxy/$events/result
{ "type": "client-request", "rpcId": "a1", "method": "$events/result",
  "payload": { "args": { "clientId": "...", "eventId": "...", "outcome": { "kind": "result", "value": ... } } } }
```

`outcome.kind` is `result` (answer), `next` (delegate to the next answerer), or
`rejected`. An unanswered approval fails closed as `unavailable`.

## Whitelists (defaults)

Unary (`proxyWhitelist`):

```
session/list, session/create, session/page,
session/prompt, session/cancel, session/rename,
session/fork, session/updateQueue, session/attachment,
session/modelCatalog, session/selectModel,
$events/result
```

Streams (`muxWhitelist`):

```
$events, session/follow, session/control
```

Anything else is refused before the host is touched: unary endpoints answer
`403 method_not_allowed`, stream endpoints produce an `error` frame
(`gateway/endpoint-not-allowed`). The privileged plane — `credentials/*`,
`settings/*`, `workspace/*`, `agentPresets/*`, `goals/*`, `subagents/*`,
`llm/discoverModels`, `session/search` — stays unreachable by default.

`sessions/{id}/sandbox-mode`: body `{ "mode": "read-only" | "workspace-write" }`
pins a `sandbox/mode` override on a **live** session (durable across cold wake).
Cold or unknown sessions answer `409 session_not_live`; `danger-full-access`
cannot be granted over the wire.

## Security model

- Authentication cannot degrade: constant-time comparison, CSPRNG keys, a
  one-time self-service bootstrap that closes permanently after the first mint
  (including while the key is memory-only), and rotation that really revokes.
- Whitelists are fail-closed and checked **after** authentication, so an
  unauthenticated caller cannot probe which endpoints exist.
- The gateway never parses or rewrites the RPC envelope; the host remains the
  single owner of the wire contract and its error shapes.
- Keys are never logged; `apiKeys` / `adminKey` / `provisionedKey` carry
  `role('secret')` so the settings surface redacts them.

## Deployment

1. Build and test: `pnpm build && pnpm test` (`lib/` is committed and must stay
   in sync — the deployment loads it).
2. Install/update the host copy: `dsh plugin update` (or `pnpm install` in the
   profile).
3. Restart DSH (or rely on `patchReload: live` for a patch-row mount).
4. Run the acceptance below.

## Acceptance

With the gateway mounted (see `scripts/acceptance.mjs` for the header docs):

```powershell
$env:DSH_AGW_KEY = 'acceptance-key'
node scripts/acceptance.mjs            # read-only checks
$env:DSH_AGW_MUTATE = '1'              # optional: creates a real session,
node scripts/acceptance.mjs            # pins its sandbox mode, renames it
```

Environment: `DSH_AGW_BASE` (default `http://127.0.0.1:3080`),
`DSH_AGW_PREFIX` (default `/api-gw/v1`), `DSH_AGW_KEY` (required),
`DSH_AGW_MUTATE` / `DSH_AGW_CWD` (optional write-path checks).

## Uninstall

Remove the plugin row from the composition (optionally
`dsh plugin remove dsh-api-gateway`) and restart.

## Documentation scope

This repository keeps only what a user needs: README, `openapi.yaml`, examples,
and tests. Internal design and refactor plans live elsewhere; the code, the
interface contract, and the examples are the complete runnable, self-hostable
delivery.

## License

MIT
