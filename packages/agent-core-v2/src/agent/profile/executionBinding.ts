import type { ExecutionBinding, ExecutionOverrides, ExecutionSelection } from '@kiki/protocol';
import type { AgentProfile } from '@kiki/agent-profiles/agentProfile';
import { resolveProfileThinkingDefault } from '@kiki/agent-profiles/modelProfileOverlay';
import type { AgentExecutorDefaults } from '#/app/agentExecutor/executorOverrides';
import { executionContextIdentity } from '#/app/agentExecutor/agentExecutor';

export function resolveExecutionBinding(
  requested: ExecutionSelection,
  defaults: AgentExecutorDefaults | undefined,
  profile: AgentProfile | undefined,
  previous: ExecutionBinding | undefined,
  engineDefault?: {
    readonly model?: string;
    readonly thinkingFor?: (model: string) => string | undefined;
  },
  liveModel?: string,
): ExecutionBinding {
  const sameSelection = previous?.selection.executor === requested.executor && previous.selection.profile === requested.profile
    && previous.selection.profile_file === requested.profile_file;
  const overrides: ExecutionOverrides = { ...(sameSelection ? previous.selection.overrides : undefined) };
  for (const [key, value] of Object.entries(requested.overrides ?? {})) {
    if (value === null) delete overrides[key as keyof ExecutionOverrides];
    else if (value !== undefined) Object.assign(overrides, { [key]: value });
  }
  const sameGroup = profile !== undefined && (profile.executor ?? 'native') === requested.executor;
  if (requested.overrides?.model === undefined && sameGroup && profile?.modelAlias === undefined && overrides.model === undefined) {
    const carried = previous === undefined
      ? liveModel
      : previous.selection.executor === requested.executor && !sameSelection
        ? previous.effective.model
        : undefined;
    if (carried !== undefined && carried.length > 0) overrides.model = carried;
  }
  const selection: ExecutionSelection = { executor: requested.executor, profile: requested.profile, profile_file: requested.profile_file,
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
  let model = pick('model', sameGroup ? profile?.modelAlias : undefined, defaults?.model_alias);
  if (model === undefined && profile !== undefined && !sameGroup && engineDefault?.model !== undefined) {
    model = engineDefault.model;
    sources['model'] = 'harness-default';
  }
  let thinking = pick('thinking', sameGroup ? resolveProfileThinkingDefault(profile, model ?? '', (id) => id) : undefined, defaults?.thinking_effort);
  if (thinking === undefined && profile !== undefined && !sameGroup && model !== undefined && engineDefault?.thinkingFor !== undefined) {
    const resolvedThinking = engineDefault.thinkingFor(model);
    if (resolvedThinking !== undefined) {
      thinking = resolvedThinking;
      sources['thinking'] = 'harness-default';
    }
  }
  const injectKikiMcp = pick('inject_kiki_mcp', profile?.injectKikiMcp, defaults?.inject_kiki_mcp);
  const effective: ExecutionBinding['effective'] = {
    model,
    thinking,
    native_agent: pick('native_agent', undefined, defaults?.native_agent),
    permission_mode: pick('permission_mode', profile?.permissionMode, defaults?.permission_mode),
    kiki_context: [...pick('kiki_context', profile?.kikiContext, defaults?.kiki_context) ?? []],
    allow_kiki_subagents: pick('allow_kiki_subagents', profile?.allowKikiSubagents, defaults?.allow_kiki_subagents) ?? false,
    inject_kiki_mcp: injectKikiMcp,
  };
  const changed = JSON.stringify(executionContextIdentity({ selection, effective })) !== JSON.stringify(previous === undefined ? undefined : executionContextIdentity(previous));
  return { version: 1, selection, effective, sources, generation: previous === undefined ? 1 : previous.generation + (changed ? 1 : 0) };
}

export function resolveSelectedExecutionBinding(
  requested: ExecutionSelection,
  prompt: { readonly model?: string | null; readonly thinking?: string | null },
  defaults: AgentExecutorDefaults | undefined,
  profile: AgentProfile | undefined,
  previous: ExecutionBinding | undefined,
  nativeEngine?: {
    readonly model?: string;
    readonly thinkingFor?: (model: string) => string | undefined;
  },
  liveModel?: string,
): ExecutionBinding {
  const sameGroup = profile !== undefined && (profile.executor ?? 'native') === requested.executor;
  return resolveExecutionBinding({
    ...requested,
    overrides: {
      ...requested.overrides,
      model: prompt.model ?? requested.overrides?.model,
      thinking: prompt.thinking === null ? null : prompt.thinking ?? requested.overrides?.thinking,
    },
  }, defaults, profile, previous, profile !== undefined && !sameGroup && requested.executor === 'native' ? nativeEngine : undefined, liveModel);
}
