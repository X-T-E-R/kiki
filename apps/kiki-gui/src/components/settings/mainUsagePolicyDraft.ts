/**
 * Usage policy: the difference layer on top of a model's shared settings.
 *
 * One model, one set of shared values — default effort, service tier, the
 * compaction trigger, the context budget, the generated-token ceiling. An
 * identity branch (`main`, `independent`) may override a field; anything it
 * leaves unset keeps inheriting, so a branch is a difference and never a second
 * copy. There is no `sub` branch: subagents use the shared values, which is
 * what makes them the zero-configuration case.
 *
 * The shared values stay where they already live: `parameters.thinking_effort`,
 * `parameters.service_tier` and `parameters.max_completion_tokens`, plus the
 * model's own `auto_compact` and `context_budget`. This module reads them back
 * for the "inherits" line; it never rewrites them.
 *
 * Three states per field, and they stay three because the engine reads them
 * apart:
 *   - inherit    — nothing is written for that position
 *   - a value    — this position's own number or word
 *   - not sent   — the tier is deliberately omitted so the API default applies,
 *                  which is not the same as being unset. Thinking has no such
 *                  state: it is switched off by the effort string `off`.
 *
 * Numeric fields are edited as text and parsed on save, like the other engine
 * fields in this editor, so a half-typed token count never blocks the row.
 *
 * Clearing one field sends `null` and restores inheritance; clearing a whole
 * branch sends `null` for that branch. The editor never does either by itself.
 *
 * The budget is a ceiling rather than a preference: the resolved value is the
 * lower of the shared cap and this position's difference, so an identity can
 * tighten the budget but never raise it past what the shared layer allows.
 */

import type { ModelEntity, ModelUsageParametersWire } from '@kiki/protocol';

/** The positions that may carry a difference. `sub` is deliberately absent. */
export type UsagePosition = 'main' | 'independent';

export const USAGE_POSITIONS: readonly UsagePosition[] = ['main', 'independent'] as const;

/** What the resolved projection reports per position; sub uses the shared values. */
export type UsageSourcePosition = UsagePosition | 'sub';

export type UsagePolicyField = keyof ModelUsageParametersWire;

export const USAGE_POLICY_FIELDS: readonly UsagePolicyField[] = [
  'thinking_effort', 'service_tier', 'auto_compact', 'context_budget', 'max_completion_tokens',
] as const;

/** The numeric fields: a whole number of tokens, 1 or more. */
const COUNT_FIELDS = new Set<UsagePolicyField>(['auto_compact', 'context_budget', 'max_completion_tokens']);

export const COUNT_USAGE_FIELDS = COUNT_FIELDS;

export const USAGE_SERVICE_TIERS = ['auto', 'default', 'flex', 'priority'] as const;

/** The tier as the editor holds it while being edited. */
export type TierDraft = 'inherit' | 'not_sent' | typeof USAGE_SERVICE_TIERS[number];

/** The four fields held as typed text; the tier has its own three-way picker. */
export type UsageTextField = 'thinkingEffort' | 'autoCompact' | 'contextBudget' | 'maxCompletionTokens';

/** Wire field name to the draft's own key; the tier has its own shape. */
export const USAGE_TEXT_KEY: Readonly<Record<Exclude<UsagePolicyField, 'service_tier'>, UsageTextField>> = {
  thinking_effort: 'thinkingEffort',
  auto_compact: 'autoCompact',
  context_budget: 'contextBudget',
  max_completion_tokens: 'maxCompletionTokens',
};

export interface UsageBranchDraft {
  thinkingEffort: string | undefined;
  tier: TierDraft;
  autoCompact: string | undefined;
  contextBudget: string | undefined;
  maxCompletionTokens: string | undefined;
}

export const EMPTY_USAGE_BRANCH: UsageBranchDraft = {
  thinkingEffort: undefined,
  tier: 'inherit',
  autoCompact: undefined,
  contextBudget: undefined,
  maxCompletionTokens: undefined,
};

export type UsagePolicyDraft = { [P in UsagePosition]?: UsageBranchDraft };

const isApiDefault = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'api_default';

function tierFromWire(value: ModelUsageParametersWire['service_tier']): TierDraft {
  if (value === undefined) return 'inherit';
  if (isApiDefault(value)) return 'not_sent';
  if (typeof value !== 'string') return 'inherit';
  return (USAGE_SERVICE_TIERS as readonly string[]).includes(value) ? value as TierDraft : 'inherit';
}

const textFromWire = (value: number | string | undefined): string | undefined =>
  value === undefined ? undefined : String(value);

/** Reads one position's branch off an entity. */
export function usageBranchDraft(entity: ModelEntity, position: UsagePosition): UsageBranchDraft {
  const branch = entity.usage?.[position];
  return {
    thinkingEffort: textFromWire(branch?.thinking_effort),
    tier: tierFromWire(branch?.service_tier),
    autoCompact: textFromWire(branch?.auto_compact),
    contextBudget: textFromWire(branch?.context_budget),
    maxCompletionTokens: textFromWire(branch?.max_completion_tokens),
  };
}

