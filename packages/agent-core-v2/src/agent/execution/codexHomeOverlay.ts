import { lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';

export const CODEX_SHARED_ASSET_DIRECTORIES = [
  'skills',
  'plugins',
  'sessions',
  'archived_sessions',
  'shell_snapshots',
  'worktrees',
  'cache',
  'mcp-oauth-locks',
  'thread-writer-locks',
] as const;

export const CODEX_PRIVATE_ENTRY_NAMES = new Set([
  'auth.json',
  'auth.lock',
  'models_cache.json',
]);

const CODEX_SHADOW_LOCAL_ENTRY_NAMES = new Set([
  'log',
  'memories',
  'tmp',
  '.DS_Store',
]);

const CODEX_ROOT_CONFIG_PATH_FIELDS = [
  'model_instructions_file',
  'js_repl_node_path',
  'sqlite_home',
  'log_dir',
  'model_catalog_json',
  'experimental_compact_prompt_file',
] as const;

const CODEX_PROFILE_CONFIG_PATH_FIELDS = [
  'js_repl_node_path',
  'model_catalog_json',
  'model_instructions_file',
  'experimental_compact_prompt_file',
] as const;

const CODEX_CONFIG_PATH_ARRAY_FIELDS = ['js_repl_node_module_dirs'] as const;

export interface PrepareCodexShadowHomeInput {
  readonly shadowHomePath: string;
  readonly sharedHomePath?: string;
  readonly privateConfig?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly onWarn?: (message: string, details?: Readonly<Record<string, unknown>>) => void;
}

export interface CodexShadowHomeResult {
  readonly applied: boolean;
  readonly sharedHomePath: string;
  readonly shadowHomePath: string;
  readonly linkedEntries: readonly string[];
}

export function resolveSharedCodexHome(
  osHomeDir = homedir(),
  hostCodexHome = process.env['CODEX_HOME'],
  excludeShadowHome?: string,
): string {
  const defaultHome = resolve(join(osHomeDir, '.codex'));
  const configured = hostCodexHome?.trim();
  if (!configured) return defaultHome;
  const expanded = expandTildePath(configured, osHomeDir);
  if (excludeShadowHome !== undefined && samePath(expanded, excludeShadowHome)) {
    return defaultHome;
  }
  return expanded;
}

export function resolvePluginAccountShadowHome(
  cacheDir: string,
  instanceId: string,
  accountId: string,
): string {
  const safeSegment = (value: string) => value.replaceAll(/[^A-Za-z0-9._-]/g, '_');
  return resolve(join(cacheDir, 'codex-shadow-homes', `${safeSegment(instanceId)}--${safeSegment(accountId)}`));
}

/**
 * Prepares a lightweight Codex Shadow Home directory that isolates credential
 * and cache files (`auth.json`, `auth.lock`, `models_cache.json`, and optional
 * broker-managed `config.toml`) while linking shared user assets (`skills`,
 * `plugins`, `sessions`, etc.) back to the primary `~/.codex` home using
 * cross-platform symlinks / Windows directory junctions.
 * Adapted from T3 Code's MIT CodexHomeLayout.ts for Node filesystem APIs and private config copies.
 */
export async function prepareCodexShadowHome(
  input: PrepareCodexShadowHomeInput,
): Promise<CodexShadowHomeResult> {
  const platform = input.platform ?? process.platform;
  const shadowHomePath = resolve(expandTildePath(input.shadowHomePath, homedir()));
  const sharedHomePath = input.sharedHomePath !== undefined
    ? resolve(expandTildePath(input.sharedHomePath, homedir()))
    : resolveSharedCodexHome(homedir(), process.env['CODEX_HOME'], shadowHomePath);

  if (samePath(sharedHomePath, shadowHomePath, platform)) {
    return { applied: false, sharedHomePath, shadowHomePath, linkedEntries: [] };
  }

  const privateEntries = new Set(CODEX_PRIVATE_ENTRY_NAMES);
  if (input.privateConfig === true) privateEntries.add('config.toml');

  try {
    await mkdir(shadowHomePath, { recursive: true });
  } catch (error) {
    input.onWarn?.('Failed to create Codex shadow home directory', {
      shadowHomePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return { applied: false, sharedHomePath, shadowHomePath, linkedEntries: [] };
  }

  let sharedEntryNames: string[];
  try {
    const sharedStat = await lstat(sharedHomePath);
    if (!sharedStat.isDirectory()) {
      return { applied: false, sharedHomePath, shadowHomePath, linkedEntries: [] };
    }
    sharedEntryNames = await readdir(sharedHomePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { applied: false, sharedHomePath, shadowHomePath, linkedEntries: [] };
    }
    input.onWarn?.('Failed to inspect primary Codex home for shadow overlay', {
      sharedHomePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return { applied: false, sharedHomePath, shadowHomePath, linkedEntries: [] };
  }

  for (const privateName of privateEntries) {
    const privatePath = join(shadowHomePath, privateName);
    try {
      const st = await lstat(privatePath);
      if (st.isSymbolicLink()) {
        await rm(privatePath, { force: true });
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        input.onWarn?.('Failed to sanitize private entry in Codex shadow home', {
          entryName: privateName,
          path: privatePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (input.privateConfig === true) {
    await initializePrivateCodexConfig(sharedHomePath, shadowHomePath, input.onWarn);
  }

  const candidateNames = new Set<string>();
  const sharedSet = new Set(sharedEntryNames);
  for (const knownDir of CODEX_SHARED_ASSET_DIRECTORIES) {
    if (sharedSet.has(knownDir)) candidateNames.add(knownDir);
  }
  if (!privateEntries.has('config.toml') && sharedSet.has('config.toml')) {
    candidateNames.add('config.toml');
  }
  if (sharedSet.has('.sqlite-maintenance.lock')) {
    candidateNames.add('.sqlite-maintenance.lock');
  }

  const linkedEntries: string[] = [];
  for (const entryName of candidateNames) {
    if (privateEntries.has(entryName) || CODEX_SHADOW_LOCAL_ENTRY_NAMES.has(entryName)) continue;
    const targetPath = join(sharedHomePath, entryName);
    const linkPath = join(shadowHomePath, entryName);
    const linked = await ensureSharedEntryLink({
      entryName,
      targetPath,
      linkPath,
      platform,
      onWarn: input.onWarn,
    });
    if (linked) linkedEntries.push(entryName);
  }

  return {
    applied: true,
    sharedHomePath,
    shadowHomePath,
    linkedEntries,
  };
}

async function initializePrivateCodexConfig(
  sharedHomePath: string,
  shadowHomePath: string,
  onWarn: PrepareCodexShadowHomeInput['onWarn'],
): Promise<void> {
  const sharedConfigPath = join(sharedHomePath, 'config.toml');
  const privateConfigPath = join(shadowHomePath, 'config.toml');
  try {
    await lstat(privateConfigPath);
    return;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      onWarn?.('Failed to inspect private Codex config', {
        privateConfigPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  try {
    const source = await readFile(sharedConfigPath, 'utf8');
    await writeFile(privateConfigPath, rebaseCodexConfigPaths(source, sharedHomePath), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'ENOENT' && code !== 'EEXIST') {
      onWarn?.('Failed to initialize private Codex config', {
        sharedConfigPath, privateConfigPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function rebaseCodexConfigPaths(contents: string, baseDir: string): string {
  const config = asTomlTable(parse(contents));
  if (config === undefined) throw new Error('Codex config TOML must be a table');

  let changed = rebaseConfigPathFields(config, CODEX_ROOT_CONFIG_PATH_FIELDS, baseDir);
  changed = rebaseConfigPathArrayFields(config, CODEX_CONFIG_PATH_ARRAY_FIELDS, baseDir) || changed;

  const workspaceWrite = asTomlTable(config['sandbox_workspace_write']);
  if (workspaceWrite !== undefined) {
    changed = rebaseConfigPathArrayFields(workspaceWrite, ['writable_roots'], baseDir) || changed;
  }

  const profiles = asTomlTable(config['profiles']);
  if (profiles !== undefined) {
    for (const profile of Object.values(profiles)) {
      const profileTable = asTomlTable(profile);
      if (profileTable === undefined) continue;
      changed = rebaseConfigPathFields(profileTable, CODEX_PROFILE_CONFIG_PATH_FIELDS, baseDir) || changed;
      changed = rebaseConfigPathArrayFields(profileTable, CODEX_CONFIG_PATH_ARRAY_FIELDS, baseDir) || changed;
    }
  }

  const agents = asTomlTable(config['agents']);
  if (agents !== undefined) {
    for (const role of Object.values(agents)) {
      const roleTable = asTomlTable(role);
      if (roleTable !== undefined) changed = rebaseConfigPathFields(roleTable, ['config_file'], baseDir) || changed;
    }
  }

  return changed ? stringify(config) : contents;
}

function rebaseConfigPathFields(
  table: Record<string, unknown>,
  fields: readonly string[],
  baseDir: string,
): boolean {
  let changed = false;
  for (const field of fields) {
    const pathValue = table[field];
    if (typeof pathValue !== 'string') continue;
    const rebased = rebaseConfigPath(pathValue, baseDir);
    if (rebased === pathValue) continue;
    table[field] = rebased;
    changed = true;
  }
  return changed;
}

function rebaseConfigPathArrayFields(
  table: Record<string, unknown>,
  fields: readonly string[],
  baseDir: string,
): boolean {
  let changed = false;
  for (const field of fields) {
    const values = table[field];
    if (!Array.isArray(values)) continue;
    let fieldChanged = false;
    const rebasedValues = values.map((value: unknown) => {
      if (typeof value !== 'string') return value;
      const rebased = rebaseConfigPath(value, baseDir);
      if (rebased !== value) fieldChanged = true;
      return rebased;
    });
    if (!fieldChanged) continue;
    table[field] = rebasedValues;
    changed = true;
  }
  return changed;
}

function rebaseConfigPath(path: string, baseDir: string): string {
  if (path === '~' || path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\')) || isAbsolute(path)) {
    return path;
  }
  return resolve(baseDir, path);
}

function asTomlTable(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function ensureSharedEntryLink(input: {
  readonly entryName: string;
  readonly targetPath: string;
  readonly linkPath: string;
  readonly platform: NodeJS.Platform;
  readonly onWarn?: (message: string, details?: Readonly<Record<string, unknown>>) => void;
}): Promise<boolean> {
  let targetStat;
  try {
    targetStat = await lstat(input.targetPath);
  } catch {
    return false;
  }
  const targetIsDir = targetStat.isDirectory();

  const existing = await inspectLinkState(input.linkPath);
  if (existing.kind === 'symlink') {
    const resolvedExisting = resolve(dirname(input.linkPath), stripWindowsLongPrefix(existing.target));
    if (samePath(resolvedExisting, input.targetPath, input.platform)) {
      return true;
    }
    try {
      await rm(input.linkPath, { force: true });
    } catch (error) {
      input.onWarn?.('Failed to update Codex shadow home link target', {
        entryName: input.entryName,
        linkPath: input.linkPath,
        targetPath: input.targetPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  } else if (existing.kind === 'real') {
    if (!existing.isDirectory) return false;
    try {
      const children = await readdir(input.linkPath);
      if (children.length > 0) return false;
      await rm(input.linkPath, { recursive: true, force: true });
    } catch {
      return false;
    }
  }

  const symlinkType = targetIsDir
    ? (input.platform === 'win32' ? 'junction' : 'dir')
    : 'file';
  try {
    await symlink(input.targetPath, input.linkPath, symlinkType);
    return true;
  } catch (error) {
    input.onWarn?.('Failed to link shared Codex asset into shadow home', {
      entryName: input.entryName,
      linkPath: input.linkPath,
      targetPath: input.targetPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function inspectLinkState(
  linkPath: string,
): Promise<
  | { readonly kind: 'missing' }
  | { readonly kind: 'symlink'; readonly target: string }
  | { readonly kind: 'real'; readonly isDirectory: boolean }
> {
  try {
    const target = await readlink(linkPath);
    return { kind: 'symlink', target };
  } catch (readLinkErr) {
    const code = errorCode(readLinkErr);
    if (code === 'ENOENT') return { kind: 'missing' };
    try {
      const st = await lstat(linkPath);
      if (st.isSymbolicLink()) {
        const fallbackTarget = await readlink(linkPath);
        return { kind: 'symlink', target: fallbackTarget };
      }
      return { kind: 'real', isDirectory: st.isDirectory() };
    } catch (statErr) {
      if (errorCode(statErr) === 'ENOENT') return { kind: 'missing' };
      return { kind: 'real', isDirectory: false };
    }
  }
}

function expandTildePath(rawPath: string, homeDir: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === '~') return resolve(homeDir);
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(join(homeDir, trimmed.slice(2)));
  }
  return resolve(trimmed);
}

function stripWindowsLongPrefix(rawPath: string): string {
  const cleaned = rawPath.startsWith('\\\\?\\') ? rawPath.slice(4) : rawPath;
  return cleaned.length > 3 ? cleaned.replace(/[\\/]+$/, '') : cleaned;
}

function samePath(left: string, right: string, platform = process.platform): boolean {
  const normLeft = stripWindowsLongPrefix(resolve(left));
  const normRight = stripWindowsLongPrefix(resolve(right));
  return platform === 'win32'
    ? normLeft.toLowerCase() === normRight.toLowerCase()
    : normLeft === normRight;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
