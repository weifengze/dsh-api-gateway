/**
 * dsh-api-gateway — Host half (0.3: in-process Remote gateway for DSH 0.1.5).
 *
 * The plugin publishes an authenticated, fail-closed HTTP/WebSocket surface to
 * remote clients (typically dsh-agent-manager) and dispatches every request
 * INSIDE the host process:
 *
 *   POST {prefix}/proxy/<namespace>/<method>  -> host shared /api fetch handler
 *   GET  {prefix}/events.mux                  -> WS mux: open/cancel streams,
 *                                                item/error/end frames
 *   POST {prefix}/sessions/{id}/sandbox-mode  -> in-process sandbox override
 *
 * Why in-process dispatch: DSH 0.1.5 gates its `/api` route with Host/Origin
 * checks AND a browser-session cookie (`browserAuth`), so a loopback HTTP fetch
 * is not a viable upstream — even from the host's own process. The host
 * connection service exposes `createSharedFetchHandler('/api')`, whose Fetch
 * handler composes exact routes plus the Typert interceptor WITHOUT the HTTP
 * route's auth fence; that is the supported in-process entry. Streams go
 * through `ctx.typertGateway.wireStream.open(endpoint, payload, signal)`,
 * including the Gateway-owned `$events` stream that carries forwarded
 * approvals and user questions.
 *
 * Every proxied unary endpoint must be on the whitelist and every mux stream
 * endpoint must be on the mux whitelist — anything else is refused before the
 * host is touched. The proxy never parses the RPC envelope's contents: it
 * forwards bytes and lets the host validate `args` against its descriptors.
 *
 * Install: pnpm add dsh-api-gateway, then add one row to the host composition
 * (see README / examples/cordis.yml). Uninstall: remove the row and restart.
 *
 * Composition plane: this plugin publishes a cross-session HTTP surface, so it
 * belongs in the HOST composition — never inside an agent preset.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import { WebSocket, WebSocketServer } from 'ws'
import type { HostConnection, HostSettings, HostTypertGateway, SettingsNamespaceScope } from './dsh.js'
import { provisionDecision, resolveCorsOrigin, routeSegments } from './http.js'
import { MuxSession } from './mux.js'
import {
  DEFAULT_MUX_WHITELIST,
  DEFAULT_PROXY_WHITELIST,
  dispatchUrl,
  endpointOf,
  isProxyEndpointAllowed,
} from './proxy.js'
import { isRemoteSandboxMode, REMOTE_SANDBOX_MODES } from './sandbox-mode.js'

/** Single source of truth for the version advertised by the service index. */
const VERSION: string = (() => {
  try { return String((createRequire(import.meta.url)('../package.json') as { version?: unknown }).version ?? '0.0.0') }
  catch { return '0.0.0' }
})()

export interface Config {
  /** Route prefix. Defaults to /api-gw/v1. */
  prefix: string
  /** Master switch; also toggleable at runtime through the admin endpoint. */
  enabled: boolean
  /** Static API keys accepted by the gateway (in addition to the provisioned key). */
  apiKeys: string[]
  /**
   * The key minted by POST {prefix}/key, persisted through the settings scope.
   *
   * Written by the gateway, not by hand -- apiKeys is the field to edit. It is
   * stored rather than kept in memory so that the bootstrap is one-time *ever*:
   * the key a client was given keeps working across restarts, and the
   * unauthenticated mint closes permanently instead of reopening on each boot.
   */
  provisionedKey?: string
  /** Allow the one-time POST {prefix}/key bootstrap when no key exists at all. */
  allowKeyProvision: boolean
  /** Admin key for {prefix}/admin/*; unset disables the admin surface. */
  adminKey?: string
  /** CORS origin(s); default '*' (open). Set an explicit origin list for public deployments. */
  corsOrigin: string | string[]
  /** Include internal error messages in HTTP responses (helpful locally, noisy publicly). */
  exposeErrors: boolean
  /** Unary endpoint whitelist; defaults to DEFAULT_PROXY_WHITELIST. */
  proxyWhitelist: string[]
  /** Mux stream endpoint whitelist; defaults to DEFAULT_MUX_WHITELIST. */
  muxWhitelist: string[]
}

