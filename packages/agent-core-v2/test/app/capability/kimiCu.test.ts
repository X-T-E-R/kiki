import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CapabilityService } from '#/app/capability/capabilityService';
import { createKimiCuEntry, parsePermissionStatus, parseWindowsDoctorOutput, readAppBundleVersion,
  windowsPowerShellPath, windowsPowerShell7Path } from '#/app/capability/entries/kimiCu';
import { cuMacArtifact } from '#/app/capability/verifiedArtifacts';
import type { CapabilityEntryContext } from '#/app/capability/entries/context';
import type { IPluginService } from '#/app/plugin/plugin';
import type { IHostProcessService } from '#/os/interface/hostProcess';

import { stubLog } from '../../_base/log/stubs';

function fixture(root: string, options: { platform?: NodeJS.Platform; arch?: string; doctor?: string;
  app?: boolean; plugin?: boolean; fetchImpl?: typeof fetch; windowsCuExecutableSha256?: string;
  commands?: Array<{ match: string; code: number; output?: string }> } = {}) {
  const calls: string[] = [];
  const plugins = {
    listPlugins: vi.fn(async () => options.plugin ? [{ id: options.platform === 'win32' ? 'kimi-cu-win' : 'kimi-cu',
      enabled: true, state: 'ok', enabledMcpServerCount: 1, mcpServerCount: 1 }] : []),
    installPlugin: vi.fn(), setPluginEnabled: vi.fn(), setPluginMcpServerEnabled: vi.fn(),
  } as unknown as IPluginService;
  const hostProcess = {
    spawn: async (command: string, args: readonly string[]) => {
      const call = `${command} ${args.join(' ')}`;
      calls.push(call);
      const match = options.commands?.find((entry) => call.includes(entry.match));
      const stdout = match?.output ?? (call.includes('doctor') ? options.doctor ?? '' : '');
      const code = match?.code ?? (call.includes('doctor') ? options.doctor === undefined ? 3 : 0 : 0);
      return {
        stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        stdout: Readable.from([stdout]), stderr: Readable.from(['']),
        wait: () => Promise.resolve(code), dispose: () => undefined,
      };
    },
  } as unknown as IHostProcessService;
  const applicationsDir = path.join(root, 'Applications');
  const ctx: CapabilityEntryContext = {
    platform: options.platform ?? 'darwin', arch: options.arch ?? 'arm64',
    applicationsDir, kimiHomeDir: path.join(root, 'kiki-home'), userHomeDir: path.join(root, 'user-home'),
    plugins, hostProcess, fetchImpl: options.fetchImpl,
    windowsCuExecutableSha256: options.windowsCuExecutableSha256,
  };
  return { entry: createKimiCuEntry(ctx), calls, plugins, applicationsDir };
}

