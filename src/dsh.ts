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

/** One Fetch-shaped dispatcher over the host's shared `/api` channel. */
export interface ApiFetchHandler {
  fetch(request: Request): Promise<Response>
}

/** Host connection service (`ctx.connection`). */
export interface HostConnection {
  /**
   * Compose the `/api` Fetch handler. The HTTP route wraps this with the
   * Host/Origin fence and browser authentication; calling it directly skips
   * both, which is intended for in-process Host consumers.
   */
  createSharedFetchHandler(channel: '/api'): ApiFetchHandler
}

/** Carrier-safe stream failure, as the Gateway maps it for the wire. */
export interface StreamFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Host Typert gateway service (`ctx.typertGateway`). */
export interface HostTypertGateway {
  readonly wireStream: {
    /** Open one logical stream (Remote stream method or the `$events` stream). */
    open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>
    /** Convert a stream failure into the stable wire shape. */
    failure(error: unknown): StreamFailure
  }
}

/** Owner-facing handle for one registered settings namespace. */
export interface SettingsNamespaceScope<T> {
  /** Current resolved value: schema defaults, then `base`, then the user layer. */
  get(): T
  /** Observe committed changes to the resolved value. */
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
  /** Merge a partial patch into the namespace's user layer and persist it. */
  update(patch: object): Promise<void>
}

/** Host settings service (`ctx.settings`). */
export interface HostSettings {
  register<T>(
    ns: string,
    schema: unknown,
    options?: { base?: T; applies?: 'live' | 'restart' },
  ): SettingsNamespaceScope<T>
}
