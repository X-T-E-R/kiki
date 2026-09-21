import { basename, dirname, join, normalize } from 'pathe';

import { findGitWorkTree } from '#/app/git/workTree';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { SystemPromptContext } from './profile';

export const AGENTS_MD_RECOMMENDED_MAX_BYTES = 32 * 1024;

export const LIST_DIR_ROOT_WIDTH = 30;
export const LIST_DIR_CHILD_WIDTH = 10;

interface ProfileContextDeps {
  readonly fs: IHostFileSystem;
  readonly homeDir: string;
}

export type { ProfileContextDeps };

export interface PreparedSystemPromptContext extends SystemPromptContext {
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly agentsMdPaths?: readonly string[];
  readonly additionalDirsInfo?: string;
  readonly agentsMdWarning?: string;
}

export interface PrepareSystemPromptContextOptions {
  readonly additionalDirs?: readonly string[];
  readonly preloadedAgentsMd?: LoadedAgentsMd;
}

export async function prepareSystemPromptContext(
  deps: ProfileContextDeps,
  workDir: string,
  brandHome?: string,
  options?: PrepareSystemPromptContextOptions,
): Promise<PreparedSystemPromptContext> {
  const additionalDirs = dedupeDirs(options?.additionalDirs ?? []);
  const [cwdListing, agentsMdResult, additionalDirsInfo] = await Promise.all([
    listDirectory(deps, workDir, { collapseHiddenDirs: true }),
    options?.preloadedAgentsMd !== undefined
      ? Promise.resolve(options.preloadedAgentsMd)
      : loadAgentsMdForRoots(deps, brandHome, [workDir]),
    loadAdditionalDirsInfo(deps, additionalDirs),
  ]);
  return {
    cwdListing,
    agentsMd: agentsMdResult.content,
    agentsMdPaths: agentsMdResult.paths,
    additionalDirsInfo,
    agentsMdWarning: agentsMdResult.warning,
  };
}

export async function loadAgentsMd(
  deps: ProfileContextDeps,
  workDir: string,
  brandHome?: string,
): Promise<string> {
  const result = await loadAgentsMdForRoots(deps, brandHome, [workDir]);
  return result.content;
}

export async function loadAgentsMdDetailed(
  deps: ProfileContextDeps,
  workDir: string,
  brandHome?: string,
): Promise<LoadedAgentsMd> {
  return loadAgentsMdForRoots(deps, brandHome, [workDir]);
}

export interface LoadedAgentsMd {
  readonly content: string;
  readonly warning: string | undefined;
  readonly paths: readonly string[];
}

export const AGENTS_MD_PLAIN_NAMES = ['AGENTS.md', 'agents.md'] as const;

const AGENTS_MD_CASE_FOLDED_NAME = 'agents.md';

export function dotKikiAgentsMdPath(dir: string): string {
  return join(dir, '.kiki', 'AGENTS.md');
}

export function agentsMdCandidatePaths(dir: string): string[] {
  return [dotKikiAgentsMdPath(dir), join(dir, 'AGENTS.md')];
}

