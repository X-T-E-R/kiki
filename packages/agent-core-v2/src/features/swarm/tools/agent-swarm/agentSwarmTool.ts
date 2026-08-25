import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { Error2, ErrorCodes } from '#/errors';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelService } from '#/kosong/model/model';
import type {
  AgentProfile,
  AgentProfileRouteCatalogEntry,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentProfileCatalogSnapshot } from '#/app/agentProfileCatalog/scopedAgentProfile';
import {
  listAvailableSubagentTargets,
  resolveSubagentTarget,
} from '#/app/agentProfileCatalog/subagentDispatch';
import { ISessionSwarmService, type SessionSwarmTask } from '#/features/swarm/session/sessionSwarm';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  fillLeasePins,
  spawnConstraintOrigin,
} from '#/app/agentProfileCatalog/applySubagentLease';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import {
  addSubagentBindingSchemaConstraints,
  buildSubagentModelDescriptions,
  canonicalizeSubagentBinding,
  exposesSubagentModelChoice,
  normalizeSubagentBindingValue,
  resolveSubagentBinding,
  resolveSubagentTimeoutMs,
  stripSubagentModelParameter,
  subagentBindingMode,
  subagentModelSource,
} from '#/session/subagent/configSection';
import { assertProfileRouteBinding } from '#/session/subagent/profileRouteBinding';
import { roleConstraintsFromProfile } from '#/session/subagent/modelConstraints';
import {
  AgentSwarmToolInputSchema,
  IAgentSwarmTool,
  MAX_AGENT_SWARM_SUBAGENTS,
  PROMPT_TEMPLATE_PLACEHOLDER,
  type AgentSwarmToolInput,
} from './agent-swarm';
import {
  buildProfileDescriptions,
  buildRouteDescriptions,
} from '#/agent/tools/agent/subagentDescription';
import AGENT_SWARM_DESCRIPTION from './agent-swarm.md?raw';

const DEFAULT_SUBAGENT_TYPE = 'coder';

const AGENT_SWARM_PARAMETERS = toInputJsonSchema(AgentSwarmToolInputSchema, (schema) => {
  addSubagentBindingSchemaConstraints(schema, 'swarm');
});
const AGENT_SWARM_PARAMETERS_NO_MODEL = stripSubagentModelParameter(AGENT_SWARM_PARAMETERS);

interface AgentSwarmSpawnSpec {
  readonly kind: 'spawn';
  readonly index: number;
  readonly item: string;
  readonly prompt: string;
}

interface AgentSwarmResumeSpec {
  readonly kind: 'resume';
  readonly index: number;
  readonly agentId: string;
  readonly item?: string;
  readonly prompt: string;
}

type AgentSwarmSpec = AgentSwarmSpawnSpec | AgentSwarmResumeSpec;

interface SwarmRunResult {
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly error?: string;
}

