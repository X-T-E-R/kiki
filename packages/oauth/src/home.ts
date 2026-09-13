import { constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export function resolveKikiHome(explicit?: string, env: NodeJS.ProcessEnv = process.env, userHome = homedir()): string {
  return resolve(explicit ?? env['KIKI_HOME'] ?? join(userHome, '.kiki'));
}

export interface HomeMigrationResult {
  readonly status: 'absent' | 'already-completed' | 'completed' | 'incomplete';
  readonly copied: readonly string[];
  readonly preserved: readonly string[];
  readonly unmigrated?: readonly string[];
}

export const KIKI_CONFIG_MIGRATION_MARKER = '.kiki-config-migration-v2.json';

function collectAssets(source: string, directory: string): string[] {
  const full = join(source, directory);
  if (!existsSync(full)) return [];
  const info = lstatSync(full);
  if (info.isSymbolicLink()) throw new Error(`Migration cannot copy symbolic-link asset ${JSON.stringify(directory)}; resolve it explicitly before retrying.`);
  if (!info.isDirectory()) return [directory];
  return readdirSync(full).flatMap((entry) => collectAssets(source, join(directory, entry)));
}

function prepareDestination(root: string, parent: string): void {
  let current = root;
  for (const part of relative(root, parent).split(sep).filter(Boolean)) {
    current = join(current, part);
    mkdirSync(current, { recursive: true, mode: 0o700 });
    if (lstatSync(current).isSymbolicLink()) throw new Error('Configuration migration refuses symbolic-link destination directories.');
  }
}

/** Copies configuration, authored resources, and provider credentials; never runtime tokens, locks, caches, or sessions. */
export function migrateLegacyKikiConfiguration(source: string, destination: string): HomeMigrationResult {
  return migrateConfiguration(source, destination, false);
}

/** Explicitly migrates project configuration assets; source project files remain untouched. */
export function migrateLegacyKikiProject(projectRoot: string): HomeMigrationResult {
  return migrateConfiguration(join(projectRoot, '.kimi-code'), join(projectRoot, '.kiki'), true);
}

function migrateConfiguration(source: string, destination: string, project: boolean): HomeMigrationResult {
  const destinationRelative = relative(resolve(source), resolve(destination));
  if (destinationRelative === '' || !existsSync(source)) return { status: 'absent', copied: [], preserved: [] };
  if (destinationRelative !== '..' && !destinationRelative.startsWith(`..${sep}`) && !isAbsolute(destinationRelative)) throw new Error('Migration destination must not be inside the source directory.');
  const marker = join(destination, KIKI_CONFIG_MIGRATION_MARKER);
  if (existsSync(marker)) return { status: 'already-completed', copied: [], preserved: [] };
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) throw new Error('Legacy configuration migration requires a real source directory.');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  if (lstatSync(destination).isSymbolicLink()) throw new Error('Configuration migration refuses a symbolic-link destination.');
  const copied: string[] = [];
  const preserved: string[] = [];
  const files = project ? ['local.toml', 'AGENTS.md', 'mcp.json'] : ['config.toml', 'mcp.json', 'tui.toml', 'SYSTEM.md', 'AGENTS.md', 'region', 'device_id'];
  for (const directory of ['agents', 'commands', 'skills', 'themes']) files.push(...collectAssets(source, directory));
  const credentials = join(source, 'credentials');
  if (!project && existsSync(credentials)) {
    if (lstatSync(credentials).isSymbolicLink() || !lstatSync(credentials).isDirectory()) throw new Error('Legacy credentials directory is not a regular directory.');
    files.push(...readdirSync(credentials).filter((name) => !name.startsWith('.') && name.endsWith('.json')).map((name) => join('credentials', name)));
  }
  for (const name of files) {
    const from = join(source, name);
    const to = join(destination, name);
    if (!existsSync(from)) continue;
    if (existsSync(to)) { preserved.push(name); continue; }
    const info = lstatSync(from);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Legacy configuration contains an unsupported file type at ${JSON.stringify(name)}; no files were overwritten.`);
    const parent = dirname(to);
    prepareDestination(destination, parent);
    const temporary = join(parent, `.kiki-migrate-${randomUUID()}`);
    try {
      copyFileSync(from, temporary, constants.COPYFILE_EXCL);
      chmodSync(temporary, name.startsWith(`credentials${sep}`) ? 0o600 : (info.mode & 0o100) | 0o600);
      try { linkSync(temporary, to); copied.push(name); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        preserved.push(name);
      }
    } finally { rmSync(temporary, { force: true }); }
  }
  const handled = new Set([
    ...files.map((name) => name.split(sep)[0]), 'agents', 'commands', 'skills', 'themes',
    'sessions', 'server.token', 'server', 'instances', 'cache', 'logs', 'store', 'blobs',
    'updates', 'user-history', 'banner', 'bin', '.tmp', '.DS_Store', 'desktop.ini', '.kiki-home-migration.json', KIKI_CONFIG_MIGRATION_MARKER,
  ]);
  if (!project) { handled.add('credentials'); handled.add('oauth'); }
  const unmigrated = readdirSync(source).filter((name) => !handled.has(name) && !existsSync(join(destination, name)));
  if (unmigrated.length > 0) return { status: 'incomplete', copied, preserved, unmigrated };
  const temporaryMarker = join(destination, `.kiki-migrate-${randomUUID()}`);
  try {
    writeFileSync(temporaryMarker, JSON.stringify({ version: 2, copied, preserved }), { flag: 'wx', mode: 0o600 });
    try { linkSync(temporaryMarker, marker); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { rmSync(temporaryMarker, { force: true }); }
  return { status: 'completed', copied, preserved };
}
