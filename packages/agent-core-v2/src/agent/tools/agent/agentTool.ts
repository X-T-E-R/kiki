import type { Runtime } from '#/runtime/runtime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { resolvePathAccessPath } from '#/tool/path-access';
import { loadDispatchProfileFile, inheritProfileFileSources } from '#/session/dispatch/profileFile';
import { evaluateDispatchAdmission, tightenDispatchLaunchPolicy, type DispatchLaunchPolicy } from '#/session/dispatch/launchPolicy';
import {
  isAbortError,
  isUserCancellation,
  userCancellationReason,
} from '#/_base/utils/abort';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesStringRuleSubject } from '#/tool/rule-match';
import {
  IAgentTaskService,
  type RegisterAgentTaskOptions,
} from '#/agent/task/task';
import { IAgentProfileService } from '#/agent/profile/profile';
import { isAgentNotifyAvailable } from '#/agent/tools/agent-notify/agent-notify';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import type {
  AgentProfile,
  AgentProfileRouteCatalogEntry,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { AgentProfileCatalogSnapshot } from '#/app/agentProfileCatalog/scopedAgentProfile';
import { evaluateSubagentDispatchDecision, type SubagentSelectionOrigin } from '#/app/agentProfileCatalog/subagentDispatch';
import { projectSubagentModelCatalog } from '#/session/subagent/modelCatalogProjection';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IModelService } from '#/kosong/model/model';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  subagentParentAgentId,
  subagentProfileName,
} from '#/session/agentLifecycle/subagentMetadata';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import {
  AGENTS_SECTION,
  isParentNotifyEnabled,
  type AgentsConfig,
} from '#/session/agentCollaboration/configSection';
import { COLLABORATION_TASK_NAME_LABEL } from '#/session/agentCollaboration/registry';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  ISessionDispatchService,
  type DispatchChild,
  type DispatchRun,
} from '#/session/dispatch/dispatch';
import { emitAgentRunSpawned, mirrorAgentRun, SubagentStarted } from '#/session/subagent/mirrorAgentRun';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  addSubagentBindingSchemaConstraints,
  buildSubagentModelDescriptions,
  formatSubagentTimeoutDescription,
  normalizeSubagentBindingValue,
  resolveDefaultSubagentProfileName,
  resolveDefaultSubagentTarget,
  resolveSubagentTimeoutMs,
  withDispatchPolicyDefaults,
} from '#/session/subagent/configSection';
import {
  GENERIC_SUBAGENT_PROFILE,
  GENERIC_SUBAGENT_PROFILE_NAME,
} from '#/session/subagent/genericProfile';
import {
  BACKGROUND_AGENT_UNAVAILABLE,
  ISubagentTool,
  mainProfileSubagentNotice,
  RESUME_WITH_TYPE_UNAVAILABLE,
  RESUMED_LABEL,
  SUBAGENT_STOPPED_MESSAGE,
  SubagentToolInputSchema,
  USER_INTERRUPTED_SUBAGENT_MESSAGE,
  type SubagentToolInput,
} from './agent';
import { SubagentTask, type SubagentHandle } from './subagent-task';
import {
  compactProfileDescriptions,
  compactRouteDescriptions,
} from './subagentDescription';

import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { IAgentStateService } from '#/agent/state/agentState';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';
import { IAgentMemorySnapshot } from '#/app/memory/memorySnapshot';

import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md?raw';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md?raw';
import AGENT_DESCRIPTION_BASE from './agent.md?raw';

const SUBAGENT_TOOL_PARAMETERS = toInputJsonSchema(SubagentToolInputSchema, (schema) => {
  addSubagentBindingSchemaConstraints(schema);
});
const PARENT_NOTIFY_DESCRIPTION =
  'Subagents may use AgentNotify only when the parent must change course before their final result; routine progress belongs in the final receipt.';
export { buildProfileDescriptions } from './subagentDescription';

export class SubagentTool implements ISubagentTool {
  declare readonly _serviceBrand: undefined;
  readonly name: string = 'AgentRun';

  readonly parameters: Record<string, unknown> = SUBAGENT_TOOL_PARAMETERS;

