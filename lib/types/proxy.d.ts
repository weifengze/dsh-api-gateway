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
export declare const DEFAULT_PROXY_WHITELIST: readonly string[];
/**
 * Stream endpoints the mux may open. Fail-closed like the unary whitelist:
 * only streams a remote client genuinely needs are listed.
 */
export declare const DEFAULT_MUX_WHITELIST: readonly string[];
/** Whether a proxied unary endpoint may be dispatched. */
export declare const isProxyEndpointAllowed: (endpoint: string, whitelist: readonly string[]) => boolean;
/** Whether a mux stream endpoint may be opened. */
export declare const isMuxEndpointAllowed: (endpoint: string, whitelist: readonly string[]) => boolean;
/** Canonical endpoint of two path segments: `<namespace>/<method>`. */
export declare const endpointOf: (namespace: string, method: string) => string;
/** Synthetic base URL for in-process dispatch. It never leaves the process. */
export declare const DISPATCH_BASE = "http://dsh.invalid";
/** Request URL handed to the host's shared `/api` fetch handler. */
export declare const dispatchUrl: (endpoint: string) => string;
