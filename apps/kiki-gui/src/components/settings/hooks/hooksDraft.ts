import {
  hookRuleConfigSchema, hooksV2ConfigSchema, legacyHookConfigSchema,
  type HooksConfig, type HooksV2Config, type LegacyHookConfig, type HookRuleConfig,
} from '@kiki/protocol';
import { hooksConfigPatch, parseHooksConfigJson } from '@kiki/session-core/settings';

export type HooksDraft =
  | { readonly shape: 'legacy'; readonly rules: readonly LegacyHookConfig[] }
  | { readonly shape: 'v2'; readonly config: HooksV2Config };

export type RuleRef =
  | { readonly kind: 'declarative'; readonly id: string }
  | { readonly kind: 'legacy'; readonly index: number };

export interface DraftIssue {
  readonly path: string;
  readonly message: string;
  readonly ref: RuleRef | null;
  readonly field: string;
}

export function draftFromHooks(hooks: HooksConfig): HooksDraft {
  return Array.isArray(hooks) ? { shape: 'legacy', rules: hooks } : { shape: 'v2', config: hooks };
}

export function draftToHooks(draft: HooksDraft): HooksConfig {
  return draft.shape === 'legacy' ? [...draft.rules] : draft.config;
}

export function parseHooksDraftJson(json: string): HooksDraft {
  return draftFromHooks(parseHooksConfigJson(json));
}

export function hooksDraftJson(draft: HooksDraft): string {
  return JSON.stringify(draftToHooks(draft), null, 2);
}

type SchemaIssue = NonNullable<ReturnType<typeof hookRuleConfigSchema.safeParse>['error']>['issues'][number];

function draftIssues(issues: readonly SchemaIssue[], prefix: readonly (string | number)[], ref: RuleRef | null, actionType?: string): DraftIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code === 'invalid_union' && issue.path[0] === 'action' && (actionType === 'inject' || actionType === 'observe')) {
      return draftIssues(issue.errors[actionType === 'inject' ? 0 : 1] ?? [], [...prefix, 'action'], ref);
    }
    const paths = issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => [...issue.path, key]) : [issue.path];
    return paths.map((path) => {
      const fullPath = [...prefix, ...path];
      return {
        path: fullPath.join('.'), message: issue.message, ref,
        field: path.toReversed().find((part): part is string => typeof part === 'string') ?? (ref === null ? String(prefix[0] ?? 'hooks') : 'rule'),
      };
    });
  });
}

/** Parse rows separately so union failures cannot hide their row or field path. */
export function validateHooksDraft(draft: HooksDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const legacy = draft.shape === 'legacy' ? draft.rules : draft.config.legacy;
  if (Array.isArray(legacy)) {
    legacy.forEach((rule, index) => {
      const result = legacyHookConfigSchema.safeParse(rule);
      if (!result.success) issues.push(...draftIssues(result.error.issues, draft.shape === 'legacy' ? [index] : ['legacy', index], { kind: 'legacy', index }));
    });
  }
  if (draft.shape === 'v2') {
    const config = draft.config;
    const top = hooksV2ConfigSchema.safeParse({
      ...config, rules: Array.isArray(config.rules) ? [] : config.rules,
      legacy: Array.isArray(config.legacy) ? [] : config.legacy,
    });
    if (!top.success) issues.push(...draftIssues(top.error.issues, [], null));
    if (Array.isArray(config.rules)) {
      config.rules.forEach((rule, index) => {
        const result = hookRuleConfigSchema.safeParse(rule);
        if (!result.success) issues.push(...draftIssues(result.error.issues, ['rules', index], { kind: 'declarative', id: rule.id }, rule.action?.type));
      });
    }
  }
  return issues;
}

export function hooksDraftPatch(draft: HooksDraft): { hooks: HooksConfig } {
  return hooksConfigPatch(draftToHooks(draft));
}

export function newLegacyRule(): LegacyHookConfig {
  return { event: 'PreToolUse', command: '' };
}

function legacyRules(draft: HooksDraft): readonly LegacyHookConfig[] {
  return draft.shape === 'legacy' ? draft.rules : draft.config.legacy;
}

