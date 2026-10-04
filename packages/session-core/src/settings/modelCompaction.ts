export interface LoopControlView {
  readonly autoCompact?: string;
  readonly compactionTriggerRatio?: number;
  readonly compactionSoftContextSize?: number;
  readonly reservedContextSize?: number;
}

/** The effective input window honors both the total context limit and any model context budget. */
export function effectiveModelInputTokens(windowTokens: number, inputTokens?: number, contextBudget?: number): number {
  return Math.min(windowTokens, inputTokens ?? windowTokens, contextBudget ?? windowTokens);
}

export interface ModelCompactionPreviewDraft {
  readonly windowTokens: number;
  readonly inputTokens?: number;
  readonly contextBudget?: number;
  readonly autoCompact?: number;
  /** The REST model overrides object (snake_case), or the editor's JSON text. */
  readonly overrides?: unknown;
}

export type ModelCompactionPreview =
  | { readonly valid: false }
  | {
    readonly valid: true;
    readonly windowTokens: number;
    readonly inputTokens?: number;
    readonly contextBudget?: number;
    readonly usableTokens: number;
    readonly autoCompact?: number;
    readonly autoCompactOverridden: boolean;
  };

/** Resolves model-only overrides before applying the context budget; invalid drafts have no preview. */
export function modelCompactionPreview(draft: ModelCompactionPreviewDraft): ModelCompactionPreview {
  let overrides = draft.overrides;
  if (typeof overrides === 'string') {
    try { overrides = overrides.trim() === '' ? undefined : JSON.parse(overrides); }
    catch { return { valid: false }; }
  }
  if (overrides !== undefined && (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides))) {
    return { valid: false };
  }
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    record[key.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  for (const key of ['maxContextSize', 'maxInputSize', 'contextBudget', 'autoCompact']) {
    const value = record[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
      return { valid: false };
    }
  }
  const windowTokens = (record['maxContextSize'] as number | undefined) ?? draft.windowTokens;
  const inputTokens = (record['maxInputSize'] as number | undefined) ?? draft.inputTokens;
  const contextBudget = (record['contextBudget'] as number | undefined) ?? draft.contextBudget;
  const autoCompact = (record['autoCompact'] as number | undefined) ?? draft.autoCompact;
  return {
    valid: true,
    windowTokens,
    inputTokens,
    contextBudget,
    usableTokens: effectiveModelInputTokens(windowTokens, inputTokens, contextBudget),
    autoCompact,
    autoCompactOverridden: record['autoCompact'] !== undefined,
  };
}

/** Reports the existing model/global token bounds, including an exhausted reserve without inventing a slider range. */
export function modelCompactionBounds(usable: number, reserved = 50_000): { floor: number; ceil: number; locked: boolean } {
  const ceil = usable - reserved;
  const floor = Math.min(ceil, 64_000);
  return { floor, ceil, locked: usable <= 0 || ceil <= floor };
}

export function readLoopControl(value: unknown): LoopControlView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const pick = (camel: string, snake: string) => record[camel] ?? record[snake];
  const autoCompact = pick('autoCompact', 'auto_compact');
  const ratio = pick('compactionTriggerRatio', 'compaction_trigger_ratio');
  const soft = pick('compactionSoftContextSize', 'compaction_soft_context_size');
  const reserved = pick('reservedContextSize', 'reserved_context_size');
  return {
    autoCompact: typeof autoCompact === 'string' ? autoCompact : undefined,
    compactionTriggerRatio: typeof ratio === 'number' ? ratio : undefined,
    compactionSoftContextSize: typeof soft === 'number' && soft > 0 ? soft : undefined,
    reservedContextSize: typeof reserved === 'number' ? reserved : undefined,
  };
}

function configuredCompactPoint(usable: number, tokens: number, reserved: number): number {
  const { ceil, floor } = modelCompactionBounds(usable, reserved);
  return Math.max(floor, Math.min(tokens, ceil));
}

function percentLabel(value: string): string {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value.trim());
  if (match === null) return value;
  const rounded = Math.round(Number(match[1]) * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/** Settings preview of the engine's global/legacy default, without session resident-cost estimates. */
export function inheritedCompactPoint(
  usable: number,
  loop: LoopControlView,
): { tokens: number; from: 'global' | 'legacy'; percent?: string } {
  if (usable <= 0) return { tokens: 0, from: 'legacy' };
  const reserved = loop.reservedContextSize ?? 50_000;
  if (loop.autoCompact !== undefined) {
    const percent = Number(loop.autoCompact.replace('%', ''));
    return {
      tokens: configuredCompactPoint(usable, Math.round(usable * percent / 100), reserved),
      from: 'global',
      percent: percentLabel(loop.autoCompact),
    };
  }
  let tokens = usable * (loop.compactionTriggerRatio ?? 0.85);
  if (reserved > 0 && reserved < usable) tokens = Math.min(tokens, usable - reserved);
  if (loop.compactionSoftContextSize !== undefined) tokens = Math.min(tokens, loop.compactionSoftContextSize);
  return { tokens, from: 'legacy' };
}

/** Settings preview of an absolute model target; the stored target itself remains unchanged. */
export function modelCompactPoint(usable: number, configuredTokens: number | undefined, loop: LoopControlView): number {
  if (usable <= 0) return 0;
  return configuredTokens === undefined
    ? inheritedCompactPoint(usable, loop).tokens
    : configuredCompactPoint(usable, configuredTokens, loop.reservedContextSize ?? 50_000);
}
