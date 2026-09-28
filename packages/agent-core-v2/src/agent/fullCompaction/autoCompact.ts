import type { ProfileModelContext } from '#/agent/profile/profile';

export type AutoCompactSource = 'session' | 'profile' | 'model' | 'global' | 'legacy';

export interface ResolvedAutoCompact {
  readonly tokens: number;
  readonly source: AutoCompactSource;
  readonly effectiveMaxContextTokens: number;
  readonly reservedContextTokens: number;
}

export function globalPercentFromTokens(tokens: number, usableTokens: number): string {
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || !Number.isSafeInteger(usableTokens) || usableTokens <= 0) {
    throw new Error('A positive token count and usable context window are required to convert auto_compact to a global percentage.');
  }
  const percent = Math.min(100, Math.max(0.00000001, Math.round(tokens / usableTokens * 10_000_000_000) / 100_000_000));
  return `${percent.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

export function resolveAutoCompact(
  model: ProfileModelContext,
  sessionTokens?: number,
  systemAndToolsTokens?: number,
): ResolvedAutoCompact {
  const usable = model.modelCapabilities.max_input_tokens ?? model.modelCapabilities.max_context_tokens;
  const reserved = model.reservedContextSize ?? 50_000;
  if (usable <= 0) return { tokens: 0, source: 'legacy', effectiveMaxContextTokens: usable, reservedContextTokens: reserved };
  const layers: readonly [AutoCompactSource, number | string | undefined][] = [
    ['session', sessionTokens],
    ['profile', model.profileAutoCompact],
    ['model', model.modelAutoCompact],
    ['global', model.globalAutoCompact],
  ];
  const chosen = layers.find(([, value]) => value !== undefined);
  let tokens: number;
  let source: AutoCompactSource;
  if (chosen !== undefined) {
    source = chosen[0];
    tokens = typeof chosen[1] === 'string' ? Math.round(usable * Number(chosen[1].slice(0, -1)) / 100) : chosen[1]!;
    const ceil = usable - reserved;
    const floor = Math.min(ceil, Math.max(64_000, Math.ceil(((systemAndToolsTokens ?? 0) + 32_000) / 8_000) * 8_000));
    tokens = Math.max(floor, Math.min(tokens, ceil));
  } else {
    source = 'legacy';
    tokens = usable * (model.compactionTriggerRatio ?? 0.85);
    if (reserved > 0 && reserved < usable) tokens = Math.min(tokens, usable - reserved);
    if ((model.compactionSoftContextSize ?? 0) > 0) tokens = Math.min(tokens, model.compactionSoftContextSize!);
  }
  return { tokens, source, effectiveMaxContextTokens: usable, reservedContextTokens: reserved };
}
