import { promises as fs } from 'node:fs';
import { basename, join } from 'pathe';

import { ILogService, type LogPayload } from '#/_base/log/log';

import { SkillParseError, UnsupportedSkillTypeError, parseSkillText } from './parser';
import type { SkillDiscoveryResult, ISkillDiscovery } from './skillDiscovery';
import type { SkillDefinition, SkillRoot, SkippedSkill } from './types';
import { normalizeSkillName } from './types';

export const MAX_SKILL_SCAN_DEPTH = 8;
export const MAX_CONCURRENT_SKILL_IO = 16;

export function isSkillScanExcludedEntry(entryName: string): boolean {
  return entryName === 'node_modules' || entryName.startsWith('.');
}

export class FileSkillDiscovery implements ISkillDiscovery {
  declare readonly _serviceBrand: undefined;

  constructor(@ILogService private readonly log: ILogService) {}

  async discover(roots: readonly SkillRoot[]): Promise<SkillDiscoveryResult> {
    return discoverFileSkills(roots, (message, payload) => {
      this.log.warn(message, payload);
    });
  }
}

export async function discoverFileSkills(
  roots: readonly SkillRoot[],
  warn?: (message: string, payload?: LogPayload) => void,
): Promise<SkillDiscoveryResult> {
  const byDiscoveryKey = new Map<string, SkillDefinition>();
  const skipped: SkippedSkill[] = [];
  const scannedDirectories: string[] = [];
  const runIo = createConcurrencyLimit(MAX_CONCURRENT_SKILL_IO);

  const parse = (input: Omit<Parameters<typeof parseSkill>[0], 'skipped' | 'warn' | 'readFile'>) =>
    parseSkill({
      ...input,
      skipped,
      warn,
      readFile: (filePath) => runIo(() => fs.readFile(filePath, 'utf8')),
    });
  const register = (skill: SkillDefinition, root: SkillRoot): SkillDefinition => {
    const key = `${skill.metadata.promptCommand === true ? 'command\0' : ''}${skillDiscoveryKey(root, skill.name)}`;
    if (!byDiscoveryKey.has(key)) byDiscoveryKey.set(key, skill);
    return skill;
  };

  async function walkSkillDir(
    dirPath: string,
    root: SkillRoot,
    isTopLevel: boolean,
    depth: number,
    subSkillParentName?: string,
  ): Promise<void> {
    if (depth > MAX_SKILL_SCAN_DEPTH) return;

    if (root.scanMode === 'root-skill-only') {
      const rootSkillMd = join(dirPath, 'SKILL.md');
      if (await runIo(() => isFile(rootSkillMd))) {
        const skill = await parse({
          skillMdPath: rootSkillMd,
          skillDirName: basename(dirPath),
          root,
        });
        if (skill !== undefined) register(skill, root);
      }
      return;
    }

    let entries: readonly string[];
    try {
      entries = [...(await runIo(() => fs.readdir(dirPath)))].toSorted();
    } catch {
      return;
    }
    scannedDirectories.push(dirPath);

    if (root.scanMode === 'commands') {
      const parsed = await mapConcurrent(entries, MAX_CONCURRENT_SKILL_IO, async (entry) => {
        if (!entry.endsWith('.md') || isSkillScanExcludedEntry(entry)) return undefined;
        const skillMdPath = join(dirPath, entry);
        if (!(await runIo(() => isFile(skillMdPath)))) return undefined;
        return parse({
          skillMdPath,
          skillDirName: entry.slice(0, -'.md'.length),
          root,
        });
      });
      for (const skill of parsed) if (skill !== undefined) register(skill, root);
      return;
    }

    const inspected = await mapConcurrent(entries, MAX_CONCURRENT_SKILL_IO, async (entry) => {
      const entryPath = join(dirPath, entry);
      const excluded = isSkillScanExcludedEntry(entry);
      const [skill, directory] = await Promise.all([
        runIo(() => isFile(join(entryPath, 'SKILL.md'))),
        excluded ? Promise.resolve(false) : runIo(() => isDir(entryPath)),
      ]);
      return { entry, skill, directory };
    });
    const directorySkills = new Set(inspected.filter((entry) => entry.skill).map((entry) => entry.entry));
    const subdirs = inspected.filter((entry) => entry.directory).map((entry) => entry.entry);

    const parsedDirectorySkills = await mapConcurrent(
      [...directorySkills],
      MAX_CONCURRENT_SKILL_IO,
      async (entry) => ({
        entry,
        skill: await parse({
          skillMdPath: join(dirPath, entry, 'SKILL.md'),
          skillDirName: entry,
          root,
          subSkillParentName,
        }),
      }),
    );
    const allowedSubSkillBundles = new Map<string, string>();
    for (const { entry, skill } of parsedDirectorySkills) {
      if (skill === undefined) continue;
      register(skill, root);
      if (hasSubSkillEnabled(skill)) allowedSubSkillBundles.set(entry, skill.name);
    }

    if (isTopLevel) {
      if (root.plugin !== undefined) {
        const rootSkillMd = join(dirPath, 'SKILL.md');
        if (await runIo(() => isFile(rootSkillMd))) {
          const skill = await parse({
            skillMdPath: rootSkillMd,
            skillDirName: basename(dirPath),
            root,
          });
          if (skill !== undefined) register(skill, root);
        }
      }

      const parsedFlatSkills = await mapConcurrent(entries, MAX_CONCURRENT_SKILL_IO, async (entry) => {
        if (!entry.endsWith('.md') || entry === 'SKILL.md') return undefined;
        const skillName = entry.slice(0, -'.md'.length);
        if (directorySkills.has(skillName)) return undefined;
        const skillMdPath = join(dirPath, entry);
        if (!(await runIo(() => isFile(skillMdPath)))) return undefined;
        return parse({ skillMdPath, skillDirName: skillName, root });
      });
      for (const skill of parsedFlatSkills) if (skill !== undefined) register(skill, root);
    }

    for (const entry of subdirs) {
      if (directorySkills.has(entry) && !allowedSubSkillBundles.has(entry)) continue;
      const allowedSubSkillParentName = allowedSubSkillBundles.get(entry);
      await walkSkillDir(
        join(dirPath, entry),
        root,
        false,
        depth + 1,
        allowedSubSkillParentName ?? subSkillParentName,
      );
    }
  }

  for (const root of roots) {
    await walkSkillDir(root.path, root, true, 0);
  }

  return {
    skills: sortSkills([...byDiscoveryKey.values()]),
    skipped,
    scannedRoots: roots.map((root) => root.path),
    scannedDirectories,
  };
}

