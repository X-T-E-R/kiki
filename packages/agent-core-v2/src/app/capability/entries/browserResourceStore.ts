import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { downloadToFile, type FetchLike } from '#/app/capability/host';
import { extractBinaryZip } from '#/os/backends/node-local/binaryArchive';

export const BROWSER_DRIVER_VERSION = '0.38.2';
const RELEASE = 'https://raw.githubusercontent.com/X-T-E-R/kiki/4c64f17a9dbc5ded7b08157204468995d3931566/';
const DONOR = `${RELEASE}packages/agent-core-v2/src/app/browser/donor/`;
export const BROWSER_DRIVER_FILES: Readonly<Record<string, { url: string; sha256: string }>> = {
  'agent-browser.exe': { url: `${RELEASE}apps/kimi-code/vendor/agent-browser/win32-x64/agent-browser.exe`, sha256: '1a333ab6c97f06a8da7c30a3829bbd4d98888e7c8145954ac2142c0205e78417' },
  LICENSE: { url: `${DONOR}LICENSE`, sha256: '014bb31e83d5c2e76aea1cc6e82217346ab41362f32cb355ad0f5c10aa0aeaff' },
  NOTICE: { url: `${DONOR}NOTICE`, sha256: '452e12a990c82f0f490f28300c1777eb6560c2a963472c544deeaba1c4aa985b' },
  'build.json': { url: `${DONOR}build.json`, sha256: 'cf2cfd3eaa2dda08a7ea166c47b85e0bbbfca43a57fdca5601d6fb99c974b590' },
  'kiki-no-replay-r1.patch': { url: `${DONOR}kiki-no-replay-r1.patch`, sha256: '85c228468161eaa3e49e948ad63e0af8bad00010757be3e80ed5c42d6b1851ca' },
};
export const CHROME_METADATA_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
export type BrowserResourceReporter = (step: string, percent?: number) => void;

export function browserResourcePaths(home: string) {
  const root = join(home, 'browser', 'resources');
  return { root, driverDirectory: join(root, 'driver-0.38.2-r1'), driver: join(root, 'driver-0.38.2-r1', 'agent-browser.exe'), chromeDirectory: join(root, 'chrome'), chrome: join(root, 'chrome', 'chrome-win64', 'chrome.exe') };
}

async function digest(file: string): Promise<string> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Browser resource is not a regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await lstat(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Browser resource changed during verification');
  return hash.digest('hex');
}

export async function verifiedBrowserDriver(file: string): Promise<boolean> {
  return digest(file).then((hash) => hash === BROWSER_DRIVER_FILES['agent-browser.exe']!.sha256, () => false);
}

export async function installedBrowserDriver(home: string): Promise<string | undefined> {
  const paths = browserResourcePaths(home);
  try {
    if ((await lstat(paths.driverDirectory)).isSymbolicLink()) return undefined;
    for (const [name, artifact] of Object.entries(BROWSER_DRIVER_FILES)) {
      if (await digest(join(paths.driverDirectory, name)) !== artifact.sha256) return undefined;
    }
    return paths.driver;
  } catch { return undefined; }
}

export async function installedBrowserChrome(home: string): Promise<{ executable: string; version: string } | undefined> {
  const paths = browserResourcePaths(home);
  try {
    if ((await lstat(paths.chromeDirectory)).isSymbolicLink()) return undefined;
    const record = JSON.parse(await readFile(join(paths.chromeDirectory, 'installed.json'), 'utf8')) as { version: string; files: Record<string, string> };
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(record.version)) return undefined;
    for (const name of ['chrome.exe', 'chrome.dll']) {
      if (await digest(join(paths.chromeDirectory, 'chrome-win64', name)) !== record.files[name]) return undefined;
    }
    return { executable: paths.chrome, version: record.version };
  } catch { return undefined; }
}

function cancellableFetch(fetchImpl: typeof fetch, signal?: AbortSignal): FetchLike {
  return async (url, init) => {
    signal?.throwIfAborted();
    return fetchImpl(url, { ...init, signal: signal === undefined ? init?.signal : init?.signal === undefined ? signal : AbortSignal.any([signal, init.signal]), redirect: 'error' });
  };
}

