import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CapabilityService } from '#/app/capability/capabilityService';
import { createKimiWebbridgeEntry } from '#/app/capability/entries/kimiWebbridge';
import type { CapabilityEntryContext } from '#/app/capability/entries/context';
import { webbridgeArtifact } from '#/app/capability/verifiedArtifacts';
import type { IPluginService } from '#/app/plugin/plugin';
import type { IHostProcessService } from '#/os/interface/hostProcess';

import { stubLog } from '../../_base/log/stubs';

const statusUrl = 'http://127.0.0.1:10086/status';
const bytes = new TextEncoder().encode('verified fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');

function fixture(root: string, options: { status?: object; binary?: Uint8Array; plugin?: boolean; baseUrl?: string;
  onDownload?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const hostProcess = {
    spawn: (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      return Promise.resolve({
        stdout: Readable.from(['']), stderr: Readable.from(['']),
        stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        wait: () => Promise.resolve(0), dispose: () => undefined,
      });
    },
  } as unknown as IHostProcessService;
  const plugins = {
    listPlugins: vi.fn(async () => options.plugin ? [{
      id: 'kimi-webbridge', enabled: true, state: 'ok', version: 'v2.0.22',
      originalSource: 'https://code.kimi.com/kimi-code/plugins/official/kimi-webbridge.zip',
      enabledMcpServerCount: 0, mcpServerCount: 0,
    }] : []),
    installPlugin: vi.fn(), setPluginEnabled: vi.fn(),
  } as unknown as IPluginService;
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url) === statusUrl) {
      if (options.status === undefined) throw new Error('not running');
      return new Response(JSON.stringify(options.status));
    }
    if (String(url) === 'https://cdn.kimi.com/webbridge/fixture/releases/kimi-webbridge-darwin-arm64') {
      expect(init?.redirect).toBe('manual');
      await options.onDownload?.();
      return new Response(options.binary ?? bytes);
    }
    throw new Error(`Unexpected network access ${String(url)}`);
  }) as unknown as typeof fetch;
  const context: CapabilityEntryContext = {
    platform: 'darwin', arch: 'arm64', kimiHomeDir: path.join(root, 'kiki'),
    userHomeDir: path.join(root, 'user'), plugins, hostProcess, fetchImpl,
    webbridgeBaseUrl: options.baseUrl,
    webbridgeArtifact: {
      version: 'fixture',
      url: 'https://cdn.kimi.com/webbridge/fixture/releases/kimi-webbridge-darwin-arm64',
      sha256, metadataUrl: 'https://cdn.kimi.com/webbridge/fixture/version.json', maxBytes: 1024,
    },
  };
  return { entry: createKimiWebbridgeEntry(context), fetchImpl, plugins, calls, context };
}

