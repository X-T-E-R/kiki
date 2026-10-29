/**
 * Memory Advisor settings: the framework-free half of the quick switch and the
 * settings card. Field shapes, ranges and defaults come from the protocol
 * schema (`memoryAdvisorConfigSchema`), never from a second copy here.
 *
 * Two switches stay separate on purpose: `memory.enabled` decides whether
 * memory exists at all; `advisor.mode` only decides whether a chosen model
 * picks which saved entries ride into a turn. Turning the advisor off never
 * writes `enabled`, and a mode change never touches the selector or source.
 */

import {
  MEMORY_ADVISOR_FIRST_STEP_WAIT_DEFAULTS,
  memoryAdvisorConfigSchema,
  memoryAdvisorFirstStepWaitMs,
  type MemoryAdvisorConfig,
  type MemoryAdvisorFailure,
  type MemoryAdvisorPatch,
  type MemoryAdvisorSelector,
  type MemoryAdvisorStatus,
} from '@kiki/protocol';

import type { I18nKey } from '../i18n/locale';

export type MemoryAdvisorProtocol = MemoryAdvisorSelector['protocol'];
export type MemoryAdvisorMode = MemoryAdvisorConfig['mode'];

export const MEMORY_ADVISOR_PROTOCOLS: readonly MemoryAdvisorProtocol[] = ['chat_json', 'system_one', 'pair_score'];

/** The tuning fields a person may change, in the order the settings card lists them. */
export const MEMORY_ADVISOR_NUMBER_FIELDS = [
  'first_step_wait_ms',
  'timeout_ms',
  'max_calls_per_turn',
  'max_full_units',
  'judge_input_tokens',
  'candidate_chars',
  'catalog_page_items',
  'max_catalog_pages',
] as const;
export type MemoryAdvisorNumberField = (typeof MEMORY_ADVISOR_NUMBER_FIELDS)[number];