export async function promoteResourcePath(staged: string, destination: string): Promise<void> {
  const previous = `${destination}.previous-${randomUUID()}`;
  let replaced = false;
  try { await rename(destination, previous); replaced = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { await rename(staged, destination); }
  catch (error) {
    if (replaced) {
      try { await rename(previous, destination); }
      catch (rollback) { throw new AggregateError([error, rollback], `Browser resource replacement failed; previous files remain at ${previous}`); }
    }
    throw error;
  }
  if (replaced) await rm(previous, { recursive: true, force: true });
}

export async function installBrowserDriver(home: string, report: BrowserResourceReporter, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<void> {
  if (await installedBrowserDriver(home) !== undefined) return;
  const paths = browserResourcePaths(home);
  await mkdir(paths.root, { recursive: true });
  const staging = await mkdtemp(join(paths.root, '.driver-install-'));
  try {
    for (const [name, artifact] of Object.entries(BROWSER_DRIVER_FILES)) {
      signal?.throwIfAborted();
      report('driver-download', 0);
      await downloadToFile(artifact.url, join(staging, name), (percent) => report('driver-download', percent), cancellableFetch(fetchImpl, signal), { sha256: artifact.sha256, maxBytes: 32 * 1024 * 1024 });
    }
    signal?.throwIfAborted();
    report('verify');
    await promoteResourcePath(staging, paths.driverDirectory);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function downloadAndInstallChrome(home: string, report: BrowserResourceReporter, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<void> {
  const paths = browserResourcePaths(home);
  await mkdir(paths.root, { recursive: true });
  const staging = await mkdtemp(join(paths.root, '.chrome-install-'));
  try {
    report('chrome-metadata');
    const response = await fetchImpl(CHROME_METADATA_URL, { signal: signal === undefined ? AbortSignal.timeout(30_000) : AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error' });
    if (!response.ok) throw new Error(`Chrome version lookup failed: HTTP ${response.status}`);
    if (response.body === null) throw new Error('Chrome version response has no body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 1024 * 1024) throw new Error('Chrome metadata exceeds the size limit');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { channels?: { Stable?: { version?: string; downloads?: { chrome?: { platform: string; url: string }[] } } } };
    const stable = metadata.channels?.Stable;
    const version = stable?.version;
    const url = stable?.downloads?.chrome?.find((entry) => entry.platform === 'win64')?.url;
    if (version === undefined || !/^\d+\.\d+\.\d+\.\d+$/.test(version) || url !== `https://storage.googleapis.com/chrome-for-testing-public/${version}/win64/chrome-win64.zip`) throw new Error('Chrome metadata did not identify an approved Windows download');
    const archive = join(staging, 'chrome.zip');
    report('chrome-download', 0);
    await downloadToFile(url, archive, (percent) => report('chrome-download', percent), cancellableFetch(fetchImpl, signal), { maxBytes: 512 * 1024 * 1024 });
    signal?.throwIfAborted();
    report('extract');
    const extracted = join(staging, 'extracted');
    await mkdir(extracted);
    await extractBinaryZip(archive, extracted);
    signal?.throwIfAborted();
    report('verify');
    const files = Object.fromEntries(await Promise.all(['chrome.exe', 'chrome.dll'].map(async (name) => [name, await digest(join(extracted, 'chrome-win64', name))])));
    await writeFile(join(extracted, 'installed.json'), JSON.stringify({ version, files }));
    signal?.throwIfAborted();
    await promoteResourcePath(extracted, paths.chromeDirectory);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function installBrowserChrome(home: string, report: BrowserResourceReporter, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<void> {
  if (await installedBrowserChrome(home) !== undefined) return;
  await downloadAndInstallChrome(home, report, fetchImpl, signal);
}

export async function updateBrowserChrome(home: string, report: BrowserResourceReporter, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<void> {
  await downloadAndInstallChrome(home, report, fetchImpl, signal);
}

export const CODEX_BRIDGE_DIRECTORY = 'codex-browser-bridge-1.11.1-kiki-no-resend-r1';
export const CODEX_BRIDGE_VENDOR_DIR = 'apps/kimi-code/vendor/codex-browser-bridge/win32-x64';
export const CODEX_BRIDGE_RELEASE_COMMIT = '0d160973e1421f34f3e50f16f690f22163b69352';
export const CODEX_BRIDGE_FILE_NAMES = ['codex-browser-bridge.exe', 'LICENSE', 'build.json', 'kiki-no-resend-r1.patch'] as const;
export const CODEX_BRIDGE_FILE_SHA256: Readonly<Record<(typeof CODEX_BRIDGE_FILE_NAMES)[number], string>> = {
  'codex-browser-bridge.exe': '677e62598e86e973419119811ca323ef85b6df46d593e8609d807d9b1695c87c',
  LICENSE: 'a7e4df5a67f584d81676d54851b6b2165f3861655ab494f89d933799846b2e6e',
  'build.json': '97255556a6e369c1ed5278f51b4ee807c1d5968e34d2a6f6f6421b5ad0fbbe61',
  'kiki-no-resend-r1.patch': 'f406329d24d9b670fc1e7c2c3fdc0d897cf4bb440f08f9df7dbeb70c15440d27',
};

export function codexBridgeResourcePaths(home: string) {
  const root = join(home, 'browser', 'resources');
  const directory = join(root, CODEX_BRIDGE_DIRECTORY);
  return { root, directory, binary: join(directory, 'codex-browser-bridge.exe') };
}

export function codexBridgeReleaseUrl(commit: string, name: string): string {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('codex-browser-bridge release commit is not public');
  return `https://raw.githubusercontent.com/X-T-E-R/kiki/${commit}/${CODEX_BRIDGE_VENDOR_DIR}/${name}`;
}

export async function codexBridgeInstallState(home: string): Promise<'installed' | 'missing' | 'mismatch'> {
  const paths = codexBridgeResourcePaths(home);
  let directory;
  try { directory = await lstat(paths.directory); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'mismatch'; }
  if (!directory.isDirectory() || directory.isSymbolicLink()) return 'mismatch';
  try {
    for (const name of CODEX_BRIDGE_FILE_NAMES) {
      if (await digest(join(paths.directory, name)) !== CODEX_BRIDGE_FILE_SHA256[name]) return 'mismatch';
    }
    return 'installed';
  } catch { return 'mismatch'; }
}

export async function installedCodexBridge(home: string): Promise<string | undefined> {
  const paths = codexBridgeResourcePaths(home);
  return await codexBridgeInstallState(home) === 'installed' ? paths.binary : undefined;
}

export async function installCodexBridge(home: string, report: BrowserResourceReporter, fetchImpl: typeof fetch = fetch, signal?: AbortSignal, releaseCommit: string | undefined = CODEX_BRIDGE_RELEASE_COMMIT): Promise<void> {
  if (await installedCodexBridge(home) !== undefined) return;
  if (releaseCommit === undefined || !/^[0-9a-f]{40}$/.test(releaseCommit)) {
    throw new Error('The pinned codex-browser-bridge release is not public. Prepare does not download it.');
  }
  const paths = codexBridgeResourcePaths(home);
  await mkdir(paths.root, { recursive: true });
  const staging = await mkdtemp(join(paths.root, '.codex-bridge-install-'));
  try {
    for (const name of CODEX_BRIDGE_FILE_NAMES) {
      signal?.throwIfAborted();
      report('codex-bridge-download', 0);
      await downloadToFile(codexBridgeReleaseUrl(releaseCommit, name), join(staging, name), (percent) => report('codex-bridge-download', percent), cancellableFetch(fetchImpl, signal), { sha256: CODEX_BRIDGE_FILE_SHA256[name], maxBytes: 32 * 1024 * 1024 });
    }
    signal?.throwIfAborted();
    report('verify');
    await promoteResourcePath(staging, paths.directory);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