/** The value a row currently holds, as the one string every branch compares. */
export function usageFieldValue(branch: UsageBranchDraft, field: UsagePolicyField): string {
  if (field === 'service_tier') return branch.tier === 'inherit' ? '' : branch.tier;
  return branch[USAGE_TEXT_KEY[field]] ?? '';
}

/** Sets one text field, narrowing the wire name to the draft key it maps to. */
export function setUsageText(branch: UsageBranchDraft, field: Exclude<UsagePolicyField, 'service_tier'>, value: string): UsageBranchDraft {
  return { ...branch, [USAGE_TEXT_KEY[field]]: value };
}

/** Clears one field back to inheriting. */
export function clearUsageField(field: UsagePolicyField): Partial<UsageBranchDraft> {
  return field === 'service_tier' ? { tier: 'inherit' } : { [USAGE_TEXT_KEY[field]]: undefined };
}

export function usageBranchDraftsEqual(a: UsageBranchDraft, b: UsageBranchDraft): boolean {
  return USAGE_POLICY_FIELDS.every((field) => usageFieldValue(a, field) === usageFieldValue(b, field));
}

export function usagePolicyDraftsEqual(a: UsagePolicyDraft, b: UsagePolicyDraft): boolean {
  return USAGE_POSITIONS.every((position) =>
    usageBranchDraftsEqual(a[position] ?? EMPTY_USAGE_BRANCH, b[position] ?? EMPTY_USAGE_BRANCH));
}

/**
 * How many fields this position sets, for the one difference count on screen.
 * `inherit` is what "not overridden" means for the tier, so it is normalised
 * away above: a position that set nothing must count as zero, not one.
 */
export function countUsageDifferences(branch: UsageBranchDraft): number {
  return USAGE_POLICY_FIELDS.filter((field) => usageFieldValue(branch, field) !== '').length;
}

export type UsagePolicyProblem = UsagePolicyField;

/**
 * The numeric fields reject a non-positive or non-integer value before any
 * patch leaves the editor. The tier cannot fail here — the picker only offers
 * the wire enum — but the check stays so a programmatically-set value cannot
 * slip through as a stored difference.
 */
export function usageBranchProblem(branch: UsageBranchDraft): UsagePolicyProblem | undefined {
  for (const field of USAGE_POLICY_FIELDS) {
    if (!COUNT_FIELDS.has(field)) continue;
    const text = usageFieldValue(branch, field);
    if (text === '') continue;
    const parsed = Number(text);
    if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(parsed) || parsed < 1) return field;
  }
  return undefined;
}

/**
 * The wire branch for one position: only the fields that changed, with `null`
 * for a field returning to inheriting. A position whose fields all came back
 * sends `null` for the branch, which removes a difference without touching the
 * other position.
 */
export function usageBranchWire(
  draft: UsageBranchDraft,
  baseline: UsageBranchDraft,
): Record<string, unknown> | null {
  const wire: Record<string, unknown> = {};
  const text = (field: Exclude<UsagePolicyField, 'service_tier'>, next: string | undefined) => {
    if (usageFieldValue(draft, field) === usageFieldValue(baseline, field)) return;
    if (next === undefined || next === '') wire[field] = null;
    else wire[field] = COUNT_FIELDS.has(field) ? Number(next) : next;
  };
  if (usageFieldValue(draft, 'service_tier') !== usageFieldValue(baseline, 'service_tier')) {
    wire['service_tier'] = draft.tier === 'inherit' ? null
      : draft.tier === 'not_sent' ? { kind: 'api_default' }
      : draft.tier;
  }
  text('thinking_effort', draft.thinkingEffort);
  text('auto_compact', draft.autoCompact);
  text('context_budget', draft.contextBudget);
  text('max_completion_tokens', draft.maxCompletionTokens);
  return Object.keys(wire).length === 0 ? null : wire;
}

/** The full `usage` patch: one entry per position that actually changed. */
export function usagePolicyPatch(
  draft: UsagePolicyDraft,
  baseline: UsagePolicyDraft,
): Record<string, unknown> {
  const usage: Record<string, unknown> = {};
  for (const position of USAGE_POSITIONS) {
    const next = draft[position] ?? EMPTY_USAGE_BRANCH;
    const was = baseline[position] ?? EMPTY_USAGE_BRANCH;
    const wire = usageBranchWire(next, was);
    if (wire !== null) usage[position] = wire;
    else if (!usageBranchDraftsEqual(next, was)) usage[position] = null;
  }
  return Object.keys(usage).length === 0 ? {} : { usage };
}

/** What a position really resolves to, from the server's own projection. */
export function usageEffectiveFor(entity: ModelEntity, position: UsageSourcePosition): ModelUsageParametersWire | undefined {
  return entity.usage_effective?.[position];
}

/** The origin label a position's resolved value was read from. */
export function usageSourceFor(
  entity: ModelEntity,
  position: UsageSourcePosition,
  field: UsagePolicyField,
): string | undefined {
  return entity.usage_sources?.[position]?.[field];
}