function withLegacyRules(draft: HooksDraft, rules: LegacyHookConfig[]): HooksDraft {
  return draft.shape === 'legacy' ? { ...draft, rules } : { ...draft, config: { ...draft.config, legacy: rules } };
}

export function addLegacyRule(draft: HooksDraft): { draft: HooksDraft; ref: RuleRef } {
  const rules = legacyRules(draft);
  return { draft: withLegacyRules(draft, [...rules, newLegacyRule()]), ref: { kind: 'legacy', index: rules.length } };
}

export function updateLegacyRule(draft: HooksDraft, index: number, patch: Partial<LegacyHookConfig>): HooksDraft {
  return withLegacyRules(draft, legacyRules(draft).map((rule, position) => position === index ? { ...rule, ...patch } : rule));
}

export function removeLegacyRule(draft: HooksDraft, index: number): HooksDraft {
  return withLegacyRules(draft, legacyRules(draft).filter((_, position) => position !== index));
}

function v2Config(draft: HooksDraft): HooksV2Config {
  if (draft.shape !== 'v2') throw new Error('not a v2 draft');
  return draft.config;
}

export function newDeclarativeRule(existingIds: readonly string[]): HookRuleConfig {
  let number = 1;
  while (existingIds.includes(`rule-${number}`)) number++;
  // Obtain schema defaults with valid text, then leave the form's required text empty.
  const rule = hookRuleConfigSchema.parse({ id: `rule-${number}`, event: 'prompt.submit', action: { type: 'inject', text: 'draft' } });
  return { ...rule, action: { type: 'inject', text: '' } };
}

export function addDeclarativeRule(draft: HooksDraft): { draft: HooksDraft; ref: RuleRef } {
  const config = v2Config(draft);
  const rule = newDeclarativeRule(config.rules.map((entry) => entry.id));
  return { draft: { shape: 'v2', config: { ...config, rules: [...config.rules, rule] } }, ref: { kind: 'declarative', id: rule.id } };
}

export function updateDeclarativeRule(draft: HooksDraft, id: string, patch: Partial<HookRuleConfig>): HooksDraft {
  const config = v2Config(draft);
  return { shape: 'v2', config: { ...config, rules: config.rules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule) } };
}

export function removeDeclarativeRule(draft: HooksDraft, id: string): HooksDraft {
  const config = v2Config(draft);
  return { shape: 'v2', config: { ...config, rules: config.rules.filter((rule) => rule.id !== id), disabled: config.disabled.filter((entry) => entry !== id) } };
}

export function convertToV2(draft: HooksDraft): HooksDraft {
  if (draft.shape === 'v2') return draft;
  return { shape: 'v2', config: { schemaVersion: 2, enabled: true, disabled: [], files: [], rules: [], legacy: [...draft.rules] } };
}

export function canFlattenToLegacy(draft: HooksDraft): boolean {
  return draft.shape === 'v2' && draft.config.rules.length === 0 && draft.config.files.length === 0 && draft.config.disabled.length === 0;
}

export function flattenToLegacy(draft: HooksDraft): HooksDraft {
  if (!canFlattenToLegacy(draft)) throw new Error('cannot flatten draft with declarative rules, files or disabled ids to legacy');
  return { shape: 'legacy', rules: v2Config(draft).legacy };
}

export function setV2Enabled(draft: HooksDraft, enabled: boolean): HooksDraft {
  return { shape: 'v2', config: { ...v2Config(draft), enabled } };
}

export function setV2Files(draft: HooksDraft, files: readonly string[]): HooksDraft {
  return { shape: 'v2', config: { ...v2Config(draft), files: [...files] } };
}

export function setV2Disabled(draft: HooksDraft, ids: readonly string[]): HooksDraft {
  return { shape: 'v2', config: { ...v2Config(draft), disabled: [...ids] } };
}

export function formatSelectorLines(selectors: readonly string[]): string {
  return selectors.join('\n');
}

export function parseSelectorLines(text: string): readonly string[] {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ''))];
}
