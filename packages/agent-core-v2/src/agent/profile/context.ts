import { basename, dirname, join, normalize } from 'pathe';
import { instructionVersion, type InstructionFile } from '#/agent/agentsMdReminder/instructionCoverage';

import { findGitWorkTree } from '#/app/git/workTree';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { SystemPromptContext } from './profile';

export const AGENTS_MD_RECOMMENDED_MAX_BYTES = 32 * 1024;

export const LIST_DIR_ROOT_WIDTH = 20;

interface ProfileContextDeps {
  readonly fs: IHostFileSystem;
  readonly homeDir: string;
}

export type { ProfileContextDeps };

export interface PreparedSystemPromptContext extends SystemPromptContext {
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly agentsMdPaths?: readonly string[];
  readonly agentsMdFiles?: readonly InstructionFile[];
  readonly additionalDirsInfo?: string;
  readonly agentsMdWarning?: string;
}

export interface PrepareSystemPromptContextOptions {
  readonly additionalDirs?: readonly string[];
  readonly preloadedAgentsMd?: LoadedAgentsMd;
  readonly inheritance?: AgentsMdInheritance;
  readonly cwdListing?: string;
  readonly additionalDirsInfo?: string;
}

export async function prepareSystemPromptContext(
  deps: ProfileContextDeps,
  workDir: string,
  brandHome?: string,
  options?: PrepareSystemPromptContextOptions,
): Promise<PreparedSystemPromptContext> {
  const additionalDirs = dedupeDirs(options?.additionalDirs ?? []);
  const [cwdListing, agentsMdResult, additionalDirsInfo] = await Promise.all([
    options?.cwdListing ?? listDirectory(deps, workDir),
    options?.preloadedAgentsMd !== undefined
      ? Promise.resolve(options.preloadedAgentsMd)
      : loadAgentsMdForRoots(deps, brandHome, [workDir], { inheritance: options?.inheritance }),
    options?.additionalDirsInfo ?? loadAdditionalDirsInfo(deps, additionalDirs),
  ]);
  return {
    cwdListing,
    agentsMd: agentsMdResult.content,
    agentsMdPaths: agentsMdResult.paths,
    agentsMdFiles: agentsMdResult.files,
    additionalDirsInfo,
    agentsMdWarning: agentsMdResult.warning,
  };
}

export async function loadAgentsMd(
  deps: ProfileContextDeps,
  workDir: string,
  brandHome?: string,
  options: LoadAgentsMdOptions = {},
): Promise<string> {
  const result = await loadAgentsMdForRoots(deps, brandHome, [workDir], options);
  return result.content;
}

export async function loadAgentsMdDetailed(
  deps: ProfileContextDeps,
  workDir: string,
  brandHome?: string,
  options: LoadAgentsMdOptions = {},
): Promise<LoadedAgentsMd> {
  return loadAgentsMdForRoots(deps, brandHome, [workDir], options);
}

export interface LoadedAgentsMd {
  readonly content: string;
  readonly warning: string | undefined;
  readonly paths: readonly string[];
  readonly files?: readonly InstructionFile[];
}

export const AGENTS_MD_PLAIN_NAMES = ['AGENTS.md', 'agents.md'] as const;

const AGENTS_MD_CASE_FOLDED_NAME = 'agents.md';

