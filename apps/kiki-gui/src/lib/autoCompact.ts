/**
 * Automatic-compaction point helpers for the context panel and the settings
 * editors. The server owns the effective value (`GET/PATCH …/auto-compact`);
 * these helpers only parse what the user typed, bound the slider, and format
 * the numbers the panel shows. Nothing here decides the effective point.
 */

import type { AutoCompactStatus } from '@kiki/protocol';

export type AutoCompactSource = AutoCompactStatus['source'];
export type AutoCompactSaveTarget = 'model' | 'profile' | 'global';

/**
 * Context windows that several current providers actually document (checked
 * against official model pages, 2026-09): 128k (GPT-5.1 Chat, GLM-4.5),
 * 200k (Claude Haiku 4.5, GLM-4.6–5.1, o3), 256k = 262,144 (Kimi K2.6/K2.7,
 * Qwen3-max / Qwen3-Coder), 400k (GPT-5 / 5.1 / 5.2), 500k (Grok 4.5–4.7) and
 * 1M = 1,000,000 (Claude Opus/Sonnet 5, DeepSeek V4, Kimi K3, GLM-5.2+, Qwen3.5+,
 * MiniMax M3). Vendors whose "1M" is 1,047,576 / 1,048,576 / 1,050,000 type
 * the exact number instead.
 */
export const CONTEXT_WINDOW_PRESETS: readonly number[] = [128_000, 200_000, 262_144, 400_000, 500_000, 1_000_000];

/** Preset label: the binary 256k reads the way vendors write it, not as 262.1k. */
export function formatPresetTokens(value: number): string {
  return value === 262_144 ? '256k' : formatCompactTokens(value);
}

/** Shares of the usable window the compaction presets aim at: early, balanced, late. */
const COMPACT_PRESET_SHARES = [0.5, 0.65, 0.8] as const;

/**
 * One-click compaction points for one model, adaptive to its usable window
 * instead of a fixed list: about 50%, 65% and 80% of the usable limit, each
 * rounded down to a readable step (50k from 400k windows up, 25k from 150k,
 * 8k below), kept inside [floor, ceil] and de-duplicated. Three values stay
 * legible under a 288px track; a model whose window leaves no room gets none.
 */
export function compactPresetsFor(usable: number, ceil: number, floor = 0): readonly number[] {
  if (usable <= 0 || ceil <= 0) return [];
  const step = usable >= 400_000 ? 50_000 : usable >= 150_000 ? 25_000 : AUTO_COMPACT_STEP;
  const values = COMPACT_PRESET_SHARES
    .map((share) => Math.floor((usable * share) / step) * step)
    .filter((value) => value > 0 && value >= floor && value <= ceil);
  return [...new Set(values)];
}

/** Slider step and the keyboard commit debounce from the design (§5). */
export const AUTO_COMPACT_STEP = 8_000;
export const AUTO_COMPACT_KEY_COMMIT_MS = 600;
const FLOOR_MIN = 64_000;
const FLOOR_HEADROOM = 32_000;

export interface AutoCompactBounds {
  /** Lowest point the engine keeps (resident cost + headroom, at least 64k). */
  readonly floor: number;
  /** Highest session point: at least 95% of the usable limit, or limit minus reserve. */
  readonly ceil: number;
  /** No room to move: the window is too small for an adjustable point. */
  readonly locked: boolean;
}

/**
 * Mirrors the engine's explicit session clamp: users may reach 95% even
 * when that leaves less than the configured reserve. Defaults keep U − R.
 * `resident` is the system + tools estimate when known.
 */
export function autoCompactBounds(status: AutoCompactStatus, resident?: number): AutoCompactBounds {
  const usable = status.effectiveMaxContextTokens;
  const ceil = Math.max(0, usable - status.reservedContextTokens, Math.floor(usable * 0.95));
  const wanted = Math.max(FLOOR_MIN, Math.ceil(((resident ?? 0) + FLOOR_HEADROOM) / AUTO_COMPACT_STEP) * AUTO_COMPACT_STEP);
  const floor = Math.min(ceil, wanted);
  return { floor, ceil, locked: ceil - floor < AUTO_COMPACT_STEP };
}

