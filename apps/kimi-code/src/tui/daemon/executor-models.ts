import type { AutocompleteItem } from '@kiki/pi-tui';
import type {
  ExecutorCatalogItem,
  ExecutorModelCatalogResponse,
  Session,
} from '@kiki/protocol';

export const ANTIGRAVITY_EXECUTOR_ID = 'antigravity-acp';

export interface ResolvedExecutorModels {
  readonly executorId: string;
  readonly label: string;
  readonly models: readonly string[];
  readonly thinkingLevels: readonly string[];
  readonly modelThinkingLevels: Readonly<Record<string, readonly string[]>>;
}

export interface NativeModelSummary {
  readonly id: string;
  readonly displayName?: string;
  readonly provider: string;
}

export function isExternalExecutorId(executorId: string | undefined): executorId is string {
  return executorId !== undefined && executorId !== '' && executorId !== 'native';
}

export function isAntigravityExecutorId(
  executorId: string | undefined,
  catalog: readonly ExecutorCatalogItem[],
): boolean {
  if (!isExternalExecutorId(executorId)) return false;
  if (executorId === ANTIGRAVITY_EXECUTOR_ID) return true;
  const item = catalog.find((entry) => entry.id === executorId);
  return item?.instance?.source_executor === ANTIGRAVITY_EXECUTOR_ID;
}

export function antigravityInstanceIdOf(
  executorId: string | undefined,
  catalog: readonly ExecutorCatalogItem[],
): string | undefined {
  if (!isAntigravityExecutorId(executorId, catalog)) return undefined;
  return executorId === ANTIGRAVITY_EXECUTOR_ID ? undefined : executorId;
}

/**
 * Merges entitled models and per-model thinking levels for an external executor
 * from live session negotiation, the executor model catalog endpoint, and the
 * executor registry item.
 */
export function resolveExecutorModels(
  executorId: string,
  sessionNegotiated: Session['negotiated'] | undefined,
  catalogItem: ExecutorCatalogItem | undefined,
  modelCatalog: ExecutorModelCatalogResponse | undefined,
): ResolvedExecutorModels {
  const negotiated = sessionNegotiated ?? catalogItem?.capabilities?.negotiated;
  const seen = new Set<string>();
  const models: string[] = [];
  for (const list of [
    negotiated?.models,
    modelCatalog?.effective.models.values,
    catalogItem?.capabilities?.negotiated?.models,
  ]) {
    for (const id of list ?? []) {
      const trimmed = id.trim();
      if (trimmed !== '' && !seen.has(trimmed)) {
        seen.add(trimmed);
        models.push(trimmed);
      }
    }
  }
  const modelThinkingLevels: Record<string, readonly string[]> = {
    ...(catalogItem?.capabilities?.negotiated?.model_thinking_levels ?? {}),
    ...(negotiated?.model_thinking_levels ?? {}),
  };
  for (const id of Object.keys(modelThinkingLevels)) {
    if (!seen.has(id)) {
      seen.add(id);
      models.push(id);
    }
  }
  const thinkingLevels = negotiated?.thinking_levels
    ?? modelCatalog?.effective.thinking_levels.values
    ?? catalogItem?.capabilities?.negotiated?.thinking_levels
    ?? [];
  return {
    executorId,
    label: catalogItem?.label ?? executorId,
    models,
    thinkingLevels,
    modelThinkingLevels,
  };
}

export function executorThinkingLevelsForModel(
  resolved: ResolvedExecutorModels,
  modelId: string | undefined,
): readonly string[] {
  if (modelId !== undefined && modelId !== '' && Object.hasOwn(resolved.modelThinkingLevels, modelId)) {
    return resolved.modelThinkingLevels[modelId] ?? [];
  }
  return resolved.thinkingLevels;
}

export function pickExecutorThinkingForModel(
  preferred: string | undefined,
  current: string | undefined,
  levels: readonly string[],
): string | undefined {
  if (levels.length === 0) return undefined;
  if (preferred !== undefined && levels.includes(preferred)) return preferred;
  if (current !== undefined && levels.includes(current)) return current;
  return levels[0];
}

function matchesPrefix(query: string, ...fields: readonly (string | undefined)[]): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') return true;
  return fields.some((field) => field !== undefined && field.toLowerCase().includes(normalized));
}

export function buildModelArgumentCompletions(
  prefix: string,
  external: ResolvedExecutorModels | undefined,
  nativeModels: readonly NativeModelSummary[],
): AutocompleteItem[] {
  if (external !== undefined && external.models.length > 0) {
    return external.models
      .filter((id) => matchesPrefix(prefix, id, external.label))
      .map((id) => {
        const levels = executorThinkingLevelsForModel(external, id);
        const description = levels.length > 0
          ? `${external.label} · ${levels.join('/')}`
          : external.label;
        return { value: id, label: id, description };
      });
  }
  return nativeModels
    .filter((model) => matchesPrefix(prefix, model.id, model.displayName, model.provider))
    .map((model) => ({
      value: model.id,
      label: model.id,
      description: model.displayName !== undefined && model.displayName !== '' && model.displayName !== model.id
        ? `${model.displayName} · ${model.provider}`
        : model.provider,
    }));
}

