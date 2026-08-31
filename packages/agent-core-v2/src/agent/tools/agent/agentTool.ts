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
import { IAgentExecutionService } from '#/agent/execution/execution';
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
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  COLLABORATION_AGENT_TYPE_LABEL,
  COLLABORATION_TASK_NAME_LABEL,
  IAgentCollaborationRegistry,
} from '#/session/agentCollaboration/registry';
import {
  directChildAgents,
  findDirectChild,
} from '#/session/agentCollaboration/directChildren';
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
  formatSubagentTimeoutDescription,
  normalizeSubagentBindingValue,
  resolveSubagentBinding,
  resolveSubagentTimeoutMs,
} from '#/session/subagent/configSection';
import {
  assertProfileRouteBinding,
  assertProfileRouteModelAvailable,
} from '#/session/subagent/profileRouteBinding';
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
} from './subagentDescription';

import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md?raw';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md?raw';
import AGENT_DESCRIPTION_BASE from './agent.md?raw';

const SUBAGENT_TOOL_PARAMETERS = toInputJsonSchema(SubagentToolInputSchema, (schema) => {
  addSubagentBindingSchemaConstraints(schema, 'agent');
});
export { buildProfileDescriptions } from './subagentDescription';

export class SubagentTool implements ISubagentTool {
  declare readonly _serviceBrand: undefined;
  readonly name: string = 'AgentRun';