describe('Computer Use publisher assets and guarded preparation', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kiki-cu-safety-'));
    for (const key of ['KIKI_CU_WINDOWS_EXE', 'KIKI_CU_WINDOWS_HOME', 'LOCALAPPDATA', 'ProgramFiles']) {
      vi.stubEnv(key, '');
    }
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function stageWindowsExecutable(contents = 'pinned Windows CU test fixture'): Promise<{ executable: string; sha256: string }> {
    const executable = path.join(root, 'kimi-cu.exe');
    await writeFile(executable, contents);
    vi.stubEnv('KIKI_CU_WINDOWS_EXE', executable);
    return { executable, sha256: createHash('sha256').update(contents).digest('hex') };
  }

  it('parses platform health information without treating incomplete output as healthy', () => {
    expect(parsePermissionStatus('permissions: accessibility=true screenRecording=false'))
      .toEqual({ accessibility: true, screenRecording: false });
    expect(parsePermissionStatus('broken')).toBeUndefined();
    expect(parseWindowsDoctorOutput('version=0.3.6\nmcp=true\nhelper=embedded'))
      .toEqual({ version: '0.3.6' });
    expect(parseWindowsDoctorOutput('mcp=false\nhelper=embedded')).toBeUndefined();
  });

  it('uses fixed publisher app versions for each mac architecture and rejects unknown platforms', () => {
    expect(cuMacArtifact('arm64')?.url).toBe('https://cdn.kimi.com/kimi-computer-use/0.6.1/KimiCU.app.zip');
    expect(cuMacArtifact('x64')?.url).toBe('https://cdn.kimi.com/kimi-computer-use/0.6.1/KimiCU-x86_64.app.zip');
    expect(cuMacArtifact('ia32')).toBeUndefined();
    expect(fixture(root, { platform: 'win32', arch: 'x64' }).entry).toMatchObject({ supported: true, pluginId: 'kimi-cu-win' });
    expect(fixture(root, { platform: 'win32', arch: 'arm64' }).entry.supported).toBe(false);
    expect(windowsPowerShellPath('D:\\Windows')).toContain('System32');
    expect(windowsPowerShell7Path('D:\\Program Files')).toContain('PowerShell');
  });

  it('blocks Windows setup script before network, plugin mutation, or any doctor execution when runtime is absent', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('must not fetch installer'); }) as unknown as typeof fetch;
    const { entry, plugins, calls } = fixture(root, { platform: 'win32', arch: 'x64', fetchImpl });
    expect((await entry.detect()).steps.find((step) => step.id === 'runtime'))
      .toMatchObject({ state: 'missing', detail: expect.stringContaining('doctor was not run') });
    await expect(entry.install(() => {})).rejects.toThrow(/setup_windows\.ps1.*no verified digest/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(plugins.installPlugin).not.toHaveBeenCalled();
    expect(plugins.setPluginEnabled).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('does not run a forged environment executable even if a fake doctor would claim health', async () => {
    const { executable } = await stageWindowsExecutable('fake doctor');
    const { entry, calls } = fixture(root, { platform: 'win32', arch: 'x64',
      doctor: 'version=0.3.6\nmcp=true\nhelper=embedded' });
    expect((await entry.detect()).steps.find((step) => step.id === 'runtime'))
      .toMatchObject({ state: 'missing', detail: expect.stringContaining('SHA-256') });
    await expect(entry.install(() => {})).rejects.toThrow(/no verified digest/);
    expect(calls).toEqual([]);
    expect(await readFile(executable, 'utf8')).toBe('fake doctor');
  });

  it('rejects a relative or nonexistent environment executable without launching a probe', async () => {
    vi.stubEnv('KIKI_CU_WINDOWS_EXE', 'relative\\kimi-cu.exe');
    const { entry, calls } = fixture(root, { platform: 'win32', arch: 'x64',
      doctor: 'version=0.3.6\nmcp=true\nhelper=embedded' });
    expect((await entry.detect()).steps.find((step) => step.id === 'runtime')?.state).toBe('missing');
    vi.stubEnv('KIKI_CU_WINDOWS_EXE', path.join(root, 'does-not-exist.exe'));
    expect((await entry.detect()).steps.find((step) => step.id === 'runtime')?.state).toBe('missing');
    expect(calls).toEqual([]);
  });

  it('rejects a wrong doctor version even when the local executable matches the pinned fixture digest', async () => {
    const { executable, sha256 } = await stageWindowsExecutable();
    const { entry, calls } = fixture(root, { platform: 'win32', arch: 'x64', windowsCuExecutableSha256: sha256,
      doctor: 'version=9.9.9\nmcp=true\nhelper=embedded' });
    expect((await entry.detect()).steps.find((step) => step.id === 'runtime'))
      .toMatchObject({ state: 'missing', detail: expect.stringContaining('does not match pinned 0.3.6') });
    await expect(entry.install(() => {})).rejects.toThrow(/doctor version 9\.9\.9/);
    expect(calls).toEqual([`${executable} doctor`, `${executable} doctor`]);
  });

  it('reuses a checksum-verified Windows executable only after an exact-version health probe', async () => {
    const { executable, sha256 } = await stageWindowsExecutable();
    const { entry, plugins, calls } = fixture(root, { platform: 'win32', arch: 'x64',
      windowsCuExecutableSha256: sha256, doctor: 'version=0.3.6\nmcp=true\nhelper=embedded' });
    expect((await entry.detect()).steps.find((step) => step.id === 'runtime'))
      .toMatchObject({ state: 'ok', detail: '0.3.6' });
    await expect(entry.install(() => {})).resolves.toBe('existing-runtime-reused');
    expect(plugins.installPlugin).not.toHaveBeenCalled();
    expect(calls).toEqual([`${executable} doctor`, `${executable} doctor`]);
  });

  it('observes a pinned Windows runtime and manager-enabled plugin as ready while keeping provenance separate', async () => {
    const { executable, sha256 } = await stageWindowsExecutable();
    const { entry, calls, plugins } = fixture(root, { platform: 'win32', arch: 'x64', plugin: true,
      windowsCuExecutableSha256: sha256, doctor: 'version=0.3.6\nmcp=true\nhelper=embedded' });
    const service = new CapabilityService(undefined as never, undefined as never, undefined as never,
      stubLog(), undefined as never, undefined as never, [entry]);
    const status = await service.getCapability('kimi-cu');
    expect(status.state).toBe('ready');
    expect(status.steps.filter((step) => !step.optional).map((step) => [step.id, step.state]))
      .toEqual([['plugin', 'ok'], ['runtime', 'ok']]);
    expect(status.steps.find((step) => step.id === 'plugin-integrity'))
      .toMatchObject({ state: 'missing', optional: true, detail: expect.stringContaining('ZIP integrity') });
    expect(status.steps.find((step) => step.id === 'runtime-identity'))
      .toMatchObject({ state: 'missing', optional: true, detail: expect.stringContaining('running process') });
    expect(calls).toEqual([`${executable} doctor`]);
    expect(plugins.setPluginEnabled).not.toHaveBeenCalled();
  });

  it('keeps Windows CU partial when plugin management has disabled its MCP server', async () => {
    const { sha256 } = await stageWindowsExecutable();
    const { entry, plugins } = fixture(root, { platform: 'win32', arch: 'x64', plugin: true,
      windowsCuExecutableSha256: sha256, doctor: 'version=0.3.6\nmcp=true\nhelper=embedded' });
    plugins.listPlugins = vi.fn(async () => [{ id: 'kimi-cu-win', enabled: true, state: 'ok',
      enabledMcpServerCount: 0, mcpServerCount: 1 }]) as never;
    const service = new CapabilityService(undefined as never, undefined as never, undefined as never,
      stubLog(), undefined as never, undefined as never, [entry]);
    const status = await service.getCapability('kimi-cu');
    expect(status.state).toBe('partial');
    expect(status.steps.find((step) => step.id === 'plugin'))
      .toMatchObject({ state: 'missing', detail: 'mcp 0/1 enabled' });
  });

  it('rejects a corrupt Mac archive before running ditto, modifying existing apps, or enabling plugins', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe(cuMacArtifact('arm64')?.url);
      return new Response(new TextEncoder().encode('corrupt'), { status: 200 });
    }) as unknown as typeof fetch;
    const { entry, plugins, calls } = fixture(root, { fetchImpl });
    await expect(entry.install(() => {})).rejects.toThrow(/SHA-256/);
    expect(calls.every((call) => call.includes('service-status') || call.includes('xpc-ping'))).toBe(true);
    expect(plugins.installPlugin).not.toHaveBeenCalled();
  });

  it('refuses to launch an unsigned existing app even if its Info.plist claims the pinned version', async () => {
    const { entry, plugins, applicationsDir, calls } = fixture(root, { plugin: true });
    const app = path.join(applicationsDir, 'KimiCU.app', 'Contents');
    await mkdir(path.join(app, 'MacOS'), { recursive: true });
    const binary = path.join(app, 'MacOS', 'kimi-cu');
    await writeFile(binary, 'existing');
    await chmod(binary, 0o755);
    await writeFile(path.join(app, 'Info.plist'), '<key>CFBundleShortVersionString</key><string>0.6.1</string>');
    expect(await readAppBundleVersion(path.join(app, 'Info.plist'))).toBe('0.6.1');
    const status = await entry.detect();
    expect(status.steps.find((step) => step.id === 'app'))
      .toMatchObject({ state: 'missing', detail: expect.stringContaining('signature') });
    expect(calls.every((call) => call.includes('codesign'))).toBe(true);
    await expect(entry.install(() => {})).rejects.toThrow(/already exists; refusing download/);
    expect(calls.every((call) => call.includes('codesign'))).toBe(true);
    expect(await readFile(binary, 'utf8')).toBe('existing');
    expect(plugins.installPlugin).not.toHaveBeenCalled();
    expect(plugins.setPluginEnabled).not.toHaveBeenCalled();
  });

  it('observes a signed installed macOS app, service, permissions and enabled plugin as ready', async () => {
    const { entry, applicationsDir, calls } = fixture(root, { plugin: true, commands: [
      { match: 'codesign -dv', code: 0, output: 'TeamIdentifier=2J9472RW75' },
      { match: 'service-status', code: 0, output: 'status=1' },
      { match: 'xpc-ping', code: 0, output: 'permissions: accessibility=true screenRecording=true' },
    ] });
    const contents = path.join(applicationsDir, 'KimiCU.app', 'Contents');
    await mkdir(path.join(contents, 'MacOS'), { recursive: true });
    const binary = path.join(contents, 'MacOS', 'kimi-cu');
    await writeFile(binary, 'publisher-signed fixture');
    await chmod(binary, 0o755);
    await writeFile(path.join(contents, 'Info.plist'), '<key>CFBundleShortVersionString</key><string>0.6.1</string>');
    const service = new CapabilityService(undefined as never, undefined as never, undefined as never,
      stubLog(), undefined as never, undefined as never, [entry]);
    const status = await service.getCapability('kimi-cu');
    expect(status.state).toBe('ready');
    expect(status.steps.filter((step) => !step.optional).map((step) => [step.id, step.state]))
      .toEqual([['plugin', 'ok'], ['app', 'ok'], ['service', 'ok'], ['permissions', 'ok']]);
    expect(status.steps.find((step) => step.id === 'plugin-integrity'))
      .toMatchObject({ state: 'missing', optional: true });
    expect(calls.some((call) => call.includes('service-status'))).toBe(true);
    await expect(entry.install(() => {})).resolves.toBeUndefined();
    expect(calls.filter((call) => call.includes(' install'))).toEqual([]);
  });

  it('does not execute a previously installed app with the wrong version even if codesign would succeed', async () => {
    const { entry, applicationsDir, calls } = fixture(root);
    const contents = path.join(applicationsDir, 'KimiCU.app', 'Contents');
    await mkdir(path.join(contents, 'MacOS'), { recursive: true });
    const binary = path.join(contents, 'MacOS', 'kimi-cu');
    await writeFile(binary, 'wrong version');
    await chmod(binary, 0o755);
    await writeFile(path.join(contents, 'Info.plist'), '<key>CFBundleShortVersionString</key><string>0.5.9</string>');
    const status = await entry.detect();
    expect(status.steps.find((step) => step.id === 'app'))
      .toMatchObject({ state: 'missing', detail: expect.stringContaining('does not match pinned') });
    expect(calls).toEqual([]);
    await expect(entry.install(() => {})).rejects.toThrow(/already exists; refusing download/);
    expect(calls).toEqual([]);
  });

  it('refuses to overwrite an incomplete external app before fetching the pinned archive', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network should not be touched'); }) as unknown as typeof fetch;
    const { entry, applicationsDir } = fixture(root, { fetchImpl });
    await mkdir(path.join(applicationsDir, 'KimiCU.app'), { recursive: true });
    await expect(entry.install(() => {})).rejects.toThrow(/already exists; refusing download/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
