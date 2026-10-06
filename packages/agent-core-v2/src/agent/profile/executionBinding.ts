import type { ExecutionBinding, ExecutionOverrides, ExecutionSelection } from '@kiki/protocol';
import type { AgentProfile } from '@kiki/agent-profiles/agentProfile';
import { resolveProfileThinkingDefault } from '@kiki/agent-profiles/modelProfileOverlay';
import type { AgentExecutorDefaults } from '#/app/agentExecutor/executorOverrides';

export function resolveExecutionBinding(
  requested: ExecutionSelection,
  defaults: AgentExecutorDefaults | undefined,
  profile: AgentProfile | undefined,
  previous: ExecutionBinding | undefined,
): ExecutionBinding {
  const sameSelection = previous?.selection.executor === requested.executor && previous.selection.profile === requested.profile;
  const overrides: ExecutionOverrides = { ...(sameSelection ? previous.selection.overrides : undefined) };
  for (const [key, value] of Object.entries(requested.overrides ?? {})) {
    if (value === null) delete overrides[key as keyof ExecutionOverrides];
    else if (value !== undefined) Object.assign(overrides, { [key]: value });
  }
  const selection: ExecutionSelection = { executor: requested.executor, profile: requested.profile,
    overrides: Object.keys(overrides).length > 0 ? overrides : undefined };
  const sources: ExecutionBinding['sources'] = {};
  const pick = <T>(key: keyof ExecutionOverrides, profileValue: T | undefined, defaultValue: T | undefined): T | undefined => {
    const explicit = overrides[key];
    if (explicit !== undefined && explicit !== null) { sources[key] = 'session'; return explicit as T; }
    if (profileValue !== undefined) { sources[key] = 'profile'; return profileValue; }
    if (defaultValue !== undefined) { sources[key] = 'harness-settings'; return defaultValue; }
    sources[key] = 'harness-default';
    return undefined;
  };
  const model = pick('model', profile?.modelAlias, defaults?.model_alias);
  const effective: ExecutionBinding['effective'] = {
    model,
    thinking: pick('thinking', profile === undefined ? undefined : resolveProfileThinkingDefault(profile, model ?? '', (id) => id), defaults?.thinking_effort),
    permission_mode: pick('permission_mode', profile?.permissionMode, defaults?.permission_mode),
    kiki_context: [...pick('kiki_context', profile?.kikiContext, defaults?.kiki_context) ?? []],
    allow_kiki_subagents: pick('allow_kiki_subagents', profile?.allowKikiSubagents, defaults?.allow_kiki_subagents) ?? false,
  };
  const changed = JSON.stringify({ selection, effective }) !== JSON.stringify(previous === undefined ? undefined : { selection: previous.selection, effective: previous.effective });
  return { version: 1, selection, effective, sources, generation: previous === undefined ? 1 : previous.generation + (changed ? 1 : 0) };
}
