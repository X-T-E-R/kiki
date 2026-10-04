import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

import { appRoot, nativeBinPath, targetTriple } from './paths.mjs';

const execFileAsync = promisify(execFile);
const target = targetTriple();
const sourceExecutable = process.env.KIKI_NATIVE_SMOKE_EXECUTABLE ?? nativeBinPath(target);
const packageJson = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf-8'));
await stat(sourceExecutable);
const scratchRoot = resolve(appRoot, '..', '..', '.tmp');
await mkdir(scratchRoot, { recursive: true });
const smokeRoot = await mkdtemp(resolve(scratchRoot, 'native-smoke-'));
const installation = resolve(smokeRoot, 'installation');
const home = resolve(smokeRoot, 'home');
const cache = resolve(smokeRoot, 'cache');
const temp = resolve(smokeRoot, 'temp');
const executablePath = resolve(installation, basename(sourceExecutable));

function assertIncludes(output, expected, command) {
  if (!output.includes(expected)) {
    throw new Error(`Native smoke output for "${command}" did not include "${expected}".\n${output}`);
  }
}

try {
  for (const dir of [installation, home, cache, temp]) await mkdir(dir, { recursive: true });
  await copyFile(sourceExecutable, executablePath);
  const env = {
    ...process.env,
    NODE_PATH: '', NODE_OPTIONS: '',
    KIKI_HOME: home, KIKI_CACHE_DIR: cache,
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    TMP: temp, TEMP: temp, TMPDIR: temp,
    KIKI_NATIVE_ASSET_SMOKE: '',
  };
  async function runKimi(args, extraEnv = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(executablePath, args, {
        cwd: installation,
        env: { ...env, ...extraEnv },
        timeout: 60_000,
        maxBuffer: 1024 * 1024 * 16,
      });
      return `${stdout}${stderr}`;
    } catch (error) {
      const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message].filter(Boolean).join('\n');
      throw new Error(`Native smoke failed: ${executablePath} ${args.join(' ')}\n${detail}`);
    }
  }

  assertIncludes(await runKimi(['--version']), packageJson.version, '--version');
  assertIncludes(await runKimi(['--help']), 'Usage: kiki', '--help');
  assertIncludes(await runKimi(['export', '--help']), 'Usage: kiki export', 'export --help');
  const output = await runKimi(['--version'], { KIKI_NATIVE_ASSET_SMOKE: '1' });
  assertIncludes(output, `Native asset smoke passed: ${target}`, 'native asset smoke');
  assertIncludes(output, 'MiniDb worker build passed', 'MiniDb worker smoke');
  assertIncludes(output, 'search worker ready', 'search worker smoke');
  assertIncludes(output, 'PTY input/resize/exit/kill passed', 'PTY smoke');
  console.log(output.trim());
} finally {
  await rm(smokeRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

console.log(`Native smoke passed: ${sourceExecutable}`);
