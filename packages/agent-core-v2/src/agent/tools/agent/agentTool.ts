import { type CollectionView } from '#/_base/di/collection';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import {
  isAbortError,
  isUserCancellation,
  userCancellationReason,
} from '#/_base/utils/abort';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  IAgentTaskService,
  type RegisterAgentTaskOptions,
} from '#/agent/task/task';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import {
  AgentToolContribution,
  registerAgentToolService,
} from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService, type ToolReference } from '#/agent/toolRegistry/toolRegistry';
import type {
  AgentProfile,
  AgentProfileRouteCatalogEntry,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { AgentProfileCatalogSnapshot } from '#/app/agentProfileCatalog/scopedAgentProfile';
import {
  listAvailableSubagentTargets,
  resolveSubagentTarget,
} from '#/app/agentProfileCatalog/subagentDispatch';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import {
  fillLeasePins,
  spawnConstraintOrigin,
} from '#/app/agentProfileCatalog/applySubagentLease';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  refreshInheritedSubagentBinding,
  withSubagentBindingMode,
} from '#/session/agentLifecycle/agentLifecycleService';
import {
  delegatorRef,
  isSubagentMeta,
  labelsFromAgentMeta,
  requestIdentitySpawnLabels,
  subagentLabels,
  subagentParentAgentId,
} from '#/session/agentLifecycle/subagentMetadata';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { Runtime } from '#/runtime/runtime';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { emitAgentRunSpawned, mirrorAgentRun, SubagentStarted } from '#/session/subagent/mirrorAgentRun';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { roleConstraintsFromProfile } from '#/session/subagent/modelConstraints';
import {
  addSubagentBindingSchemaConstraints,
  buildSubagentModelDescriptions,
  canonicalizeSubagentBinding,
  exposesSubagentModelChoice,
  formatSubagentTimeoutDescription,
  normalizeSubagentBindingValue,
  resolveSubagentBinding,
  subagentBindingMode,
  subagentDisplayModel,
  subagentModelSource,
  resolveSubagentTimeoutMs,
  stripSubagentModelParameter,
  wrapSubagentModelError,
} from '#/session/subagent/configSection';
import {
  assertProfileRouteBinding,
  assertProfileRouteModelAvailable,
} from '#/session/subagent/profileRouteBinding';
import { resolveNestedSubagentDefaultContext } from '#/session/subagent/bindingContext';
import {
  BACKGROUND_AGENT_UNAVAILABLE,
  DEFAULT_PROFILE_NAME,
  ISubagentTool,
  RESUME_WITH_TYPE_UNAVAILABLE,
  RESUMED_LABEL,
  SUBAGENT_STOPPED_MESSAGE,
  SubagentToolInputSchema,
  USER_INTERRUPTED_SUBAGENT_MESSAGE,
  type SubagentToolInput,
} from './agent';
import { SubagentTask, type SubagentHandle } from './subagent-task';
import {
  buildProfileDescriptions,
  buildRouteDescriptions,
  COLLABORATION_TOOL_NAMES,
} from './subagentDescription';

import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md?raw';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md?raw';
import AGENT_DESCRIPTION_BASE from './agent.md?raw';

const SUBAGENT_TOOL_PARAMETERS = toInputJsonSchema(SubagentToolInputSchema, (schema) => {
  addSubagentBindingSchemaConstraints(schema, 'agent');
});
const SUBAGENT_TOOL_PARAMETERS_NO_MODEL = stripSubagentModelParameter(SUBAGENT_TOOL_PARAMETERS);
export { buildProfileDescriptions } from './subagentDescription';

export class SubagentTool implements ISubagentTool {
  declare readonly _serviceBrand: undefined;
  readonly name: string = 'Agent';

  get parameters(): Record<string, unknown> {
    return exposesSubagentModelChoice(this.config, this.flags)
      ? SUBAGENT_TOOL_PARAMETERS
      : SUBAGENT_TOOL_PARAMETERS_NO_MODEL;
  }