export function extractAgentsMdPathsFromSystemPrompt(systemPrompt: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of systemPrompt.matchAll(/^<!-- From: (.+) -->$/gm)) {
    const path = match[1];
    if (path === undefined || basename(path).toLowerCase() !== AGENTS_MD_CASE_FOLDED_NAME) {
      continue;
    }
    const normalized = normalize(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

export async function findAgentsMdInDir(
  deps: { readonly fs: IHostFileSystem },
  dir: string,
): Promise<string[]> {
  const found: string[] = [];
  const dotKiki = await findAgentsMdPath(deps, join(dir, '.kiki'));
  if (dotKiki !== undefined && (await isNonEmptyFile(deps, dotKiki))) found.push(dotKiki);
  const plain = await findAgentsMdPath(deps, dir);
  if (plain !== undefined && (await isNonEmptyFile(deps, plain))) found.push(plain);
  return found;
}

async function findAgentsMdPath(
  deps: { readonly fs: IHostFileSystem },
  dir: string,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await deps.fs.readdir(dir);
  } catch {
    return undefined;
  }
  const matches = entries
    .filter((entry) => entry.name.toLowerCase() === AGENTS_MD_CASE_FOLDED_NAME)
    .toSorted((a, b) => agentsMdNameRank(a.name) - agentsMdNameRank(b.name) || a.name.localeCompare(b.name));
  return matches[0] === undefined ? undefined : join(dir, matches[0].name);
}

function agentsMdNameRank(name: string): number {
  if (name === 'AGENTS.md') return 0;
  if (name === 'agents.md') return 1;
  return 2;
}

async function isNonEmptyFile(
  deps: { readonly fs: IHostFileSystem },
  path: string,
): Promise<boolean> {
  try {
    const content = await deps.fs.readText(path, { errors: 'ignore' });
    return content.trim().length > 0;
  } catch {
    return false;
  }
}

export async function loadAgentsMdForRoots(
  deps: ProfileContextDeps,
  brandHome: string | undefined,
  workDirs: readonly string[],
): Promise<LoadedAgentsMd> {
  const discovered: AgentFile[] = [];
  const seen = new Set<string>();
  const loadWarnings: string[] = [];
  const warnLoad = (message: string): void => {
    loadWarnings.push(message);
  };

  const collect = async (path: string): Promise<boolean> => {
    const file = await readAgentFile(deps, path, warnLoad);
    if (file === undefined) return false;
    const key = normalize(file.path);
    if (seen.has(key)) return false;
    seen.add(key);
    discovered.push(file);
    return true;
  };

  const brandDir = brandHome ?? join(deps.homeDir, '.kiki');
  const workspaceFiles: { dotKiki: string | undefined; plain: string | undefined }[] = [];
  const workspaceRoots = new Set<string>();
  for (const workDir of workDirs) {
    const rootWorkDir = normalize(workDir);
    const projectRoot = (await findGitWorkTree(deps.fs, rootWorkDir))?.root ?? rootWorkDir;
    if (workspaceRoots.has(projectRoot)) continue;
    workspaceRoots.add(projectRoot);
    workspaceFiles.push({
      dotKiki: await findAgentsMdPath(deps, join(projectRoot, '.kiki')),
      plain: await findAgentsMdPath(deps, projectRoot),
    });
  }

  const hasWorkspaceOverride = (
    await Promise.all(
      workspaceFiles.map(async ({ dotKiki }) =>
        dotKiki === undefined ? false : isFile(deps, dotKiki),
      ),
    )
  ).some(Boolean);
  if (!hasWorkspaceOverride) {
    const userFile = await findAgentsMdPath(deps, brandDir);
    if (userFile !== undefined) await collect(userFile);
  }

  for (const { dotKiki, plain } of workspaceFiles) {
    if (dotKiki !== undefined) await collect(dotKiki);
    if (plain !== undefined) await collect(plain);
  }

  const content = renderAgentFiles(discovered);
  const totalBytes = byteLength(content);
  if (totalBytes > AGENTS_MD_RECOMMENDED_MAX_BYTES) {
    loadWarnings.push(
      `AGENTS.md total ${formatKB(totalBytes)} KB exceeds the recommended ` +
        `${formatKB(AGENTS_MD_RECOMMENDED_MAX_BYTES)} KB. Large instruction files ` +
        `increase cost and may impact performance; consider trimming.`,
    );
  }
  const warning = loadWarnings.length > 0 ? loadWarnings.join('\n') : undefined;
  const paths = discovered.map((file) => normalize(file.path));
  return { content, warning, paths };
}

export interface AgentsMdWatchRoot {
  readonly root: string;
  readonly candidates: readonly string[];
}

export async function agentsMdWatchRoots(
  deps: ProfileContextDeps,
  workDir: string,
  brandHome?: string,
): Promise<readonly AgentsMdWatchRoot[]> {
  const brandDir = brandHome ?? join(deps.homeDir, '.kiki');
  const rootWorkDir = normalize(workDir);
  const projectRoot = (await findGitWorkTree(deps.fs, rootWorkDir))?.root ?? rootWorkDir;
  return [
    { root: brandDir, candidates: [join(brandDir, 'AGENTS.md')] },
    {
      root: projectRoot,
      candidates: [join(projectRoot, 'AGENTS.md'), dotKikiAgentsMdPath(projectRoot)],
    },
  ];
}

async function loadAdditionalDirsInfo(
  deps: ProfileContextDeps,
  additionalDirs: readonly string[],
): Promise<string> {
  const sections = await Promise.all(
    additionalDirs.map(async (dir) => {
      const listing = await listDirectory(deps, dir);
      return `### ${dir}\n${listing}`;
    }),
  );
  return sections.join('\n\n');
}

export async function findProjectRoot(
  deps: { readonly fs: IHostFileSystem },
  workDir: string,
): Promise<string> {
  const rootWorkDir = normalize(workDir);
  return (await findGitWorkTree(deps.fs, rootWorkDir))?.root ?? rootWorkDir;
}

export function dirsRootToLeaf(workDir: string, projectRoot: string): string[] {
  const dirs: string[] = [];
  let current = normalize(workDir);

  while (true) {
    dirs.push(current);
    if (current === projectRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs.toReversed();
}

interface AgentFile {
  readonly path: string;
  readonly content: string;
}

async function readAgentFile(
  deps: ProfileContextDeps,
  path: string,
  warn: (message: string) => void,
): Promise<AgentFile | undefined> {
  if (!(await isFile(deps, path))) {
    if (await entryExists(deps, path)) {
      warn(`Instruction file at ${path} exists but is not a readable regular file; skipping.`);
    }
    return undefined;
  }
  let content: string;
  try {
    content = (await deps.fs.readText(path, { errors: 'ignore' })).trim();
  } catch {
    warn(`Instruction file at ${path} could not be read; skipping.`);
    return undefined;
  }
  if (content.length === 0) return undefined;
  return { path, content };
}

async function pathExists(deps: { readonly fs: IHostFileSystem }, path: string): Promise<boolean> {
  try {
    await deps.fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function entryExists(deps: { readonly fs: IHostFileSystem }, path: string): Promise<boolean> {
  return pathExists(deps, path);
}

async function isFile(deps: { readonly fs: IHostFileSystem }, path: string): Promise<boolean> {
  try {
    const stat = await deps.fs.stat(path);
    return stat.isFile;
  } catch {
    return false;
  }
}

function renderAgentFiles(files: readonly AgentFile[]): string {
  if (files.length === 0) return '';
  return files.map((file) => `${annotationFor(file.path)}${file.content}`).join('\n\n');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function formatKB(bytes: number): string {
  const kb = bytes / 1024;
  return Number.isInteger(kb) ? String(kb) : kb.toFixed(1);
}

function annotationFor(path: string): string {
  return `<!-- From: ${path} -->\n`;
}

function dedupeDirs(dirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of dirs) {
    if (typeof dir !== 'string') continue;
    const trimmed = dir.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

interface ListDirectoryOptions {
  readonly collapseHiddenDirs?: boolean;
}

interface Entry {
  readonly name: string;
  readonly isDir: boolean;
}

async function collectEntries(
  deps: ProfileContextDeps,
  dirPath: string,
  maxWidth: number,
): Promise<{ entries: Entry[]; total: number; readable: boolean }> {
  const all: Entry[] = [];
  try {
    const dirents = await deps.fs.readdir(dirPath);
    for (const d of dirents) {
      all.push({ name: d.name, isDir: d.isDirectory });
    }
  } catch {
    return { entries: [], total: 0, readable: false };
  }
  all.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries: all.slice(0, maxWidth), total: all.length, readable: true };
}

function shouldCollapseDirectory(entry: Entry, options: ListDirectoryOptions): boolean {
  return options.collapseHiddenDirs === true && entry.isDir && entry.name.startsWith('.');
}

async function listDirectory(
  deps: ProfileContextDeps,
  workDir: string,
  options: ListDirectoryOptions = {},
): Promise<string> {
  const lines: string[] = [];
  const { entries, total, readable } = await collectEntries(deps, workDir, LIST_DIR_ROOT_WIDTH);
  if (!readable) return '[not readable]';
  const remaining = total - entries.length;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const { name, isDir } = entry;
    const isLast = i === entries.length - 1 && remaining === 0;
    const connector = isLast ? '└── ' : '├── ';

    if (isDir) {
      lines.push(`${connector}${name}/`);
      if (shouldCollapseDirectory(entry, options)) continue;
      const childPrefix = isLast ? '    ' : '│   ';
      const childDir = join(workDir, name);
      const child = await collectEntries(deps, childDir, LIST_DIR_CHILD_WIDTH);
      if (!child.readable) {
        lines.push(`${childPrefix}└── [not readable]`);
        continue;
      }
      const childRemaining = child.total - child.entries.length;
      for (let j = 0; j < child.entries.length; j++) {
        const ce = child.entries[j];
        if (ce === undefined) continue;
        const cIsLast = j === child.entries.length - 1 && childRemaining === 0;
        const cConnector = cIsLast ? '└── ' : '├── ';
        const suffix = ce.isDir ? '/' : '';
        lines.push(`${childPrefix}${cConnector}${ce.name}${suffix}`);
      }
      if (childRemaining > 0) {
        lines.push(`${childPrefix}└── ... and ${String(childRemaining)} more`);
      }
    } else {
      lines.push(`${connector}${name}`);
    }
  }

  if (remaining > 0) {
    lines.push(`└── ... and ${String(remaining)} more entries`);
  }

  return lines.length > 0 ? lines.join('\n') : '(empty directory)';
}