export function dotKikiAgentsMdPath(dir: string): string {
  return join(dir, '.kiki', 'AGENTS.md');
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


export interface AgentsMdInheritance {
  readonly baseHomeDir?: string;
  readonly instructions: boolean | 'stack';
}

export interface LoadAgentsMdOptions {
  readonly inheritance?: AgentsMdInheritance;
}

export async function loadAgentsMdForRoots(
  deps: ProfileContextDeps,
  brandHome: string | undefined,
  workDirs: readonly string[],
  options: LoadAgentsMdOptions = {},
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
  const inheritance = options.inheritance;
  const baseDir =
    inheritance?.instructions !== false &&
    inheritance?.baseHomeDir !== undefined &&
    normalize(inheritance.baseHomeDir) !== normalize(brandDir)
      ? inheritance.baseHomeDir
      : undefined;
  const stack = inheritance?.instructions === 'stack';
  const workspaceFiles: { dotKiki: string | undefined; plain: string | undefined }[] = [];
  const workspaceRoots = new Set<string>();
  const nestedDirectories = new Set<string>();
  for (const workDir of workDirs) {
    const rootWorkDir = normalize(workDir);
    const projectRoot = (await findGitWorkTree(deps.fs, rootWorkDir))?.root ?? rootWorkDir;
    for (const directory of instructionDirectories(projectRoot, rootWorkDir).slice(1)) nestedDirectories.add(directory);
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
    if (stack && baseDir !== undefined) {
      const baseFile = await findAgentsMdPath(deps, baseDir);
      if (baseFile !== undefined) await collect(baseFile);
    }
    if (userFile !== undefined) await collect(userFile);
    if (!stack && userFile === undefined && baseDir !== undefined) {
      const baseFile = await findAgentsMdPath(deps, baseDir);
      if (baseFile !== undefined) await collect(baseFile);
    }
  }

  for (const { dotKiki, plain } of workspaceFiles) {
    if (dotKiki !== undefined) await collect(dotKiki);
    if (plain !== undefined) await collect(plain);
  }

  for (const directory of nestedDirectories) {
    const dotKiki = await findAgentsMdPath(deps, join(directory, '.kiki'));
    const plain = await findAgentsMdPath(deps, directory);
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
  const files = await Promise.all(discovered.map(async (file) => ({ path: normalize(await deps.fs.realpath(file.path)), version: instructionVersion(file.content),
    scope: basename(dirname(file.path)).toLowerCase() === '.kiki' ? dirname(dirname(file.path)) : dirname(file.path), runtimeId: 'local' })));
  return { content, warning, paths, files };
}

export interface AgentsMdWatchRoot {
  readonly root: string;
  readonly candidates: readonly string[];
}

export async function agentsMdWatchRoots(
  deps: ProfileContextDeps,
  workDir: string,
  brandHome?: string,
  options: LoadAgentsMdOptions = {},
): Promise<readonly AgentsMdWatchRoot[]> {
  const brandDir = brandHome ?? join(deps.homeDir, '.kiki');
  const inheritance = options.inheritance;
  const baseDir =
    inheritance?.instructions !== false &&
    inheritance?.baseHomeDir !== undefined &&
    normalize(inheritance.baseHomeDir) !== normalize(brandDir)
      ? inheritance.baseHomeDir
      : undefined;
  const rootWorkDir = normalize(workDir);
  const projectRoot = (await findGitWorkTree(deps.fs, rootWorkDir))?.root ?? rootWorkDir;
  return [
    { root: brandDir, candidates: [join(brandDir, 'AGENTS.md')] },
    ...(baseDir === undefined
      ? []
      : [{ root: baseDir, candidates: [join(baseDir, 'AGENTS.md')] }]),
    ...instructionDirectories(projectRoot, rootWorkDir).map((root) => ({
      root, candidates: [join(root, 'AGENTS.md'), dotKikiAgentsMdPath(root)],
    })),
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

export function instructionDirectories(root: string, target: string, pathClass: 'posix' | 'win32' = 'posix'): readonly string[] {
  const directories = [normalize(target)];
  const key = (path: string) => pathClass === 'win32' ? normalize(path).toLowerCase() : normalize(path);
  const boundary = key(root);
  while (key(directories[0]!) !== boundary) {
    const parent = dirname(directories[0]!);
    if (parent === directories[0]) return [normalize(target)];
    directories.unshift(parent);
  }
  directories[0] = normalize(root);
  return directories;
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

async function listDirectory(
  deps: ProfileContextDeps,
  workDir: string,
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

    lines.push(`${connector}${name}${isDir ? '/' : ''}`);
  }

  if (remaining > 0) {
    lines.push(`└── ... and ${String(remaining)} more entries; use Glob to explore`);
  }

  return lines.length > 0 ? lines.join('\n') : '(empty directory)';
}
