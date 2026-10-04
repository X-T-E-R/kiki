import { parse } from 'smol-toml';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { RuntimePath } from '#/runtime/runtime';
import { wrapSystemReminder } from '#/agent/systemReminder/systemReminder';
import { hooksFromToml, HooksV2ConfigSchema } from '../configSection';
import {
  hookHash, hookOrder, HOOK_INJECTION_MAX_BYTES, renderHookInjection,
  type EffectiveHookRule, type HookDiagnostic, type HookRulesSnapshot,
} from './rules';

export interface HookRuleSource {
  readonly namespace: string;
  readonly path: string;
  readonly root: string;
  readonly config: unknown;
  readonly mutable: boolean;
  readonly trusted: boolean;
  readonly enabled?: boolean;
}

export async function loadHookRules(
  sources: readonly HookRuleSource[],
  fs: IHostFileSystem,
  path: RuntimePath,
  resolveModel: (alias: string) => string | undefined,
): Promise<HookRulesSnapshot> {
  const rules: EffectiveHookRule[] = [];
  const diagnostics: HookDiagnostic[] = [];
  const seenFiles = new Set<string>();
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const watchPaths = new Set(sources.map((source) => path.resolve(source.path)));
  const disabled: { source: HookRuleSource; ids: readonly string[] }[] = [];
  const sourceStates = new Map(sources.map((source) => [source.namespace, { namespace: source.namespace, path: source.path, status: 'loaded' as 'loaded' | 'invalid' | 'unavailable' }]));
  const diagnostic = (source: HookRuleSource, message: string, hookId?: string): void => {
    diagnostics.push({ path: source.path, hookId, message });
    if (hookId === undefined) sourceStates.get(source.namespace)!.status = 'invalid';
  };
  async function boundedPath(source: HookRuleSource, ref: string): Promise<string> {
    const candidate = path.resolve(path.dirname(source.path), ref);
    watchPaths.add(candidate);
    const file = await fs.realpath(candidate);
    watchPaths.add(file);
    return file;
  }
  async function visit(source: HookRuleSource, depth: number): Promise<void> {
    if (depth > 16) { diagnostic(source, 'hooks include depth exceeds 16'); return; }
    const parsed = HooksV2ConfigSchema.safeParse(hooksFromToml(source.config));
    if (!parsed.success) { diagnostic(source, parsed.error.message); return; }
    const config = parsed.data;
    disabled.push({ source, ids: config.disabled });
    for (const rule of config.rules) {
      const id = `${source.namespace}/${rule.id}`;
      if (seenIds.has(id)) { duplicateIds.add(id); diagnostic(source, `duplicate hook ID: ${id}`, id); }
      seenIds.add(id);
      let reason = !source.trusted ? 'workspace_untrusted' : source.enabled === false || !config.enabled || !rule.enabled ? 'disabled' : undefined;
      let models: string[] | undefined;
      let text = rule.action.type === 'inject' ? rule.action.text : undefined;
      try {
        models = rule.match.models?.map((alias) => {
          const canonical = resolveModel(alias);
          if (canonical === undefined) throw new Error(`unknown model alias: ${alias}`);
          return canonical;
        });
        if (rule.action.type === 'inject') {
          if (rule.action.textFile !== undefined) text = await fs.readText(await boundedPath(source, rule.action.textFile));
          if (!text?.trim()) throw new Error('hook text must not be empty');
        }
      } catch (error) {
        reason = 'invalid';
        diagnostic(source, String(error), id);
      }
      const effective: EffectiveHookRule = {
        rule, id, namespace: source.namespace, path: source.path, mutable: source.mutable,
        contentHash: hookHash({ rule, text }),
        semanticHash: hookHash({ event: rule.event, match: Object.fromEntries(Object.entries({ ...rule.match, models }).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, values]) => [key, values?.toSorted()])), cadence: rule.cadence, action: rule.action.type }),
        models, text, active: reason === undefined, reason,
      };
      if (rule.action.type === 'inject' && Buffer.byteLength(wrapSystemReminder(renderHookInjection(effective)), 'utf8') > HOOK_INJECTION_MAX_BYTES) {
        reason = 'invalid';
        diagnostic(source, `hook injection exceeds ${HOOK_INJECTION_MAX_BYTES} byte budget`, id);
      }
      rules.push({ ...effective, active: reason === undefined, reason });
    }
    for (const ref of config.files) {
      try {
        const file = await boundedPath(source, ref);
        const identity = `${source.namespace}:${file}`;
        if (seenFiles.has(identity)) throw new Error(`duplicate or cyclic hook file: ${ref}`);
        seenFiles.add(identity);
        const raw = parse(await fs.readText(file));
        await visit({ ...source, path: file, config: raw['hooks'], enabled: source.enabled !== false && config.enabled }, depth + 1);
      } catch (error) {
        diagnostic(source, String(error));
        if (typeof error === 'object' && error !== null && 'code' in error) sourceStates.get(source.namespace)!.status = 'unavailable';
      }
    }
  }
  for (const source of sources) {
    try {
      const file = await boundedPath(source, path.basename(source.path));
      seenFiles.add(`${source.namespace}:${file}`);
      sourceStates.get(source.namespace)!.path = file;
      await visit({ ...source, path: file }, 0);
    } catch (error) { diagnostic(source, String(error)); sourceStates.get(source.namespace)!.status = 'unavailable'; }
  }
  for (const { source, ids } of disabled) {
    for (const id of ids) {
      if (source.namespace !== 'user' && !id.startsWith(`${source.namespace}/`)) diagnostic(source, `cannot disable hook from another source: ${id}`);
    }
  }
  const effective = rules.map((rule) => {
    if (duplicateIds.has(rule.id)) return { ...rule, active: false, reason: 'duplicate_id' };
    if (disabled.some(({ source, ids }) => (source.namespace === 'user' || source.namespace === rule.namespace) && ids.includes(rule.id))) return { ...rule, active: false, reason: 'disabled' };
    return rule;
  }).toSorted(hookOrder);
  return { sources: [...sourceStates.values()], revision: hookHash(effective.map((rule) => [rule.id, rule.contentHash, rule.reason])), rules: effective, diagnostics, watchPaths: [...watchPaths],
    disabled: disabled.filter(({ source }) => source.namespace === 'user').flatMap(({ ids }) => ids),
  };
}