  private readonly callerAgentId: string;
  private readonly canRunInBackground: () => boolean;
  private readonly notifiedMainProfiles = new Set<string>();
  private catalogReady = false;
  private frozenDescription: string | undefined;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionDispatchService private readonly dispatch: ISessionDispatchService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ILogService private readonly log: ILogService,
    @IConfigService private readonly config: IConfigService,
    @IModelService private readonly models: IModelService,
    @ISessionTodoService private readonly todos: ISessionTodoService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentMemorySnapshot private readonly memorySnapshot: IAgentMemorySnapshot,
  ) {
    this.callerAgentId = scopeContext.agentId;
    this.canRunInBackground = () =>
      this.toolPolicy.isToolActive('TaskList') &&
      this.toolPolicy.isToolActive('TaskOutput') &&
      this.toolPolicy.isToolActive('TaskStop');
    void this.catalog.ready.then(() => {
      this.catalogReady = true;
    });
  }

  get description(): string {
    if (!this.catalogReady) return this.buildDescription();
    return this.frozenDescription ??= this.buildDescription();
  }

  private buildDescription(): string {
    const backgroundDescription = this.canRunInBackground()
      ? AGENT_BACKGROUND_DESCRIPTION
      : AGENT_BACKGROUND_DISABLED_DESCRIPTION;
    const timeoutDescription = formatSubagentTimeoutDescription(
      resolveSubagentTimeoutMs(this.config),
    );
    const agentDescription = isParentNotifyEnabled(
      this.config.get<AgentsConfig>(AGENTS_SECTION),
    )
      ? AGENT_DESCRIPTION_BASE
      : AGENT_DESCRIPTION_BASE.replace(`\n\n${PARENT_NOTIFY_DESCRIPTION}`, '');
    let description = `${agentDescription}\n\nSubagent timeout: ${timeoutDescription}.\n\n${backgroundDescription}`;
    const { caller: own } = this.dispatchCatalog();
    const targets = this.projectedTargets();
    const preferred = targets.profiles.filter((profile) =>
      evaluateSubagentDispatchDecision(this.catalog, own, profile.name).recommendationStatus === 'preferred');
    const ordered = [...preferred, ...targets.profiles.filter((profile) => !preferred.includes(profile))];
    const typeLines = compactProfileDescriptions(ordered);
    if (typeLines) {
      description += `\n\nAvailable profiles (pass via profile; preferred first):\n${typeLines}`;
      if (ordered.length > 8) description += `\n${ordered.length - 8} more profiles omitted; use an exact profile name supplied by the user.`;
    }
    const routeLines = compactRouteDescriptions(targets.routes);
    if (routeLines) description += `\n\nAvailable routes (pass via route):\n${routeLines}`;
    const modelLines = buildSubagentModelDescriptions(targets.aliases.slice(0, 4));
    if (modelLines !== undefined) description += `\n\n${modelLines}`;
    return description;
  }

  dispatchCatalog(): import('./subagentCapabilities').SubagentCapabilityCatalog {
    const caller = withDispatchPolicyDefaults(this.config, this.profile.data(),
      this.callerAgentId === 'main' ? 'main' : 'sub');
    return {
      catalog: this.catalog,
      caller,
      profiles: this.catalogProfiles(),
      routes: this.catalogRoutes(),
      snapshot: caller.profileDefinitionId === undefined ? undefined : this.catalogSnapshot(),
    };
  }

  visibleProfileDescriptions(): ReadonlyMap<string, { readonly line: string; readonly signature: string }> {
    return new Map(this.projectedTargets().profiles.map((profile) => [
      profile.name,
      { line: compactProfileDescriptions([profile]), signature: JSON.stringify(profile) },
    ]));
  }

  private projectedTargets(): ReturnType<typeof projectSubagentModelCatalog> {
    const { caller, profiles, routes, snapshot } = this.dispatchCatalog();
    return projectSubagentModelCatalog(
      this.catalog,
      caller,
      { profiles, routes, snapshot },
      this.models,
      this.config,
    );
  }

  private catalogProfiles(): readonly AgentProfile[] {
    return this.catalog.list().filter((profile) => profile.main !== true);
  }

  private catalogRoutes(): readonly AgentProfileRouteCatalogEntry[] {
    return this.catalog.listRoutes?.() ?? [];
  }

  private catalogSnapshot(): AgentProfileCatalogSnapshot {
    const snapshot = this.catalog.snapshot?.() ?? {
      publicProfiles: new Map(this.catalog.list().map((profile) => [profile.name, profile])),
      defaultProfile: this.catalog.getDefault(),
      routes: new Map(),
      scopedBindings: new Map(),
      sourceDefinitions: new Map(),
      dependencyIndex: new Map(),
      diagnostics: [],
    };
    return inheritProfileFileSources(this.profile.data(), this.catalog, snapshot) ?? snapshot;
  }

  async resolveExecution(args: SubagentToolInput): Promise<ToolExecution> {
    const capturedLaunchPolicy = this.dispatch.readLaunchPolicy(this.callerAgentId);
    const admission = evaluateDispatchAdmission(capturedLaunchPolicy, args.resume?.trim() ? 'resume' : 'spawn');
    if (!admission.allowed) return { output: admission.reason!, isError: true };
    const requestedProfileName = args.profile?.length ? args.profile : undefined;
    const requestedRoute = args.route?.trim();
    const resumeAgentId = args.resume?.trim();

    if (
      resumeAgentId !== undefined &&
      resumeAgentId.length > 0 &&
      requestedProfileName !== undefined
    ) {
      return { output: RESUME_WITH_TYPE_UNAVAILABLE, isError: true };
    }
    if (resumeAgentId !== undefined && resumeAgentId.length > 0 && requestedRoute !== undefined) {
      return { output: 'Cannot set route when resuming an existing agent.', isError: true };
    }
    if (args.profile_file !== undefined && (resumeAgentId || requestedProfileName || requestedRoute)) {
      return { output: 'profile_file is only for a new agent and is mutually exclusive with profile and route.', isError: true };
    }

    const profileNameForDisplay =
      resumeAgentId !== undefined && resumeAgentId.length > 0
        ? (await this.resumeProfileName(resumeAgentId)) ?? RESUMED_LABEL
        : args.profile_file ?? requestedRoute ?? requestedProfileName
          ?? resolveDefaultSubagentProfileName(this.config) ?? RESUMED_LABEL;
    const prefix = args.background === true ? 'Launching background' : 'Launching';
    if (resumeAgentId === undefined || resumeAgentId.length === 0) await this.catalog.ready;
    const snapshot = this.catalog.snapshot?.();
    let filePath: string | undefined;
    if (args.profile_file !== undefined) {
      const runtime = this.runtime.inspect();
      const view = new RuntimeWorkspaceView(runtime, this.workspace);
      filePath = resolvePathAccessPath(args.profile_file, {
        env: runtime.environment,
        workspace: { workspaceDir: view.workDir, additionalDirs: view.additionalDirs },
        operation: 'read',
      });
      view.resolve(filePath, view.workDir, true);
    }
    return {
      description: `${prefix} ${profileNameForDisplay} agent: ${args.description}`,
      accesses: filePath === undefined ? ToolAccesses.none() : ToolAccesses.readFile(filePath),
      display: {
        kind: 'agent_call',
        agent_name: profileNameForDisplay,
        prompt: args.prompt,
        background: args.background,
      },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesStringRuleSubject(ruleArgs, profileNameForDisplay),
      execute: async (ctx) => this.withStandingDirectives(await this.execution(filePath === undefined ? args : { ...args, profile_file: filePath }, ctx, snapshot, capturedLaunchPolicy)),
    };
  }

  private directiveEpoch: number | undefined;
  private directiveEchoes = 0;

  private async withStandingDirectives(result: ExecutableToolResult): Promise<ExecutableToolResult> {
    if (result.isError || (this.directiveEpoch === this.states.get(contextWindowEpochKey) && this.directiveEchoes >= 3)) return result;
    const directives = this.todos.getNotes(this.callerAgentId).notes?.directives?.trim();
    const text = directives || (await this.memorySnapshot.liveSessionEntries())
      .filter((entry) => entry.type === 'feedback')
      .map((entry) => `[${entry.id}] ${entry.title}`).join('; ');
    if (!text) return result;
    const epoch = this.states.get(contextWindowEpochKey);
    if (epoch !== this.directiveEpoch) { this.directiveEpoch = epoch; this.directiveEchoes = 0; }
    if (this.directiveEchoes >= 3) return result;
    this.directiveEchoes++;
    const suffix = `\n\nStanding directives in effect: ${text.slice(0, 300)}`;
    return { ...result, output: typeof result.output === 'string' ? result.output + suffix : [...result.output, { type: 'text', text: suffix }] };
  }

  private defaultDispatchSelection(): {
    readonly profileName: string;
    readonly resolvedProfile?: AgentProfile;
    readonly selectionOrigin: SubagentSelectionOrigin;
  } {
    const target = resolveDefaultSubagentTarget(this.config);
    if (target.kind === 'generic') {
      return {
        profileName: GENERIC_SUBAGENT_PROFILE_NAME,
        resolvedProfile: GENERIC_SUBAGENT_PROFILE,
        selectionOrigin: 'configured-fallback',
      };
    }
    if (target.kind === 'profile') {
      return { profileName: target.name, selectionOrigin: 'configured-fallback' };
    }
    throw new Error2(
      ErrorCodes.PROFILE_UNKNOWN,
      'No agent profile specified and [subagent].default_profile is explicitly blank. Pass an explicit profile, route, or profile_file, or configure a default profile name.',
    );
  }

  private async resumeProfileName(ref: string): Promise<string | undefined> {
    const target = this.lifecycle.get(ref);
    if (target !== undefined) return target.accessor.get(IAgentProfileService).data().profileName;
    const agents = (await this.metadata.read()).agents ?? {};
    const matches = Object.entries(agents).filter(([agentId, meta]) =>
      subagentParentAgentId(meta) === this.callerAgentId &&
      (agentId === ref || meta.labels?.[COLLABORATION_TASK_NAME_LABEL] === ref),
    );
    if (matches.length !== 1) return undefined;
    return subagentProfileName(matches[0]![1]);
  }

  private dispatchedMainProfile(child: DispatchChild, fileProfile: AgentProfile | undefined): boolean {
    if (child.effectiveProfile !== undefined) return child.effectiveProfile.main === true;
    if (fileProfile !== undefined) return fileProfile.main === true;
    return this.catalog.get(child.profileName)?.main === true;
  }

  private mainProfileNotice(handle: SubagentHandle): string | undefined {
    if (handle.mainProfile !== true || this.notifiedMainProfiles.has(handle.profileName)) return undefined;
    this.notifiedMainProfiles.add(handle.profileName);
    return mainProfileSubagentNotice(handle.profileName);
  }

  private withMainProfileNotice(handle: SubagentHandle, output: string): string {
    const notice = this.mainProfileNotice(handle);
    return notice === undefined ? output : `${output}\n${notice}`;
  }

  private async launch(
    args: SubagentToolInput,
    toolCallId: string,
    parentTurnId: number,
    controller: AbortController,
    runtime: Runtime,
    snapshot: AgentProfileCatalogSnapshot | undefined,
    capturedLaunchPolicy: DispatchLaunchPolicy,
    runTask: Promise<string | undefined>,
  ): Promise<SubagentHandle> {
    const policy = tightenDispatchLaunchPolicy(this.dispatch.readLaunchPolicy(this.callerAgentId), capturedLaunchPolicy);
    const admission = evaluateDispatchAdmission(policy, args.resume?.trim() ? 'resume' : 'spawn');
    if (!admission.allowed) throw new Error2(ErrorCodes.REQUEST_INVALID, admission.reason!);
    const requester = this.lifecycle.get(this.callerAgentId);
    if (requester === undefined) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_FOUND,
        `Caller agent "${this.callerAgentId}" does not exist`,
        { details: { agentId: this.callerAgentId } },
      );
    }
    const resumeRef = args.resume?.trim();
    const caller = withDispatchPolicyDefaults(this.config, this.profile.data(),
      this.callerAgentId === 'main' ? 'main' : 'sub');
    const fileTarget = args.profile_file === undefined ? undefined
      : await loadDispatchProfileFile(args.profile_file, runtime, this.workspace, this.catalog,
          { ...caller, subagentPolicy: caller.subagentPolicy ?? caller.defaultPolicy }, snapshot);
    const fileProfile = fileTarget === undefined
      ? undefined
      : fileTarget.snapshot.publicProfiles.get(fileTarget.profileName);
    const defaultTarget = resumeRef !== undefined && resumeRef.length > 0
      || fileTarget !== undefined
      || (args.profile?.length ?? 0) > 0
      || args.route !== undefined
      ? undefined
      : this.defaultDispatchSelection();
    const run: DispatchRun =
      resumeRef !== undefined && resumeRef.length > 0
        ? await this.dispatch.runOnExisting(
            await this.dispatch.resolveOwnedChild(
              { kind: 'agent', agentId: this.callerAgentId },
              resumeRef,
            ),
            args.prompt,
            {
              signal: controller.signal, requesterAgentId: this.callerAgentId, capturedLaunchPolicy: policy,
              allowParentNotify: args.allow_parent_notify,
              bindingOverride: args.model_alias === undefined && args.effort === undefined ? undefined : {
                modelAlias: args.model_alias, thinkingEffort: args.effort, allowModelChange: args.allow_model_change,
              },
            },
          )
        : await this.dispatch.launch({
            capturedLaunchPolicy: policy,
            delegator: { kind: 'agent', agentId: this.callerAgentId },
            requesterAgentId: this.callerAgentId,
            requesterProfileData: this.profile.data(),
            resolvedProfile: defaultTarget?.resolvedProfile,
            profileName: fileTarget?.profileName ?? (args.profile?.length ? args.profile : defaultTarget?.profileName),
            routeId: args.route,
            selectionKind: fileTarget === undefined ? undefined : 'profile_file',
            selectionOrigin: defaultTarget?.selectionOrigin,
            snapshot: fileTarget?.snapshot ?? snapshot,
            message: args.prompt,
            name: args.name?.trim(),
            modelAlias: normalizeSubagentBindingValue(args.model_alias, 'model_alias'),
            thinkingEffort: normalizeSubagentBindingValue(args.effort, 'effort'),
            allowParentNotify: args.allow_parent_notify,
            runtime,
            workDir: this.workspace.workDir,
            signal: controller.signal,
            userLabel: args.description,
            parentTurnId,
          });
    const started = await run.started;
    const prompt = run.request.kind === 'prompt' ? run.request.prompt : undefined;
    const mirrored = mirrorAgentRun(requester, started, {
      profileName: run.child.profileName,
      prompt,
      signal: controller.signal,
      deferStarted: true,
      resolveTaskId: () => runTask,
      cancel: (reason) => {
        controller.abort(reason);
      },
    });
    const childProfile = run.child.agent.accessor.get(IAgentProfileService).data();
    const parentNotify = isAgentNotifyAvailable({
      hasParent: true,
      allowParentNotify: childProfile.allowParentNotify,
      configEnabled: isParentNotifyEnabled(this.config.get<AgentsConfig>(AGENTS_SECTION)),
      toolPolicyEnabled: run.child.agent.accessor
        .get(IAgentToolPolicyService)
        .isToolActive('AgentNotify'),
    })
      ? 'enabled'
      : 'disabled';
    return {
      agentId: run.child.agentId,
      profileName: run.child.profileName,
      name: run.child.name,
      parentToolCallId: toolCallId,
      mainProfile: this.dispatchedMainProfile(run.child, fileProfile),
      model: run.child.modelAlias,
      thinkingEffort: run.child.thinkingEffort,
      thinkingEffortSource: run.child.thinkingEffortSource,
      routeDetached: run.child.routeDetached,
      profileSource: run.child.profileSource,
      bindingAdvisories: run.child.bindingAdvisories,
      dispatchDecision: run.child.dispatchDecision,
      parentNotify,
      completion: mirrored.then((result) => ({ result: result.summary, usage: result.usage })),
    };
  }

  private async execution(
    args: SubagentToolInput,
    { toolCallId, signal, turnId }: ExecutableToolContext,
    snapshot: AgentProfileCatalogSnapshot | undefined,
    capturedLaunchPolicy: DispatchLaunchPolicy,
  ): Promise<ExecutableToolResult> {
    try {
      signal.throwIfAborted();
      const runInBackground = args.background === true;
      const runLabel = args.description;
      const requestedProfileName = args.profile?.length ? args.profile : undefined;
      const requestedRoute = args.route?.trim();
      const resumeAgentId = args.resume?.trim();
      const isResume = resumeAgentId !== undefined && resumeAgentId.length > 0;

      if (isResume && requestedProfileName !== undefined) {
        return { output: RESUME_WITH_TYPE_UNAVAILABLE, isError: true };
      }
      if (isResume && requestedRoute !== undefined) {
        return { output: 'Cannot set route when resuming an existing agent.', isError: true };
      }

      const allowBackground = this.canRunInBackground();
      if (runInBackground && !allowBackground) {
        return { output: BACKGROUND_AGENT_UNAVAILABLE, isError: true };
      }
      const timeoutMs = resolveSubagentTimeoutMs(this.config);
      const runtimeLease = this.runtime.acquire(args.profile_file === undefined ? ['process'] : ['process', 'fs']);

      const controller = new AbortController();
      const abortBeforeRegister = (): void => {
        controller.abort(signal.reason);
      };
      if (!runInBackground) {
        signal.addEventListener('abort', abortBeforeRegister, { once: true });
      }

      let handle: SubagentHandle;
      let resolveRunTask!: (taskId: string | undefined) => void;
      const runTask = new Promise<string | undefined>((resolve) => { resolveRunTask = resolve; });
      try {
        handle = await this.launch(args, toolCallId, turnId, controller, runtimeLease.runtime, snapshot, capturedLaunchPolicy, runTask);
      } catch (error) {
        resolveRunTask(undefined);
        signal.removeEventListener('abort', abortBeforeRegister);
        this.log.warn('subagent launch failed', {
          toolCallId,
          runInBackground,
          operation: isResume ? 'resume' : 'spawn',
          profile: requestedRoute ?? requestedProfileName ?? resolveDefaultSubagentProfileName(this.config),
          resumeAgentId: isResume ? resumeAgentId : undefined,
          error,
        });
        throw error;
      } finally {
        runtimeLease.dispose();
      }

      let taskId: string | undefined;
      try {
        const registerOptions: RegisterAgentTaskOptions = {
          detached: runInBackground,
          timeoutMs,
          detachTimeoutMs: timeoutMs,
          autoBackgroundOnTimeout: !runInBackground && allowBackground,
          signal: runInBackground ? undefined : signal,
        };
        taskId = this.tasks.registerTask(
          new SubagentTask(
            handle,
            runLabel,
            controller,
            handle.name === undefined
              ? undefined
              : { taskName: handle.name, agentType: handle.profileName },
          ),
          registerOptions,
        );
        await this.dispatch.recordRun(handle.agentId, taskId);
        signal.removeEventListener('abort', abortBeforeRegister);
        const requester = this.lifecycle.get(this.callerAgentId);
        if (requester !== undefined) {
          emitAgentRunSpawned(requester, handle.agentId, {
            profileName: handle.profileName,
            name: handle.name,
            parentToolCallId: toolCallId,
            description: runLabel,
            runInBackground,
            model: handle.model,
            taskId,
          });
          await requester.accessor
            .get(IEventDispatcher)
            ?.dispatch(new SubagentStarted({ subagentId: handle.agentId, taskId }));
        }
        resolveRunTask(taskId);
      } catch (error) {
        resolveRunTask(taskId);
        controller.abort();
        void handle.completion.catch(() => {});
        signal.removeEventListener('abort', abortBeforeRegister);
        this.log?.warn('background agent task registration failed', {
          toolCallId,
          agentId: handle.agentId,
          profile: handle.profileName,
          error,
        });
        const message = error instanceof Error ? error.message : String(error);
        return {
          output:
            isError2(error) && error.code === ErrorCodes.TASK_LIMIT_EXCEEDED
              ? 'Too many background tasks are already running.'
              : message,
          isError: true,
        };
      }

      if (runInBackground) {
        return {
          output: this.withMainProfileNotice(handle, formatBackgroundAgentResult(taskId, handle, runLabel)),
        };
      }

      const release = await this.tasks.waitForForegroundRelease(taskId);
      if (release === 'detached' || release === 'timeout_detached') {
        return {
          output: this.withMainProfileNotice(handle, formatBackgroundAgentResult(taskId, handle, runLabel)),
        };
      }
      return await this.formatForegroundResult(taskId, handle, timeoutMs);
    } catch (error) {
      if (isError2(error) && error.code === ErrorCodes.DISPATCH_LIMIT_EXCEEDED) {
        return { output: JSON.stringify({ code: error.code, message: error.message, details: error.details }), isError: true };
      }
      return { output: `subagent error: ${launchErrorMessage(error, signal)}`, isError: true };
    }
  }

  private async formatForegroundResult(
    taskId: string,
    handle: SubagentHandle,
    timeoutMs: number,
  ): Promise<ExecutableToolResult> {
    const info = this.tasks.getTask(taskId);
    if (info?.status === 'completed') {
      return {
        output: this.withMainProfileNotice(handle, formatForegroundAgentSuccess(handle, await this.tasks.readOutput(taskId))),
      };
    }
    const timedOut = info?.status === 'timed_out';
    const message = timedOut
      ? `Agent timed out after ${formatSubagentTimeoutDescription(timeoutMs)}.`
      : formatSubagentStoppedMessage(info?.stopReason);
    return {
      output: this.withMainProfileNotice(handle, formatForegroundAgentFailure(handle, message, timedOut)),
      isError: true,
    };
  }
}

