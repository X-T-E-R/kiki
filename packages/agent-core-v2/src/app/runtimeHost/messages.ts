import { randomUUID } from 'node:crypto';

import type { ErrorPayload } from '#/_base/errors/serialize';

export const RUNTIME_PROTOCOL_NAME = 'kimi-home-runtime';
export const RUNTIME_PROTOCOL_VERSION = 1;
export const RUNTIME_MAX_FRAME_BYTES = 1_048_576;
export const RUNTIME_MAX_IN_FLIGHT = 1_024;
export const RUNTIME_CALL_TIMEOUT_MS = 5_000;
export const RUNTIME_ELECTION_TIMEOUT_MS = 5_000;
export const RUNTIME_CONNECT_TIMEOUT_MS = 5_000;
export const RUNTIME_HANDSHAKE_TIMEOUT_MS = 5_000;
export const RUNTIME_MAX_CALL_TIMEOUT_MS = 600_000;
export const RUNTIME_MAX_REQUEST_ID_LENGTH = 128;
export const RUNTIME_MAX_METHOD_LENGTH = 256;

export interface RuntimeLimits {
  readonly maxFrameBytes?: number;
  readonly maxInFlight?: number;
  readonly callTimeoutMs?: number;
  readonly electionTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
}

export interface RuntimeHello {
  readonly v: typeof RUNTIME_PROTOCOL_VERSION;
  readonly protocol: typeof RUNTIME_PROTOCOL_NAME;
  readonly hostId: string;
  readonly canonicalHomeDir: string;
}

export interface RuntimeMaybeTokens {
  readonly tokens: readonly string[];
}

export interface RuntimeTokenAck {
  readonly v: typeof RUNTIME_PROTOCOL_VERSION;
  readonly protocol: typeof RUNTIME_PROTOCOL_NAME;
  readonly epoch: number;
  readonly hostId: string;
  readonly canonicalHomeDir: string;
}

export interface RuntimeReady {
  readonly epoch: number;
  readonly hostId: string;
  readonly canonicalHomeDir: string;
  readonly methods: readonly string[];
}

export interface RuntimeCallRequest {
  readonly requestId: string;
  readonly method: string;
  readonly epoch: number;
  readonly payload: unknown;
  readonly timeoutMs: number;
}

export interface RuntimeCallCancel {
  readonly requestId: string;
  readonly epoch: number;
}

export interface RuntimeCallResult {
  readonly requestId: string;
  readonly epoch: number;
  readonly value: unknown;
}

export interface RuntimeCallError {
  readonly requestId: string;
  readonly epoch: number;
  readonly error: ErrorPayload;
}

export interface RuntimeReject {
  readonly requestId?: string;
  readonly epoch?: number;
  readonly code: string;
  readonly message: string;
}

export interface RuntimeMethodContext {
  readonly requestId: string;
  readonly epoch: number;
  readonly callerHostId: string;
  readonly signal: AbortSignal;
}

export type RuntimeInboundFrame =
  | { readonly type: 'hello'; readonly hello: RuntimeHello }
  | { readonly type: 'token'; readonly token: RuntimeMaybeTokens }
  | { readonly type: 'call'; readonly call: RuntimeCallRequest }
  | { readonly type: 'cancel'; readonly cancel: RuntimeCallCancel };

export type RuntimeOutboundFrame =
  | { readonly type: 'ack'; readonly ack: RuntimeTokenAck }
  | { readonly type: 'ready'; readonly ready: RuntimeReady }
  | { readonly type: 'result'; readonly result: RuntimeCallResult }
  | { readonly type: 'error'; readonly error: RuntimeCallError }
  | { readonly type: 'reject'; readonly reject: RuntimeReject };

export type RuntimeFrame = RuntimeInboundFrame | RuntimeOutboundFrame;

export interface RuntimeCallOptions {
  readonly requestId?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type RuntimeRole = 'idle' | 'owner' | 'client';

export interface RuntimeHostStatus {
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  readonly role: RuntimeRole;
  readonly ready: boolean;
  readonly epoch: number;
  readonly hostId: string;
}

export function newRequestId(): string {
  return randomUUID();
}

export function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && Math.floor(value) > 0
    ? Math.floor(value)
    : fallback;
}

export function callTimeoutMs(value: number | undefined, fallback = RUNTIME_CALL_TIMEOUT_MS): number {
  return Math.min(RUNTIME_MAX_CALL_TIMEOUT_MS, positiveInt(value, fallback));
}