export function buildEffortArgumentCompletions(
  prefix: string,
  efforts: readonly string[],
): AutocompleteItem[] {
  return efforts
    .filter((effort) => matchesPrefix(prefix, effort))
    .map((effort) => ({ value: effort, label: effort }));
}

export function buildLoginArgumentCompletions(
  prefix: string,
  catalog: readonly ExecutorCatalogItem[],
  hasPendingAntigravity: boolean,
): AutocompleteItem[] {
  const items: AutocompleteItem[] = [];
  if (hasPendingAntigravity) {
    items.push({ value: 'cancel', label: 'cancel', description: 'Cancel pending Antigravity sign-in' });
  }
  const seen = new Set<string>();
  for (const item of catalog) {
    if (item.id !== ANTIGRAVITY_EXECUTOR_ID && item.instance?.source_executor !== ANTIGRAVITY_EXECUTOR_ID) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push({
      value: item.id,
      label: item.id,
      description: item.label,
    });
  }
  if (!seen.has(ANTIGRAVITY_EXECUTOR_ID)) {
    items.push({ value: ANTIGRAVITY_EXECUTOR_ID, label: ANTIGRAVITY_EXECUTOR_ID, description: 'Antigravity' });
  }
  return items.filter((item) => matchesPrefix(prefix, item.value, item.description));
}

export type ParsedAntigravityLoginCommand =
  | { readonly kind: 'cancel' }
  | {
      readonly kind: 'complete';
      readonly codeOrUrl: string;
      readonly instanceId?: string;
      /** Set when the user explicitly typed a target executor/instance id in `/login <target> <code>`. */
      readonly explicitTargetId?: string;
    }
  | { readonly kind: 'start'; readonly instanceId?: string };

/** True when an external executor's negotiated slash commands advertise `command` (with or without leading `/`). */
export function executorAdvertisesSlashCommand(
  command: string,
  sessionNegotiated: Session['negotiated'] | undefined,
  catalogItem: ExecutorCatalogItem | undefined,
): boolean {
  const target = command.trim().replace(/^\/+/u, '').toLowerCase();
  if (target === '') return false;
  const commands = sessionNegotiated?.slash_commands ?? catalogItem?.capabilities?.negotiated?.slash_commands;
  if (commands === undefined) return false;
  return commands.some((entry) => entry.trim().replace(/^\/+/u, '').toLowerCase() === target);
}

/** Formats an external executor slash command prompt (e.g. `/compact` or `/compact <args>`). */
export function formatExternalSlashCommandPrompt(command: string, args = ''): string {
  const normalized = command.trim().replace(/^\/+/u, '');
  const trimmedArgs = args.trim();
  return trimmedArgs === '' ? `/${normalized}` : `/${normalized} ${trimmedArgs}`;
}

/**
 * Guards against completing a pending Antigravity login for one target
 * (`instance-agy-work`) when the user explicitly supplied another target
 * (`/login antigravity-acp <code>`). Returns an error message on mismatch.
 */
export function checkAntigravityPendingTargetMismatch(
  parsed: Extract<ParsedAntigravityLoginCommand, { readonly kind: 'complete' }>,
  pending: { readonly handle: string; readonly instanceId?: string },
): string | undefined {
  if (parsed.explicitTargetId === undefined) return undefined;
  const pendingTarget = pending.instanceId ?? ANTIGRAVITY_EXECUTOR_ID;
  if (parsed.explicitTargetId === pendingTarget) return undefined;
  return `Pending Antigravity sign-in is for "${pendingTarget}", not "${parsed.explicitTargetId}". Run /login ${pendingTarget} <code> or /login cancel first.`;
}

/**
 * Parses `/login [args]` when targeting Antigravity (either explicitly named,
 * bound on the active session, or completing an already-pending AGY login).
 * Returns `undefined` when `/login` should go to native OAuth providers.
 */
export function parseAntigravityLoginArgs(
  rawArgs: string | undefined,
  activeExecutorId: string | undefined,
  catalog: readonly ExecutorCatalogItem[],
  pending: { readonly handle: string; readonly instanceId?: string } | undefined,
): ParsedAntigravityLoginCommand | undefined {
  const trimmed = rawArgs?.trim() ?? '';
  if (trimmed === '') {
    if (isAntigravityExecutorId(activeExecutorId, catalog)) {
      return { kind: 'start', instanceId: antigravityInstanceIdOf(activeExecutorId, catalog) };
    }
    return undefined;
  }
  const parts = trimmed.split(/\s+/u);
  const first = parts[0]!;
  const rest = parts.slice(1).join(' ').trim();

  if (pending !== undefined && first.toLowerCase() === 'cancel' && rest === '') {
    return { kind: 'cancel' };
  }
  if (isAntigravityExecutorId(first, catalog)) {
    const instanceId = antigravityInstanceIdOf(first, catalog);
    if (rest === '') return { kind: 'start', instanceId };
    if (rest.toLowerCase() === 'cancel') return { kind: 'cancel' };
    return { kind: 'complete', codeOrUrl: rest, instanceId, explicitTargetId: first };
  }
  if (pending !== undefined) {
    return { kind: 'complete', codeOrUrl: trimmed, instanceId: pending.instanceId };
  }
  return undefined;
}
