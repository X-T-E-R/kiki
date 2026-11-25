import { availableParallelism } from 'node:os';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import {
  attachForegroundSteerDetach,
  resolveForegroundAutoDetachTimeoutMs,
  resolveForegroundCallerPolicy,
} from '#/agent/task/foregroundPolicy';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { LOOP_CONTROL_SECTION, type LoopControl } from '#/agent/loop/configSection';
import { resolveAgentTaskConfig } from '#/agent/task/configSection';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { TASK_WAIT_FLAG_ID } from '#/agent/tools/task/task-wait/flag';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentRuntimeService, inspectAgentRuntime, inspectAgentWorkspaceRoots } from '#/agent/runtimeBinding/agentRuntime';
import { RuntimeWorkspaceView, runtimeShellPathBridge } from '#/runtime/runtimeWorkspaceView';
import { acquireToolRuntime, prepareToolRuntime, resolveSshToolTarget, tagSshResult, toolApprovalRule, hostToolParameters } from '#/agent/tools/os/sshToolTarget';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { getShellPathBridge } from '@kiki/kaos/exec-env';
import { sliceUtf16 } from '#/_base/text/utf16';
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
  type ToolUpdate,
} from '#/tool/toolContract';
import {
  type ToolOutputAccumulatorResult,
  ToolOutputAccumulator,
} from '#/tool/output-accumulator';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { matchesBashRuleSubject } from '#/tool/bash-rule-match';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { userCancellationReason } from '#/_base/utils/abort';
import bashDescriptionTemplate from './bash.md?raw';
import { ProcessTask } from './process-task';
import { bashFileToolHint } from './bashFileToolHints';
import { isConcurrencySafeBash } from './bashConcurrency';
import {
  type BashInput,
  BashInputSchema,
  DEFAULT_BACKGROUND_TIMEOUT_S,
  DEFAULT_TIMEOUT_S,
  IBashTool,
  MAX_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
} from './bash';

const MS_PER_SECOND = 1000;

const SHELL_TIMEOUT_VARS = {
  DEFAULT_TIMEOUT_S,
  DEFAULT_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
  MAX_BACKGROUND_TIMEOUT_S,
};

function timeoutCapS(isBackground: boolean): number {
  return isBackground ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
}

function timeoutClampNote(args: BashInput): string | undefined {
  if (args.timeout === undefined) return undefined;
  const isBackground = args.run_in_background === true;
  if (isBackground && args.disable_timeout === true) return undefined;
  const cap = timeoutCapS(isBackground);
  if (args.timeout <= cap) return undefined;
  return `<system>timeout ${String(args.timeout)} is above the ${String(cap)}-second limit for a ${isBackground ? 'background' : 'foreground'} command, so ${String(cap)} seconds was used.</system>`;
}

function normalizeTimeoutMs(timeout: number | undefined, isBackground: boolean): number {
  const defaultSeconds = isBackground ? DEFAULT_BACKGROUND_TIMEOUT_S : DEFAULT_TIMEOUT_S;
  const value = timeout ?? defaultSeconds;
  return Math.min(value, timeoutCapS(isBackground)) * MS_PER_SECOND;
}

async function disposeProcess(proc: IHostProcess): Promise<void> {
  try {
    await proc.dispose();
  } catch {
  }
}

function renderBashDescription(shellName: string): string {
  return renderPrompt(bashDescriptionTemplate, { ...SHELL_TIMEOUT_VARS, SHELL_NAME: shellName });
}

function withoutBackgroundDescription(description: string): string {
  return `${withoutAutoBackgroundOnTimeout(description)
    .replace(/Use `run_in_background=true`.*?`TaskStop`\. /, '')}\nBackground execution is disabled for this agent; omit run_in_background.`;
}

function withoutAutoBackgroundOnTimeout(description: string): string {
  return description.replace('may move to background on timeout', 'are killed on timeout');
}