describe('WebBridge pinned supply chain and readiness', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'webbridge-safe-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('selects only platform-appropriate fixed assets and publisher digests', () => {
    expect(webbridgeArtifact('win32', 'x64')?.url).toBe('https://cdn.kimi.com/webbridge/v2.0.22/releases/kimi-webbridge-windows-amd64.exe');
    expect(webbridgeArtifact('win32', 'arm64')).toBeUndefined();
    expect(webbridgeArtifact('darwin', 'x64')?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(webbridgeArtifact('linux', 'arm64')?.version).toBe('v2.0.22');
  });

  it('marks observed daemon, extension and enabled plugin ready without claiming their identities are authenticated', async () => {
    const { entry, calls } = fixture(root, { status: { running: true, version: 'v2.0.22', extension_connected: true }, plugin: true });
    const service = new CapabilityService(undefined as never, undefined as never, undefined as never,
      stubLog(), undefined as never, [entry]);
    const status = await service.getCapability('kimi-webbridge');
    expect(status.state).toBe('ready');
    expect(status.steps.filter((step) => !step.optional).map((step) => [step.id, step.state]))
      .toEqual([['daemon', 'ok'], ['skill', 'ok'], ['extension', 'ok']]);
    expect(status.steps.find((step) => step.id === 'daemon-binary'))
      .toMatchObject({ state: 'missing', optional: true });
    expect(status.steps.find((step) => step.id === 'daemon-identity'))
      .toMatchObject({ state: 'missing', optional: true, detail: expect.stringContaining('cannot authenticate') });
    expect(status.steps.find((step) => step.id === 'plugin-integrity'))
      .toMatchObject({ state: 'missing', optional: true, detail: expect.stringContaining('ZIP integrity') });
    expect(calls).toEqual([]);
  });

  it('reports pinned binary integrity without treating a matching file as authenticated daemon identity', async () => {
    const destination = path.join(root, 'user', '.kimi-webbridge', 'bin', 'kimi-webbridge');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    await chmod(destination, 0o755);
    const { entry } = fixture(root, { status: { running: true, version: 'fixture', extension_connected: true }, plugin: true });
    const status = await entry.detect();
    expect(status.steps.find((step) => step.id === 'daemon-binary')).toMatchObject({ state: 'ok', optional: true });
    expect(status.steps.find((step) => step.id === 'daemon')?.state).toBe('ok');
    expect(status.steps.find((step) => step.id === 'extension')?.state).toBe('ok');
    expect(status.steps.find((step) => step.id === 'daemon-identity')?.state).toBe('missing');
  });

  it('does not confuse independent plugin and daemon version strings with compatibility evidence', async () => {
    const { entry, plugins } = fixture(root, { status: { running: true, version: 'v2.0.22', extension_connected: true }, plugin: true });
    plugins.listPlugins = vi.fn(async () => [{ id: 'kimi-webbridge', enabled: true, state: 'ok',
      version: '1.11.3', originalSource: 'https://code.kimi.com/kimi-code/plugins/official/kimi-webbridge.zip',
      enabledMcpServerCount: 0, mcpServerCount: 0 }]) as never;
    const status = await entry.detect();
    expect(status.steps.find((step) => step.id === 'skill')?.state).toBe('ok');
    expect(status.steps.find((step) => step.id === 'plugin-integrity'))
      .toMatchObject({ state: 'missing', optional: true, detail: expect.stringContaining('compatibility') });
  });

  it.each([
    { status: { running: false, version: 'v2.0.22', extension_connected: true }, expected: 'daemon' },
    { status: { running: true, version: 'v2.0.22', extension_connected: false }, expected: 'extension' },
  ])('leaves a $expected functional layer missing', async ({ status: daemonStatus, expected }) => {
    const { entry } = fixture(root, { status: daemonStatus, plugin: true });
    const service = new CapabilityService(undefined as never, undefined as never, undefined as never,
      stubLog(), undefined as never, [entry]);
    const status = await service.getCapability('kimi-webbridge');
    expect(status.state).not.toBe('ready');
    expect(status.steps.find((step) => step.id === expected)?.state).toBe('missing');
  });

  it.each([
    { enabled: false, state: 'ok', enabledMcpServerCount: 1, mcpServerCount: 1 },
    { enabled: true, state: 'error', enabledMcpServerCount: 1, mcpServerCount: 1 },
    { enabled: true, state: 'ok', enabledMcpServerCount: 0, mcpServerCount: 1 },
    { enabled: true, state: 'ok', hasErrors: true, enabledMcpServerCount: 1, mcpServerCount: 1 },
  ])('does not treat an unavailable plugin as functional: %o', async (pluginState) => {
    const { entry, plugins } = fixture(root, { status: { running: true, version: 'v2.0.22', extension_connected: true } });
    plugins.listPlugins = vi.fn(async () => [{ id: 'kimi-webbridge', ...pluginState }]) as never;
    const service = new CapabilityService(undefined as never, undefined as never, undefined as never,
      stubLog(), undefined as never, [entry]);
    const status = await service.getCapability('kimi-webbridge');
    expect(status.state).toBe('partial');
    expect(status.steps.find((step) => step.id === 'skill')?.state).toBe('missing');
  });

  it('reports an already present binary as unverified when its bytes differ from the pinned release', async () => {
    const destination = path.join(root, 'user', '.kimi-webbridge', 'bin', 'kimi-webbridge');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'untrusted');
    await chmod(destination, 0o755);
    const { entry } = fixture(root, { status: { running: true, version: 'fixture', extension_connected: true }, plugin: true });
    expect((await entry.detect()).steps.find((step) => step.id === 'daemon-binary'))
      .toMatchObject({ state: 'missing', detail: expect.stringContaining('does not match') });
  });

  it('blocks a forged status redirect, credentials and nonloopback target', async () => {
    const { entry, fetchImpl } = fixture(root, { baseUrl: 'http://127.0.0.1:10086@metadata.google.internal:10086' });
    await entry.detect();
    expect(fetchImpl).not.toHaveBeenCalledWith(statusUrl, expect.anything());
    expect((await entry.detect()).steps.find((step) => step.id === 'daemon')?.state).toBe('missing');
  });

  it('rejects a mismatched binary before starting, installing plugin or publishing to user directory', async () => {
    const { entry, calls, plugins } = fixture(root, { binary: new TextEncoder().encode('wrong') });
    await expect(entry.install(() => {})).rejects.toThrow(/SHA-256/);
    expect(calls).toEqual([]);
    expect(plugins.installPlugin).not.toHaveBeenCalled();
    await expect(access(path.join(root, 'user', '.kimi-webbridge', 'bin', 'kimi-webbridge'))).rejects.toThrow();
  });

  it('does not overwrite or launch a competing binary created while its verified download is in flight', async () => {
    const destination = path.join(root, 'user', '.kimi-webbridge', 'bin', 'kimi-webbridge');
    const { entry, calls } = fixture(root, { onDownload: async () => {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, 'competing executable');
    } });
    await expect(entry.install(() => {})).rejects.toThrow(/EEXIST/);
    expect(await readFile(destination, 'utf8')).toBe('competing executable');
    expect(calls).toEqual([]);
  });

  it('installs an exact fixture only once and does not overwrite existing files on retry', async () => {
    const status = { running: true, version: 'fixture', extension_connected: false };
    const { entry, calls, plugins } = fixture(root, { status });
    const result = await entry.install(() => {});
    expect(result).toBe('existing-loopback-daemon-observed-identity-unverified');
    expect(calls).toEqual([]);
    const { entry: down, calls: launches, plugins: pending } = fixture(root);
    await expect(down.install(() => {})).rejects.toThrow(/valid status/);
    const destination = path.join(root, 'user', '.kimi-webbridge', 'bin', 'kimi-webbridge');
    expect(await readFile(destination)).toEqual(Buffer.from(bytes));
    expect(launches).toHaveLength(1);
    expect(plugins.installPlugin).not.toHaveBeenCalled();
    expect(pending.installPlugin).not.toHaveBeenCalled();
    await writeFile(destination, 'existing external binary');
    await chmod(destination, 0o755);
    await expect(down.install(() => {})).rejects.toThrow(/not the pinned/);
    expect(await readFile(destination, 'utf8')).toBe('existing external binary');
  }, 20_000);
});
