import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKikiBrowserEntry } from '#/app/capability/entries/kikiBrowser';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { BROWSER_DRIVER_FILES, CHROME_METADATA_URL, browserResourcePaths, installedBrowserChrome, installedBrowserDriver, installBrowserChrome, installBrowserDriver } from '#/app/capability/entries/browserResourceStore';
import type { CapabilityEntryContext } from '#/app/capability/entries/context';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import type { IHostProcessService } from '#/os/interface/hostProcess';

const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const driverSource = join(repo, 'apps/kimi-code/vendor/agent-browser/win32-x64/agent-browser.exe');
const donor = join(repo, 'packages/agent-core-v2/src/app/browser/donor');
const version = '123.4.5.6';
const chromeUrl = `https://storage.googleapis.com/chrome-for-testing-public/${version}/win64/chrome-win64.zip`;
async function archive(files: Record<string, string>) {
  const zip = new ZipFile();
  for (const [name, bytes] of Object.entries(files)) zip.addBuffer(Buffer.from(bytes), name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('browser components in isolated Kiki home', () => {
  let home: string;
  let server: Server;
  let base: string;
  let chromeBytes: Buffer;
  let fail = false;
  let stall = false;
  let onRequest: (() => void) | undefined;
  let probeOutput: string;
  const spawnProbe = vi.fn<IHostProcessService['spawn']>();
  const probeHost: IHostProcessService = { _serviceBrand: undefined, spawn: spawnProbe };
  beforeEach(async () => {
    probeOutput = 'agent-browser 0.38.2 kiki-no-replay-r1 kiki-stdio-r1';
    spawnProbe.mockReset().mockImplementation(async () => ({
      _serviceBrand: undefined, pid: 1, exitCode: 0, stdin: new PassThrough(),
      stdout: Readable.from([probeOutput]), stderr: Readable.from([]),
      wait: async () => 0, kill: async () => undefined, dispose: () => undefined,
    }));
    await mkdir(join(repo, '.tmp'), { recursive: true });
    home = await mkdtemp(join(repo, '.tmp', 'browser-install-'));
    chromeBytes = await archive({ 'chrome-win64/chrome.exe': 'synthetic Chrome executable', 'chrome-win64/chrome.dll': 'synthetic Chrome library' });
    fail = false;
    stall = false;
    onRequest = undefined;
    server = createServer((request, response) => {
      Promise.resolve().then(async () => {
        if (fail) { response.writeHead(503); response.end('temporary failure'); return; }
        if (stall) { onRequest?.(); return; }
        const key = decodeURIComponent((request.url ?? '/').slice(1));
        if (key === 'metadata') { response.end(JSON.stringify({ channels: { Stable: { version, downloads: { chrome: [{ platform: 'win64', url: chromeUrl }] } } } })); return; }
        const bytes = key === 'chrome.zip' ? chromeBytes : await readFile(key === 'agent-browser.exe' ? driverSource : join(donor, key));
        response.setHeader('content-length', bytes.length);
        response.end(bytes);
      }).catch(onUnexpectedError);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Fixture has no port');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const fetchSource: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const file = url === CHROME_METADATA_URL ? 'metadata' : url === chromeUrl ? 'chrome.zip' : Object.entries(BROWSER_DRIVER_FILES).find(([, artifact]) => artifact.url === url)?.[0];
    if (file === undefined) throw new Error(`Unexpected install URL: ${url}`);
    return fetch(`${base}/${encodeURIComponent(file)}`, init);
  };
  function ctx(hostProcess: IHostProcessService = probeHost): CapabilityEntryContext {
    return { platform: 'win32', arch: 'x64', kimiHomeDir: home, userHomeDir: home,
      plugins: undefined as never, hostProcess, fetchImpl: fetchSource };
  }

  it('recovers a genuinely missing driver using pinned bytes and notices with a portable version probe', async () => {
    const entry = createKikiBrowserEntry(ctx());
    expect((await entry.detect()).steps.map((step) => step.state)).toEqual(['missing', 'missing']);
    const report = vi.fn();
    await entry.install(report, undefined, 'driver-only');
    expect(await installedBrowserDriver(home)).toBe(browserResourcePaths(home).driver);
    expect((await entry.detect()).steps.map((step) => step.state)).toEqual(['ok', 'missing']);
    expect(report).toHaveBeenCalledWith('driver-download', 100);
    expect(await readdir(browserResourcePaths(home).driverDirectory)).toEqual(expect.arrayContaining(Object.keys(BROWSER_DRIVER_FILES)));
    expect(await installedBrowserChrome(home)).toBeUndefined();
    expect((await entry.detect()).version).toBe('0.38.2');
    expect(spawnProbe).toHaveBeenCalledWith(browserResourcePaths(home).driver, ['--version'], { windowsHide: true });
  }, 30_000);

  it('does not accept a version probe without both fixed driver markers', async () => {
    const entry = createKikiBrowserEntry(ctx(), driverSource);
    probeOutput = 'agent-browser 0.38.2';
    expect(await entry.detect()).toMatchObject({ version: undefined, steps: [{ id: 'driver', state: 'missing' }, { id: 'chrome', state: 'missing' }] });
    spawnProbe.mockRejectedValueOnce(new Error('fixture host cannot execute this binary'));
    expect((await entry.detect()).steps[0]?.state).toBe('missing');
  });

  it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('executes the installed pinned Windows driver and verifies its real version markers', async () => {
    await installBrowserDriver(home, () => {}, fetchSource);
    const entry = createKikiBrowserEntry(ctx(new HostProcessService()));
    expect(await entry.detect()).toMatchObject({ version: '0.38.2', steps: [{ id: 'driver', state: 'ok' }, { id: 'chrome', state: 'missing' }] });
    expect(spawnProbe).not.toHaveBeenCalled();
  }, 30_000);

  it('downloads/extracts synthetic Chrome, reports progress and detects later executable corruption', async () => {
    const report = vi.fn();
    await installBrowserChrome(home, report, fetchSource);
    expect(await installedBrowserChrome(home)).toEqual({ executable: browserResourcePaths(home).chrome, version });
    expect(report).toHaveBeenCalledWith('chrome-download', 100);
    expect(report).toHaveBeenCalledWith('extract');
    await writeFile(browserResourcePaths(home).chrome, 'tampered');
    expect(await installedBrowserChrome(home)).toBeUndefined();
    await installBrowserChrome(home, report, fetchSource);
    expect(await installedBrowserChrome(home)).toEqual({ executable: browserResourcePaths(home).chrome, version });
    expect(await readdir(browserResourcePaths(home).root)).toEqual(['chrome']);
  });

  it('repairs corrupted managed driver files while preserving them when the replacement download fails', async () => {
    const entry = createKikiBrowserEntry(ctx());
    await entry.install(() => {}, undefined, 'driver-only');
    await writeFile(browserResourcePaths(home).driver, 'damaged driver');
    expect(await installedBrowserDriver(home)).toBeUndefined();
    fail = true;
    await expect(entry.install(() => {}, undefined, 'driver-only')).rejects.toThrow('HTTP 503');
    expect(await readFile(browserResourcePaths(home).driver, 'utf8')).toBe('damaged driver');
    fail = false;
    await entry.install(() => {}, undefined, 'driver-only');
    expect((await entry.detect()).steps.map((step) => step.state)).toEqual(['ok', 'missing']);
    expect(await readdir(browserResourcePaths(home).root)).toEqual(['driver-0.38.2-r1']);
  }, 30_000);

  it('cleans failed stages and succeeds on an explicit retry without losing the completed driver', async () => {
    await installBrowserDriver(home, () => {}, fetchSource);
    fail = true;
    await expect(installBrowserChrome(home, () => {}, fetchSource)).rejects.toThrow('HTTP 503');
    expect(await readdir(browserResourcePaths(home).root)).toEqual(['driver-0.38.2-r1']);
    expect(await installedBrowserDriver(home)).toBeDefined();
    fail = false;
    await installBrowserChrome(home, () => {}, fetchSource);
    expect(await installedBrowserChrome(home)).toBeDefined();
  }, 30_000);

  it('cancels a pending HTTP install and permits retry after staging cleanup', async () => {
    stall = true;
    const controller = new AbortController();
    const started = new Promise<void>((done) => { onRequest = done; });
    const pending = installBrowserDriver(home, () => {}, fetchSource, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await started;
    controller.abort();
    await rejected;
    expect(await readdir(browserResourcePaths(home).root)).toEqual([]);
    stall = false;
    await installBrowserDriver(home, () => {}, fetchSource);
    expect(await installedBrowserDriver(home)).toBeDefined();
  }, 30_000);

  it('rejects unapproved Chrome origins and unsafe ZIPs before promotion', async () => {
    const badMetadata: typeof fetch = async () => new Response(JSON.stringify({ channels: { Stable: { version, downloads: { chrome: [{ platform: 'win64', url: 'https://example.test/other.zip' }] } } } }));
    await expect(installBrowserChrome(home, () => {}, badMetadata)).rejects.toThrow('approved Windows download');
    chromeBytes = await archive({ 'chrome-win64/other.txt': 'not a browser' });
    await expect(installBrowserChrome(home, () => {}, fetchSource)).rejects.toThrow();
    expect(await installedBrowserChrome(home)).toBeUndefined();
    expect(await readdir(browserResourcePaths(home).root)).toEqual([]);
  });

  it('reuses the bundled real driver without downloading it and rejects other platforms for automatic setup', async () => {
    const source = vi.fn(fetchSource);
    const entry = createKikiBrowserEntry({ ...ctx(), fetchImpl: source }, driverSource);
    await entry.install(() => {}, undefined, 'driver-only');
    expect(source).not.toHaveBeenCalled();
    expect(createKikiBrowserEntry({ ...ctx(), platform: 'linux' }).supported).toBe(false);
  });
});
