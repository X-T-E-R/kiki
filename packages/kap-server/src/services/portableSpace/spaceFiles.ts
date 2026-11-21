import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { atomicWrite } from '@kiki/agent-core-v2/_base/utils/fs';
import type { PortableSpaceFormat } from '@kiki/protocol';
import { domainForFile, FORK, PLAIN, RECIPIENTS, SEALED } from './treeProjection';
import { safePortablePath } from './tarArchive';
import { RECIPE_INSTALLATIONS, RECIPE_STORE } from './recipeStore';

export const MAX_SPACE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const exec = promisify(execFile);
const SENSITIVE = /^(?:\.git|\.ssh|\.gnupg|credentials|sessions|secrets?|\.secrets?|\.env(?:\..*)?|config\.local\.toml|server[.-](?:local-owner|token)|.*\.(?:pem|key|pfx))$/i;

export async function missing<T>(work: Promise<T>): Promise<T | undefined> {
  try { return await work; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', ...args], {
    cwd, windowsHide: true, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

export function gitRemote(repo: string): string {
  if (/^github:[\w.-]+\/[\w.-]+$/.test(repo)) return `https://github.com/${repo.slice(7)}.git`;
  if (/^git@[\w.-]+:[\w./-]+$/.test(repo)) return repo;
  const url = URL.canParse(repo) ? new URL(repo) : undefined;
  if (!url || !['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) || url.password || (url.username && url.protocol !== 'ssh:')) throw new Error('Unsupported portable Space Git repository');
  return repo;
}

export async function scratch<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'kiki-space-'));
  try { return await work(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
}

export function pathFormat(path: string): PortableSpaceFormat {
  const lower = path.toLowerCase();
  return lower.endsWith('.age') ? 'age' : /\.(?:tgz|tar\.gz|json)$/.test(lower) ? 'tgz' : 'dir';
}

function managed(path: string): boolean {
  return /^(?:config(?:\.(?:linux|darwin|win32))?|overlay|extensions)\.toml$/.test(path) || ['mcp.json', PLAIN, SEALED, RECIPIENTS, FORK].includes(path) || domainForFile(path) !== undefined;
}

function within(root: string, path: string): boolean {
  const sub = relative(root, path);
  return !isAbsolute(sub) && sub !== '..' && !sub.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

export async function readBounded(path: string, limit = MAX_SPACE_BYTES): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error(`Portable Space file exceeds its limit: ${basename(path)}`);
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== info.size) throw new Error(`Portable Space file changed during read: ${basename(path)}`);
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}

export async function readTree(root: string, live: boolean, include: (path: string) => boolean = () => true, osHome = homedir()): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const actualRoot = await realpath(root);
  const allowed = [actualRoot, dirname(actualRoot), await missing(realpath(osHome)) ?? osHome];
  const names = new Set<string>();
  let total = 0;
  const walk = async (directory: string, prefix: string, trail: readonly string[]): Promise<void> => {
    for (const dirent of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (!include(path) || (path.startsWith('store/') && path !== 'store/recipes' && !path.startsWith(RECIPE_STORE))) continue;
      const candidate = join(directory, dirent.name);
      if (dirent.name.startsWith('.') && ![FORK, RECIPIENTS].includes(path) || dirent.name === 'node_modules') continue;
      if (path === 'agents/builtin' || (live && path === 'credentials') || path.startsWith('credentials/') && ![PLAIN, SEALED].includes(path)) continue;
      if (!dirent.isDirectory() && !dirent.isSymbolicLink() && !managed(path)) continue;
      if (!prefix && dirent.isDirectory() && path !== 'credentials' && path !== 'store' && !domainForFile(`${path}/_`)) continue;
      let current = candidate;
      if (dirent.isSymbolicLink()) {
        if (!live) {
          if (managed(path) || domainForFile(`${path}/_`)) throw new Error(`Symbolic links are not allowed in portable directories: ${path}`);
          continue;
        }
        if (!managed(path) && !domainForFile(`${path}/_`)) continue;
        current = await realpath(candidate);
        const owner = allowed.find((base) => within(base, current));
        const gitDirectory = (await lstat(current)).isDirectory() ? current : dirname(current);
        const outside = !owner && !await git(gitDirectory, ['rev-parse', '--show-toplevel']).then((top) => within(top, current), () => false);
        if (outside || (owner ? relative(owner, current) : current).split(/[\\/]/).some((segment) => SENSITIVE.test(segment))) {
          throw new Error(`Portable Space link points outside an allowed user resource: ${path}`);
        }
      }
      const info = await lstat(current);
      if (info.isDirectory()) {
        if (trail.includes(current)) throw new Error(`Portable Space symlink cycle: ${path}`);
        if (path !== 'credentials' && path !== 'store' && !domainForFile(`${path}/_`)) continue;
        await walk(current, path, [...trail, current]);
      } else if (info.isFile() && managed(path)) {
        const canonical = safePortablePath(path);
        const alias = canonical.toLowerCase();
        if (names.has(alias)) throw new Error(`Portable Space paths overlap: ${canonical}`);
        names.add(alias);
        if (names.size > 32_768) throw new Error('Portable Space has too many files');
        const binary = path === SEALED || /\.(?:avif|gif|ico|jpe?g|mp[34]|otf|png|ttf|webm|webp|woff2?)$/i.test(path);
        const limit = path.startsWith('sessions/') || path === RECIPE_INSTALLATIONS || path.startsWith(`${RECIPE_STORE}revisions/`) || binary ? MAX_SPACE_BYTES - total : Math.min(MAX_FILE_BYTES, MAX_SPACE_BYTES - total);
        const bytes = await readBounded(current, limit);
        total += bytes.length;
        if (total > MAX_SPACE_BYTES) throw new Error('Portable Space tree exceeds 64 MiB');
        files.set(canonical, bytes);
      }
    }
  };
  await walk(actualRoot, '', [actualRoot]);
  return files;
}

export async function checkedPath(root: string, path: string): Promise<string> {
  const parts = safePortablePath(path).split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const info = await missing(lstat(current));
    if (info?.isSymbolicLink() || (info && i < parts.length - 1 && !info.isDirectory())) throw new Error(`Unsafe destination path: ${path}`);
  }
  return current;
}

