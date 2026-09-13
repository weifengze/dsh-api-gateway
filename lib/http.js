/**
 * dsh-api-gateway — HTTP plumbing (pure).
 *
 * Request-shaped helpers with no Node/Cordis surface, so they stay directly
 * unit-testable (see test/http.test.mjs).
 */
/**
 * Negotiate the `Access-Control-Allow-Origin` value.
 *
 * The header accepts exactly one origin (or `*`) — a joined list is invalid and
 * every browser rejects it. So an allow-list is matched against the request
 * `Origin` and echoed back, with `Vary: Origin` so caches stay correct.
 *
 * Returns `origin: null` when the requester is not allowed: the caller then
 * omits the header entirely and the browser blocks the response.
 */
export const resolveCorsOrigin = (configured, requestOrigin) => {
    const list = (Array.isArray(configured) ? configured : [configured]).filter((o) => o !== '');
    if (list.length === 0 || list.includes('*'))
        return { origin: '*', vary: false };
    if (requestOrigin !== undefined && requestOrigin !== '' && list.includes(requestOrigin)) {
        return { origin: requestOrigin, vary: true };
    }
    // Single configured origin: echo it even for non-browser clients that send no
    // Origin header, so curl/SDK traffic is unaffected by the allow-list.
    if (list.length === 1)
        return { origin: list[0], vary: true };
    return { origin: null, vary: true };
};
/**
 * Split a request URL into the path segments that follow the gateway prefix.
 * Returns `null` when the URL is outside the prefix.
 */
export const routeSegments = (prefix, url) => {
    const pathname = String(url ?? '').split('?')[0];
    const parts = pathname.split('/').filter((p) => p !== '');
    const prefixParts = prefix.split('/').filter((p) => p !== '');
    if (parts.length < prefixParts.length)
        return null;
    if (parts.slice(0, prefixParts.length).join('/') !== prefixParts.join('/'))
        return null;
    return parts.slice(prefixParts.length);
};
export const provisionDecision = (input) => {
    const configured = input.apiKeys.filter((k) => k !== '');
    const provisioned = input.provisionedKey !== undefined && input.provisionedKey !== '';
    if (provisioned || input.volatileKey === true || configured.length > 0) {
        return {
            action: 'refuse',
            status: 403,
            error: 'key_already_provisioned',
            hint: provisioned || input.volatileKey === true
                ? `A key was already provisioned. Rotate it with POST ${input.prefix}/admin/rotate-key (requires X-Admin-Key).`
                : 'Static apiKeys are configured; authenticate with one of them.',
        };
    }
    if (!input.allowKeyProvision) {
        return {
            action: 'refuse',
            status: 403,
            error: 'key_provisioning_disabled',
            hint: 'Set config.apiKeys instead, or enable allowKeyProvision.',
        };
    }
    return { action: 'mint' };
};
