import { createDecorator } from '#/_base/di/instantiation';
import type { MCPToolDefinition, MCPToolResult } from '#/mcpCore/types';
import type { BrowserConnectionInput, BrowserConnectionRecord } from './browserConfig';
import type { BrowserErrorCode } from './errors';

export interface BrowserFailure {
  readonly code: BrowserErrorCode;
  readonly reason?: 'feature_disabled' | 'connection_disabled' | 'outcome_unknown';
}

export interface BrowserStatus {
  readonly browser: string;
  readonly state: 'idle' | 'connecting' | 'ready' | 'running' | 'stopping' | 'disconnected' | 'failed' | 'unconfirmed';
  readonly executionHost: string;
  readonly runtimeSession?: string;
  readonly generation: number;
  readonly checkedAt?: string;
  readonly driverVersion?: string;
  readonly error?: string;
  readonly failure?: BrowserFailure;
  readonly currentCall?: { readonly sessionId: string; readonly agentId: string; readonly tool: string; readonly tab?: string };
  readonly ownership?: 'managed-profile' | 'external-browser';
  readonly profilePath?: string;
}
export interface BrowserTab {
  readonly tabId: string;
  readonly targetId: string;
  readonly title?: string;
  readonly url?: string;
  readonly active?: boolean;
  readonly label?: string;
}
export interface BrowserCaller { readonly sessionId: string; readonly agentId: string }
export interface BrowserInvocation {
  readonly browser: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly tab?: string;
  readonly frame?: string;
  readonly caller: BrowserCaller;
  readonly generation?: number;
}
export interface BrowserInvocationResult {
  readonly browser: string;
  readonly generation: number;
  readonly executionHost: string;
  readonly runtimeSession: string;
  readonly tab?: string;
  readonly frame?: string;
  readonly result: MCPToolResult;
}
export interface IBrowserControlService {
  readonly _serviceBrand: undefined;
  list(): Promise<{ readonly connections: readonly (BrowserConnectionRecord & { readonly status: BrowserStatus })[]; readonly defaultBrowser?: string }>;
  upsert(id: string, input: BrowserConnectionInput): Promise<BrowserConnectionRecord>;
  remove(id: string): Promise<void>;
  status(id: string): Promise<BrowserStatus>;
  check(id: string, signal?: AbortSignal): Promise<BrowserStatus>;
  connect(id: string, signal?: AbortSignal): Promise<BrowserStatus>;
  disconnect(id: string, signal?: AbortSignal): Promise<BrowserStatus>;
  catalog(id: string, signal?: AbortSignal): Promise<readonly MCPToolDefinition[]>;
  tabs(id: string, signal?: AbortSignal): Promise<readonly BrowserTab[]>;
  invoke(input: BrowserInvocation, signal?: AbortSignal): Promise<BrowserInvocationResult>;
}
export const IBrowserControlService = createDecorator<IBrowserControlService>('browserControlService');
