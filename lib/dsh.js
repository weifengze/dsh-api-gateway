/**
 * dsh-api-gateway — structural host contracts (DSH 0.1.5-rc.2).
 *
 * The gateway runs inside the DSH host process and consumes two host services
 * through `ctx.get`: `connection` (the `/api` carrier) and `typertGateway`
 * (the Remote dispatcher). Rather than importing those packages' internals,
 * the plugin declares the minimal structural shapes it needs. Both were
 * verified against @deepseek-ai/dsh-client-connection@0.1.5-rc.2 and
 * @deepseek-ai/dsh-api-gateway@0.1.5-rc.2:
 *
 *   - connection.createSharedFetchHandler('/api') composes the Fetch handler
 *     for the shared channel WITHOUT the HTTP route's browser-auth fence —
 *     this is what makes in-process dispatch possible.
 *   - typertGateway.wireStream.open(endpoint, payload, signal) opens any
 *     Remote stream, including the Gateway-owned `$events` event stream.
 */
export {};
