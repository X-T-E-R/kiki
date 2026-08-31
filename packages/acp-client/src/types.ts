import type { Readable, Writable } from 'node:stream';

import type {
  AgentCapabilities,
  InitializeResponse,
  McpServer,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';

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

export interface AcpProcessDescriptor {
  readonly id: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly startupTimeoutMs?: number;
  readonly cancelGraceMs?: number;
  readonly shutdownGraceMs?: number;
  readonly stderrMaxBytes?: number;
  readonly clientName?: string;
}

export type AcpClientState =
  | 'cold'
  | 'spawning'
  | 'initializing'
  | 'opening_session'
  | 'configuring'
  | 'ready'
  | 'prompting'
  | 'broken'
  | 'closing'
  | 'closed';

export type AcpSessionOpenMode = 'live' | 'resume' | 'load' | 'new';

export interface AcpClientStatus {
  readonly state: AcpClientState;
  readonly openingMode?: Exclude<AcpSessionOpenMode, 'live'>;
  readonly pid?: number;
  readonly sessionId?: string;
}

export type AcpSessionConfigOption = SessionConfigOption;
export type AcpPermissionOption = PermissionOption;
export type AcpPermissionRequest = RequestPermissionRequest;

export interface AcpSessionConfigSelection {
  readonly configId: string;
  readonly value: string | boolean;
}

export interface ExecutorSessionRefEnvelope {
  readonly executorId: string;
  readonly version: number;
  readonly ref: Readonly<Record<string, unknown>>;
}

export interface AcpOpenSessionOptions {
  readonly cwd: string;
  readonly additionalDirectories?: readonly string[];
  readonly mcpServers?: readonly McpServer[];
  readonly sessionRef?: ExecutorSessionRefEnvelope;
  readonly configOptions?: readonly AcpSessionConfigSelection[];
  readonly modeId?: string;
  readonly signal?: AbortSignal;
}

export interface AcpConfigureSessionOptions {
  readonly configOptions?: readonly AcpSessionConfigSelection[];
  readonly modeId?: string;
  readonly signal?: AbortSignal;
}

export interface AcpOpenSessionResult {
  readonly sessionId: string;
  readonly mode: AcpSessionOpenMode;
  readonly initialize: InitializeResponse;
  readonly capabilities: AgentCapabilities;
  readonly configOptions: readonly SessionConfigOption[];
  readonly sessionRef: ExecutorSessionRefEnvelope;
  readonly loadReplayObserved: boolean;
  readonly quarantinedUpdateCount: number;
}

export interface AcpPermissionDecision {
  readonly outcome: 'selected' | 'cancelled';
  readonly optionId?: string;
}

export interface AcpPermissionContext {
  readonly signal: AbortSignal;
  readonly options: readonly PermissionOption[];
}

export type AcpPermissionHandler = (
  request: RequestPermissionRequest,
  context: AcpPermissionContext,
) => AcpPermissionDecision | Promise<AcpPermissionDecision>;

export interface AcpClientLogger {
  debug?(message: string, details?: Readonly<Record<string, unknown>>): void;
  warn?(message: string, details?: Readonly<Record<string, unknown>>): void;
  error?(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export interface AcpClientOptions {
  readonly permissionHandler?: AcpPermissionHandler;
  readonly logger?: AcpClientLogger;
  readonly platform?: NodeJS.Platform;
  readonly onStateChange?: (status: AcpClientStatus) => void;
}

export interface AcpTurnRequest {
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly session: AcpOpenSessionOptions;
}

export interface AcpTurnResult {
  readonly response: PromptResponse;
  readonly session: AcpOpenSessionResult;
  readonly stderrTail: string;
}

export interface AcpTurnHandle<Event> {
  readonly events: AsyncIterable<Event>;
  readonly completion: Promise<AcpTurnResult>;
  cancel(reason?: unknown): Promise<boolean>;
}
