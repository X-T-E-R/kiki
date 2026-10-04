import type {
  AgentCapabilitiesResponse,
  ListNamedAgentProfilesQuery,
  ListNamedAgentProfilesResponse,
  NamedAgentExecutorField,
  NamedAgentProfile,
  ToolDescriptor,
  UpdateNamedAgentProfileRequest,
} from '@kiki/protocol';

export interface SubagentProfileToolDraft {
  /** null removes the field; [] is an explicit allowlist allowing no tools. */
  readonly tools: readonly string[] | null;
  readonly disallowedTools: readonly string[] | null;
}

export interface SubagentProfileToolOptions {
  /** A workspace selected by the caller, required for an unscoped file profile. */
  readonly workspaceId?: string;
}

export interface SubagentProfileToolField {
  readonly field: 'tools' | 'disallowed_tools';
  readonly source: string;
  readonly sourceFile?: string;
  readonly values: readonly string[] | null;
  readonly editable: boolean;
  readonly executor: string;
  readonly applicability: NamedAgentExecutorField['state'] | 'unknown';
  readonly reason?: string;
}

/** Search only backend inventory; never substitute a static list for missing inventory. */
export function searchSubagentToolCatalog<T extends Pick<ToolDescriptor, 'name' | 'description' | 'source' | 'mcp_server_id'>>(
  tools: readonly T[],
  query: string,
  source?: ToolDescriptor['source'],
): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return tools.filter((tool) => {
    if (source !== undefined && tool.source !== source) return false;
    const text = [tool.name, tool.description, tool.source, tool.mcp_server_id ?? ''].join('\n').toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  }).toSorted((a, b) => a.name.localeCompare(b.name));
}

export function subagentProfileToolDraft(profile: Pick<NamedAgentProfile, 'tools' | 'disallowed_tools'>): SubagentProfileToolDraft {
  return {
    tools: profile.tools === undefined ? null : [...profile.tools],
    disallowedTools: profile.disallowed_tools === undefined ? null : [...profile.disallowed_tools],
  };
}

function writeTarget(profile: NamedAgentProfile, options: SubagentProfileToolOptions) {
  const workspaceId = options.workspaceId ?? profile.workspace_id ?? profile.workspace_ids?.[0];
  if (workspaceId === undefined || profile.source_file === undefined
    || !['user', 'workspace', 'extra'].includes(profile.source)) return undefined;
  return {
    scope: profile.source === 'workspace' ? 'project' as const : profile.source === 'user' ? 'user' as const : 'extra' as const,
    workspace_id: workspaceId,
    source_file: profile.source_file,
  };
}

/** File editability and executor applicability are separate: ignored fields do not grant tools. */
export function subagentProfileToolFields(
  profile: NamedAgentProfile,
  options: SubagentProfileToolOptions = {},
): SubagentProfileToolField[] {
  const executor = profile.executor ?? 'native';
  const draft = subagentProfileToolDraft(profile);
  return (['tools', 'disallowed_tools'] as const).map((field) => {
    const applicability = profile.executor_fields?.[field];
    return {
      field,
      source: profile.source,
      sourceFile: profile.source_file,
      values: field === 'tools' ? draft.tools : draft.disallowedTools,
      editable: writeTarget(profile, options) !== undefined,
      executor,
      applicability: executor === 'native' ? 'applied' : applicability?.state ?? 'unknown',
      reason: executor === 'native' ? undefined : applicability?.reason,
    };
  });
}

function sameList(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validatedList(values: readonly string[] | null): string[] | null {
  if (values === null) return null;
  const result = values.map((value) => value.trim());
  if (result.some((value) => value === '')) throw new Error('Tool names must not be blank');
  return result;
}

/** Uses the existing profile writer, never the global subagent board opt-in configuration. */
export function subagentProfileToolPatch(
  profile: NamedAgentProfile,
  draft: SubagentProfileToolDraft,
  options: SubagentProfileToolOptions = {},
): UpdateNamedAgentProfileRequest | undefined {
  const baseline = subagentProfileToolDraft(profile);
  const tools = validatedList(draft.tools);
  const denied = validatedList(draft.disallowedTools);
  const toolsChanged = !sameList(tools, baseline.tools);
  const deniedChanged = !sameList(denied, baseline.disallowedTools);
  if (!toolsChanged && !deniedChanged) return undefined;
  const target = writeTarget(profile, options);
  if (target === undefined) throw new Error('Profile has no writable file and workspace');
  return {
    ...target,
    tools: toolsChanged ? tools : undefined,
    disallowed_tools: deniedChanged ? denied : undefined,
  };
}

export interface SubagentProfileToolClient {
  updateNamedAgentProfile(name: string, body: UpdateNamedAgentProfileRequest): Promise<NamedAgentProfile>;
  listNamedAgentProfiles(query: ListNamedAgentProfilesQuery): Promise<ListNamedAgentProfilesResponse>;
}

/** PATCH echoes are not read-back evidence: reload and locate the exact file in the addressed workspace. */
export async function saveSubagentProfileToolSettings(
  client: SubagentProfileToolClient,
  profile: NamedAgentProfile,
  draft: SubagentProfileToolDraft,
  options: SubagentProfileToolOptions = {},
): Promise<NamedAgentProfile> {
  const patch = subagentProfileToolPatch(profile, draft, options);
  if (patch === undefined) return profile;
  await client.updateNamedAgentProfile(profile.name, patch);
  const catalog = await client.listNamedAgentProfiles({ workspace_id: patch.workspace_id });
  if (!catalog.complete) throw new Error('Profile was saved but its catalog reload is incomplete');
  const saved = catalog.items.find((item) => item.name === profile.name && item.source === profile.source
    && item.source_file === patch.source_file);
  if (saved === undefined) throw new Error('Profile was saved but its file is missing from the reloaded catalog');
  return saved;
}

/** Only a selected live agent panel can supply actual tool states; a draft or main-tool catalog cannot. */
export function subagentSessionToolStates(
  panel: AgentCapabilitiesResponse | undefined,
  selectedAgentId: string | undefined,
): AgentCapabilitiesResponse['tools'] {
  if (selectedAgentId === undefined || panel?.context !== 'live' || panel.live !== true
    || panel.owner.agent_id !== selectedAgentId
    || (panel.profile?.executor !== undefined && panel.profile.executor !== 'native')) return undefined;
  return panel.tools;
}