const MAX_CONCURRENT_LOCAL_FOREGROUND_BASH = Math.max(4, Math.min(6, Math.floor(availableParallelism() / 3)));
let activeLocalForegroundBash = 0;
const localForegroundBashWaitQueue: Array<() => void> = [];

function releaseLocalForegroundBashCount(): void {
  const next = localForegroundBashWaitQueue.shift();
  if (next !== undefined) {
    next();
  } else {
    activeLocalForegroundBash = Math.max(0, activeLocalForegroundBash - 1);
  }
}

async function acquireLocalForegroundBashSlot(signal: AbortSignal): Promise<(() => void) | undefined> {
  if (signal.aborted) return undefined;
  if (activeLocalForegroundBash >= MAX_CONCURRENT_LOCAL_FOREGROUND_BASH) {
    const acquired = await new Promise<boolean>((resolve) => {
      const onWake = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      };
      const onAbort = (): void => {
        const idx = localForegroundBashWaitQueue.indexOf(onWake);
        if (idx !== -1) localForegroundBashWaitQueue.splice(idx, 1);
        resolve(false);
      };
      localForegroundBashWaitQueue.push(onWake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    if (!acquired) return undefined;
    if (signal.aborted) {
      releaseLocalForegroundBashCount();
      return undefined;
    }
  } else {
    activeLocalForegroundBash += 1;
  }
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    releaseLocalForegroundBashCount();
  };
}

export class BashTool implements IBashTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Bash' as const;
  readonly foregroundPolicy = 'detachable_task' as const;
  get parameters(): Record<string, unknown> {
    return hostToolParameters(BashInputSchema, this.runtime.nativeSshEnabled?.() === true);
  }

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @ref(IAgentScopeContext) private readonly scope?: LiveRef<IAgentScopeContext>,
    @ref(IAgentGoalService) private readonly goals?: LiveRef<IAgentGoalService>,
  ) {}

  private allowBackground(): boolean {
    return resolveForegroundCallerPolicy({
      scope: this.scope?.current,
      goals: this.goals?.current,
      toolPolicy: this.toolPolicy,
    }).canRunInBackground;
  }

  private autoBackgroundOnTimeout(): boolean {
    return resolveAgentTaskConfig(this.config)?.bashAutoBackgroundOnTimeout ?? true;
  }

  private skipUnstartedToolsOnInputEnabled(): boolean {
    return this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.skipUnstartedToolsOnInput === true;
  }

  private detachTimeoutMs(): number {
    const configuredS = resolveAgentTaskConfig(this.config)?.bashTaskTimeoutS;
    if (configuredS === undefined) return DEFAULT_BACKGROUND_TIMEOUT_S * MS_PER_SECOND;
    return configuredS * MS_PER_SECOND;
  }

  get description(): string {
    const base = renderBashDescription(inspectAgentRuntime(this.runtime).environment.shellName);
    const renderedDescription = this.runtime.nativeSshEnabled?.() === true
      ? `${base}\nFor SSH Windows hosts, this tool executes PowerShell with native Windows paths, not Bash. Use PowerShell syntax (Get-ChildItem, $env:NAME; which and && may be unavailable). Results identify the remote platform and shell.`
      : base;
    if (!this.allowBackground()) return withoutBackgroundDescription(renderedDescription);
    const description = this.autoBackgroundOnTimeout()
      ? renderedDescription
      : withoutAutoBackgroundOnTimeout(renderedDescription);
    return this.flags.enabled(TASK_WAIT_FLAG_ID) && this.toolPolicy.isToolActive('TaskWait')
      ? description
      : `${description}\nNo blocking task-wait tool is available to this agent. Keep finite delivery dependencies in bounded foreground calls when possible. TaskOutput does not wait; do not poll it to keep a turn open or claim a detached dependency completed. Use automatic completion notifications when available, and report a remaining dependency honestly if no supported completion path exists.`;
  }

  async resolveExecution(args: BashInput): Promise<ToolExecution> {
    const target = resolveSshToolTarget(args.host, args.cwd);
    const input = { ...args, host: target.host, cwd: target.path };
    const runtime = await prepareToolRuntime(this.runtime, target.host);
    let cwd: string;
    try {
      const view = new RuntimeWorkspaceView(runtime, inspectAgentWorkspaceRoots(this.runtime, this.workspaceCtx));
      cwd = runtime.path.resolve(view.workDir, runtimeShellPathBridge(runtime).fromShellPath(target.path ?? view.workDir));
    } catch (error) {
      return { isError: true, output: error instanceof Error ? error.message : String(error) };
    }
    const shellContext = { runtimeId: runtime.identity.runtimeId, cwd, pathClass: runtime.environment.pathClass };
    const preview = args.command.length > 50 ? `${sliceUtf16(args.command, 0, 50)}…` : args.command;
    return {
      accesses: runtime.environment.shellName === 'bash' && isConcurrencySafeBash(args.command)
        ? ToolAccesses.readAll() : ToolAccesses.all(),
      description: args.run_in_background
        ? `Starting background: ${preview}`
        : `Running: ${preview}`,
      display: {
        kind: 'command',
        command: args.command,
        cwd: runtime.identity.runtimeId.startsWith('ssh:') ? `ssh://${runtime.identity.runtimeId.slice(4)}${cwd}` : cwd,
        description: args.description,
        language: 'bash',
      },
      approvalRule: toolApprovalRule(this.name, args.command, runtime, target.host),
      sessionApprovalRule: JSON.stringify(['Bash', shellContext.runtimeId, cwd, args.command]),
      shellContext,
      matchesRule: (ruleArgs, mode = 'all') => matchesBashRuleSubject(ruleArgs, args.command, mode),
      execute: async ({ signal, steerSignal, skipUnstartedToolsOnInput, onUpdate, onForegroundTaskStart, callerKind, foregroundStartedAt }) => {
        const result = await this.execution(input, signal, steerSignal, onUpdate, onForegroundTaskStart, callerKind, foregroundStartedAt, skipUnstartedToolsOnInput);
        const enabled = resolveAgentTaskConfig(this.config)?.bashFileToolHints === true;
        const hint = target.host === undefined && !this.runtime.inspect().identity.runtimeId.startsWith('ssh:')
          ? bashFileToolHint(args.command, this.ctx, enabled) : undefined;
        const withHint = hint !== undefined && typeof result.output === 'string'
          ? { ...result, output: `${result.output}\n${hint}` }
          : result;
        const clampNote = timeoutClampNote(args);
        const noted = clampNote === undefined
          ? withHint
          : { ...withHint, note: withHint.note === undefined ? clampNote : `${withHint.note}\n${clampNote}` };
        return tagSshResult(noted, runtime);
      },
    };
  }

  private spawn(
    processService: IHostProcessService,
    env: HostEnvironmentInfo,
    effectiveCwd: string,
    command: string,
    local: boolean,
  ): Promise<IHostProcess> {
    if (!local && env.shellName === 'powershell') {
      return processService.spawn(env.shellPath, ['-Command', command], { cwd: effectiveCwd, env: { NO_COLOR: '1', TERM: 'dumb' } });
    }
    const shellCwd = getShellPathBridge(env).toShellPath(effectiveCwd);
    const shellCommand = `cd ${shellQuote(shellCwd)} && ${command}`;
    const noninteractiveEnv: Record<string, string> = {
      NO_COLOR: '1',
      TERM: 'dumb',
      GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
      SHELL: env.shellPath,
    };

    return processService.spawn(env.shellPath, ['-c', shellCommand], {
      env: noninteractiveEnv,
      ownedProcessTree: env.osKind === 'Windows',
      ownedProcessLifetime: local && env.osKind === 'Windows' ? 'owner' : undefined,
    });
  }

  private async execution(
    args: BashInput,
    signal: AbortSignal,
    steerSignal?: AbortSignal,
    onUpdate?: (update: ToolUpdate) => void,
    onForegroundTaskStart?: (taskId: string, options?: { readonly steerDetachable?: boolean }) => void,
    callerKind?: 'model' | 'user_shell',
    foregroundStartedAt?: number,
    skipUnstartedToolsOnInput?: boolean,
  ): Promise<ExecutableToolResult> {
    const callStartedAt = foregroundStartedAt ?? Date.now();
    const validationError = this.validateRunRequest(args, signal);
    if (validationError !== undefined) return validationError;

    const startsInBackground = args.run_in_background === true;
    const steer = !startsInBackground && this.allowBackground() ? steerSignal : undefined;
    const skipUnstartedOnInput = skipUnstartedToolsOnInput ?? this.skipUnstartedToolsOnInputEnabled();
    if (skipUnstartedOnInput && !startsInBackground && !signal.aborted && steer?.aborted === true) {
      return {
        isError: false,
        output: 'New input arrived before this command started; it was not started. Read the new input before deciding whether to run it.',
      };
    }
    const foregroundTimeoutMs = normalizeTimeoutMs(args.timeout, false);
    const callerPolicy = resolveForegroundCallerPolicy({
      scope: this.scope?.current,
      goals: this.goals?.current,
      toolPolicy: this.toolPolicy,
      callerKind,
    });
    const autoBackgroundEnabled = callerPolicy.canRunInBackground && this.autoBackgroundOnTimeout();
    const effectiveForegroundTimeoutMs =
      resolveForegroundAutoDetachTimeoutMs(
        foregroundTimeoutMs,
        !startsInBackground && callerPolicy.autoBackgroundMainWait && autoBackgroundEnabled,
      ) ?? foregroundTimeoutMs;
    const description = taskDescription(args);
    const timeoutMs = startsInBackground
      ? args.disable_timeout
        ? undefined
        : normalizeTimeoutMs(args.timeout, true)
      : effectiveForegroundTimeoutMs;

    const builder = new ToolOutputAccumulator();
    await prepareToolRuntime(this.runtime, args.host);
    const lease = args.host === undefined
      ? this.runtime.acquire(['process']) : acquireToolRuntime(this.runtime, args.host, ['process']);
    const isLocalForeground = !startsInBackground && lease.runtime.identity.runtimeId === 'local';
    let releaseBashSlot: () => void = () => {};
    if (isLocalForeground) {
      const slotSignal = steer === undefined ? signal : AbortSignal.any([signal, steer]);
      const acquired = await acquireLocalForegroundBashSlot(slotSignal);
      if (acquired === undefined) {
        if (signal.aborted) {
          lease.dispose();
          return { isError: true, output: 'Aborted before command started' };
        }
        if (skipUnstartedOnInput && steer?.aborted === true) {
          lease.dispose();
          return {
            isError: false,
            output: 'New input arrived before this command started; it was not started. Read the new input before deciding whether to run it.',
          };
        }
      } else {
        releaseBashSlot = acquired;
        if (signal.aborted) {
          releaseBashSlot();
          lease.dispose();
          return { isError: true, output: 'Aborted before command started' };
        }
        if (skipUnstartedOnInput && steer?.aborted === true) {
          releaseBashSlot();
          lease.dispose();
          return {
            isError: false,
            output: 'New input arrived before this command started; it was not started. Read the new input before deciding whether to run it.',
          };
        }
        if (steer?.aborted === true) {
          releaseBashSlot();
          releaseBashSlot = () => {};
        }
      }
    } else if (skipUnstartedOnInput && !startsInBackground && !signal.aborted && steer?.aborted === true) {
      lease.dispose();
      return {
        isError: false,
        output: 'New input arrived before this command started; it was not started. Read the new input before deciding whether to run it.',
      };
    }
    let proc: IHostProcess;
    let command: string;
    let isReadOnlyBash = false;
    try {
      const view = new RuntimeWorkspaceView(lease.runtime, inspectAgentWorkspaceRoots(this.runtime, this.workspaceCtx));
      const env = lease.runtime.environment;
      isReadOnlyBash = env.shellName === 'bash' && isConcurrencySafeBash(args.command);
      command = env.osKind === 'Windows' && env.shellName === 'bash' ? rewriteWindowsNullRedirect(args.command) : args.command;
      const effectiveCwd = view.resolve(args.cwd ?? view.workDir, view.workDir, this.permissionMode.mode === 'yolo');
      proc = lease.track(await this.spawn(lease.runtime.process!, env, effectiveCwd, command, lease.runtime.identity.runtimeId === 'local'));
    } catch (error) {
      releaseBashSlot();
      lease.dispose();
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
    closeProcessStdin(proc);

    let collectForegroundOutput = !startsInBackground;
    let foregroundOutputPersisted = false;
    let foregroundTaskId: string | undefined;
    const onProcessOutput = startsInBackground
      ? undefined
      : (kind: 'stdout' | 'stderr', text: string): void => {
          if (!collectForegroundOutput) return;
          onUpdate?.({ kind, text });
          builder.write(text);
          if (
            !foregroundOutputPersisted &&
            builder.totalChars > DEFAULT_TOOL_RESULT_MAX_CHARS &&
            foregroundTaskId !== undefined
          ) {
            this.tasks.persistOutput(foregroundTaskId);
            foregroundOutputPersisted = true;
          }
        };

    if (!startsInBackground && signal.aborted) {
      collectForegroundOutput = false;
      releaseBashSlot();
      await killSpawnedProcess(proc);
      lease.dispose();
      return {
        isError: true,
        output: 'Aborted before command started',
      };
    }

    const preRegisterElapsedMs = Math.max(0, Date.now() - callStartedAt);
    const steeredAfterSpawn = !startsInBackground && !signal.aborted && steer?.aborted === true;
    const remainingFgTimeoutMs = effectiveForegroundTimeoutMs - preRegisterElapsedMs;
    const autoDetachedBeforeRegister =
      !startsInBackground &&
      !signal.aborted &&
      autoBackgroundEnabled &&
      callerPolicy.autoBackgroundMainWait &&
      remainingFgTimeoutMs <= 0;
    const startDetached = startsInBackground || steeredAfterSpawn || autoDetachedBeforeRegister;
    const registeredTimeoutMs = startDetached
      ? (startsInBackground ? timeoutMs : this.detachTimeoutMs())
      : (!startsInBackground && autoBackgroundEnabled && callerPolicy.autoBackgroundMainWait
          ? Math.max(1, remainingFgTimeoutMs)
          : timeoutMs);

    let taskId: string;
    try {
      taskId = this.tasks.registerTask(
        new ProcessTask(proc, command, description, onProcessOutput, () => {
          releaseBashSlot();
          if (!isReadOnlyBash) lease.runtime.pathIndex?.notifyExternalChange();
          lease.dispose();
        }),
        {
          detached: startDetached,
          lifetime: startsInBackground ? (args.lifetime ?? 'finite') : undefined,
          timeoutMs: registeredTimeoutMs,
          detachTimeoutMs: this.detachTimeoutMs(),
          autoBackgroundOnTimeout: autoBackgroundEnabled,
          signal: startDetached ? undefined : signal,
        },
      );
      foregroundTaskId = startDetached ? undefined : taskId;
    } catch (error) {
      collectForegroundOutput = false;
      releaseBashSlot();
      await killSpawnedProcess(proc);
      lease.dispose();
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    if (!startDetached) {
      if (callerPolicy.canRunInBackground) onForegroundTaskStart?.(taskId);
      else onForegroundTaskStart?.(taskId, { steerDetachable: false });
    }

    if (startDetached) {
      collectForegroundOutput = false;
      const labels = startsInBackground
        ? {
            title: 'Background task started',
            brief: `Started ${taskId}`,
          }
        : autoDetachedBeforeRegister
          ? {
              title: 'Command timed out and moved to background',
              brief: `Backgrounded ${taskId} after timeout`,
            }
          : {
              title: 'New input moved task to background',
              brief: `Backgrounded ${taskId} on new input`,
            };
      return this.backgroundStartedResult(taskId, proc, description, labels, startsInBackground ? undefined : builder);
    }

    const disposeSteerDetach = attachForegroundSteerDetach(this.tasks, taskId, {
      signal,
      steerSignal: steer,
    });
    try {
      const release = await this.tasks.waitForForegroundRelease(taskId);
      if (release === 'detached' || release === 'timeout_detached') {
        collectForegroundOutput = false;
        const steered = release === 'detached' && steer?.aborted === true;
        const labels =
          release === 'timeout_detached'
            ? {
                title: 'Command timed out and moved to background',
                brief: `Backgrounded ${taskId} after timeout`,
              }
            : steered
              ? {
                  title: 'New input moved task to background',
                  brief: `Backgrounded ${taskId} on new input`,
                }
              : {
                  title: 'Task moved to background',
                  brief: `Backgrounded ${taskId}`,
                };
        return this.backgroundStartedResult(
          taskId,
          proc,
          description,
          labels,
          builder,
          steered ? 'steer_detached' : 'foreground_detached',
        );
      }

      return await this.foregroundCompletionResult(taskId, proc, builder, foregroundTimeoutMs);
    } finally {
      disposeSteerDetach();
      collectForegroundOutput = false;
      releaseBashSlot();
    }
  }

  private validateRunRequest(
    args: BashInput,
    signal: AbortSignal,
  ): ExecutableToolResult | undefined {
    if (signal.aborted) return { isError: true, output: 'Aborted before command started' };
    if (args.command.length === 0) return { isError: true, output: 'Command cannot be empty.' };
    if (args.run_in_background !== true) return undefined;
    if (!this.allowBackground()) {
      return {
        isError: true,
        output:
          'Background execution is not available for this agent because TaskOutput and TaskStop are not enabled.',
      };
    }
    return undefined;
  }

  private async foregroundCompletionResult(
    taskId: string,
    proc: IHostProcess,
    builder: ToolOutputAccumulator,
    foregroundTimeoutMs: number,
  ): Promise<ExecutableToolResult> {
    const current = this.tasks.getTask(taskId);
    const exitCode = current?.kind === 'process' ? current.exitCode : proc.exitCode;
    let result: ToolOutputAccumulatorResult;
    if (current?.cleanupPending === true) {
      const reason =
        current.stopReason ??
        `Task cleanup is unconfirmed; retry TaskStop for the same task (${taskId}) before replacing its work.`;
      const detail = reason.includes(taskId) ? reason : `task_id: ${taskId}\n${reason}`;
      result = builder.error(detail, { brief: reason });
    } else if (current?.status === 'timed_out') {
      const timeoutLabel = formatTimeoutLabel(foregroundTimeoutMs);
      result = builder.error(`Command killed by timeout (${timeoutLabel})`, {
        brief: `Killed by timeout (${timeoutLabel})`,
      });
    } else if (
      current?.status === 'killed' &&
      current.stopReason === userCancellationReason().message
    ) {
      result = builder.error('Interrupted by user', { brief: 'Interrupted by user' });
    } else if (
      (current?.status === 'failed' || current?.status === 'killed') &&
      current.stopReason !== undefined
    ) {
      result = builder.error(current.stopReason, { brief: current.stopReason });
    } else if (exitCode === 0) {
      result = builder.ok('Command executed successfully.');
    } else {
      if (builder.nChars === 0) builder.write(`Process exited with code ${String(exitCode)}`);
      result = builder.error(`Command failed with exit code: ${String(exitCode)}.`, {
        brief: `Failed with exit code: ${String(exitCode)}`,
      });
    }
    return this.addForegroundOutputReference(taskId, result, builder.totalChars);
  }

  private async addForegroundOutputReference(
    taskId: string,
    result: ToolOutputAccumulatorResult,
    totalChars: number,
  ): Promise<ExecutableToolResult> {
    if (totalChars <= DEFAULT_TOOL_RESULT_MAX_CHARS) return result;
    const output = await this.tasks.getOutputSnapshot(taskId, 0);
    if (!output.fullOutputAvailable || output.outputPath === undefined) {
      return result;
    }

    const taskInfo = `task_id: ${taskId}\noutput_size_bytes: ${String(output.outputSizeBytes)}`;
    const existingSuffix = result.spill?.suffix;
    return {
      ...result,
      spill: {
        outputPath: output.outputPath,
        totalChars,
        suffix: existingSuffix !== undefined ? `${existingSuffix}\n${taskInfo}` : taskInfo,
      },
    };
  }

  private backgroundStartedResult(
    taskId: string,
    proc: IHostProcess,
    description: string,
    labels: { title: string; brief: string },
    builder = new ToolOutputAccumulator(),
    scenario: 'background_started' | 'foreground_detached' | 'steer_detached' = 'background_started',
  ): ExecutableToolResult {
    const status = this.tasks.getTask(taskId)?.status ?? 'running';
    const metadata =
      `task_id: ${taskId}\n` +
      `pid: ${String(proc.pid)}\n` +
      `description: ${description}\n` +
      `status: ${status}\n` +
      `automatic_notification: true\n` +
      this.nextStepLines(scenario);

    const foregroundResult = builder.ok('');
    const foregroundOutput = foregroundResult.output.length > 0 ? foregroundResult.output : '';
    const result: ExecutableToolResult & {
      readonly brief: string;
    } = {
      isError: false,
      allowsTurnEndWithSendMessage: scenario === 'background_started' ? true : undefined,
      output:
        foregroundOutput.length === 0
          ? metadata
          : `${metadata}\n\nforeground_output:\n${foregroundOutput}`,
      brief: labels.brief,
    };
    return result;
  }

  private nextStepLines(
    scenario: 'background_started' | 'foreground_detached' | 'steer_detached',
  ): string {
    if (scenario === 'steer_detached') {
      return 'next_step: New input ended this foreground wait. Read the new input before deciding what to do next; the command continues in the background and completion arrives automatically.\n';
    }
    if (scenario === 'foreground_detached') {
      return 'next_step: Continue your current work; completion arrives automatically.\n';
    }
    return 'next_step: Completion arrives automatically.\n';
  }
}

registerAgentToolService(IBashTool, BashTool, {
  name: 'Bash',
  domain: 'os/backends',
  requiredRuntimeCapabilities: ['process'],
});

function formatTimeoutLabel(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? `${String(timeoutMs / 1000)}s` : `${String(timeoutMs)}ms`;
}

function taskDescription(args: BashInput): string {
  const explicit = args.description?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const preview = args.command.length > 60 ? `${sliceUtf16(args.command, 0, 60)}…` : args.command;
  return `Bash: ${preview}`;
}

function closeProcessStdin(proc: IHostProcess): void {
  try {
    proc.stdin.end();
  } catch {
  }
}

async function killSpawnedProcess(proc: IHostProcess): Promise<void> {
  try {
    await proc.kill('SIGTERM');
  } catch {
  } finally {
    await disposeProcess(proc);
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

const WINDOWS_NUL_REDIRECT = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(WINDOWS_NUL_REDIRECT, '$1/dev/null');
}