export type ParsedCompactInput =
  | { readonly kind: 'tokens'; readonly tokens: number }
  | { readonly kind: 'percent'; readonly percent: number }
  | { readonly kind: 'invalid' };

/** Accepts `400k`, `0.4m`, `400000`, `400,000` and `73%`. */
export function parseCompactInput(raw: string): ParsedCompactInput {
  const text = raw.trim().toLowerCase().replaceAll(',', '').replaceAll('_', '').replaceAll(' ', '');
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(text);
  if (percent !== null) {
    const value = Number(percent[1]);
    return value > 0 && value <= 100 ? { kind: 'percent', percent: value } : { kind: 'invalid' };
  }
  const tokens = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(text);
  if (tokens === null) return { kind: 'invalid' };
  const factor = tokens[2] === 'k' ? 1_000 : tokens[2] === 'm' ? 1_000_000 : 1;
  const value = Math.round(Number(tokens[1]) * factor);
  return Number.isSafeInteger(value) && value > 0 ? { kind: 'tokens', tokens: value } : { kind: 'invalid' };
}

/** Resolves typed input to an absolute token count against the usable limit. */
export function compactInputTokens(parsed: ParsedCompactInput, usable: number): number | null {
  if (parsed.kind === 'tokens') return parsed.tokens;
  if (parsed.kind === 'percent' && usable > 0) return Math.round((usable * parsed.percent) / 100);
  return null;
}

export type ClampReason = 'ceil' | 'floor';

export function clampCompactTokens(
  tokens: number,
  bounds: AutoCompactBounds,
): { readonly tokens: number; readonly clamped?: ClampReason } {
  if (tokens > bounds.ceil) return { tokens: bounds.ceil, clamped: 'ceil' };
  if (tokens < bounds.floor) return { tokens: bounds.floor, clamped: 'floor' };
  return { tokens };
}

/** Snap to the 8k grid while keeping both exact endpoints reachable. */
export function snapCompactTokens(tokens: number, bounds: AutoCompactBounds): number {
  if (tokens >= bounds.ceil) return bounds.ceil;
  if (tokens <= bounds.floor) return bounds.floor;
  const snapped = Math.round(tokens / AUTO_COMPACT_STEP) * AUTO_COMPACT_STEP;
  return Math.min(bounds.ceil, Math.max(bounds.floor, snapped));
}

/**
 * Compact token label for the track and menus: `467.5k`, `400k`, `1.05M`.
 * Keeps one decimal only when it carries information.
 */
export function formatCompactTokens(count: number): string {
  if (count < 1_000) return String(Math.round(count));
  if (count < 1_000_000) {
    const k = Math.round(count / 100) / 10;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  const m = Math.round(count / 10_000) / 100;
  return `${m.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}M`;
}

/** Display-only share of the usable limit; the server computes the stored value. */
export function compactPercentLabel(tokens: number, usable: number): string {
  if (usable <= 0) return '';
  const percent = Math.round((tokens / usable) * 1000) / 10;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

/** A stored global percentage (`"72.72727273%"`) shortened for display. */
export function shortPercent(value: string): string {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value.trim());
  if (match === null) return value;
  const rounded = Math.round(Number(match[1]) * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/**
 * Where the ring stands relative to the compaction point: colour answers
 * "is compaction close", the percent keeps answering "how full is the window".
 */
export function compactUsageLevel(used: number, point: number): 'ok' | 'warn' | 'danger' {
  if (point <= 0) return 'ok';
  if (used >= point) return 'danger';
  if (used >= point * 0.8) return 'warn';
  return 'ok';
}

/** Legacy default the engine uses when no layer sets `auto_compact`. */
export function legacyCompactDefault(usable: number, ratio = 0.85, reserved = 50_000): number {
  const byRatio = usable * ratio;
  return reserved > 0 && reserved < usable ? Math.min(byRatio, usable - reserved) : byRatio;
}