export const Config = z.object({
  prefix: z.string().default('/api-gw/v1'),
  enabled: z.boolean().default(true),
  // role('secret') on the ARRAY, not on its items: the settings redaction
  // only honours the top-level field role, so the old item-level role left
  // static keys readable in settings.describe.
  apiKeys: z.array(z.string()).role('secret').default([]),
  provisionedKey: z.string().role('secret'),
  allowKeyProvision: z.boolean().default(true),
  adminKey: z.string().role('secret'),
  corsOrigin: z.union([z.string(), z.array(z.string())]).default('*'),
  exposeErrors: z.boolean().default(true),
  proxyWhitelist: z.array(z.string()).default([...DEFAULT_PROXY_WHITELIST]),
  muxWhitelist: z.array(z.string()).default([...DEFAULT_MUX_WHITELIST]),
})

/** Settings namespace; must match the host's lowercase-hyphen namespace rule. */
const SETTINGS_NAMESPACE = 'dsh-api-gw'

export default {
  inject: ['webServer'],
  Config,
  apply(ctx: Context, config: Config) {
    const webServer = ctx.webServer

    // Mutable runtime config: seeded from the composition row, then re-applied
    // live from the settings namespace (settings integration) below.
    let cfg = config
    let settingsScope: SettingsNamespaceScope<Config> | null = null
    /**
     * Fallback home for a minted key when there is no settings provider to
     * persist it in. A deployment without one cannot make the key durable, so it
     * keeps the old in-memory behaviour and says so in the log; while it is
     * live, `provisionDecision` still refuses a second mint.
     */
    let volatileKey: string | null = null

    // ---- primitives ----

    const randomToken = (prefix: string, length: number) => {
      const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
      let s = prefix
      const pool = randomBytes(length * 2)
      let cursor = 0
      while (s.length < prefix.length + length && cursor < pool.length) {
        const byte = pool[cursor++]
        // 252 = 7 * 36: rejecting >= 252 avoids modulo bias.
        if (byte < 252) s += alphabet[byte % 36]
      }
      while (s.length < prefix.length + length) s += alphabet[randomBytes(1)[0] % 36]
      return s
    }

    /** Constant-time string comparison (timing-attack resistant). */
    const safeEqual = (a: string, b: string) => {
      const ab = Buffer.from(a, 'utf8')
      const bb = Buffer.from(b, 'utf8')
      if (ab.length !== bb.length) return false
      return timingSafeEqual(ab, bb)
    }

    const errorDetail = (error: unknown) => {
      const message = String((error as Error)?.message ?? error)
      return cfg.exposeErrors ? message : 'internal error (set exposeErrors: true for details)'
    }

    /** Host service lookup that never throws when the service is absent. */
    const hostService = <T>(name: string): T | undefined => {
      try { return ctx.get(name, true) as T | undefined } catch { return undefined }
    }

    /**
     * Access-Control-Allow-Origin carries a single value, so an allow-list is
     * matched against the request Origin and echoed (with Vary: Origin); a
     * disallowed requester gets no header at all.
     */
    const setCors = (res: ServerResponse, req?: IncomingMessage) => {
      const requestOrigin = typeof req?.headers?.origin === 'string' ? req.headers.origin : undefined
      const { origin, vary } = resolveCorsOrigin(cfg.corsOrigin, requestOrigin)
      if (origin !== null) res.setHeader('Access-Control-Allow-Origin', origin)
      if (vary) res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-api-key, x-admin-key')
      res.setHeader('Access-Control-Max-Age', '600')
    }

    const sendJson = (res: ServerResponse, status: number, obj: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    }

    /**
     * Buffered body read with a fixed cap and timeout, so a stalled client
     * cannot pin the gateway. The body is NOT parsed: the host validates it.
     */
    const BODY_TIMEOUT_MS = 30_000
    const readBodyRaw = (req: IncomingMessage): Promise<Buffer> => new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('body read timeout'))
        try { req.destroy() } catch { /* noop */ }
      }, BODY_TIMEOUT_MS)
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1_000_000) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error('body too large'))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(Buffer.concat(chunks))
      })
      req.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
    })

    // ---- auth ----

    const bearerToken = (req: IncomingMessage) => {
      const header = req.headers['authorization']
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
      return header.slice(7).trim()
    }

    /** Every key the deployment currently honours, from all three sources. */
    const acceptedKeys = () => {
      const keys = cfg.apiKeys.filter((key) => key !== '')
      if (cfg.provisionedKey !== undefined && cfg.provisionedKey !== '') keys.push(cfg.provisionedKey)
      if (volatileKey !== null) keys.push(volatileKey)
      return keys
    }

    const keyAccepted = (candidate: string | null) => {
      if (candidate === null || candidate === '') return false
      // Every candidate is compared against every key rather than short-circuiting
      // on the first match, so the work does not depend on which key was supplied.
      let matched = false
      for (const key of acceptedKeys()) if (safeEqual(candidate, key)) matched = true
      return matched
    }

    const authorized = (req: IncomingMessage) => {
      const xKey = req.headers['x-api-key']
      return keyAccepted(bearerToken(req)) || keyAccepted(typeof xKey === 'string' ? xKey : null)
    }

    const isAdmin = (req: IncomingMessage) => {
      if (cfg.adminKey === undefined || cfg.adminKey === '') return false
      const supplied = req.headers['x-admin-key']
      return typeof supplied === 'string' && safeEqual(supplied, cfg.adminKey)
    }

    const requireAuth = (req: IncomingMessage, res: ServerResponse) => {
      if (authorized(req)) return true
      sendJson(res, 401, { error: 'unauthorized', hint: 'Provide X-API-Key (or Authorization: Bearer <key>). POST ' + cfg.prefix + '/key provisions a key (first call only).' })
      return false
    }

    // ---- in-process dispatch ----

    /** Generous: unary calls answer quickly, but a cold resume must not 504. */
    const DISPATCH_TIMEOUT_MS = 60_000

    /**
     * Forward one already-authenticated, already-whitelisted unary call into
     * the host's shared /api fetch handler. The response envelope (status,
     * content-type, body) is returned to the client verbatim, so the host
     * stays the single owner of the wire contract and its error shapes.
     */
    const proxyUnary = async (req: IncomingMessage, res: ServerResponse, endpoint: string) => {
      const connection = hostService<HostConnection>('connection')
      if (connection === undefined) throw new Error('host connection service is unavailable')
      const body = await readBodyRaw(req)
      const handler = connection.createSharedFetchHandler('/api')
      const response = await handler.fetch(new Request(dispatchUrl(endpoint), {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        ...(body.length === 0 ? {} : { body: new Uint8Array(body) }),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      }))
      const payload = Buffer.from(await response.arrayBuffer())
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
      })
      res.end(payload)
    }

    /**
     * Upstream liveness for /health: one cheap, bounded session/list probe
     * through the same in-process path real traffic uses.
     */
    const healthUpstream = async (): Promise<'ok' | 'unreachable'> => {
      try {
        const connection = hostService<HostConnection>('connection')
        if (connection === undefined) return 'unreachable'
        const handler = connection.createSharedFetchHandler('/api')
        const res = await handler.fetch(new Request(dispatchUrl('session/list'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: 'apigw-health',
            method: 'session/list',
            payload: { args: { _request: {} } },
          }),
          signal: AbortSignal.timeout(5_000),
        }))
        if (!res.ok) return 'unreachable'
        const json = await res.json() as { type?: string; result?: { ok?: boolean } }
        return json.type === 'server-response' && json.result?.ok === true ? 'ok' : 'unreachable'
      } catch {
        return 'unreachable'
      }
    }

    // ---- HTTP dispatch ----

    const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
      setCors(res, req)
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      const seg = routeSegments(cfg.prefix, req.url)
      if (seg === null) return sendJson(res, 404, { error: 'not_found', service: 'dsh-api-gw' })

      // health stays reachable while disabled, for monitoring
      if (seg.length === 1 && seg[0] === 'health' && req.method === 'GET') {
        const upstream = await healthUpstream()
        return sendJson(res, 200, {
          status: cfg.enabled ? 'ok' : 'disabled',
          enabled: cfg.enabled,
          upstream,
          apiKeySet: acceptedKeys().length > 0,
        })
      }
      if (!cfg.enabled) return sendJson(res, 503, { error: 'service_disabled' })

      if (seg.length === 0 && req.method === 'GET') {
        return sendJson(res, 200, {
          service: 'dsh-api-gw', version: VERSION,
          endpoints: [
            { method: 'GET', path: cfg.prefix + '/health', auth: false },
            { method: 'POST', path: cfg.prefix + '/key', auth: 'first call only' },
            { method: 'POST', path: cfg.prefix + '/admin/enable', auth: 'admin' },
            { method: 'POST', path: cfg.prefix + '/admin/rotate-key', auth: 'admin' },
            { method: 'POST', path: cfg.prefix + '/proxy/<namespace>/<method>', auth: true, note: 'in-process Remote dispatch (whitelisted)' },
            { method: 'POST', path: cfg.prefix + '/sessions/{id}/sandbox-mode', auth: true, note: 'per-session sandbox override (read-only | workspace-write)' },
            { method: 'GET', path: cfg.prefix + '/events.mux', auth: true, note: 'WebSocket mux: open/cancel streams, item/error/end frames' },
            { method: 'GET', path: cfg.prefix + '/proxy/events.mux', auth: true, note: 'alias of events.mux' },
          ],
        })
      }

      /**
       * One-time bootstrap: mint the first key, then close for good.
       *
       * Unauthenticated *only* while the deployment has no key from any source --
       * the single moment when there is no credential that could be demanded. The
       * minted key is persisted before it is returned, so provisionDecision
       * refuses every later call, including after a restart, and a
       * minted-but-unpersisted (volatile) key closes the window too.
       */
      if (seg.length === 1 && seg[0] === 'key' && req.method === 'POST') {
        const decision = provisionDecision({
          provisionedKey: cfg.provisionedKey,
          apiKeys: cfg.apiKeys,
          allowKeyProvision: cfg.allowKeyProvision,
          prefix: cfg.prefix,
          volatileKey: volatileKey !== null,
        })
        if (decision.action === 'refuse') {
          return sendJson(res, decision.status, { error: decision.error, hint: decision.hint })
        }

        const minted = randomToken('apigw-', 32)
        if (settingsScope !== null) {
          try {
            await settingsScope.update({ provisionedKey: minted })
          } catch (error) {
            // Reported rather than returned: handing out a key that silently did
            // not persist is how the caller ends up with a credential that dies
            // at the next restart without anyone knowing why.
            return sendJson(res, 500, { error: 'settings_update_failed', detail: errorDetail(error) })
          }
          // The settings watcher refreshes cfg asynchronously; setting it here
          // means the key works on the very next request either way.
          cfg = { ...cfg, provisionedKey: minted }
        } else {
          volatileKey = minted
          ctx.logger?.warn?.('[dsh-api-gw] no settings provider: the provisioned key is in memory only and will not survive a restart. Set config.apiKeys for a durable key.')
        }
        // Never logged: the log is the one place a secret leaks without anyone
        // authenticating for it.
        ctx.logger?.info?.('[dsh-api-gw] API key provisioned (one-time bootstrap now closed)')
        return sendJson(res, 200, { apiKey: minted, persisted: settingsScope !== null })
      }

      // Admin surface (X-Admin-Key): runtime master switch + key rotation.
      if (seg.length === 2 && seg[0] === 'admin' && seg[1] === 'enable' && req.method === 'POST') {
        if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin_unauthorized' })
        let body: Record<string, unknown> = {}
        try { body = JSON.parse((await readBodyRaw(req)).toString('utf8') || '{}') } catch (error) { return sendJson(res, 400, { error: errorDetail(error) }) }
        const nextEnabled = body.enabled === true
        if (settingsScope !== null) {
          try { await settingsScope.update({ enabled: nextEnabled }) } catch (error) {
            return sendJson(res, 500, { error: 'settings_update_failed', detail: errorDetail(error) })
          }
        } else {
          cfg = { ...cfg, enabled: nextEnabled }
        }
        return sendJson(res, 200, { enabled: cfg.enabled })
      }
      // Replaces the provisioned key only. apiKeys is the operator's own list
      // and rotating over it would silently revoke keys the gateway was never
      // asked to manage. Without a settings provider the previous provisioned
      // key is cleared from the live config as well, so rotation really revokes.
      if (seg.length === 2 && seg[0] === 'admin' && seg[1] === 'rotate-key' && req.method === 'POST') {
        if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin_unauthorized' })
        const minted = randomToken('apigw-', 32)
        if (settingsScope !== null) {
          try {
            await settingsScope.update({ provisionedKey: minted })
          } catch (error) {
            return sendJson(res, 500, { error: 'settings_update_failed', detail: errorDetail(error) })
          }
          cfg = { ...cfg, provisionedKey: minted }
        } else {
          volatileKey = minted
          cfg = { ...cfg, provisionedKey: undefined }
        }
        ctx.logger?.info?.('[dsh-api-gw] API key rotated')
        return sendJson(res, 200, { apiKey: minted, persisted: settingsScope !== null })
      }

      // The proxy surface: auth first, then whitelist (fail closed), then bytes.
      // Auth before whitelist so an unauthenticated caller cannot probe which
      // endpoints exist by telling 403 from 401 apart.
      if (seg.length === 3 && seg[0] === 'proxy' && req.method === 'POST') {
        if (!requireAuth(req, res)) return
        const endpoint = endpointOf(seg[1], seg[2])
        if (!isProxyEndpointAllowed(endpoint, cfg.proxyWhitelist)) {
          return sendJson(res, 403, { error: 'method_not_allowed', hint: 'The requested endpoint is not on the proxy whitelist.' })
        }
        try {
          await proxyUnary(req, res, endpoint)
        } catch (error) {
          ctx.logger?.warn?.('[dsh-api-gw] proxy ' + endpoint + ' failed: ' + String(error))
          if (res.headersSent) { try { res.destroy() } catch { /* noop */ } ; return }
          return sendJson(res, 502, { error: 'host_unavailable', detail: errorDetail(error) })
        }
        return
      }

      /**
       * Per-session sandbox-mode override.
       *
       * The wire contract has no sandbox field and no Remote method switches a
       * session's mode. The host keeps the override as `sandbox/mode` log
       * events (dsh-sandbox-policy/session-mode), and its write path is
       * process-internal — so this small route is the only way a remote client
       * (the manager) can pin a fresh session's mode before the first prompt.
       *
       * Capped at workspace-write: danger-full-access stays a host-UI decision.
       * Only live sessions can be pinned; the override is durable (log replay
       * restores it after a cold wake), so one call at creation time suffices.
       */
      if (seg.length === 3 && seg[0] === 'sessions' && seg[2] === 'sandbox-mode' && req.method === 'POST') {
        if (!requireAuth(req, res)) return
        const sessionId = seg[1]
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse((await readBodyRaw(req)).toString('utf8') || '{}')
        } catch (error) {
          return sendJson(res, 400, { error: 'bad_json', detail: errorDetail(error) })
        }
        if (!isRemoteSandboxMode(body.mode)) {
          return sendJson(res, 400, {
            error: 'invalid_mode',
            hint: 'mode must be one of: ' + REMOTE_SANDBOX_MODES.join(', '),
          })
        }
        // Soft dependency: a host without the session store degrades cleanly
        // instead of breaking plugin startup.
        const sessions = hostService<SessionStore>('sessions')
        if (sessions === undefined) {
          return sendJson(res, 501, { error: 'service_unavailable', hint: 'host session store is not available' })
        }
        const session = sessions.get(sessionId as SessionId)
        if (session === undefined) {
          return sendJson(res, 409, {
            error: 'session_not_live',
            hint: 'only live (attached) sessions accept a sandbox-mode override',
          })
        }
        setSandboxMode(session, body.mode)
        return sendJson(res, 200, { sessionId, mode: body.mode })
      }

      return sendJson(res, 404, { error: 'not_found' })
    }

    // ---- mount ----

    // One noServer acceptor for all mux upgrades; handleUpgrade is called per
    // connection so the auth check runs before protocol negotiation.
    const wss = new WebSocketServer({ noServer: true })
    wss.on('error', () => { /* an aborted upgrade must not crash the host */ })
    const muxSessions = new Set<MuxSession>()

    const proxyUpgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
      if (!authorized(req)) {
        // Refuse before protocol negotiation, so an unauthenticated caller
        // never reaches the handshake.
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        return
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const session = new MuxSession(ws, {
          gateway: () => hostService<HostTypertGateway>('typertGateway'),
          whitelist: () => cfg.muxWhitelist,
        })
        muxSessions.add(session)
        ws.on('close', () => { muxSessions.delete(session) })
      })
    }

    let disposeRoute: (() => void) | null = null
    const disposeUpgrades: Array<() => void> = []
    const mountRoutes = () => {
      if (disposeRoute !== null) { try { disposeRoute() } catch { /* noop */ } ; disposeRoute = null }
      while (disposeUpgrades.length > 0) { try { disposeUpgrades.pop()!() } catch { /* noop */ } }
      const route: WebRoute = {
        kind: 'prefix',
        path: cfg.prefix,
        // The promise is returned so the carrier (and tests) can await the
        // full response lifecycle.
        handler: (req, res) => Promise.resolve(dispatch(req, res)).catch((error) => {
          ctx.logger?.warn?.('[dsh-api-gw] request failed: ' + String(error))
          try {
            if (res.headersSent) res.destroy()
            else sendJson(res, 500, { error: 'internal_error', detail: errorDetail(error) })
          } catch { /* noop */ }
        }),
      }
      disposeRoute = webServer.register(route)
      // Two upgrade paths: the canonical one and one under /proxy so a client
      // whose base is the proxy prefix (the manager's uniform base + method
      // assumption) derives the mux URL without any special case.
      for (const path of [cfg.prefix + '/events.mux', cfg.prefix + '/proxy/events.mux']) {
        const upgrade: WebUpgradeRoute = {
          path,
          handler: (req, socket, head) => proxyUpgrade(req, socket, head),
        }
        disposeUpgrades.push(webServer.registerUpgrade(upgrade))
      }
    }

    ctx.effect(() => {
      mountRoutes()
      return () => {
        if (disposeRoute !== null) { try { disposeRoute() } catch { /* noop */ } ; disposeRoute = null }
        while (disposeUpgrades.length > 0) { try { disposeUpgrades.pop()!() } catch { /* noop */ } }
        // Terminated rather than closed politely: an unload must not wait on
        // clients that keep their sockets open.
        for (const session of muxSessions) { try { session.close() } catch { /* noop */ } }
        muxSessions.clear()
        for (const client of wss.clients) client.terminate()
        wss.close()
      }
    })

    // Settings integration: expose the gateway Config as a live settings
    // namespace so edits apply without a restart. Secret fields (adminKey /
    // apiKeys) are declared role('secret') in the schema, so the wire surface
    // redacts them. Non-fatal by design: a deployment without a settings
    // provider simply keeps the composition-row config.
    ctx.inject(['settings'], (sctx) => {
      try {
        const settings = (sctx as unknown as { settings: HostSettings }).settings
        const scope = settings.register<Config>(SETTINGS_NAMESPACE, Config, { base: config, applies: 'live' })
        settingsScope = scope
        const resolved = scope.get()
        const prefixChanged = resolved.prefix !== cfg.prefix
        cfg = resolved
        if (prefixChanged) mountRoutes()
        scope.watch((next, prev) => {
          const changed = next.prefix !== prev.prefix
          cfg = next
          if (changed) mountRoutes()
        })
      } catch (error) {
        ctx.logger?.warn?.('[dsh-api-gw] settings namespace not registered: ' + String(error))
      }
    })

    ctx.logger?.info?.('[dsh-api-gw] mounted at ' + cfg.prefix + ' (in-process dispatch, enabled=' + String(cfg.enabled) + ')')
  },
}
