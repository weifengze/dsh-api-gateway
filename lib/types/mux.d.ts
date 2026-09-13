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
import type { HostTypertGateway, StreamFailure } from './dsh.js';
/** Open one logical stream. */
export interface MuxOpenMessage {
    readonly type: 'open';
    readonly streamId: string;
    readonly endpoint: string;
    readonly payload: unknown;
}
/** Cancel one active logical stream. */
export interface MuxCancelMessage {
    readonly type: 'cancel';
    readonly streamId: string;
}
export type MuxClientMessage = MuxOpenMessage | MuxCancelMessage;
/** One stream value. */
export interface MuxItemFrame {
    readonly type: 'item';
    readonly streamId: string;
    readonly value: unknown;
}
/** A stream failure mapped through the host gateway. */
export interface MuxErrorFrame {
    readonly type: 'error';
    readonly streamId: string;
    readonly error: StreamFailure;
}
/** Clean stream completion. */
export interface MuxEndFrame {
    readonly type: 'end';
    readonly streamId: string;
}
export type MuxServerFrame = MuxItemFrame | MuxErrorFrame | MuxEndFrame;
/** Close codes used by the session, mirroring the host's choices. */
export declare const MUX_CLOSE_INVALID = 1008;
export declare const MUX_CLOSE_BINARY = 1003;
export declare const MUX_CLOSE_UNDELIVERABLE = 1011;
/** Ping interval and tolerance, matching the host mux server. */
export declare const MUX_HEARTBEAT_INTERVAL_MS = 2000;
export declare const MUX_MAX_MISSED_HEARTBEATS = 2;
/**
 * Parse and validate one client text frame.
 *
 * Returns `null` for anything malformed; the caller closes the socket with
 * 1008, exactly as the host mux server does.
 */
export declare const parseMuxClientMessage: (text: string) => MuxClientMessage | null;
/** Lazy accessors so a settings change or a late service load is observed live. */
export interface MuxSessionOptions {
    /** Host Typert gateway accessor; `undefined` means the service is unavailable. */
    readonly gateway: () => HostTypertGateway | undefined;
    /** Allowed stream endpoints, read per open so config edits apply live. */
    readonly whitelist: () => readonly string[];
}
/**
 * One physical mux connection: owns the per-socket stream table, serializes
 * writes, and pumps each logical stream from the host gateway to the client.
 */
export declare class MuxSession {
    private readonly socket;
    private readonly options;
    private readonly streams;
    private writes;
    private missedHeartbeats;
    private readonly heartbeat;
    private disposed;
    constructor(socket: WebSocket, options: MuxSessionOptions);
    /** Terminate the physical socket and every logical stream. */
    close(): void;
    private beat;
    private dispose;
    private receive;
    private pump;
    private send;
}
