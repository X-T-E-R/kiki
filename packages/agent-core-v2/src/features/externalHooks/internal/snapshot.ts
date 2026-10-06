import { parse } from 'smol-toml';
import type { ISessionHookWorkspace } from '../session/hookRules';
import { loadHookRules } from './loadRules';
import { hookHash, hookOrder, type HookRulesSnapshot } from './rules';

export function projectHookRules(global: HookRulesSnapshot, project: HookRulesSnapshot, disabled: readonly string[], trusted: boolean, usageOverrides?: Readonly<Record<string, boolean>>): HookRulesSnapshot {
  const rules = [...global.rules, ...project.rules.map(entry => !trusted ? { ...entry, active: false, reason: 'workspace_untrusted' } : entry)]
    .map(entry => disabled.includes('*') || disabled.includes(entry.id) ? { ...entry, active: false, reason: 'disabled' } : entry)
    .map(entry => usageOverrides !== undefined && entry.namespace.startsWith('plugin/') && usageOverrides[entry.namespace.slice('plugin/'.length)] === false ? { ...entry, active: false, reason: 'workspace_plugin_disabled' } : entry).toSorted(hookOrder);
  return { sources: [...global.sources ?? [], ...project.sources ?? []], revision: hookHash([global.revision, project.revision, trusted, disabled, usageOverrides ?? {}]), rules, diagnostics: [...global.diagnostics, ...project.diagnostics] };
}

export async function loadWorkspaceHookRules(workspace: ISessionHookWorkspace, resolveModel: (alias: string) => string | undefined): Promise<HookRulesSnapshot> {
  await workspace.trust.ready;
  const { runtime, root } = workspace;
  const file = runtime.path.join(root, '.kiki', 'hooks.toml');
  if (runtime.fs === undefined) return { revision: 'unsupported', rules: [], sources: [{ namespace: 'workspace', path: file, status: 'unavailable' }], diagnostics: [{ path: file, message: 'workspace hooks unsupported: runtime has no filesystem capability' }] };
  let config: unknown;
  try { config = parse(await runtime.fs.readText(file))['hooks']; }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'os.fs.not_found' || error.code === 'ENOENT')) config = undefined;
    else return { revision: hookHash(String(error)), rules: [], sources: [{ namespace: 'workspace', path: file, status: typeof error === 'object' && error !== null && 'code' in error ? 'unavailable' : 'invalid' }], diagnostics: [{ path: file, message: String(error) }] };
  }
  return config === undefined ? { revision: 'absent', rules: [], diagnostics: [], sources: [{ namespace: 'workspace', path: file, status: 'absent' }] } : loadHookRules([
    { namespace: 'workspace', path: file, root, config, trusted: workspace.trust.isTrusted(), mutable: true },
  ], runtime.fs, runtime.path, resolveModel);
}
