import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const builds = new Map();
const coreRoot = fileURLToPath(new URL('../', import.meta.url));

/** @param {{ target?: string, outputDir?: string, prebuiltPath?: string }} [options] */
export async function buildWindowsProcessHelper({ target = `${process.platform}-${process.arch}`, outputDir = join(coreRoot, 'dist'), prebuiltPath } = {}) {
  if (!target.startsWith('win32-')) return null;
  const root = resolve(outputDir);
  const key = `${root}:${target}:${prebuiltPath ?? ''}`;
  if (builds.has(key)) return builds.get(key);
  const build = (async () => {
    if (!prebuiltPath && process.platform !== 'win32') throw new Error('Building the Windows process helper requires a Windows build host with .NET Framework 4 compiler, or its precompiled Windows release artifact.');
    const source = join(coreRoot, 'src/os/backends/node-local/windowsProcessHelper.cs');
    const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework/v4.0.30319/csc.exe');
    await mkdir(root, { recursive: true });
    const scratch = await mkdtemp(join(root, '.compile-'));
    const temporary = join(scratch, 'windows-process-helper.exe');
    const destination = join(root, 'windows-process-helper.exe');
    try {
      if (prebuiltPath) {
        const bytes = await readFile(prebuiltPath);
        if (bytes.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('Windows process helper artifact is not an executable.');
        await writeFile(temporary, bytes);
      } else {
        await execute(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${temporary}`, source], { timeout: 30_000, windowsHide: true });
      }
      const bytes = await readFile(temporary);
      await rename(temporary, destination);
      return { path: destination, bytes };
    } catch (error) {
      throw new Error(prebuiltPath
        ? `Windows process helper release artifact is missing or invalid: ${prebuiltPath}`
        : 'Could not compile the Windows process helper. Install or enable the .NET Framework 4 build compiler on the Windows build host.', { cause: error });
    } finally { await rm(scratch, { recursive: true, force: true }); }
  })();
  builds.set(key, build);
  void build.catch(() => { builds.delete(key); });
  return build;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildWindowsProcessHelper();
}
