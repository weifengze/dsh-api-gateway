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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export interface Config {
    /** Route prefix. Defaults to /api-gw/v1. */
    prefix: string;
    /** Master switch; also toggleable at runtime through the admin endpoint. */
    enabled: boolean;
    /** Static API keys accepted by the gateway (in addition to the provisioned key). */
    apiKeys: string[];
    /**
     * The key minted by POST {prefix}/key, persisted through the settings scope.
     *
     * Written by the gateway, not by hand -- apiKeys is the field to edit. It is
     * stored rather than kept in memory so that the bootstrap is one-time *ever*:
     * the key a client was given keeps working across restarts, and the
     * unauthenticated mint closes permanently instead of reopening on each boot.
     */
    provisionedKey?: string;
    /** Allow the one-time POST {prefix}/key bootstrap when no key exists at all. */
    allowKeyProvision: boolean;
    /** Admin key for {prefix}/admin/*; unset disables the admin surface. */
    adminKey?: string;
    /** CORS origin(s); default '*' (open). Set an explicit origin list for public deployments. */
    corsOrigin: string | string[];
    /** Include internal error messages in HTTP responses (helpful locally, noisy publicly). */
    exposeErrors: boolean;
    /** Unary endpoint whitelist; defaults to DEFAULT_PROXY_WHITELIST. */
    proxyWhitelist: string[];
    /** Mux stream endpoint whitelist; defaults to DEFAULT_MUX_WHITELIST. */
    muxWhitelist: string[];
}
export declare const Config: z<Schemastery.ObjectS<{
    prefix: z<string, string>;
    enabled: z<boolean, boolean>;
    apiKeys: z<string[], string[]>;
    provisionedKey: z<string, string>;
    allowKeyProvision: z<boolean, boolean>;
    adminKey: z<string, string>;
    corsOrigin: z<string | string[], string | string[]>;
    exposeErrors: z<boolean, boolean>;
    proxyWhitelist: z<string[], string[]>;
    muxWhitelist: z<string[], string[]>;
}>, Schemastery.ObjectT<{
    prefix: z<string, string>;
    enabled: z<boolean, boolean>;
    apiKeys: z<string[], string[]>;
    provisionedKey: z<string, string>;
    allowKeyProvision: z<boolean, boolean>;
    adminKey: z<string, string>;
    corsOrigin: z<string | string[], string | string[]>;
    exposeErrors: z<boolean, boolean>;
    proxyWhitelist: z<string[], string[]>;
    muxWhitelist: z<string[], string[]>;
}>>;
declare const _default: {
    inject: string[];
    Config: z<Schemastery.ObjectS<{
        prefix: z<string, string>;
        enabled: z<boolean, boolean>;
        apiKeys: z<string[], string[]>;
        provisionedKey: z<string, string>;
        allowKeyProvision: z<boolean, boolean>;
        adminKey: z<string, string>;
        corsOrigin: z<string | string[], string | string[]>;
        exposeErrors: z<boolean, boolean>;
        proxyWhitelist: z<string[], string[]>;
        muxWhitelist: z<string[], string[]>;
    }>, Schemastery.ObjectT<{
        prefix: z<string, string>;
        enabled: z<boolean, boolean>;
        apiKeys: z<string[], string[]>;
        provisionedKey: z<string, string>;
        allowKeyProvision: z<boolean, boolean>;
        adminKey: z<string, string>;
        corsOrigin: z<string | string[], string | string[]>;
        exposeErrors: z<boolean, boolean>;
        proxyWhitelist: z<string[], string[]>;
        muxWhitelist: z<string[], string[]>;
    }>>;
    apply(ctx: Context, config: Config): void;
};
export default _default;
