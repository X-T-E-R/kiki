import type { IAgentGoalService } from '#/agent/goal/goal';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentTaskService } from '#/agent/task/task';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import type { ToolForegroundPolicy } from '#/tool/toolContract';

/** Default foreground wait budget before main and branch agents auto-detach eligible tasks outside goal mode. */
export const MAIN_FOREGROUND_AUTO_DETACH_MS = 15_000;

/** Autonomous watchdog deadline for `instant` foreground tools. */
export const DEFAULT_INSTANT_FOREGROUND_TIMEOUT_MS = 120_000;

/** Autonomous watchdog deadline for `bounded_io` foreground tools without an explicit flow timeout. */
export const DEFAULT_BOUNDED_IO_FOREGROUND_TIMEOUT_MS = 180_000;

/** Hard upper bound for an explicit `foregroundTimeoutMs` override on foreground tools. */
export const MAX_AUTONOMOUS_FOREGROUND_TIMEOUT_MS = 3_600_000;

/** Identifies whether a foreground tool wait is driven by a model tool call or a user-initiated shell command. */
export type ForegroundCallerKind = 'model' | 'user_shell';

/** Resolved foreground-wait and background-detach capabilities for the calling agent scope. */
export interface ForegroundCallerPolicy {
  readonly callerKind: ForegroundCallerKind;
  readonly isRootMain: boolean;
  readonly isMainOrBranch: boolean;
  readonly hasActiveGoal: boolean;
  readonly mainOutsideGoal: boolean;
  readonly canRunInBackground: boolean;
  readonly autoBackgroundMainWait: boolean;
}

/** Resolves the shared foreground-to-background disposition policy for a calling agent. */
export function resolveForegroundCallerPolicy(input: {
  readonly scope?: IAgentScopeContext;
  readonly goals?: IAgentGoalService;
  readonly toolPolicy?: IAgentToolPolicyService;
  readonly callerKind?: ForegroundCallerKind;
}): ForegroundCallerPolicy {
  const callerKind = input.callerKind ?? 'model';
  const isRootMain =
    input.scope !== undefined &&
    input.scope.agentId === MAIN_AGENT_ID &&
    input.scope.parentAgentId === undefined;
  const isMainOrBranch = isRootMain || input.scope?.isBranch === true;
  const hasActiveGoal =
    isRootMain && input.goals?.getGoal().goal?.status === 'active';
  const mainOutsideGoal = isMainOrBranch && !hasActiveGoal;
  const canRunInBackground =
    input.toolPolicy !== undefined &&
    input.toolPolicy.isToolActive('TaskList') &&
    input.toolPolicy.isToolActive('TaskOutput') &&
    input.toolPolicy.isToolActive('TaskStop');
  return {
    callerKind,
    isRootMain,
    isMainOrBranch,
    hasActiveGoal,
    mainOutsideGoal,
    canRunInBackground,
    autoBackgroundMainWait: callerKind === 'model' && mainOutsideGoal && canRunInBackground,
  };
}

/** Caps a foreground wait timeout to the main/branch auto-detach budget when auto-backgrounding applies. */
export function resolveForegroundAutoDetachTimeoutMs(
  requestedTimeoutMs: number | undefined,
  autoBackgroundMainWait: boolean,
): number | undefined {
  if (!autoBackgroundMainWait) return requestedTimeoutMs;
  if (requestedTimeoutMs !== undefined && requestedTimeoutMs > 0) {
    return Math.min(requestedTimeoutMs, MAIN_FOREGROUND_AUTO_DETACH_MS);
  }
  return MAIN_FOREGROUND_AUTO_DETACH_MS;
}

/** Resolves the autonomous finite watchdog deadline for synchronous/bounded foreground tool execution. */
export function resolveAutonomousForegroundTimeoutMs(
  policy: ToolForegroundPolicy,
  explicitTimeoutMs?: number,
): number | undefined {
  if (explicitTimeoutMs !== undefined && Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0) {
    return Math.min(Math.ceil(explicitTimeoutMs), MAX_AUTONOMOUS_FOREGROUND_TIMEOUT_MS);
  }
  switch (policy) {
    case 'instant':
      return DEFAULT_INSTANT_FOREGROUND_TIMEOUT_MS;
    case 'bounded_io':
      return DEFAULT_BOUNDED_IO_FOREGROUND_TIMEOUT_MS;
    case 'detachable_task':
    case 'steerable_wait':
      return undefined;
  }
}

/** Detaches a foreground task immediately when steer fires without cancelling it or racing hard aborts/pauses. */
export function attachForegroundSteerDetach(
  tasks: Pick<IAgentTaskService, 'detach'>,
  taskId: string,
  options: {
    readonly signal: AbortSignal;
    readonly steerSignal?: AbortSignal;
    readonly pauseSignal?: AbortSignal;
  },
): () => void {
  const { signal, steerSignal, pauseSignal } = options;
  if (steerSignal === undefined) return () => {};
  const detach = (): void => {
    if (!signal.aborted && pauseSignal?.aborted !== true) {
      tasks.detach(taskId);
    }
  };
  steerSignal.addEventListener('abort', detach, { once: true });
  if (steerSignal.aborted) detach();
  return () => {
    steerSignal.removeEventListener('abort', detach);
  };
}