registerAgentToolService(ISubagentTool, SubagentTool, {
  name: 'AgentRun',
  domain: 'subagent',
  requiredRuntimeCapabilities: ['process'],
});

export function bindingResultLines(handle: SubagentHandle): string[] {
  const bindingAdvisories = handle.bindingAdvisories ?? [];
  return [
    `actual_profile: ${handle.profileName}`,
    ...(handle.profileSource === 'profile-file' ? ['profile_source: profile_file'] : []),
    ...(handle.dispatchDecision === undefined ? [] : [
      `dispatch_policy: ${handle.dispatchDecision.policyMode}`,
      `selection_kind: ${handle.dispatchDecision.selectionKind}`,
      `selection_origin: ${handle.dispatchDecision.selectionOrigin}`,
      `recommendation_status: ${handle.dispatchDecision.recommendationStatus}`,
      ...(handle.dispatchDecision.advisoryDeviation ? ['recommendation_deviation: true'] : []),
      ...(handle.dispatchDecision.fallback === undefined
        ? []
        : [`recommendation_fallback: ${handle.dispatchDecision.fallback}`]),
    ]),
    ...(handle.thinkingEffortSource === undefined || handle.thinkingEffort === undefined
      ? []
      : [
          `thinking_effort: ${handle.thinkingEffort}`,
          `thinking_effort_source: ${handle.thinkingEffortSource}`,
        ]),
    ...(handle.routeDetached === true ? ['route_status: detached'] : []),
    ...(bindingAdvisories.length === 0 ? [] : [
      `binding_advisory_count: ${String(bindingAdvisories.length)}`,
      `binding_advisory_first: ${JSON.stringify(bindingAdvisories[0])}`,
    ]),
    `parent_notify: ${handle.parentNotify ?? 'enabled'}`,
  ];
}