export interface MemoryAdvisorRange {
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

interface NumberCheck { readonly minValue: number | null; readonly maxValue: number | null }
interface Wrapped { unwrap?: () => unknown }

/** The schema's own defaults, as the engine would read an empty `[memory.advisor]`. */
export const MEMORY_ADVISOR_DEFAULTS: MemoryAdvisorConfig = memoryAdvisorConfigSchema.parse({});

function rangeOf(field: MemoryAdvisorNumberField): MemoryAdvisorRange {
  let node = memoryAdvisorConfigSchema.shape[field] as unknown as Wrapped & Partial<NumberCheck>;
  while (node.minValue === undefined && typeof node.unwrap === 'function') node = node.unwrap() as Wrapped & Partial<NumberCheck>;
  return {
    min: node.minValue ?? 0,
    max: node.maxValue ?? Number.MAX_SAFE_INTEGER,
    fallback: MEMORY_ADVISOR_DEFAULTS[field] ?? MEMORY_ADVISOR_FIRST_STEP_WAIT_DEFAULTS.chat_json,
  };
}

export const MEMORY_ADVISOR_RANGES: Readonly<Record<MemoryAdvisorNumberField, MemoryAdvisorRange>> = Object.fromEntries(
  MEMORY_ADVISOR_NUMBER_FIELDS.map((field) => [field, rangeOf(field)]),
) as Record<MemoryAdvisorNumberField, MemoryAdvisorRange>;

/**
 * The value a tuning field shows and whether it is the user's own. The
 * first-step wait has no single default: an unset value follows the resolved
 * source protocol, which the server reports on the status.
 */
export function memoryAdvisorNumberValue(
  field: MemoryAdvisorNumberField,
  config: MemoryAdvisorConfig | undefined,
  status: MemoryAdvisorStatus | undefined,
): { readonly value: number; readonly fallback: number; readonly explicit: boolean } {
  const fallback = field === 'first_step_wait_ms'
    ? status?.first_step_wait_default_ms ?? memoryAdvisorFirstStepWaitMs(undefined, status?.source_status?.protocol ?? status?.protocol ?? config?.selector?.protocol)
    : MEMORY_ADVISOR_RANGES[field].fallback;
  const saved = config?.[field];
  return { value: saved ?? fallback, fallback, explicit: saved !== undefined };
}

/** A whole number inside the schema range, or `null` when the text is not one. */
export function parseMemoryAdvisorNumber(field: MemoryAdvisorNumberField, text: string): number | null {
  if (!/^\d+$/u.test(text.trim())) return null;
  const value = Number(text.trim());
  const range = MEMORY_ADVISOR_RANGES[field];
  return value >= range.min && value <= range.max ? value : null;
}

/** The quick switch's write: the mode alone, so the selector and source stay as saved. */
export function memoryAdvisorModePatch(on: boolean, current?: MemoryAdvisorConfig): { advisor: MemoryAdvisorPatch } {
  if (!on) return { advisor: { mode: 'off' } };
  // Coming back on restores the last real choice only when it was `select`;
  // `off` itself carries no memory of it, so the default `rank` applies.
  return { advisor: { mode: current?.mode === 'select' ? 'select' : 'rank' } };
}

/**
 * The advisor is available by default: with no `[memory.advisor]` it counts as
 * on and simply waits for a model. Only an explicit `mode = "off"` turns it off.
 */
export function memoryAdvisorOn(config: MemoryAdvisorConfig | undefined): boolean {
  return (config?.mode ?? MEMORY_ADVISOR_DEFAULTS.mode) !== 'off';
}

/**
 * The base URL a model's requests actually go to. The server's resolved
 * `effective_base_url` (model, provider, env or vendor default) wins; servers
 * that do not send it fall back to the model's own `base_url` override, then
 * its provider's, then `fallback` (the status origin of a saved selector).
 */
export function memoryAdvisorModelBaseUrl(
  model: { readonly base_url?: string; readonly effective_base_url?: string } | undefined,
  provider: { readonly base_url?: string } | undefined,
  fallback?: string,
): string | undefined {
  for (const candidate of [model?.effective_base_url, model?.base_url, provider?.base_url, fallback]) {
    const value = candidate?.trim();
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/**
 * Where a non-chat selector's endpoint may live: the origin of the selected
 * model's effective base URL (see `memoryAdvisorModelBaseUrl`), so the request
 * carries that model's auth and nothing else. Returns the required origin when
 * the endpoint points elsewhere.
 */
export function memoryAdvisorEndpointIssue(
  endpoint: string,
  modelBaseUrl: string | undefined,
): { readonly kind: 'invalid' } | { readonly kind: 'origin'; readonly origin: string } | { readonly kind: 'no_provider_url' } | null {
  let url: URL;
  try { url = new URL(endpoint.trim()); } catch { return { kind: 'invalid' }; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return { kind: 'invalid' };
  if (modelBaseUrl === undefined || modelBaseUrl.trim() === '') return { kind: 'no_provider_url' };
  let base: URL;
  try { base = new URL(modelBaseUrl.trim()); } catch { return { kind: 'no_provider_url' }; }
  return base.origin === url.origin ? null : { kind: 'origin', origin: base.origin };
}

/** The selector a draft would save, or `null` while it is incomplete. */
export function memoryAdvisorSelectorFromDraft(draft: {
  readonly protocol: MemoryAdvisorProtocol;
  readonly model: string;
  readonly endpoint: string;
}): MemoryAdvisorSelector | null {
  const model = draft.model.trim();
  if (model === '') return null;
  if (draft.protocol === 'chat_json') return { protocol: 'chat_json', model };
  const endpoint = draft.endpoint.trim();
  if (endpoint === '') return null;
  return { protocol: draft.protocol, model, endpoint };
}

export type MemoryAdvisorTone = 'muted' | 'ok' | 'caution' | 'danger';

export interface MemoryAdvisorView {
  /** What the quick switch shows: off, needs a model, problem, or running. */
  readonly kind: 'off' | 'unconfigured' | 'problem' | 'on';
  readonly on: boolean;
  readonly tone: MemoryAdvisorTone;
  readonly stateKey: I18nKey;
  readonly reasonKey?: I18nKey;
}

const FAILURE_KEYS: Readonly<Record<MemoryAdvisorFailure, I18nKey>> = {
  unconfigured: 'memory.advisor.reason.unconfigured',
  not_permitted: 'memory.advisor.reason.not_permitted',
  consent_required: 'memory.advisor.reason.consent_required',
  unsupported_store: 'memory.advisor.reason.unsupported_store',
  timeout: 'memory.advisor.reason.timeout',
  aborted: 'memory.advisor.reason.aborted',
  auth: 'memory.advisor.reason.auth',
  rate_limited: 'memory.advisor.reason.rate_limited',
  protocol: 'memory.advisor.reason.protocol',
  invalid_output: 'memory.advisor.reason.invalid_output',
  capability_mismatch: 'memory.advisor.reason.capability_mismatch',
  input_budget: 'memory.advisor.reason.input_budget',
  unavailable: 'memory.advisor.reason.unavailable',
};

export function memoryAdvisorReasonKey(reason: MemoryAdvisorFailure | undefined): I18nKey | undefined {
  return reason === undefined ? undefined : FAILURE_KEYS[reason];
}

/**
 * One reading of config + status for every surface. The saved mode decides
 * on/off; the status only explains what that choice is doing right now.
 */
export function memoryAdvisorView(config: MemoryAdvisorConfig | undefined, status: MemoryAdvisorStatus | undefined): MemoryAdvisorView {
  const on = memoryAdvisorOn(config);
  const reasonKey = memoryAdvisorReasonKey(status?.reason);
  if (!on) return { kind: 'off', on, tone: 'muted', stateKey: 'memory.advisor.state.off' };
  if ((config?.source === undefined && config?.selector === undefined) || status?.state === 'unconfigured') {
    return { kind: 'unconfigured', on, tone: 'caution', stateKey: 'memory.advisor.state.unconfigured' };
  }
  switch (status?.state) {
    case 'failed':
    case 'unsupported_store':
      return { kind: 'problem', on, tone: 'danger', stateKey: `memory.advisor.state.${status.state}`, reasonKey };
    case 'limited':
      return { kind: 'problem', on, tone: 'caution', stateKey: 'memory.advisor.state.limited', reasonKey };
    case 'disabled':
      return { kind: 'problem', on, tone: 'muted', stateKey: 'memory.advisor.state.disabled', reasonKey };
    case 'pending':
    case 'selected':
    case 'none':
      return { kind: 'on', on, tone: 'ok', stateKey: `memory.advisor.state.${status.state}` };
    default:
      return { kind: 'on', on, tone: 'ok', stateKey: 'memory.advisor.state.ready' };
  }
}

/** The card the quick entries open, optionally naming the workspace to read live status for. */
export function memoryAdvisorSettingsRoute(workspaceId?: string): string {
  return `/settings/memory${workspaceId === undefined ? '' : `?workspace=${encodeURIComponent(workspaceId)}`}#st-card-memory-advisor`;
}