  private readonly callerAgentId: string;
  private readonly canRunInBackground: () => boolean;
  private catalogReady = false;
  private frozenCatalogProfiles: readonly AgentProfile[] | undefined;
  private frozenCatalogRoutes: readonly AgentProfileRouteCatalogEntry[] | undefined;
  private frozenCatalogSnapshot: AgentProfileCatalogSnapshot | undefined;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @ILogService private readonly log: ILogService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
    @AgentToolContribution private readonly contributions: CollectionView<AgentToolContribution>,
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
    const backgroundDescription = this.canRunInBackground()
      ? AGENT_BACKGROUND_DESCRIPTION
      : AGENT_BACKGROUND_DISABLED_DESCRIPTION;
    let description = `${AGENT_DESCRIPTION_BASE}\n\n${backgroundDescription}`;
    const own = this.profile.data();
    const snapshot =
      own.profileDefinitionId === undefined ? undefined : this.catalogSnapshot();
    const targets = listAvailableSubagentTargets(
      this.catalog,
      own,
      {
        profiles: this.catalogProfiles(),
        routes: this.catalogRoutes(),
        snapshot,
      },
      this.models,
    );
    const typeLines = buildProfileDescriptions(
      targets.profiles,
      this.knownToolReferences(),
      (profile, name, source) =>
        this.toolPolicy.isToolActiveForProfile(profile, name, source),
      true,
      this.collaborationEnabled() ? undefined : COLLABORATION_TOOL_NAMES,
      (alias) => this.isRecommendedModelAliasAvailable(alias),
    );
    if (typeLines) {
      description += `\n\nAvailable agent types (pass via subagent_type):\n${typeLines}`;
    }
    const routeLines = buildRouteDescriptions(targets.routes);
    if (routeLines) {
      description += `\n\nAvailable agent routes (pass via route):\n${routeLines}`;
    }
    const modelLines = buildSubagentModelDescriptions(
      this.config,
      this.flags,
      this.models,
      this.profile.data().modelAlias,
    );
    if (modelLines !== undefined) {
      description += `\n\n${modelLines}`;
    }
    return description;
  }

  private isRecommendedModelAliasAvailable(alias: string): boolean {
    try {
      if (this.models.resolveId(alias) !== undefined) return true;
    } catch (error) {
      this.log.debug('Omitting unresolved recommended model alias from Agent tool description', {
        alias,
        error,
      });
      return false;
    }
    this.log.debug('Omitting unavailable recommended model alias from Agent tool description', {
      alias,
    });
    return false;
  }

  private catalogProfiles(): readonly AgentProfile[] {
    if (this.frozenCatalogProfiles !== undefined) return this.frozenCatalogProfiles;
    const profiles = this.catalog.list().filter((profile) => profile.main !== true);
    if (this.catalogReady) this.frozenCatalogProfiles = profiles;
    return profiles;
  }

  private catalogRoutes(): readonly AgentProfileRouteCatalogEntry[] {
    if (this.frozenCatalogRoutes !== undefined) return this.frozenCatalogRoutes;
    const routes = this.catalog.listRoutes?.() ?? [];
    if (this.catalogReady) this.frozenCatalogRoutes = routes;
    return routes;
  }

  private catalogSnapshot(): AgentProfileCatalogSnapshot {
    if (this.frozenCatalogSnapshot !== undefined) return this.frozenCatalogSnapshot;
    const snapshot = this.catalog.snapshot?.() ?? {
      publicProfiles: new Map(this.catalog.list().map((profile) => [profile.name, profile])),
      defaultProfile: this.catalog.getDefault(),
      routes: new Map(),
      scopedBindings: new Map(),
      sourceDefinitions: new Map(),
      dependencyIndex: new Map(),
      diagnostics: [],
    };
    if (this.catalogReady) this.frozenCatalogSnapshot = snapshot;
    return snapshot;
  }

  private knownToolReferences(): ToolReference[] {
    const refs = new Map<string, ToolReference>();
    const collaborationEnabled = this.collaborationEnabled();
    for (const contribution of this.contributions.items) {
      if (!collaborationEnabled && COLLABORATION_TOOL_NAMES.has(contribution.options.name)) continue;
      refs.set(contribution.options.name, {
        name: contribution.options.name,
        source: contribution.options.source ?? 'builtin',
      });
    }
    for (const ref of this.toolRegistry.listReferences()) {
      if (!refs.has(ref.name)) refs.set(ref.name, ref);
    }
    return [...refs.values()];
  }

  private collaborationEnabled(): boolean {
    return (
      this.flags.enabled('agent-collaboration') &&
      this.config.get<{ enabled?: boolean } | undefined>('agents')?.enabled !== false
    );
  }

  async resolveExecution(args: SubagentToolInput): Promise<ToolExecution> {
    const requestedProfileName = args.subagent_type?.length ? args.subagent_type : undefined;
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
    if (
      resumeAgentId !== undefined &&
      resumeAgentId.length > 0 &&
      (args.model !== undefined || args.model_alias !== undefined || args.thinking_effort !== undefined)
    ) {
      return {
        output: 'Cannot set model, model_alias, or thinking_effort when resuming an existing agent.',
        isError: true,
      };
    }

    const profileNameForDisplay =
      resumeAgentId !== undefined && resumeAgentId.length > 0
        ? this.resumeProfileName(resumeAgentId) ?? RESUMED_LABEL
        : requestedRoute ?? requestedProfileName ?? DEFAULT_PROFILE_NAME;
    const prefix = args.run_in_background === true ? 'Launching background' : 'Launching';
    if (resumeAgentId === undefined || resumeAgentId.length === 0) await this.catalog.ready;
    const snapshot = this.catalog.snapshot?.();
    return {
      description: `${prefix} ${profileNameForDisplay} agent: ${args.description}`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'agent_call',
        agent_name: profileNameForDisplay,
        prompt: args.prompt,
        background: args.run_in_background,
      },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, profileNameForDisplay),
      execute: (ctx) => this.execution(args, ctx, snapshot),
    };
  }

  private resumeProfileName(agentId: string): string | undefined {
    const target = this.lifecycle.get(agentId);
    if (target === undefined) return undefined;
    return target.accessor.get(IAgentProfileService).data().profileName;
  }

  private async launch(
    args: SubagentToolInput,
    toolCallId: string,
    parentTurnId: number,
    controller: AbortController,
    runtime: Runtime,
    snapshot: AgentProfileCatalogSnapshot | undefined,
  ): Promise<SubagentHandle> {
    const modelAlias = normalizeSubagentBindingValue(args.model_alias, 'model_alias');
    const thinkingEffort = normalizeSubagentBindingValue(
      args.thinking_effort,
      'thinking_effort',
    );
    const requester = this.lifecycle.get(this.callerAgentId);
    if (requester === undefined) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_FOUND,
        `Caller agent "${this.callerAgentId}" does not exist`,
        { details: { agentId: this.callerAgentId } },
      );
    }

    const resumeAgentId = args.resume?.trim();
    const isResume = resumeAgentId !== undefined && resumeAgentId.length > 0;

    let agentId: string;
    let profileName: string;
    let displayModel: string | undefined;
    let promptText = args.prompt;
    if (isResume) {
      let target = this.lifecycle.get(resumeAgentId);
      if (target === undefined) {
        const persisted = (await this.sessionMetadata.read()).agents?.[resumeAgentId];
        if (persisted !== undefined) {
          if (!isSubagentMeta(persisted)) {
            throw new Error2(
              ErrorCodes.AGENT_NOT_A_SUBAGENT,
              `Agent instance "${resumeAgentId}" is not a subagent`,
              { details: { agentId: resumeAgentId } },
            );
          }
          if (subagentParentAgentId(persisted) !== this.callerAgentId) {
            throw new Error2(
              ErrorCodes.AGENT_NOT_OWNED,
              `Agent instance "${resumeAgentId}" does not belong to this parent agent`,
              { details: { agentId: resumeAgentId, callerAgentId: this.callerAgentId } },
            );
          }
          target = await this.lifecycle.create({
            agentId: resumeAgentId,
            forkedFrom: persisted.forkedFrom,
            labels: labelsFromAgentMeta(persisted),
            delegator: delegatorRef(persisted),
          });
        }
      }
      if (target === undefined) {
        throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent instance "${resumeAgentId}" does not exist`, {
          details: { agentId: resumeAgentId },
        });
      }
      const persisted = await this.ensureOwnedIdleSubagent(resumeAgentId, target);
      await refreshInheritedSubagentBinding(requester, target, persisted);
      agentId = target.id;
      const resumed = target.accessor.get(IAgentProfileService).data();
      profileName = resumed.routeId ?? resumed.profileName ?? RESUMED_LABEL;
      displayModel =
        resumed.modelAlias === undefined
          ? undefined
          : subagentDisplayModel(this.config, resumed.modelAlias);
    } else {
      const requestedProfileName = args.subagent_type?.length
        ? args.subagent_type
        : args.route === undefined
          ? DEFAULT_PROFILE_NAME
          : undefined;
      await this.catalog.ready;
      const own = this.profile.data();
      const target = resolveSubagentTarget(
        this.catalog,
        own,
        {
          profileName: requestedProfileName,
          routeId: args.route,
          snapshot,
        },
        this.models,
      );
      const selection = target.selection;
      const baseProfileName = selection.baseProfile.name;
      const profile = target.effectiveProfile;
      if (own.modelAlias === undefined) {
        throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Caller agent has no model bound', {
          details: { agentId: this.callerAgentId },
        });
      }
      const filled = fillLeasePins(
        {
          modelAlias,
          thinkingEffort,
          modelPreference: args.model,
        },
        target.lease,
        selection.route,
      );
      const filledSymbolic =
        filled.modelPreference === 'primary' || filled.modelPreference === 'secondary'
          ? filled.modelPreference
          : undefined;
      assertProfileRouteBinding(
        selection.route,
        {
          modelAlias:
            filled.modelAlias ?? (filledSymbolic === undefined ? filled.modelPreference : undefined),
          thinkingEffort: filled.thinkingEffort,
          modelPreference: filledSymbolic,
        },
        this.models,
      );
      assertProfileRouteModelAvailable(selection.route, this.modelCatalog, this.models);
      const toolBindingRequest = {
        modelPreference: filled.modelPreference,
        modelAlias: filled.modelAlias,
        thinkingEffort: filled.thinkingEffort,
      };
      const profileBindingRequest = {
        modelPreference: profile.modelPreference,
        modelAlias: profile.modelAlias,
        thinkingEffort: profile.thinkingEffort,
      };
      const roleConstraints = roleConstraintsFromProfile(
        profile,
        spawnConstraintOrigin(target.lease, target.spawnPolicy),
      );
      let binding = resolveSubagentBinding(
        this.config,
        this.flags,
        { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
        toolBindingRequest,
        profileBindingRequest,
        this.models,
        roleConstraints,
      );
      if (subagentModelSource(binding) === 'caller') {
        const callerMeta = (await this.sessionMetadata.read()).agents?.[this.callerAgentId];
        const nestedDefault = resolveNestedSubagentDefaultContext(this.lifecycle, callerMeta);
        if (nestedDefault !== undefined) {
          binding = resolveSubagentBinding(
            this.config,
            this.flags,
            nestedDefault,
            toolBindingRequest,
            profileBindingRequest,
            this.models,
            roleConstraints,
          );
        }
      }
      binding = canonicalizeSubagentBinding(binding, this.models);
      const bindingSource = subagentModelSource(binding);
      try {
        this.modelCatalog.get(binding.model);
      } catch (error) {
        throw wrapSubagentModelError(error, binding.model, own.modelAlias, bindingSource);
      }
      let created: IAgentScopeHandle;
      try {
        const callerMeta = (await this.sessionMetadata.read()).agents?.[this.callerAgentId];
        created = await this.lifecycle.create({
          binding: {
            profile: baseProfileName,
            route: selection.route?.id,
            resolvedProfile: selection.baseProfile,
            resolvedRoute: selection.route,
            model: binding.model,
            thinking: binding.thinking,
            lease: target.lease,
            spawnPolicy: target.spawnPolicy,
          },
          labels: withSubagentBindingMode(
            {
              ...subagentLabels(this.callerAgentId),
              ...requestIdentitySpawnLabels(this.callerAgentId, parentTurnId, callerMeta),
            },
            subagentBindingMode(binding),
          ),
          delegator: { kind: 'agent', agentId: this.callerAgentId },
          userLabel: args.description,
          runtimeId: runtime.identity.runtimeId,
        });
      } catch (error) {
        throw wrapSubagentModelError(error, binding.model, own.modelAlias, bindingSource);
      }
      created.accessor.get(IAgentPermissionModeService).setMode(this.permissionMode.mode);
      created.accessor
        .get(IAgentUserToolService)
        .inheritUserTools(requester.accessor.get(IAgentUserToolService));
      agentId = created.id;
      profileName = selection.route?.id ?? profile.name;
      displayModel = binding.displayModel;
      promptText = await applyProfilePromptPrefix(profile, args.prompt, {
        cwd: this.workspace.workDir,
        process: runtime.process!,
        log: this.log,
      });
    }

    const run = await this.subagents.run(
      agentId,
      { kind: 'prompt', prompt: promptText },
      { signal: controller.signal },
    );
    const mirrored = mirrorAgentRun(requester, run, {
      profileName,
      prompt: promptText,
      signal: controller.signal,
      deferStarted: true,
      cancel: (reason) => {
        controller.abort(reason);
      },
    });
    return {
      agentId,
      profileName,
      parentToolCallId: toolCallId,
      model: displayModel,
      thinkingEffort: this.lifecycle
        .get(agentId)
        ?.accessor.get(IAgentProfileService)
        .getEffectiveThinkingLevel(),
      completion: mirrored.then((r) => ({ result: r.summary, usage: r.usage })),
    };
  }

  private async ensureOwnedIdleSubagent(
    agentId: string,
    target: IAgentScopeHandle,
  ): Promise<AgentMeta> {
    const meta = (await this.sessionMetadata.read()).agents?.[agentId];
    if (!isSubagentMeta(meta)) {
      throw new Error2(ErrorCodes.AGENT_NOT_A_SUBAGENT, `Agent instance "${agentId}" is not a subagent`, {
        details: { agentId },
      });
    }
    if (subagentParentAgentId(meta) !== this.callerAgentId) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_OWNED,
        `Agent instance "${agentId}" does not belong to this parent agent`,
        { details: { agentId, callerAgentId: this.callerAgentId } },
      );
    }
    if (target.accessor.get(IAgentLoopService).status().state === 'running') {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_RUNNING,
        `Agent instance "${agentId}" is already running and cannot run concurrently`,
        { details: { agentId } },
      );
    }
    return meta!;
  }

  private async execution(
    args: SubagentToolInput,
    { toolCallId, signal, turnId }: ExecutableToolContext,
    snapshot: AgentProfileCatalogSnapshot | undefined,
  ): Promise<ExecutableToolResult> {
    try {
      signal.throwIfAborted();
      const runInBackground = args.run_in_background === true;
      const requestedProfileName = args.subagent_type?.length ? args.subagent_type : undefined;
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
      const runtimeLease = this.runtime.acquire(['process']);

      const controller = new AbortController();
      const abortBeforeRegister = (): void => {
        controller.abort(signal.reason);
      };
      if (!runInBackground) {
        signal.addEventListener('abort', abortBeforeRegister, { once: true });
      }

      let handle: SubagentHandle;
      try {
        handle = await this.launch(args, toolCallId, turnId, controller, runtimeLease.runtime, snapshot);
      } catch (error) {
        signal.removeEventListener('abort', abortBeforeRegister);
        this.log.warn('subagent launch failed', {
          toolCallId,
          runInBackground,
          operation: isResume ? 'resume' : 'spawn',
          subagentType: requestedRoute ?? requestedProfileName ?? DEFAULT_PROFILE_NAME,
          resumeAgentId: isResume ? resumeAgentId : undefined,
          error,
        });
        throw error;
      } finally {
        runtimeLease.dispose();
      }

      let taskId: string;
      try {
        const registerOptions: RegisterAgentTaskOptions = {
          detached: runInBackground,
          timeoutMs,
          signal: runInBackground ? undefined : signal,
        };
        taskId = this.tasks.registerTask(
          new SubagentTask(handle, args.description, controller),
          registerOptions,
        );
        signal.removeEventListener('abort', abortBeforeRegister);
      } catch (error) {
        controller.abort();
        void handle.completion.catch(() => {});
        signal.removeEventListener('abort', abortBeforeRegister);
        this.log?.warn('background agent task registration failed', {
          toolCallId,
          agentId: handle.agentId,
          subagentType: handle.profileName,
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

      const requester = this.lifecycle.get(this.callerAgentId);
      if (requester !== undefined) {
        emitAgentRunSpawned(requester, handle.agentId, {
          profileName: handle.profileName,
          parentToolCallId: toolCallId,
          description: args.description,
          runInBackground,
          model: handle.model,
          taskId,
        });
        void requester.accessor
          .get(IEventDispatcher)
          ?.dispatch(new SubagentStarted({ subagentId: handle.agentId }));
      }

      if (runInBackground) {
        return {
          output: formatBackgroundAgentResult(taskId, handle, args.description, allowBackground),
        };
      }

      const release = await this.tasks.waitForForegroundRelease(taskId);
      if (release === 'detached') {
        return {
          output: formatBackgroundAgentResult(taskId, handle, args.description, allowBackground),
        };
      }
      return await this.formatForegroundResult(taskId, handle, timeoutMs);
    } catch (error) {
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
        output: formatForegroundAgentSuccess(handle, await this.tasks.readOutput(taskId)),
      };
    }
    const timedOut = info?.status === 'timed_out';
    const message = timedOut
      ? `Agent timed out after ${formatSubagentTimeoutDescription(timeoutMs)}.`
      : formatSubagentStoppedMessage(info?.stopReason);
    return {
      output: formatForegroundAgentFailure(handle, message, timedOut),
      isError: true,
    };
  }
}

registerAgentToolService(ISubagentTool, SubagentTool, {
  name: 'Agent',
  domain: 'subagent',
  requiredRuntimeCapabilities: ['process'],
});

function formatBackgroundAgentResult(
  taskId: string,
  handle: SubagentHandle,
  description: string,
  allowBackground: boolean,
): string {
  return [
    `task_id: ${taskId}`,
    'status: running',
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'automatic_notification: true',
    '',
    `description: ${description}`,
    '',
    allowBackground
      ? `next_step: The completion arrives automatically in a later turn — do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user. (If you have nothing to do until it finishes, run such tasks in the foreground next time.)`
      : 'next_step: The completion arrives automatically in a later turn.',
    `resume_hint: To continue or recover this same subagent later, call Agent(resume="${handle.agentId}", prompt="..."). The parameter is agent_id ("${handle.agentId}"), NOT task_id ("${taskId}") or source_id from a later <notification>. Recovery cases: a later <notification type="task.lost" | "task.failed" | "task.killed"> for this subagent — its conversation history is preserved across session restarts and resume will pick it up.`,
  ].join('\n');
}

function formatForegroundAgentSuccess(handle: SubagentHandle, result: string): string {
  return [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
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
    `actual_subagent_type: ${handle.profileName}`,
    'status: failed',
    '',
    `subagent error: ${message}`,
  ];
  if (timedOut) {
    lines.push(
      `resume_hint: Continue with Agent(resume="${handle.agentId}", prompt="continue"). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost.`,
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
