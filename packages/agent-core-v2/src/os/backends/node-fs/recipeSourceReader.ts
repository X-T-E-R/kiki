import { readFile, realpath, stat, mkdir, lstat, writeFile } from 'node:fs/promises';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { hookExecution, validateHookResources } from '#/app/recipes/recipeHooks';
import type { RecipeScriptHook, RecipeSource } from '@kiki/protocol';
import type { HookDef } from '#/features/externalHooks/internal/types';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertUrlIsSafeToFetch, guardedFetch } from 'guarded-fetch';
import { fromBuffer } from 'yauzl';
import { IRecipeSourceReader, type RecipePackageReader } from '#/app/recipes/recipes';
import { recipeDigest, recipeFailure, validateRecipePath } from '#/app/recipes/recipePrimitives';
import { resolveInstallSource } from '#/app/plugin/source';
import { resolveGithubCommitSha, resolveGithubSource } from '#/app/plugin/github-resolver';
import { LifecycleScope } from '#/app/scopes';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
export class RecipeSourceReader implements IRecipeSourceReader {
  declare readonly _serviceBrand: undefined;
  constructor(@IBootstrapService private readonly bootstrap?: IBootstrapService) {}
  private materializing: Promise<unknown> = Promise.resolve();
  materializeHooks(hooks: readonly RecipeScriptHook[]): Promise<readonly HookDef[]> {
    const result = this.materializing.then(() => this.materialize(hooks));
    this.materializing = result.catch(() => undefined);
    return result;
  }
  private async materialize(hooks: readonly RecipeScriptHook[]): Promise<readonly HookDef[]> {
    if (this.bootstrap === undefined) recipeFailure('Recipe hook resource host is unavailable');
    const cache = path.join(this.bootstrap.homeDir, 'cache', 'recipe-hooks');
    await mkdir(cache, { recursive: true });
    if ((await lstat(cache)).isSymbolicLink()) recipeFailure('Recipe hook cache must not be a symbolic link');
    const root = await realpath(cache);
    const result: HookDef[] = [];
    for (const hook of hooks) {
      validateHookResources(hook);
      const directory = path.join(root, recipeDigest(hookExecution(hook)).slice(7));
      await mkdir(directory, { recursive: true });
      if ((await lstat(directory)).isSymbolicLink()) recipeFailure('Recipe hook resource directory is unsafe');
      for (const [file, text] of Object.entries(hook.files)) {
        let parent = directory;
        for (const segment of file.split('/').slice(0, -1)) {
          parent = path.join(parent, segment); await mkdir(parent, { recursive: true });
          if ((await lstat(parent)).isSymbolicLink()) recipeFailure('Recipe hook resource path is unsafe', hook.source, file);
        }
        const target = path.join(directory, file);
        try { await writeFile(target, text, { flag: 'wx', encoding: 'utf8' }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        if ((await lstat(target)).isSymbolicLink() || decode(await readFile(target)) !== text) recipeFailure('Frozen Recipe hook resource is corrupt', hook.source, file);
      }
      result.push({ event: hook.event as HookDef['event'], command: hook.command, matcher: hook.matcher, timeout: hook.timeout,
        cwd: directory, env: { KIKI_RECIPE_ROOT: directory } });
    }
    return result;
  }
  async catalog(url: string): Promise<unknown> { return JSON.parse((await download(url)).toString('utf8')); }
  async open(source: RecipeSource): Promise<RecipePackageReader> {
    if (/^https?:/u.test(source.locator)) await publicUrl(source.locator);
    const parsed = resolveInstallSource(source.locator);
    if (parsed.kind === 'local-path') {
      const input = await realpath(parsed.path);
      const root = (await stat(input)).isDirectory() ? input : path.dirname(input);
      const manifest = (await stat(input)).isDirectory() ? 'recipe.toml' : path.basename(input);
      let bytes = 0;
      return { source: { ...source, locator: path.join(root, manifest).replaceAll('\\', '/') }, read: async (file) => {
        validateRecipePath(file);
        const target = await realpath(path.join(root, file === 'recipe.toml' ? manifest : file));
        if (!target.startsWith(root + path.sep)) recipeFailure('Recipe file escapes package root', source.locator, file);
        const size = (await stat(target)).size;
        if (size > MAX_FILE_BYTES || bytes + size > MAX_BYTES) recipeFailure('Recipe exceeds text budget', source.locator, file);
        bytes += size;
        return decode(await readFile(target));
      } };
    }
    if (parsed.kind === 'github') {
      const resolution = await resolveGithubSource(parsed);
      const sha = await resolveGithubCommitSha(parsed.owner, parsed.repo, resolution.ref.value);
      const buffer = await download(`https://codeload.github.com/${parsed.owner}/${parsed.repo}/zip/${sha}`);
      return zipReader(source, buffer);
    }
    const url = packageUrl(source.locator);
    if (url.pathname.endsWith('.toml')) {
      const base = new URL('.', url); let bytes = 0;
      return { source: { ...source, locator: url.href }, read: async (file) => {
        validateRecipePath(file);
        const target = new URL(file === 'recipe.toml' ? url.href : file.split('/').map(encodeURIComponent).join('/'), base);
        if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) recipeFailure('Recipe file escapes remote package', source.locator, file);
        const value = await download(target.href, { origin: base.origin, prefix: base.pathname });
        bytes += value.length;
        if (value.length > MAX_FILE_BYTES || bytes > MAX_BYTES) recipeFailure('Recipe exceeds text budget', source.locator, file);
        return decode(value);
      } };
    }
    if (source.sha256 === undefined) recipeFailure('Recipe ZIP requires SHA-256', source.locator);
    const buffer = await download(url.href);
    if (createHash('sha256').update(buffer).digest('hex') !== source.sha256) recipeFailure('Recipe ZIP checksum mismatch', source.locator);
    return zipReader(source, buffer);
  }
}
function decode(bytes: Uint8Array): string { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function packageUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') recipeFailure('Recipe sources require credential-free HTTPS', `${url.origin}${url.pathname}`);
  return url;
}
async function publicUrl(raw: string): Promise<URL> {
  const url = packageUrl(raw);
  try { return (await assertUrlIsSafeToFetch(url, { httpsOnly: true })).url; }
  catch (cause) { throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Recipe source must use a public address', { cause, details: { source: raw } }); }
}
async function download(raw: string, boundary?: { origin: string; prefix: string }): Promise<Buffer> {
  const signal = AbortSignal.timeout(15_000);
  try {
    const response = await guardedFetch(packageUrl(raw), { httpsOnly: true, timeoutMs: 15_000, maxRedirects: 5, signal,
      fetch: (input, init) => {
        const url = packageUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (boundary !== undefined && (url.origin !== boundary.origin || !url.pathname.startsWith(boundary.prefix))) recipeFailure('Recipe redirect escapes package', raw);
        return globalThis.fetch(input, init);
      },
    });
    if (!response.ok) { await response.body?.cancel(); recipeFailure(`Recipe download failed: HTTP ${response.status}`, raw); }
    if (response.body === null) return Buffer.alloc(0);
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read(); signal.throwIfAborted();
        if (chunk.done) return Buffer.concat(chunks, bytes);
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) recipeFailure('Recipe download exceeds budget', raw);
        chunks.push(chunk.value);
      }
    } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  } catch (cause) {
    if (cause instanceof Error2) throw cause;
    if (cause instanceof Error && cause.cause instanceof Error2) throw cause.cause;
    throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Recipe source could not be read', { cause, details: { source: raw } });
  }
}
async function zipReader(source: RecipeSource, buffer: Buffer): Promise<RecipePackageReader> {
  const files: Record<string, Buffer> = {}; let total = 0; let count = 0;
  await new Promise<void>((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error !== null || zip === undefined) { reject(error); return; }
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', (entry) => {
        try {
          const name = entry.fileName;
          validateRecipePath(name.endsWith('/') ? name.slice(0, -1) : name);
          count++; total += entry.uncompressedSize;
          if (count > 256 || total > MAX_BYTES || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) recipeFailure('Unsafe or oversized Recipe archive', source.locator, name);
          if (name.endsWith('/')) { zip.readEntry(); return; }
          if (files[name] !== undefined) recipeFailure('Invalid Recipe archive entry', source.locator, name);
          zip.openReadStream(entry, (error, stream) => {
            if (error !== null || stream === undefined) { reject(error); zip.close(); return; }
            const chunks: Buffer[] = []; let size = 0;
            stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BYTES) { stream.destroy(); reject(new Error('Recipe file exceeds budget')); zip.close(); } else chunks.push(chunk); });
            stream.on('error', reject); stream.on('end', () => { files[name] = Buffer.concat(chunks); zip.readEntry(); });
          });
        } catch (error) { reject(error); zip.close(); }
      }); zip.readEntry();
    });
  });
  const manifests = Object.keys(files).filter((file) => file === 'recipe.toml' || /^[^/]+\/recipe\.toml$/u.test(file));
  if (manifests.length !== 1) recipeFailure('Recipe archive must contain one package root', source.locator);
  const manifest = manifests[0]!; const prefix = manifest.slice(0, -'recipe.toml'.length);
  return { source, read: async (file) => {
    const value = files[prefix + validateRecipePath(file)];
    if (value === undefined) recipeFailure('Recipe referenced file is missing', source.locator, file);
    if (value.byteLength > MAX_FILE_BYTES) recipeFailure('Recipe exceeds text budget', source.locator, file);
    return decode(value);
  } };
}
registerScopedService(LifecycleScope.App, IRecipeSourceReader, RecipeSourceReader, ScopeActivation.OnDemand, 'recipes');
