/**
 * Transport SPI — the single abstraction every klient transport implements.
 *
 * A `KlientChannel` carries service calls and event subscriptions for one
 * scope triple. The facade above it never knows which transport is underneath
 * (http, ipc, or in-memory); transports never know which facade method
 * triggered a frame. `ScopeRef` already carries session/agent coordinates so
 * future session/agent facades plug in without changing this interface.
 */

import type {
  SessionViewSignal,
  SessionViewSubscribeInput,
  SessionViewTranscriptCatchUpInput,
  SessionViewTranscriptPageInput,
} from '../contract/session/view.js';

export interface IDisposable {
  dispose(): void;
}

export interface SessionViewChannelSubscription {
  updateSessionCursor(cursor: SessionViewSubscribeInput['sessionCursor']): void;
  setTranscriptGrades(grades: SessionViewSubscribeInput['transcriptGrades']): void;
  updateTranscriptCursor(agentId: string, cursor: NonNullable<SessionViewSubscribeInput['transcriptSince']>[string]): void;
  restart(): void;
  nudge(): void;
  close(): void;
}

export interface SessionViewChannel {
  snapshot(sessionId: string, options?: CallOptions): Promise<unknown>;
  transcriptPage(sessionId: string, input: SessionViewTranscriptPageInput): Promise<unknown>;
  transcriptCatchUp(sessionId: string, input: SessionViewTranscriptCatchUpInput): Promise<unknown>;
  subscribe(
    sessionId: string,
    input: SessionViewSubscribeInput,
    handler: (signal: SessionViewSignal) => void,
  ): SessionViewChannelSubscription;
}

/** Optional per-call knobs a transport may honor. */
export interface CallOptions {
  /**
   * Per-call deadline (ms). A transport with a default call timeout (ipc/http)
   * takes it as an override — long-poll calls pass a deadline covering the
   * engine-side wait; transports without a timeout (memory) ignore it.
   */
  readonly timeoutMs?: number;
  /** Abort an in-flight call when the transport can propagate cancellation. */
  readonly signal?: AbortSignal;
}

/** Scope coordinates of a call/subscription. Empty object = core (app) scope. */
export interface ScopeRef {
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
}

/**
 * Where an event subscription reads from:
 * - `stream` — a scope's named event stream, mirroring kap-server's WS
 *   `eventMap`: core `events` (the global `IEventService` bus), session
 *   `interactions` / `interactions:resolved`, agent `events` (the per-agent
 *   `IEventBus`). The scope coordinates disambiguate which scope's stream.
 * - `emitter` — one service's `onDid*` `Event<T>` property, addressed by the
 *   service's wire name and the property name (e.g. `onDidChangeModels`).
 */
export type EventSourceRef =
  | { readonly kind: 'stream'; readonly name: string }
  | { readonly kind: 'emitter'; readonly service: string; readonly event: string };

export interface KlientChannel {
  /** HTTP-only KAP REST domains; other transports leave this unavailable. */
  readonly rest?: import('./facade/http-rest.js').HttpRestFacade;
  readonly terminal?: import('./facade/terminal.js').TerminalFacade;
  readonly sessionView?: SessionViewChannel;
  readonly sessionCommands?: import('../contract/session/commands.js').SessionCommandChannel;
  /**
   * Invoke `service.method(...args)` in the given scope; resolves with the raw
   * wire result. `options.timeoutMs` overrides the transport's default per-call
   * deadline (e.g. a long `wait`); omit to use the transport default.
   */
  call(
    scope: ScopeRef,
    service: string,
    method: string,
    args: unknown[],
    options?: CallOptions,
  ): Promise<unknown>;
  /**
   * Invoke `service.method(...args)` in the given scope and return a streaming
   * result. The callee must return an `AsyncIterable`; each yielded chunk is
   * surfaced as-is (after the transport's serialization round-trip).
   */
  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown>;
  /**
   * Subscribe to an event source; `handler` receives raw wire payloads.
   * `onError` reports asynchronous subscription failures (bad source, dropped
   * remote subscription) — synchronous validation may also throw. Every loss of
   * subscription continuity must call `onError` before any restored `onReady`.
   * `onReady` runs only after the source is attached, initially and after each
   * reconnect. Failed or disposed subscriptions never acknowledge readiness.
   */
  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
    onReady?: () => void,
  ): IDisposable;
  /** Tear the transport down (sockets, lazy bridges). Rejects in-flight calls. */
  close(): Promise<void>;
}
