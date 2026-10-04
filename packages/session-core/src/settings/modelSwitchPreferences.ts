import { modelSwitchConfigSchema, type ModelSwitchConfig, type ModelSwitchMode } from '@kiki/protocol';

export type { ModelSwitchMode } from '@kiki/protocol';

export interface ModelSwitchPreferenceRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly fromModels?: readonly string[];
  readonly toModels?: readonly string[];
  readonly mode: ModelSwitchMode;
  readonly confirm?: boolean;
}

export interface ModelSwitchPreferences {
  readonly defaultMode: ModelSwitchMode;
  readonly confirm: boolean;
  readonly rules: readonly ModelSwitchPreferenceRule[];
}

export interface ResolvedModelSwitchPreferences {
  readonly mode: ModelSwitchMode;
  readonly confirm: boolean;
  readonly matchedRuleId?: string;
  readonly matchedRuleIndex?: number;
}

export function readModelSwitchPreferences(wire?: ModelSwitchConfig): ModelSwitchPreferences {
  const config = modelSwitchConfigSchema.parse(wire ?? {});
  return {
    defaultMode: config.default_mode,
    confirm: config.confirm,
    rules: config.rules.map((rule) => ({
      id: rule.id,
      enabled: rule.enabled,
      fromModels: rule.from_models,
      toModels: rule.to_models,
      mode: rule.mode,
      confirm: rule.confirm,
    })),
  };
}

export function modelSwitchPreferencesToWire(preferences: ModelSwitchPreferences): ModelSwitchConfig {
  return modelSwitchConfigSchema.parse({
    default_mode: preferences.defaultMode,
    confirm: preferences.confirm,
    rules: preferences.rules.map((rule) => ({
      id: rule.id,
      enabled: rule.enabled,
      from_models: rule.fromModels,
      to_models: rule.toModels,
      mode: rule.mode,
      confirm: rule.confirm,
    })),
  });
}

export function matchesModelSwitchPattern(pattern: string, canonicalModelId: string): boolean {
  const characters = Array.from(canonicalModelId);
  let previous = Array.from({ length: characters.length + 1 }, () => false);
  previous[0] = true;
  for (const token of pattern) {
    const current = Array.from({ length: characters.length + 1 }, () => false);
    if (token === '*') {
      current[0] = previous[0] === true;
      for (let index = 1; index <= characters.length; index += 1) {
        current[index] = current[index - 1] === true || previous[index] === true;
      }
    } else {
      for (let index = 1; index <= characters.length; index += 1) {
        current[index] = previous[index - 1] === true && (token === '?' || token === characters[index - 1]);
      }
    }
    previous = current;
  }
  return previous[characters.length] === true;
}

export function previewModelSwitchRule(
  rule: ModelSwitchPreferenceRule,
  fromCanonicalId: string,
  toCanonicalId: string,
): { fromMatches: boolean; toMatches: boolean; matches: boolean } {
  const fromMatches = rule.fromModels === undefined || rule.fromModels.some((pattern) => matchesModelSwitchPattern(pattern, fromCanonicalId));
  const toMatches = rule.toModels === undefined || rule.toModels.some((pattern) => matchesModelSwitchPattern(pattern, toCanonicalId));
  return { fromMatches, toMatches, matches: rule.enabled && fromMatches && toMatches };
}

/** Returns a value snapshot; use its mode in the accepted operation instead of resolving again after settings change. */
export function resolveModelSwitchPreferences(
  preferences: ModelSwitchPreferences,
  fromCanonicalId: string,
  toCanonicalId: string,
  explicitMode?: ModelSwitchMode,
): ResolvedModelSwitchPreferences {
  const matchedRuleIndex = preferences.rules.findIndex((rule) => previewModelSwitchRule(rule, fromCanonicalId, toCanonicalId).matches);
  const rule = preferences.rules[matchedRuleIndex];
  return {
    mode: explicitMode ?? rule?.mode ?? preferences.defaultMode,
    confirm: rule?.confirm ?? preferences.confirm,
    matchedRuleId: rule?.id,
    matchedRuleIndex: rule === undefined ? undefined : matchedRuleIndex,
  };
}

export function rememberModelSwitchChoice(
  preferences: ModelSwitchPreferences,
  fromCanonicalId: string,
  toCanonicalId: string,
  mode: ModelSwitchMode,
): ModelSwitchPreferences {
  const resolved = resolveModelSwitchPreferences(preferences, fromCanonicalId, toCanonicalId);
  if (resolved.matchedRuleIndex === undefined) {
    return { ...preferences, defaultMode: mode, confirm: false };
  }
  return {
    ...preferences,
    rules: preferences.rules.map((rule, index) => index === resolved.matchedRuleIndex ? { ...rule, mode, confirm: false } : rule),
  };
}
