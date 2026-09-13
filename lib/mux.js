/**
 * dsh-api-gateway — Remote stream mux (wire protocol + server session).
 *
 * Mirrors the wire contract of the DSH 0.1.5 `RemoteStreamMuxServer`
 * (@deepseek-ai/dsh-api-gateway/stream-protocol): one WebSocket multiplexes
 * logical streams; the client sends `open` / `cancel` and the host answers
 * with `item` / `error` / `end`. The plugin re-hosts that protocol so a
 * remote client can consume Remote streams (session events, control state,
 * forwarded approvals/questions) without ever touching the host's
 * browser-authenticated HTTP route.
 *
 * The mux server class itself is not exported by the host package, so the
 * protocol is reimplemented here against the same validation rules and the
 * same heartbeat policy. `MuxSession` is transport-thin: all protocol logic
 * stays in the exported parse helpers, which are directly unit-testable.
 */
import { WebSocket } from 'ws';
/** Close codes used by the session, mirroring the host's choices. */
export const MUX_CLOSE_INVALID = 1008;
export const MUX_CLOSE_BINARY = 1003;
export const MUX_CLOSE_UNDELIVERABLE = 1011;
/** Ping interval and tolerance, matching the host mux server. */
export const MUX_HEARTBEAT_INTERVAL_MS = 2_000;
export const MUX_MAX_MISSED_HEARTBEATS = 2;
// ---- pure validation ----
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value, keys) => {
    const own = Object.keys(value);
    return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const validId = (value) => typeof value === 'string' && value.length > 0;
/**
 * Parse and validate one client text frame.
 *
 * Returns `null` for anything malformed; the caller closes the socket with
 * 1008, exactly as the host mux server does.
 */
export const parseMuxClientMessage = (text) => {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (!isRecord(value) || typeof value.type !== 'string')
        return null;
    if (value.type === 'cancel' && exactKeys(value, ['type', 'streamId']) && validId(value.streamId)) {
        return { type: 'cancel', streamId: value.streamId };
    }
    if (value.type === 'open'
        && exactKeys(value, ['type', 'streamId', 'endpoint', 'payload'])
        && validId(value.streamId)
        && typeof value.endpoint === 'string'
        && value.endpoint.length > 0) {
        return { type: 'open', streamId: value.streamId, endpoint: value.endpoint, payload: value.payload };
    }
    return null;
};
/**
 * One physical mux connection: owns the per-socket stream table, serializes
 * writes, and pumps each logical stream from the host gateway to the client.
 */
export class MuxSession {
    socket;
    options;
    streams = new Map();
    writes = Promise.resolve();
    missedHeartbeats = 0;
    heartbeat;
    disposed = false;
    constructor(socket, options) {
        this.socket = socket;
        this.options = options;
        socket.on('message', (data, isBinary) => { this.receive(data, isBinary); });
        socket.on('close', () => { this.dispose(); });
        socket.on('pong', () => { this.missedHeartbeats = 0; });
        socket.on('error', () => { this.dispose(); });
        this.heartbeat = setInterval(() => { this.beat(); }, MUX_HEARTBEAT_INTERVAL_MS);
        this.heartbeat.unref?.();
    }
    /** Terminate the physical socket and every logical stream. */
    close() {
        this.dispose();
        this.socket.terminate();
    }
    beat() {
        if (this.socket.readyState !== WebSocket.OPEN)
            return;
        if (this.missedHeartbeats >= MUX_MAX_MISSED_HEARTBEATS) {
            setImmediate(() => {
                if (!this.disposed && this.missedHeartbeats >= MUX_MAX_MISSED_HEARTBEATS)
                    this.socket.terminate();
            });
            return;
        }
        this.missedHeartbeats += 1;
        try {
            this.socket.ping();
        }
        catch { /* socket going away */ }
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        clearInterval(this.heartbeat);
        for (const stream of this.streams.values())
            stream.abort.abort(new Error('mux socket closed'));
        this.streams.clear();
    }
    receive(data, isBinary) {
        if (isBinary) {
            this.socket.close(MUX_CLOSE_BINARY, 'text messages required');
            return;
        }
        const message = parseMuxClientMessage(typeof data === 'string' ? data : String(data));
        if (message === null) {
            this.socket.close(MUX_CLOSE_INVALID, 'invalid Remote stream request');
            return;
        }
        if (message.type === 'cancel') {
            this.streams.get(message.streamId)?.abort.abort(new Error('Remote stream cancelled'));
            return;
        }
        if (this.streams.has(message.streamId)) {
            this.socket.close(MUX_CLOSE_INVALID, 'duplicate Remote stream id');
            return;
        }
        if (!this.options.whitelist().includes(message.endpoint)) {
            void this.send({
                type: 'error',
                streamId: message.streamId,
                error: {
                    code: 'gateway/endpoint-not-allowed',
                    message: 'stream endpoint is not on the gateway mux whitelist',
                    details: { endpoint: message.endpoint },
                },
            });
            return;
        }
        const abort = new AbortController();
        const active = { abort, done: Promise.resolve() };
        this.streams.set(message.streamId, active);
        const done = this.pump(message.streamId, message.endpoint, message.payload, active);
        active.done = done;
        const remove = () => { this.streams.delete(message.streamId); };
        void done.then(remove, remove);
    }
    async pump(streamId, endpoint, payload, active) {
        const gateway = this.options.gateway();
        if (gateway === undefined) {
            await this.send({
                type: 'error',
                streamId,
                error: {
                    code: 'gateway/service-unavailable',
                    message: 'host typertGateway service is unavailable',
                    details: {},
                },
            }).catch(() => undefined);
            return;
        }
        try {
            const source = await gateway.wireStream.open(endpoint, payload, active.abort.signal);
            for await (const value of source)
                await this.send({ type: 'item', streamId, value });
            if (!active.abort.signal.aborted)
                await this.send({ type: 'end', streamId });
        }
        catch (error) {
            if (!active.abort.signal.aborted && this.socket.readyState === WebSocket.OPEN) {
                try {
                    await this.send({ type: 'error', streamId, error: gateway.wireStream.failure(error) });
                }
                catch {
                    // A terminal frame that cannot be written leaves the logical stream
                    // ambiguous, so fail the physical generation (mirrors the host).
                    this.socket.close(MUX_CLOSE_UNDELIVERABLE, 'Remote stream failure could not be delivered');
                }
            }
        }
    }
    send(frame) {
        let text;
        try {
            text = JSON.stringify(frame);
        }
        catch (cause) {
            return Promise.reject(new Error('dsh-api-gw: mux item is not JSON serializable', { cause }));
        }
        const delivery = this.writes.then(() => new Promise((resolve, reject) => {
            if (this.socket.readyState !== WebSocket.OPEN) {
                reject(new Error('dsh-api-gw: mux socket is closed'));
                return;
            }
            this.socket.send(text, (error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        }));
        this.writes = delivery.catch(() => undefined);
        return delivery;
    }
}
