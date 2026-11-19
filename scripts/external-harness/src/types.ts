import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { RegisteredProjectHook } from '../agy-hook-registration.mjs';
import type { McpServerConfig, RegisteredMcpPlugin } from '../agy-mcp-plugin.mjs';
import type { PermissionChannel, PermissionChannelIdentity } from '../agy-permission-hook.mjs';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT = 'engine-default';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const NATIVE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const NATIVE_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/i;
export const LEGACY_NATIVE_STEP = {
  user: 14,
  planner: 15,
  error: 17,
  ephemeral: 90,
  system: 101,
  tool: 132,
} as const;
export const NATIVE_DONE = 3;
export const NATIVE_ERROR = 7;
export const LEGACY_NETWORK_FAILURE = 'There was a network issue connecting to the server, please try again.';
export const NETWORK_RECOVERY_INSTRUCTION =
  'The connection to the model provider was interrupted after your last completed step. ' +
  'Continue the same task from where it stopped. Do not repeat tool calls that already finished.';
export const MAX_CONSECUTIVE_NETWORK_RECOVERIES = 5;
export const NETWORK_RECOVERY_BACKOFF_MS = [1000, 3000, 7000, 15000, 25000] as const;
export const NETWORK_RECOVERY_EXIT_GRACE_MS = 5000;
export const ERROR_RESULT_WATCHDOG_MS = 15000;

export interface AgyError extends Error {
  code?: string;
  details?: Record<string, unknown>;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

export interface AgyStepUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  thinking_tokens?: number;
  total_tokens?: number;
}

export interface AgySubagentChild {
  type_name?: string;
  initial_prompt?: string;
  conversation_id?: string;
  log_uri?: string;
}

export interface AgyStepUpdate {
  step_index?: number;
  step_type: string;
  state?: string;
  usage?: AgyStepUsage;
  text_delta?: string;
  tool_name?: string;
  parameters?: unknown;
  error?: string | { message?: string };
  tool_info?: {
    name?: string;
    parameters?: unknown;
    error?: string | { message?: string };
    output?: unknown;
    result?: unknown;
  };
  subagent_info?: {
    subagents?: AgySubagentChild[];
  };
}

export interface AgyDeniedAction {
  action?: string;
  display_name?: string;
}

export interface AgyResultPayload {
  conversation_id?: string;
  status: string;
  error?: string;
  response?: string;
  num_turns?: number;
  usage?: unknown;
  denied_actions?: AgyDeniedAction[];
}

export interface AgyInitPayload {
  cwd?: string;
  model?: string;
  agent?: string;
  project_id?: string;
  permission_mode?: string;
  tools?: unknown;
}

export interface AgyNativeEvent {
  event: string;
  conversation_id?: string;
  project_id?: string;
  init?: AgyInitPayload;
  step_update?: AgyStepUpdate;
  result?: AgyResultPayload;
  _watchdogSynthesized?: boolean;
  _watchdogConfirmedFlush?: boolean;
}

export interface AgyAccountConfig {
  apiKey: string;
  baseUrl: string;
  modelIds: string[];
}

export interface PromptBlock {
  type: string;
  text?: string;
}

export interface AcpClientProxy {
  notify(method: string, params: Record<string, unknown>): Promise<void>;
}

export interface SteeringItem {
  id: string;
  text: string;
  resolve: (result: { outcome: string; reason?: string }) => void;
}

export interface ToolDetail {
  name?: string;
  state?: string;
}

export interface UnresolvedTool extends ToolDetail {
  toolCallId: string;
}

export interface ActiveTurn {
  client: AcpClientProxy;
  text: string;
  steering: SteeringItem[];
  networkRecoveries: number;
  networkRecoveriesTotal: number;
  segmentStart: number;
  progressSinceRecovery: boolean;
  progressFloor: number;
  recoveryAbort: AbortController;
  usageSteps: Set<number>;
  usage: UsageTotals;
  denied: boolean;
  promptConsumed?: boolean;
  continuationWriter?: ChildProcess;
  lastStepType?: string;
  lastStepState?: string;
  lastStepIndex?: number;
  consecutiveErrorSteps?: number;
  lastErrorStepText?: string;
  finalResponseDone?: boolean;
  finalResponseStepIndex?: number;
  finalResponseText: string;
  steerDeliveryUnknown?: boolean;
  preToolDenied?: Set<string>;
  errorWatchdog?: ReturnType<typeof setTimeout>;
  errorWatchdogToken?: symbol;
  resolve: (value: { stopReason: string; usage?: UsageTotals }) => void;
  reject: (error: unknown) => void;
}

export interface AgySession {
  id: string;
  cwd: string;
  additionalDirectories: string[];
  model: string;
  effort: string;
  permissionMode?: string;
  modelChoices?: string[];
  accountBound: boolean;
  conversationId?: string;
  mcpNamespace?: string;
  mcpServers: McpServerConfig[];
  mcpPlugin?: RegisteredMcpPlugin;
  mcpBound: Set<string>;
  mcpReady: Set<string>;
  permissionIdentity: PermissionChannelIdentity;
  permissionChannel?: PermissionChannel;
  steeringRegistration?: RegisteredProjectHook;
  commandGuidanceRegistration?: RegisteredProjectHook;
  ownedRecoveryDone?: boolean;
  child?: ChildProcess;
  active?: ActiveTurn;
  broken: boolean;
  failure?: string;
  init?: AgyNativeEvent;
  exited?: Promise<void>;
  cleanup?: Promise<void>;
  preparing?: Promise<void>;
  cancelling?: Promise<void>;
  restarting?: boolean;
  releaseResume?: () => Promise<void>;
  drainReceived?: () => Promise<unknown>;
  queueInternalAction?: (action: () => Promise<void> | void) => Promise<void>;
  denialCounts: Map<string, number>;
  toolIds: Map<string, 'pending' | 'settled'>;
  toolDetails: Map<string, ToolDetail>;
  toolInputs: Map<string, unknown>;
}

export interface LegacyToolProof {
  stepIndex: number;
  name: string;
  failed?: boolean;
  error?: string;
}

export interface LegacyRecoveryProof {
  version: number;
  sessionId: string;
  conversationId: string;
  model: string;
  effort: string;
  promptSha256?: string;
  terminalError?: string;
  disclosedCwd?: string;
  additionalDirectories?: string[];
  tools: LegacyToolProof[];
}

export interface SpawnProcessFn {
  (command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
}

export interface StopProcessFn {
  (child: ChildProcess | undefined): Promise<void> | void;
}

export interface AgyBridgeOptions {
  cliPath?: string;
  cliPrefix?: string[];
  auditDir?: string;
  nativeHome?: string;
  model?: string;
  spawnProcess?: SpawnProcessFn;
  stopProcess?: StopProcessFn;
  account?: AgyAccountConfig;
  onAccountExit?: () => void;
  continuationExitGraceMs?: number;
  networkRecoveryBackoffMs?: readonly number[];
  maxConsecutiveNetworkRecoveries?: number;
  errorResultWatchdogMs?: number;
}

export interface AuditRecord {
  at?: string;
  type: string;
  [key: string]: unknown;
}