  readonly parameters: Record<string, unknown> = SUBAGENT_TOOL_PARAMETERS;

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
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
    @IAgentCollaborationRegistry private readonly nameRegistry: IAgentCollaborationRegistry,
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
      undefined,
      (alias: string) => this.isRecommendedModelAliasAvailable(alias),
    );
    if (typeLines) {
      description += `\n\nAvailable agent profiles (pass via profile):\n${typeLines}`;
    }
    const routeLines = buildRouteDescriptions(targets.routes);
    if (routeLines) {
      description += `\n\nAvailable agent routes (pass via route):\n${routeLines}`;
    }
    const modelLines = buildSubagentModelDescriptions(this.models);
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
    for (const contribution of this.contributions.items) {
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

  async resolveExecution(args: SubagentToolInput): Promise<ToolExecution> {
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
    if (
      resumeAgentId !== undefined &&
      resumeAgentId.length > 0 &&
      (args.model_alias !== undefined || args.effort !== undefined)
    ) {
      return {
        output: 'Cannot set model_alias or effort when continuing an existing agent.',
        isError: true,
      };
    }

    const profileNameForDisplay =
      resumeAgentId !== undefined && resumeAgentId.length > 0
        ? this.resumeProfileName(resumeAgentId) ?? RESUMED_LABEL
        : requestedRoute ?? requestedProfileName ?? DEFAULT_PROFILE_NAME;
    const prefix = args.background === true ? 'Launching background' : 'Launching';
    if (resumeAgentId === undefined || resumeAgentId.length === 0) await this.catalog.ready;
    const snapshot = this.catalog.snapshot?.();
    return {
      description: `${prefix} ${profileNameForDisplay} agent: ${args.description}`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'agent_call',
        agent_name: profileNameForDisplay,
        prompt: args.prompt,
        background: args.background,
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
    const thinkingEffort = normalizeSubagentBindingValue(args.effort, 'effort');
    const requester = this.lifecycle.get(this.callerAgentId);
    if (requester === undefined) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_FOUND,
        `Caller agent "${this.callerAgentId}" does not exist`,
        { details: { agentId: this.callerAgentId } },
      );
    }

    const resumeRef = args.resume?.trim();
    const isResume = resumeRef !== undefined && resumeRef.length > 0;

    let agentId: string;
    let profileName: string;
    let displayModel: string | undefined;
    let promptText = args.prompt;
    if (isResume) {
      const resumeAgentId = await this.resolveResumeTarget(resumeRef);
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
      await this.ensureOwnedIdleSubagent(resumeAgentId, target);
      agentId = target.id;
      const resumed = target.accessor.get(IAgentProfileService).data();
      profileName = resumed.routeId ?? resumed.profileName ?? RESUMED_LABEL;
      displayModel = resumed.modelAlias;
    } else {
      const requestedProfileName = args.profile?.length
        ? args.profile
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
      const filled = fillLeasePins(
        {
          modelAlias,
          thinkingEffort,
        },
        target.lease,
        selection.route,
      );
      assertProfileRouteBinding(
        selection.route,
        {
          modelAlias: filled.modelAlias,
          thinkingEffort: filled.thinkingEffort,
        },
        this.models,
      );
      assertProfileRouteModelAvailable(selection.route, this.modelCatalog, this.models);
      const roleConstraints = roleConstraintsFromProfile(
        profile,
        spawnConstraintOrigin(target.lease, target.spawnPolicy),
      );
      const binding = canonicalizeSubagentBinding(
        resolveSubagentBinding(
          this.config,
          {
            modelAlias: filled.modelAlias,
            thinkingEffort: filled.thinkingEffort,
          },
          {
            modelAlias: selection.route?.lockedModelAlias ?? profile.modelAlias,
            thinkingEffort: selection.route?.lockedThinkingEffort ?? profile.thinkingEffort,
          },
          this.models,
          roleConstraints,
          { profileName: profile.name, routeId: selection.route?.id },
        ),
        this.models,
      );
      this.modelCatalog.get(binding.model);
      const requestedName = args.name?.trim();
      const nameOwner = { kind: 'agent' as const, agentId: this.callerAgentId };
      if (requestedName !== undefined && !(await this.nameRegistry.reserve(requestedName, nameOwner))) {
        throw new Error2(
          ErrorCodes.AGENT_ALREADY_EXISTS,
          `Agent name "${requestedName}" is already used in this session. Pick another name, or pass it to resume to continue that agent.`,
          { details: { name: requestedName } },
        );
      }
      let created: IAgentScopeHandle;
      try {
        const callerMeta = (await this.sessionMetadata.read()).agents?.[this.callerAgentId];
        const requesterUserTools = requester.accessor.get(IAgentUserToolService);
        created = await this.lifecycle.create({
          binding: {
            profile: baseProfileName,
            route: selection.route?.id,
            resolvedProfile: selection.baseProfile,
            resolvedRoute: selection.route,
            model: binding.model,
            thinking: binding.thinking,
            inheritedUserToolNames: requesterUserTools.list().map((tool) => tool.name),
            lease: target.lease,
            spawnPolicy: target.spawnPolicy,
          },
          labels: {
            ...subagentLabels(this.callerAgentId),
            ...requestIdentitySpawnLabels(this.callerAgentId, parentTurnId, callerMeta),
            ...(requestedName === undefined
              ? {}
              : {
                  [COLLABORATION_TASK_NAME_LABEL]: requestedName,
                  [COLLABORATION_AGENT_TYPE_LABEL]: baseProfileName,
                }),
          },
          delegator: { kind: 'agent', agentId: this.callerAgentId },
          userLabel: args.description,
          runtimeId: runtime.identity.runtimeId,
        });
      } catch (error) {
        if (requestedName !== undefined) this.nameRegistry.release(requestedName, nameOwner);
        throw error;
      }
      if (requestedName !== undefined) this.nameRegistry.commit(requestedName, nameOwner);
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

  /**
   * `resume` accepts either the name given at creation or the generated agent
   * ID. An unmatched value is passed through unchanged so an ID that exists but
   * is not ours still reports why it was refused rather than "not found".
   */
  private async resolveResumeTarget(ref: string): Promise<string> {
    const children = directChildAgents((await this.sessionMetadata.read()).agents, this.callerAgentId);
    return findDirectChild(children, ref)?.agentId ?? ref;
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
    if (target.accessor.get(IAgentExecutionService).status().state !== 'idle') {
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
          profile: requestedRoute ?? requestedProfileName ?? DEFAULT_PROFILE_NAME,
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
          new SubagentTask(handle, runLabel, controller),
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

      const requester = this.lifecycle.get(this.callerAgentId);
      if (requester !== undefined) {
        emitAgentRunSpawned(requester, handle.agentId, {
          profileName: handle.profileName,
          parentToolCallId: toolCallId,
          description: runLabel,
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
          output: formatBackgroundAgentResult(taskId, handle, runLabel, allowBackground),
        };
      }

      const release = await this.tasks.waitForForegroundRelease(taskId);
      if (release === 'detached') {
        return {
          output: formatBackgroundAgentResult(taskId, handle, runLabel, allowBackground),
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
  name: 'AgentRun',
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
    `actual_profile: ${handle.profileName}`,
    'automatic_notification: true',
    '',
    `description: ${description}`,
    '',
    allowBackground
      ? `next_step: The completion arrives automatically in a later turn — do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user. (If you have nothing to do until it finishes, run such tasks in the foreground next time.)`
      : 'next_step: The completion arrives automatically in a later turn.',
    `resume_hint: To continue or recover this same subagent later, call AgentRun(resume="${handle.agentId}", prompt="..."). The parameter is agent_id ("${handle.agentId}"), NOT task_id ("${taskId}") or source_id from a later <notification>. Recovery cases: a later <notification type="task.lost" | "task.failed" | "task.killed"> for this subagent — its conversation history is preserved across session restarts and resume will pick it up.`,
  ].join('\n');
}

function formatForegroundAgentSuccess(handle: SubagentHandle, result: string): string {
  return [
    `agent_id: ${handle.agentId}`,
    `actual_profile: ${handle.profileName}`,
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
    `actual_profile: ${handle.profileName}`,
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
