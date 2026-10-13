import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODEX_BRIDGE_FILE_NAMES,
  CODEX_BRIDGE_FILE_SHA256,
  CODEX_BRIDGE_RELEASE_COMMIT,
  codexBridgeInstallState,
  codexBridgeReleaseUrl,
  codexBridgeResourcePaths,
  installCodexBridge,
  installedCodexBridge,
} from '#/app/capability/entries/browserResourceStore';

const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const vendor = join(repo, 'apps/kimi-code/vendor/codex-browser-bridge/win32-x64');
const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });

async function homeDir(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-codex-bridge-'));
  homes.push(home);
  return home;
}

function fetchRelease(commit: string, fail = false): typeof fetch {
  return (async (input: string | URL | Request) => {
    if (fail) return new Response(null, { status: 503 });
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const name = CODEX_BRIDGE_FILE_NAMES.find((entry) => url === codexBridgeReleaseUrl(commit, entry));
    if (name === undefined) throw new Error(`Unexpected Codex release URL: ${url}`);
    const bytes = await readFile(join(vendor, name));
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  }) as typeof fetch;
}

describe('codex bridge release bytes', () => {
  it('treats the vendored files as the pinned release and a changed binary as a mismatch', async () => {
    const home = await homeDir();
    expect(await codexBridgeInstallState(home)).toBe('missing');
    const paths = codexBridgeResourcePaths(home);
    const { cp, mkdir } = await import('node:fs/promises');
    await mkdir(paths.directory, { recursive: true });
    for (const name of CODEX_BRIDGE_FILE_NAMES) await cp(join(vendor, name), join(paths.directory, name));
    expect(await installedCodexBridge(home)).toBe(paths.binary);
    await writeFile(paths.binary, 'damaged');
    expect(await codexBridgeInstallState(home)).toBe('mismatch');
    expect(CODEX_BRIDGE_FILE_SHA256['codex-browser-bridge.exe']).toBe('677e62598e86e973419119811ca323ef85b6df46d593e8609d807d9b1695c87c');
  });

  it('downloads the pinned bytes and leaves the previous file in place when the download fails', async () => {
    const home = await homeDir();
    const commit = 'a'.repeat(40);
    const report = vi.fn();
    await installCodexBridge(home, report, fetchRelease(commit), undefined, commit);
    const binary = codexBridgeResourcePaths(home).binary;
    expect(await installedCodexBridge(home)).toBe(binary);
    expect(report).toHaveBeenCalledWith('verify');
    const previous = await readFile(binary);
    await writeFile(binary, 'damaged');
    await expect(installCodexBridge(home, () => {}, fetchRelease(commit, true), undefined, commit)).rejects.toThrow(/HTTP 503/);
    expect(await readFile(binary, 'utf8')).toBe('damaged');
    await installCodexBridge(home, () => {}, fetchRelease(commit), undefined, commit);
    expect(await readFile(binary)).toEqual(previous);
    expect(await installedCodexBridge(home)).toBe(binary);
  }, 30_000);

  it('installs the vendor bytes from the pinned public commit URL', async () => {
    const home = await homeDir();
    const commit = CODEX_BRIDGE_RELEASE_COMMIT;
    expect(codexBridgeReleaseUrl(commit, 'codex-browser-bridge.exe')).toBe(
      `https://raw.githubusercontent.com/X-T-E-R/kiki/${commit}/apps/kimi-code/vendor/codex-browser-bridge/win32-x64/codex-browser-bridge.exe`,
    );
    expect(() => codexBridgeReleaseUrl('short', 'codex-browser-bridge.exe')).toThrow(/not public/);
    await installCodexBridge(home, () => {}, fetchRelease(commit));
    expect(await installedCodexBridge(home)).toBe(codexBridgeResourcePaths(home).binary);
  }, 30_000);
});
