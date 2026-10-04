import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SpaceSourceSelections {
  readonly groups?: Record<string, 'follow' | 'fixed'>;
  readonly selections?: Record<string, { mode: 'follow' | 'fixed'; excluded?: boolean }>;
}
export function readSpaceSourceSelections(home: string): SpaceSourceSelections | undefined {
  const path = join(home, 'space-preferences.json');
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as SpaceSourceSelections & { schema?: number };
  if (raw.schema !== 2) throw new Error('Unsupported space preferences schema');
  return raw;
}
export function prepareSpaceResourceProjection(home: string, main: string, source: SpaceSourceSelections, defaults: Record<string, unknown>): string {
  const root = join(home, '.space-resources/base');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const allowed = (domain: string, identity: string): boolean => {
    const item = source.selections?.[`resource:${domain}:${identity}`];
    return item?.excluded !== true && (item?.mode ?? source.groups?.[domain] ?? (defaults[domain] !== false ? 'follow' : 'fixed')) === 'follow';
  };
  const copy = (domain: string, relative: string): void => {
    const target = join(root, relative);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    if (!allowed(domain, relative) || !existsSync(join(main, relative))) return;
    if (lstatSync(join(main, relative)).isSymbolicLink()) throw new Error('Inherited linked resource cannot be projected');
    mkdirSync(join(target, '..'), { recursive: true });
    const original = join(main, relative);
    if (lstatSync(original).isDirectory()) symlinkSync(original, target, process.platform === 'win32' ? 'junction' : 'dir');
    else cpSync(original, target);
  };
  for (const [domain, directory] of [['agents', 'agents'], ['skills', 'skills'], ['skills', 'commands'], ['appearance', 'themes']] as const) {
    rmSync(join(root, directory), { recursive: true, force: true });
    if (!existsSync(join(main, directory))) continue;
    for (const entry of readdirSync(join(main, directory))) if (!entry.startsWith('.')) copy(domain, `${directory}/${entry}`);
  }
  copy('agents', 'SYSTEM.md'); copy('instructions', 'AGENTS.md');
  const fixedInstructions = join(home, '.space-resources/instructions-fixed.md');
  if (source.selections?.['resource:instructions:AGENTS.md']?.mode === 'fixed' && source.selections['resource:instructions:AGENTS.md'].excluded !== true && existsSync(fixedInstructions)) cpSync(fixedInstructions, join(root, 'AGENTS.md'));
  rmSync(join(root, 'mcp.json'), { force: true });
  const installedPath = join(main, 'plugins/installed.json');
  const plugins = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath, 'utf8')) as { plugins: { id: string; root: string; enabled: boolean }[] } : { plugins: [] };
  rmSync(join(root, 'plugins'), { recursive: true, force: true });
  mkdirSync(join(root, 'plugins'), { recursive: true });
  const projected = plugins.plugins.filter((plugin) => allowed('plugins', plugin.id)).map((plugin) => ({ ...plugin,
    enabled: plugin.enabled && source.selections?.[`resource:plugins:${plugin.id}`]?.mode === 'follow',
  }));
  writeFileSync(join(root, 'plugins/installed.json'), JSON.stringify({ version: 1, plugins: projected }), { mode: 0o600 });
  return root;
}