function formatBackgroundAgentResult(
  taskId: string,
  handle: SubagentHandle,
  description: string,
): string {
  return [
    `task_id: ${taskId}`,
    'status: running',
    `agent_id: ${handle.agentId}`,
    ...bindingResultLines(handle),
    'automatic_notification: true',
    `description: ${description}`,
  ].join('\n');
}

function formatForegroundAgentSuccess(handle: SubagentHandle, result: string): string {
  return [
    `agent_id: ${handle.agentId}`,
    ...bindingResultLines(handle),
    'status: completed',
    '',
    '[summary]',
    result,
  ].join('\n');
}

function formatForegroundAgentFailure(
  handle: SubagentHandle,
  message: string,
  timedOut: boolean,
): string {
  const lines = [
    `agent_id: ${handle.agentId}`,
    ...bindingResultLines(handle),
    'status: failed',
    '',
    `subagent error: ${message}`,
  ];
  if (timedOut) {
    lines.push(
      `resume_hint: Continue with AgentRun(resume="${handle.agentId}", prompt="continue"). Use agent_id only; do not set profile. The subagent retains its prior context; redo any unfinished tool call if its result was lost.`,
    );
  }
  return lines.join('\n');
}

function launchErrorMessage(error: unknown, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) return USER_INTERRUPTED_SUBAGENT_MESSAGE;
  if (isAbortError(error)) return formatSubagentStoppedMessage(errorMessage(signal.reason));
  return error instanceof Error ? error.message : String(error);
}

function formatSubagentStoppedMessage(reason: string | undefined): string {
  const normalized = reason?.trim();
  if (normalized === userCancellationReason().message) return USER_INTERRUPTED_SUBAGENT_MESSAGE;
  if (normalized === undefined || normalized.length === 0) return SUBAGENT_STOPPED_MESSAGE;
  return `${SUBAGENT_STOPPED_MESSAGE} Reason: ${normalized}`;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return undefined;
}