async function parseSkill(input: {
  readonly skipped: SkippedSkill[];
  readonly warn?: (message: string, payload?: LogPayload) => void;
  readonly skillMdPath: string;
  readonly skillDirName: string;
  readonly root: SkillRoot;
  readonly subSkillParentName?: string;
  readonly readFile: (path: string) => Promise<string>;
}): Promise<SkillDefinition | undefined> {
  try {
    const text = await input.readFile(input.skillMdPath);
    const parsed = parseSkillText({
      skillMdPath: input.skillMdPath,
      skillDirName: input.skillDirName,
      source: input.root.source,
      promptCommand: input.root.scanMode === 'commands',
      text,
    });
    const subSkillParentName = input.subSkillParentName;
    const skill =
      subSkillParentName !== undefined
        ? {
            ...parsed,
            name: qualifySubSkillName(subSkillParentName, parsed.name),
            metadata: {
              ...parsed.metadata,
              isSubSkill: true,
            },
          }
        : parsed;
    return input.root.plugin === undefined ? skill : { ...skill, plugin: input.root.plugin };
  } catch (error) {
    if (error instanceof UnsupportedSkillTypeError) {
      input.skipped.push({
        path: input.skillMdPath,
        type: error.skillType,
        reason: `unsupported skill type "${error.skillType}"`,
      });
    } else if (error instanceof SkillParseError) {
      input.warn?.(`Skipping invalid skill at ${input.skillMdPath}: ${error.message}`, error);
    } else {
      input.warn?.(`Skipping skill at ${input.skillMdPath} due to unexpected error`, error);
    }
    return undefined;
  }
}

function skillDiscoveryKey(root: SkillRoot, name: string): string {
  const normalizedName = normalizeSkillName(name);
  return root.plugin === undefined ? normalizedName : `${root.plugin.id}\0${normalizedName}`;
}

function sortSkills(skills: readonly SkillDefinition[]): readonly SkillDefinition[] {
  return [...skills].toSorted((a, b) => a.name.localeCompare(b.name));
}

function qualifySubSkillName(parentName: string, skillName: string): string {
  if (skillName === parentName || skillName.startsWith(`${parentName}.`)) return skillName;
  return `${parentName}.${skillName}`;
}

function hasSubSkillEnabled(skill: SkillDefinition): boolean {
  const nested = skill.metadata['metadata'];
  const nestedFlag =
    typeof nested === 'object' && nested !== null
      ? (nested as Record<string, unknown>)['has-sub-skill'] === true ||
        (nested as Record<string, unknown>)['hasSubSkill'] === true
      : false;
  return (
    skill.metadata['has-sub-skill'] === true ||
    skill.metadata['hasSubSkill'] === true ||
    nestedFlag
  );
}

function createConcurrencyLimit(limit: number) {
  let active = 0;
  const pending: Array<() => void> = [];
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => {
        pending.push(resolve);
      });
    }
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
      pending.shift()?.();
    }
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        results[index] = await operation(values[index]!);
      }
    }),
  );
  return results;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
