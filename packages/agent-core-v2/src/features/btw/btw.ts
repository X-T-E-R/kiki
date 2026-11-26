import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { SessionSeedCarry, SessionSeedMode } from './seedBuilder';

export const TOOL_CALL_DISABLED_MESSAGE =
  'Tool calls are disabled for side questions. Answer with text only.';

export const SIDE_QUESTION_SYSTEM_REMINDER = `
This is a side-channel conversation with the user. You should answer user questions directly based on what you already know.

IMPORTANT:
- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- Do not call workspace or external tools. Ordinary tool calls are disabled and will be rejected (only Merge may fold an explicit summary back into main when requested).
  Even though tool definitions are visible in this request, they exist only
  for technical reasons (prompt cache). You must not use them.
- Respond only with text based on what you already know from the conversation
  and this side-channel conversation.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.
`.trim();

export type BranchInitiator = 'user' | 'agent';

export interface CreateSessionBranchInput {
  readonly parentAgentId?: string;
  readonly initiator?: BranchInitiator;
  readonly task?: string;
  readonly prompt?: string;
  readonly seed?: SessionSeedMode;
  readonly carry?: SessionSeedCarry;
  readonly title?: string;
  readonly name?: string;
  readonly model?: string;
  readonly thinking?: string | null;
  readonly executor?: string;
  readonly cwd?: string;
  readonly toolsLocked?: boolean;
  readonly signal?: AbortSignal;
}

export interface CreateSessionBranchResult {
  readonly branchId: string;
  readonly parentAgentId: string;
  readonly seed: SessionSeedMode;
  readonly title?: string;
  readonly toolsLocked: boolean;
  readonly started: boolean;
}

export interface FoldSessionBranchInput {
  readonly branchId: string;
  readonly summary?: string;
  readonly context?: string;
  readonly asks?: readonly string[];
  readonly done?: boolean;
  readonly fromTool?: boolean;
  readonly operationId?: string;
}

export interface FoldSessionBranchResult {
  readonly branchId: string;
  readonly foldId?: string;
  readonly status: 'merged' | 'prompted';
  readonly done: boolean;
  readonly sealed: boolean;
  readonly handedBackCount: number;
  readonly throughTurnId: number;
}

export interface DiscardSessionBranchInput {
  readonly branchId: string;
}

export interface DiscardSessionBranchResult {
  readonly branchId: string;
  readonly discarded: boolean;
}

export interface SetSessionBranchToolsLockInput {
  readonly branchId: string;
  readonly locked: boolean;
}

export interface SetSessionBranchToolsLockResult {
  readonly branchId: string;
  readonly toolsLocked: boolean;
}

export interface ISessionBranchService {
  readonly _serviceBrand: undefined;

  createBranch(input?: CreateSessionBranchInput): Promise<CreateSessionBranchResult>;
  foldBranch(input: FoldSessionBranchInput): Promise<FoldSessionBranchResult>;
  discardBranch(input: DiscardSessionBranchInput): Promise<DiscardSessionBranchResult>;
  setToolsLocked(input: SetSessionBranchToolsLockInput): Promise<SetSessionBranchToolsLockResult>;
  isBranch(agentId: string): boolean;
  isToolsLocked(agentId: string): boolean;
  isSealed(agentId: string): boolean;
  /** True while a fold of this branch is admitted but has not yet recorded its merge watermark. */
  isFolding(agentId: string): boolean;
  /** Fires with the branch id after an in-flight fold settles, successfully or not. */
  readonly onDidSettleFold: Event<string>;
}

export const ISessionBranchService: ServiceIdentifier<ISessionBranchService> =
  createDecorator<ISessionBranchService>('sessionBranchService');

export interface ISessionBtwService {
  readonly _serviceBrand: undefined;

  start(): Promise<string>;
}

export const ISessionBtwService: ServiceIdentifier<ISessionBtwService> =
  createDecorator<ISessionBtwService>('sessionBtwService');
