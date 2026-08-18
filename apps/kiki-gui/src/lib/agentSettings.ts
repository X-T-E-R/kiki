import type { KikiConfigPatch, KikiConfigResponse } from './client';

export interface SecondaryModelDraftEntry {
  readonly id: string;
  readonly description: string;
}

export interface SubagentGovernanceDraft {
  readonly models: SecondaryModelDraftEntry[];
  readonly defaultModel: string;
  readonly force: boolean;
  readonly enforcePool: boolean;
  readonly denyModels: string;
}

export type SubagentGovernanceIssue =
  | 'duplicate_model'
  | 'reserved_primary'
  | 'default_required'
  | 'default_not_in_pool'
  | 'force_pool_conflict'
  | 'enforce_requires_pool'
  | 'enforce_force_conflict';

export function subagentGovernanceFromConfig(
  config: KikiConfigResponse,
): SubagentGovernanceDraft {
  return {
    models: Object.entries(config.secondary_model?.models ?? {}).map(([id, description]) => ({
      id,
      description,
    })),
    defaultModel: config.secondary_model?.defaultModel ?? '',
    force: config.secondary_model?.force === true,
    enforcePool: config.secondary_model?.enforcePool === true,
    denyModels: (config.subagent?.denyModels ?? []).join('\n'),
  };
}

export function validateSubagentGovernance(
  draft: SubagentGovernanceDraft,
): SubagentGovernanceIssue | null {
  const ids = draft.models.map((model) => model.id.trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length) return 'duplicate_model';
  if (ids.includes('primary')) return 'reserved_primary';
  const defaultModel = draft.defaultModel.trim();
  if ((ids.length > 0 || draft.force) && defaultModel === '') return 'default_required';
  if (ids.length > 0 && !ids.includes(defaultModel)) return 'default_not_in_pool';
  if (draft.force && ids.length > 0) return 'force_pool_conflict';
  if (draft.enforcePool && ids.length === 0) return 'enforce_requires_pool';
  if (draft.enforcePool && draft.force) return 'enforce_force_conflict';
  return null;
}

export function subagentGovernancePatch(draft: SubagentGovernanceDraft): KikiConfigPatch {
  const models = Object.fromEntries(
    draft.models
      .map((model) => [model.id.trim(), model.description.trim()] as const)
      .filter(([id]) => id !== ''),
  );
  return {
    subagent: {
      deny_models: draft.denyModels
        .split(/\r?\n/)
        .map((model) => model.trim())
        .filter(Boolean),
    },
    secondary_model: {
      default_model: draft.defaultModel.trim() || undefined,
      models: Object.keys(models).length > 0 ? models : undefined,
      force: draft.force,
      enforce_pool: draft.enforcePool,
    },
    replace_domains: ['secondary_model'],
  };
}

export interface ExperimentalFlagRow {
  readonly id: string;
  readonly effective: boolean;
  readonly override?: boolean;
}

export function experimentalFlagRows(
  meta: { readonly experimental_flags?: Record<string, boolean> },
  config: Pick<KikiConfigResponse, 'experimental'>,
): ExperimentalFlagRow[] {
  const effective = meta.experimental_flags ?? {};
  const overrides = config.experimental ?? {};
  return [...new Set([...Object.keys(effective), ...Object.keys(overrides)])]
    .toSorted((a, b) => a.localeCompare(b))
    .map((id) => ({ id, effective: effective[id] === true, override: overrides[id] }));
}