export class AgentSwarmTool implements IAgentSwarmTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AgentSwarm' as const;

  get parameters(): Record<string, unknown> {
    return exposesSubagentModelChoice(this.config, this.flags)
      ? AGENT_SWARM_PARAMETERS
      : AGENT_SWARM_PARAMETERS_NO_MODEL;
  }

  private readonly callerAgentId: string;
  private catalogReady = false;
  private frozenCatalogProfiles: readonly AgentProfile[] | undefined;
  private frozenCatalogRoutes: readonly AgentProfileRouteCatalogEntry[] | undefined;
  private frozenCatalogSnapshot: AgentProfileCatalogSnapshot | undefined;

  constructor(
    @ISessionSwarmService private readonly swarmService: ISessionSwarmService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentSwarmService private readonly swarmMode: IAgentSwarmService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelService private readonly models: IModelService,
  ) {
    this.callerAgentId = scopeContext.agentId;
    void this.catalog.ready.then(() => {
      this.catalogReady = true;
    });
  }

  get description(): string {
    const modelLines = buildSubagentModelDescriptions(
      this.config,
      this.flags,
      this.models,
      this.profile.data().modelAlias,
    );
    let description = modelLines === undefined
      ? AGENT_SWARM_DESCRIPTION
      : `${AGENT_SWARM_DESCRIPTION}\n\n${modelLines}`;
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
      [],
      () => true,
      true,
      undefined,
      (alias) => this.isModelAliasAvailable(alias),
      false,
    );
    if (typeLines.length > 0) {
      description += `\n\nAvailable agent types (pass via subagent_type):\n${typeLines}`;
    }
    const routeLines = buildRouteDescriptions(targets.routes);
    if (routeLines.length > 0) {
      description += `\n\nAvailable agent routes (pass via route):\n${routeLines}`;
    }
    return description;
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

  private isModelAliasAvailable(alias: string): boolean {
    try {
      return this.models.resolveId(alias) !== undefined;
    } catch {
      return false;
    }
  }

  resolveExecution(args: AgentSwarmToolInput): ToolExecution {
    const agentCount = (args.items?.length ?? 0) + Object.keys(args.resume_agent_ids ?? {}).length;
    return {
      accesses: ToolAccesses.all(),
      description: `Launching agent swarm: ${args.description}`,
      display: {
        kind: 'agent_call',
        agent_name: `swarm (${agentCount} subagents)`,
        prompt: args.description,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AgentSwarmToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      this.swarmMode.enter('tool');
      const result = await this.runSwarm(args, context.signal, context.toolCallId, context.turnId);
      return {
        output: result,
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private async runSwarm(
    args: AgentSwarmToolInput,
    signal: AbortSignal,
    toolCallId: string,
    turnId: number,
  ): Promise<string> {
    const modelAlias = normalizeSubagentBindingValue(args.model_alias, 'model_alias');
    const thinkingEffort = normalizeSubagentBindingValue(
      args.thinking_effort,
      'thinking_effort',
    );
    if (
      (args.items?.length ?? 0) === 0 &&
      Object.keys(args.resume_agent_ids ?? {}).length > 0 &&
      (args.route !== undefined || args.model !== undefined || modelAlias !== undefined || thinkingEffort !== undefined)
    ) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        'Cannot set route, model, model_alias, or thinking_effort for a resume-only swarm.',
      );
    }
    const requestedProfileName =
      normalizeOptionalString(args.subagent_type) ??
      (args.route === undefined ? DEFAULT_SUBAGENT_TYPE : undefined);
    let profileName = requestedProfileName ?? DEFAULT_SUBAGENT_TYPE;
    let routeId: string | undefined;
    let catalogSnapshot: AgentProfileCatalogSnapshot | undefined;
    let binding: { model: string; thinking?: string } | undefined;
    if ((args.items?.length ?? 0) > 0) {
      await this.catalog.ready;
      const own = this.profile.data();
      catalogSnapshot = this.catalog.snapshot?.();
      const target = resolveSubagentTarget(
        this.catalog,
        own,
        {
          profileName: requestedProfileName,
          routeId: args.route,
          snapshot: catalogSnapshot,
        },
        this.models,
      );
      const selection = target.selection;
      profileName = selection.baseProfile.name;
      routeId = selection.route?.id;
      const targetProfile = target.effectiveProfile;
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
      if (own.modelAlias !== undefined) {
        const resolved = canonicalizeSubagentBinding(
          resolveSubagentBinding(
            this.config,
            this.flags,
            { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
            {
              modelPreference: filled.modelPreference,
              modelAlias: filled.modelAlias,
              thinkingEffort: filled.thinkingEffort,
            },
            {
              modelPreference: targetProfile.modelPreference,
              modelAlias: targetProfile.modelAlias,
              thinkingEffort: targetProfile.thinkingEffort,
            },
            this.models,
            roleConstraintsFromProfile(
              targetProfile,
              spawnConstraintOrigin(target.lease, target.spawnPolicy),
            ),
          ),
          this.models,
        );
        const modelSource = subagentModelSource(resolved);
        binding = { model: resolved.model, thinking: resolved.thinking };
        Object.defineProperties(binding, {
          modelSource: { value: modelSource, enumerable: false },
          bindingMode: { value: subagentBindingMode(resolved), enumerable: false },
        });
      }
    }
    const timeoutMs = resolveSubagentTimeoutMs(this.config);
    const specs = await createAgentSwarmSpecs(args, (agentId) =>
      this.swarmService.getSwarmItem({ callerAgentId: this.callerAgentId, agentId }),
    );
    const tasks: SessionSwarmTask<AgentSwarmSpec>[] = specs.map((spec) => {
      const descriptionName = spec.kind === 'resume' ? 'resume' : routeId ?? profileName;
      const common = {
        data: spec,
        profileName: spec.kind === 'resume' ? 'subagent' : profileName,
        routeId: spec.kind === 'resume' ? undefined : routeId,
        parentToolCallId: toolCallId,
        parentTurnId: turnId,
        prompt: spec.prompt,
        description: childDescription(args.description, spec.index, descriptionName),
        swarmIndex: spec.index,
        runInBackground: false,
        swarmItem: spec.item,
        signal,
        timeout: timeoutMs,
      };
      if (spec.kind === 'resume') {
        return {
          ...common,
          kind: 'resume' as const,
          resumeAgentId: spec.agentId,
        };
      }
      return {
        ...common,
        kind: 'spawn' as const,
        catalogSnapshot,
        binding,
      };
    });
    const results = await this.swarmService.run({
      callerAgentId: this.callerAgentId,
      tasks,
    });
    return renderSwarmResults(
      results.map(({ task, ...result }) => ({ spec: task.data as AgentSwarmSpec, ...result })),
    );
  }
}

async function createAgentSwarmSpecs(
  args: AgentSwarmToolInput,
  getResumeItem: (agentId: string) => Promise<string | undefined>,
): Promise<AgentSwarmSpec[]> {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(([agentId, prompt]) => ({
    agentId: agentId.trim(),
    prompt: prompt.trim(),
  }));
  const items = (args.items ?? []).map((item) => item.trim());
  const itemCount = items.length;
  const resumeCount = resumeEntries.length;
  const totalCount = resumeCount + itemCount;
  if (!hasMinimumAgentSwarmInputs(itemCount, resumeCount)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'AgentSwarm requires at least 2 items unless resume_agent_ids is provided.',
    );
  }
  if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`,
      { details: { total: totalCount, max: MAX_AGENT_SWARM_SUBAGENTS } },
    );
  }
  const promptTemplate = normalizeOptionalString(args.prompt_template);
  if (items.length > 0 && promptTemplate === undefined) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'prompt_template is required when items are provided.',
    );
  }
  if (promptTemplate !== undefined && !promptTemplate.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `prompt_template must include the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
      { details: { placeholder: PROMPT_TEMPLATE_PLACEHOLDER } },
    );
  }

  const seenPrompts = new Map<string, number>();
  const specs: AgentSwarmSpec[] = [];
  for (const entry of resumeEntries) {
    specs.push({
      kind: 'resume',
      index: specs.length + 1,
      agentId: entry.agentId,
      item: await getResumeItem(entry.agentId),
      prompt: entry.prompt,
    });
  }
  if (items.length > 0) {
    const itemPromptTemplate = promptTemplate!;
    items.forEach((item, index) => {
      const prompt = itemPromptTemplate.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item);
      const previousIndex = seenPrompts.get(prompt);
      if (previousIndex !== undefined) {
        throw new Error2(
          ErrorCodes.VALIDATION_FAILED,
          `Duplicate subagent prompts from items ${String(previousIndex)} and ${String(index + 1)}. AgentSwarm requires distinct subagents.`,
          { details: { previousIndex, index: index + 1 } },
        );
      }
      seenPrompts.set(prompt, index + 1);
      specs.push({
        kind: 'spawn',
        index: specs.length + 1,
        item,
        prompt,
      });
    });
  }
  return specs;
}

