/**
 * dsh-api-gateway — endpoint plumbing (pure).
 *
 * Whitelists and wire helpers for the in-process gateway, with no Node/Cordis
 * surface so they stay directly unit-testable (see test/proxy.test.mjs).
 *
 * DSH 0.1.5 wire endpoints are `<namespace>/<method>` strings (slash form):
 * `session/create`, `session/modelCatalog`, `$events/result`, ... The legacy
 * dot form (`session.create`) was removed by the host and is not accepted.
 */

/**
 * Unary endpoints the proxy may forward. Everything else is refused with 403
 * before any dispatch happens — fail-closed, no exceptions.
 *
 * The list covers the remote client's needs and nothing more: the privileged
 * plane (credentials/*, settings/*, workspace/*, agentPresets/*, goals/*,
 * subagents/*, llm/discoverModels, session/search, ...) stays unreachable
 * through the proxy. `$events/result` is the answer channel for approvals and
 * user questions, which arrive on the `$events` mux stream.
 */
export const DEFAULT_PROXY_WHITELIST: readonly string[] = [
  // sessions
  'session/list', 'session/create', 'session/page',
  'session/prompt', 'session/cancel', 'session/rename',
  'session/fork', 'session/updateQueue', 'session/attachment',
  // models
  'session/modelCatalog', 'session/selectModel',
  // answers to forwarded waterfall events (approvals / user questions)
  '$events/result',
]

/**
 * Stream endpoints the mux may open. Fail-closed like the unary whitelist:
 * only streams a remote client genuinely needs are listed.
 */
export const DEFAULT_MUX_WHITELIST: readonly string[] = [
  // all forwarded host events: approval/request, user-questions/request, status
  '$events',
  // per-session durable event stream (+ optional live assistant frames)
  'session/follow',
  // live control baseline: queues, jobs, projection state
  'session/control',
]

/** Whether a proxied unary endpoint may be dispatched. */
export const isProxyEndpointAllowed = (endpoint: string, whitelist: readonly string[]): boolean =>
  whitelist.includes(endpoint)

/** Whether a mux stream endpoint may be opened. */
export const isMuxEndpointAllowed = (endpoint: string, whitelist: readonly string[]): boolean =>
  whitelist.includes(endpoint)

/** Canonical endpoint of two path segments: `<namespace>/<method>`. */
export const endpointOf = (namespace: string, method: string): string => `${namespace}/${method}`

/** Synthetic base URL for in-process dispatch. It never leaves the process. */
export const DISPATCH_BASE = 'http://dsh.invalid'

/** Request URL handed to the host's shared `/api` fetch handler. */
export const dispatchUrl = (endpoint: string): string => `${DISPATCH_BASE}/api/${endpoint}`