export async function writeFileAtomic(path: string, bytes: string | Buffer, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, bytes, undefined, mode, undefined, true);
}

async function ensureLines(path: string, lines: readonly string[], prepend = false): Promise<void> {
  const before = await missing(readFile(path, 'utf8')) ?? '';
  const insert = lines.filter((line) => !before.split(/\r?\n/).some((entry) => entry.trim() === line));
  if (insert.length === 0) return;
  if (!prepend) {
    await writeFileAtomic(path, `${before}${!before || before.endsWith('\n') ? '' : '\n'}${insert.join('\n')}\n`);
    return;
  }
  const bom = before.startsWith('\uFEFF') ? '\uFEFF' : '';
  const content = before.slice(bom.length);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  await writeFileAtomic(path, `${bom}${insert.join(newline)}${newline}${content}`);
}

async function guardPlain(root: string): Promise<boolean> {
  let inside = false;
  try { inside = await git(root, ['rev-parse', '--is-inside-work-tree']) === 'true'; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      let directory = root;
      for (;;) {
        if (await missing(lstat(join(directory, '.git'))) !== undefined) throw new Error('Git is required to verify plaintext credential safety', { cause: error });
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    } else if (!String((error as { stderr?: string }).stderr).includes('not a git repository')) throw error;
  }
  if (inside) {
    try { await git(root, ['ls-files', '--error-unmatch', '--', PLAIN]); }
    catch (error) {
      if ((error as { code?: number }).code !== 1) throw error;
      return true;
    }
    throw new Error('Refusing to write plaintext credentials: credentials/credentials.toml is tracked or staged in Git');
  }
  return false;
}

async function guardPlainIgnored(root: string): Promise<void> {
  try { await git(root, ['check-ignore', '-q', '--', PLAIN]); }
  catch (error) {
    if ((error as { code?: number }).code === 1) throw new Error('Refusing to write plaintext credentials: credentials/credentials.toml is not ignored by Git', { cause: error });
    throw error;
  }
}

export async function writeTree(destination: string, files: ReadonlyMap<string, Buffer>, gitInit: boolean, replaceManaged: boolean): Promise<void> {
  const path = resolve(destination);
  if ((await missing(lstat(path)))?.isSymbolicLink()) throw new Error('Portable Space destination cannot be a symbolic link');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const root = await realpath(path);
  const previous = await readTree(root, false);
  const plainInGit = files.has(PLAIN) ? await guardPlain(root) : false;
  if (previous.size > 0 && !replaceManaged) throw new Error('Portable export destination already contains managed files; choose an empty destination');
  const aliases = new Set<string>();
  for (const path of files.keys()) {
    const alias = safePortablePath(path).toLowerCase();
    if (aliases.has(alias)) throw new Error(`Portable Space paths overlap: ${path}`);
    aliases.add(alias);
  }
  for (const path of aliases) {
    const parts = path.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (aliases.has(parts.join('/'))) throw new Error(`Portable Space paths overlap: ${path}`);
    }
  }
  for (const path of new Set([...previous.keys(), ...files.keys()])) {
    const target = await checkedPath(root, path);
    const info = await missing(lstat(target));
    if (info && !info.isFile()) throw new Error(`Portable Space destination is not a regular file: ${path}`);
  }
  if (gitInit && !await missing(lstat(join(root, '.git')))) await git(root, ['init']);
  if (files.has(PLAIN)) {
    await ensureLines(await checkedPath(root, '.gitignore'), [`/${PLAIN}`, '/config.local.toml'], true);
    if (plainInGit || gitInit) await guardPlainIgnored(root);
  }
  if (files.has(SEALED)) await ensureLines(await checkedPath(root, '.gitattributes'), [`${SEALED} binary`]);
  for (const path of [PLAIN, SEALED]) if (previous.has(path) && !files.has(path)) await rm(join(root, path), { force: true });
  if (files.has(PLAIN)) {
    const directory = join(root, 'credentials');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  for (const [path, bytes] of files) {
    if (previous.get(path)?.equals(bytes) && path !== PLAIN) continue;
    await writeFileAtomic(join(root, path), bytes, path.startsWith('credentials/') ? 0o600 : 0o644);
  }
  for (const path of previous.keys()) if (path !== PLAIN && path !== SEALED && !files.has(path)) await rm(join(root, path), { force: true });
}