function hasMinimumAgentSwarmInputs(itemCount: number, resumeCount: number): boolean {
  return resumeCount > 0 || itemCount >= 2;
}

function childDescription(swarmDescription: string, index: number, profileName: string): string {
  return `${swarmDescription} #${String(index)} (${profileName})`;
}

function renderSwarmResults(results: readonly SwarmRunResult[]): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const aborted = results.filter((result) => result.status === 'aborted').length;
  const shouldRenderResumeHint =
    results.some((result) => result.status !== 'completed') &&
    results.some((result) => result.agentId !== undefined);
  const lines = [
    '<agent_swarm_result>',
    `<summary>${renderSwarmSummary(completed, failed, aborted)}</summary>`,
  ];

  if (shouldRenderResumeHint) {
    lines.push(
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
    );
  }

  for (const result of results) {
    const agentId = result.agentId === undefined ? '' : ` agent_id="${result.agentId}"`;
    const mode = result.spec.kind === 'resume' ? ' mode="resume"' : '';
    const item = result.spec.item === undefined ? '' : ` item="${escapeXmlAttribute(result.spec.item)}"`;
    const state = result.state === undefined ? '' : ` state="${result.state}"`;
    const body = result.status === 'completed' ? (result.result ?? '') : (result.error ?? 'unknown error');
    lines.push(
      `<subagent${mode}${agentId}${item}${state} outcome="${result.status}">${body}</subagent>`,
    );
  }

  lines.push('</agent_swarm_result>');
  return lines.join('\n');
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function renderSwarmSummary(completed: number, failed: number, aborted = 0): string {
  const parts: string[] = [];
  if (completed > 0) parts.push(`completed: ${String(completed)}`);
  if (failed > 0) parts.push(`failed: ${String(failed)}`);
  if (aborted > 0) parts.push(`aborted: ${String(aborted)}`);
  return parts.join(', ');
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
