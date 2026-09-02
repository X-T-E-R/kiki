import type { Readable, Writable } from 'node:stream';

import type { NormalizedExecutorEvent } from '@moonshot-ai/protocol';

export interface HostProcessOptionsLike {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly shell?: boolean | string;
  readonly detached?: boolean;
  readonly windowsHide?: boolean;
  readonly mergeStderr?: boolean;
  readonly timeout?: number;
}

export interface HostProcessLike {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  wait(): Promise<number>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface HostProcessServiceLike {
  spawn(
    command: string,
    args?: readonly string[],
    options?: HostProcessOptionsLike,
  ): Promise<HostProcessLike>;
}

export interface CodexProcessDescriptor {
  readonly id: string;
  readonly command: string;
  readonly commandArgsPrefix?: readonly string[];
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  readonly stderrMaxBytes?: number;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export type CodexClientState =
  | 'cold'
  | 'spawning'
  | 'initializing'
  | 'ready'
  | 'turning'
  | 'broken'
  | 'closing'
  | 'closed';

export interface CodexClientStatus {
  readonly state: CodexClientState;
  readonly pid?: number;
  readonly threadId?: string;
  readonly turnId?: string;
}

export type CodexRequestId = string | number;

export interface CodexNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface CodexServerRequest {
  readonly id: CodexRequestId;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface CodexServerRequestResponder {
  respond(result: unknown): Promise<void>;
  respondError(code: number, message: string, data?: unknown): Promise<void>;
}

export type CodexServerRequestHandler = (
  request: CodexServerRequest,
  responder: CodexServerRequestResponder,
  signal: AbortSignal,
) => void | Promise<void>;

export interface CodexClientLogger {
  error?(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export interface CodexClientOptions {
  readonly onServerRequest?: CodexServerRequestHandler;
  readonly onNotification?: (notification: CodexNotification) => void | Promise<void>;
  readonly onFrame?: (frame: CodexWireFrame) => void;
  readonly onStateChange?: (status: CodexClientStatus) => void;
  readonly logger?: CodexClientLogger;
}

export interface CodexWireFrame {
  readonly sequence: number;
  readonly direction: 'client-to-server' | 'server-to-client';
  readonly boundary: 'request' | 'response' | 'notification' | 'malformed';
  readonly raw: string;
  readonly payload?: unknown;
}

export interface CodexModel {
  readonly id: string;
  readonly model?: string;
  readonly displayName?: string;
  readonly hidden?: boolean;
  readonly supportedReasoningEfforts?: readonly {
    readonly reasoningEffort?: string;
    readonly description?: string;
  }[];
}

export interface CodexModelListResult {
  readonly data: readonly CodexModel[];
  readonly nextCursor?: string | null;
}

export interface CodexThreadResult {
  readonly thread: Readonly<Record<string, unknown>> & { readonly id: string };
  readonly model?: string;
  readonly modelProvider?: string;
  readonly cwd?: string;
}

export interface CodexTurnStartedResult {
  readonly turn: Readonly<Record<string, unknown>> & { readonly id: string };
}

export interface CodexTurnCompletion {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: string;
  readonly error?: unknown;
  readonly stderrTail: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly contextWindow?: number;
  };
}

export interface CodexTurnHandle {
  readonly events: AsyncIterable<NormalizedExecutorEvent>;
  readonly completion: Promise<CodexTurnCompletion>;
  cancel(reason?: unknown): Promise<boolean>;
}
