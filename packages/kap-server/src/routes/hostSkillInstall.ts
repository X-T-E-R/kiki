import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type HostSkillTarget = 'claude' | 'codex' | 'grok' | 'agents';

export interface HostSkillPreview {
  readonly host: HostSkillTarget;
  readonly directory: string;
  readonly path: string;
  readonly overwrites: boolean;
  readonly revision: string;
}

const TARGETS: Record<HostSkillTarget, readonly string[]> = {
  claude: ['.claude', 'skills'],
  codex: ['.codex', 'skills'],
  grok: ['.grok', 'skills'],
  agents: ['.agents', 'skills'],
};

export class HostSkillInstallConflict extends Error {}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function checkPath(path: string, kind: 'directory' | 'file'): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
      throw new HostSkillInstallConflict(`Unexpected ${kind} at ${path}.`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function previewHostSkill(host: HostSkillTarget, content: string, home = homedir()): Promise<HostSkillPreview> {
  const [hostDir, skillsDir] = TARGETS[host];
  const root = join(home, hostDir!);
  const directory = join(root, skillsDir!);
  const skillDir = join(directory, 'kiki-as-subagent');
  const path = join(skillDir, 'SKILL.md');
  for (const dir of [home, root, directory, skillDir]) await checkPath(dir, 'directory');
  const overwrites = await checkPath(path, 'file');
  const previous = overwrites ? hash(await readFile(path, 'utf8')) : '';
  return { host, directory, path, overwrites, revision: hash(`${host}\0${path}\0${hash(content)}\0${previous}`) };
}

export async function installHostSkill(
  host: HostSkillTarget,
  content: string,
  revision: string,
  home = homedir(),
): Promise<HostSkillPreview> {
  const preview = await previewHostSkill(host, content, home);
  if (preview.revision !== revision) throw new HostSkillInstallConflict('Skill target changed; preview again before installing.');
  await mkdir(dirname(preview.path), { recursive: true });
  const checked = await previewHostSkill(host, content, home);
  if (checked.revision !== revision) throw new HostSkillInstallConflict('Skill target changed; preview again before installing.');
  const temp = `${preview.path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
    await rename(temp, preview.path);
  } finally {
    await rm(temp, { force: true });
  }
  return { ...preview, overwrites: checked.overwrites };
}
