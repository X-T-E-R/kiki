import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { join } from 'pathe';
import { AcpLoginHelper, type HostProcessServiceLike } from '@kiki/acp-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import {
  ANTIGRAVITY_STORAGE_BASE,
  parseAntigravityCliRelease,
} from '#/app/agentExecutor/antigravityDistribution';
import {
  AntigravityQuotaCollector,
  antigravityQuotaToHarnessReadings,
  parseAntigravitySummaryWindows,
} from '#/app/agentExecutor/antigravityQuota';
import {
  ANTIGRAVITY_INSTALL_TIMEOUT_MS, AntigravityService, IAntigravityService,
  parseAntigravityCodeAuthUrl, validateAntigravityLoginCodeResponse,
  type AntigravityInstallProgress, type AntigravityInstallProgressed,
} from '#/app/agentExecutor/antigravityService';
import { IEventService } from '#/app/event/event';
import * as archive from '#/os/backends/node-local/binaryArchive';
import {
  acquireAntigravityBinaryLease,
  ANTIGRAVITY_SSH_CONNECTION_SENTINEL,
  antigravityProcessService,
  antigravitySettingsHome,
} from '#/app/agentExecutor/antigravityProcess';
import { wrapWindowsNodeShims } from '#/app/agentExecutor/windowsNodeShim';
import { AgentExecutorRegistryService } from '#/app/agentExecutor/agentExecutorRegistryService';
import { IConfigService } from '#/app/config/config';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import * as antigravityHostOps from '#/os/backends/node-local/antigravityHostOps';
import {
  installOfficialAntigravityBinary,
  officialReleaseDirectoryName,
  pruneUnusedOfficialVersions,
  scrubAntigravityProbeSession,
  syncAntigravityUserConfig,
} from '#/os/backends/node-local/antigravityHostOps';
import {
  prepareAntigravityRuntime,
  removeAntigravityRuntimeTemp,
  watchAntigravityTurnOutcome,
} from '#/os/backends/node-local/antigravityRuntime';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(configure?: (services: TestInstantiationService) => void) {
  const root = await mkdtemp(join(tmpdir(), 'kiki-agy-login-'));
  roots.push(root);
  const bootstrap = { osHomeDir: root, homeDir: root, platform: 'win32', arch: 'x64', getEnv: () => undefined } as unknown as IBootstrapService;
  const services = new TestInstantiationService();
  services.set(IBootstrapService, bootstrap);
  services.set(IHostFileSystem, {
    stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    readdir: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    remove: async () => {},
  } as unknown as IHostFileSystem);
  services.set(IHostProcessService, { spawn: async () => { throw new Error('unexpected spawn'); } } as unknown as IHostProcessService);
  services.set(IAtomicTomlDocumentStore, {} as IAtomicTomlDocumentStore);
  services.set(IAgentExecutorRegistry, { resolveExecutable: async () => ({ descriptor: {
    id: 'antigravity-acp', command: 'fixture', args: [], homeEnv: 'GEMINI_HOME', homeDir: '~/custom-gemini',
  } }) } as unknown as IAgentExecutorRegistry);
  configure?.(services);
  services.set(IAntigravityService, new SyncDescriptor(AntigravityService));
  return { root, bootstrap, services, service: services.get(IAntigravityService) as AntigravityService };
}

describe('Antigravity managed login service', () => {
  it('uses the same expanded settings home for sign-in and ordinary process startup', async () => {
    const context = await fixture();
    const close = vi.spyOn(AcpLoginHelper.prototype, 'close').mockResolvedValue();
    vi.spyOn(AcpLoginHelper.prototype, 'start').mockResolvedValue({ alreadySignedIn: true });
    try {
      expect(antigravitySettingsHome({ GEMINI_HOME: '~/custom-gemini' }, context.bootstrap)).toBe(join(context.root, 'custom-gemini'));
      expect(await context.service.beginLogin({ methodId: 'oauth-business', gcpProject: 'proj-1', gcpLocation: 'us-central1' }))
        .toMatchObject({ alreadySignedIn: true, instanceId: 'antigravity-acp' });
      expect(JSON.parse(await readFile(join(context.root, 'custom-gemini/antigravity-acp/settings.json'), 'utf8')))
        .toMatchObject({ auth: { type: 'oauth-business' }, gcp: { project: 'proj-1', location: 'us-central1' } });
      expect(close).toHaveBeenCalledOnce();
    } finally { await context.service.dispose(); await context.services.dispose(); }
  });

  it('expands tilde settings paths against the final child home', async () => {
    const context = await fixture();
    try {
      const inheritedHome = join(context.root, 'inherited-home');
      const childHome = join(context.root, 'child-home');
      const bootstrap = { ...context.bootstrap, getEnv: (name: string) => name === 'HOME' ? inheritedHome : undefined } as IBootstrapService;
      expect(antigravitySettingsHome({ GEMINI_HOME: '~/custom' }, bootstrap)).toBe(join(inheritedHome, 'custom'));
      expect(antigravitySettingsHome({ GEMINI_HOME: '~\\custom', HOME: childHome }, bootstrap)).toBe(join(childHome, 'custom'));

      const host = new HostProcessService();
      const spawn = vi.fn<HostProcessServiceLike['spawn']>((command, args, options) => host.spawn(command, args, options));
      const processes: HostProcessServiceLike = { spawn };
      const descriptor = { id: 'antigravity-acp', protocol: 'acp-v1', revision: 'fixture', args: [], homeEnv: 'GEMINI_HOME', homeDir: '~/profile' } as const;
      const settingsPath = join(childHome, 'profile', 'antigravity-acp', 'settings.json');
      await mkdir(join(childHome, 'profile', 'antigravity-acp'), { recursive: true });
      const originalSettings = '{broken';
      await writeFile(settingsPath, originalSettings);
      const wrapped = antigravityProcessService(processes, descriptor, bootstrap);
      const child = await wrapped.spawn(process.execPath, ['-e', ''], { env: { HOME: childHome, GEMINI_API_KEY: 'fixture-secret' } });
      try { expect(await child.wait()).toBe(0); } finally { await child.dispose(); }
      expect(await readFile(settingsPath, 'utf8')).toBe(originalSettings);
      const options = spawn.mock.calls[0]?.[2] as (NonNullable<Parameters<HostProcessServiceLike['spawn']>[2]> & { readonly envUnset?: readonly string[] }) | undefined;
      expect(options?.env).toMatchObject({ HOME: childHome, GEMINI_HOME: join(childHome, 'profile') });
      expect(options?.env).not.toHaveProperty('GEMINI_API_KEY');
      expect(options?.envUnset).toContain('GEMINI_API_KEY');
    } finally { await context.service.dispose(); await context.services.dispose(); }
  });

  it('closes an in-flight helper and never publishes a login handle after disposal', async () => {
    const context = await fixture();
    let resolve!: (value: { alreadySignedIn: false; authUrl: string; redirectUri: string }) => void;
    const starting = new Promise<{ alreadySignedIn: false; authUrl: string; redirectUri: string }>((done) => { resolve = done; });
    const start = vi.spyOn(AcpLoginHelper.prototype, 'start').mockReturnValue(starting);
    const close = vi.spyOn(AcpLoginHelper.prototype, 'close').mockResolvedValue();
    const pending = context.service.beginLogin('oauth-personal');
    const rejected = expect(pending).rejects.toThrow('closed');
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      await context.service.dispose();
      expect(close).toHaveBeenCalledOnce();
      resolve({ alreadySignedIn: false, authUrl: 'https://accounts.google.com/', redirectUri: 'http://127.0.0.1:48123/' });
      await rejected;
      await expect(context.service.beginLogin('oauth-personal')).rejects.toThrow('closed');
    } finally { await context.services.dispose(); }
  });
});

describe('Antigravity install progress', () => {
  async function installFixture() {
    const published: AntigravityInstallProgress[] = [];
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const context = await fixture((services) => {
      services.set(IHostFileSystem, {
        stat: async () => { throw enoent; }, remove: async () => {}, readdir: async () => { throw enoent; },
      } as unknown as IHostFileSystem);
      services.set(IAtomicTomlDocumentStore, { get: async () => undefined, set: async () => {} } as unknown as IAtomicTomlDocumentStore);
      services.set(IEventService, { publish: (event: AntigravityInstallProgressed) => { published.push(event.payload); } } as unknown as IEventService);
    });
    return { ...context, published };
  }

  it('publishes download, extract, activate, then done for one install id', async () => {
    const context = await installFixture();
    const install = vi.spyOn(archive, 'installBinaryArchive').mockImplementation(async (options) => {
      options.onProgress?.({ stage: 'download', receivedBytes: 0, totalBytes: 10 });
      options.onProgress?.({ stage: 'download', receivedBytes: 10, totalBytes: 10 });
      options.onProgress?.({ stage: 'extract' });
      return 'hash';
    });
    try {
      await context.service.install('1.4.5');
      expect(install.mock.calls[0]?.[0].timeoutMs).toBe(ANTIGRAVITY_INSTALL_TIMEOUT_MS);
      expect(context.published.map((event) => event.stage)).toEqual(['download', 'download', 'extract', 'activate', 'done']);
      expect(new Set(context.published.map((event) => event.installId)).size).toBe(1);
      expect(context.published.every((event) => event.version === '1.4.5')).toBe(true);
    } finally { await context.service.dispose(); await context.services.dispose(); }
  });

  it('ends a timed-out download with one failed event and no activate', async () => {
    const context = await installFixture();
    vi.spyOn(archive, 'installBinaryArchive').mockImplementation(async (options) => {
      options.onProgress?.({ stage: 'download', receivedBytes: 0 });
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    try {
      await expect(context.service.install('1.4.5')).rejects.toThrow('timeout');
      expect(context.published.map((event) => event.stage)).toEqual(['download', 'failed']);
      expect(context.published.at(-1)).toMatchObject({ stage: 'failed', timedOut: true });
      expect((await context.service.status()).phase).toBe('failed');
    } finally { await context.service.dispose(); await context.services.dispose(); }
  });

  it('marks an ordinary failure as not timed out', async () => {
    const context = await installFixture();
    vi.spyOn(archive, 'installBinaryArchive').mockRejectedValue(new Error('Binary download failed (HTTP 404)'));
    try {
      await expect(context.service.install('1.2.1')).rejects.toThrow('HTTP 404');
      expect(context.published).toEqual([expect.objectContaining({ stage: 'failed', timedOut: false, version: '1.2.1', error: 'Binary download failed (HTTP 404)' })]);
    } finally { await context.service.dispose(); await context.services.dispose(); }
  });
});

describe('Antigravity sign-in completion codes', () => {
  const authUrl = 'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A48123%2F&state=fixture-state';
  async function pendingLogin() {
    const context = await fixture();
    vi.spyOn(AcpLoginHelper.prototype, 'start').mockResolvedValue({ alreadySignedIn: false, authUrl, redirectUri: 'http://127.0.0.1:48123/' });
    vi.spyOn(AcpLoginHelper.prototype, 'close').mockResolvedValue();
    const started = await context.service.beginLogin('oauth-personal');
    if (started.alreadySignedIn) throw new Error('expected a pending sign-in');
    return { ...context, handle: started.handle };
  }

  it('codes a paste from another flow as a retryable callback mismatch', async () => {
    const context = await pendingLogin();
    try {
      expect(await context.service.completeLogin(context.handle, 'http://127.0.0.1:48123/?state=other&code=x'))
        .toMatchObject({ signedIn: false, retryable: true, messageCode: 'callback_mismatch' });
    } finally { await context.service.dispose(); await context.services.dispose(); }
  });

  it('codes a vendor rejection as a final sign-in failure and keeps the vendor words in message', async () => {
    const context = await pendingLogin();
    vi.spyOn(AcpLoginHelper.prototype, 'finish').mockRejectedValue(new Error('invalid_grant'));
    try {
      expect(await context.service.completeLogin(context.handle, 'http://127.0.0.1:48123/?state=fixture-state&code=x'))
        .toEqual({ signedIn: false, retryable: false, messageCode: 'signin_failed', message: 'Antigravity sign-in failed: invalid_grant' });
    } finally { await context.service.dispose(); await context.services.dispose(); }
  });

  it('carries no code on success', async () => {
    const context = await pendingLogin();
    vi.spyOn(AcpLoginHelper.prototype, 'finish').mockResolvedValue();
    try {
      expect(await context.service.completeLogin(context.handle, 'http://127.0.0.1:48123/?state=fixture-state&code=x'))
        .toMatchObject({ signedIn: true, retryable: false });
    } finally { await context.service.dispose(); await context.services.dispose(); }
  });
});

describe('Antigravity runtime lifecycle and turn outcomes', () => {
  it('isolates native profiles and process temp homes without inheriting a standalone harness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-agy-instances-'));
    roots.push(root);
    const bootstrap = { homeDir: root, osHomeDir: root, platform: process.platform, getEnv: () => undefined } as unknown as IBootstrapService;
    const processes = new HostProcessService({ GEMINI_HOME: 'foreign-profile', ANTIGRAVITY_HARNESS_PATH: 'foreign-harness',
      GEMINI_API_KEY: 'fixture', GOOGLE_API_KEY: 'fixture', CHROME_CRASHPAD_PIPE_NAME: 'foreign-pipe' });
    const children = await Promise.all(['instance-a', 'instance-b', 'instance-a'].map(async (id) => {
      const wrapper = antigravityProcessService(processes, { id, selectedSource: 'agy-cli',
        instance: { source_executor: 'antigravity-acp', label: id, configuration: { kind: 'inherit' }, proxy: { kind: 'inherit' } },
        protocol: 'acp-v1', revision: 'fixture', args: [] }, bootstrap);
      const child = await wrapper.spawn(process.execPath, ['-e', `
        const { existsSync, writeFileSync } = require('node:fs');
        const { join } = require('node:path');
        const { GEMINI_HOME, TEMP, TMP, AGY_ACP_FORCE_FILE_STORAGE, ANTIGRAVITY_HARNESS_PATH,
          GEMINI_API_KEY, GOOGLE_API_KEY, CHROME_CRASHPAD_PIPE_NAME } = process.env;
        writeFileSync(join(TEMP, 'unpacked'), 'fixture');
        process.stdout.write(JSON.stringify({ home: GEMINI_HOME, temp: TEMP, tmp: TMP, ready: existsSync(GEMINI_HOME),
          isolated: [ANTIGRAVITY_HARNESS_PATH, GEMINI_API_KEY, GOOGLE_API_KEY, CHROME_CRASHPAD_PIPE_NAME].every(v => v === undefined),
          fileStorage: AGY_ACP_FORCE_FILE_STORAGE }));
      `]);
      try {
        const chunks = [];
        for await (const chunk of child.stdout) chunks.push(String(chunk));
        expect(await child.wait()).toBe(0);
        const env = JSON.parse(chunks.join('')) as { home: string; temp: string };
        expect(env).toMatchObject({ ready: true, isolated: true, tmp: env.temp, fileStorage: '1' });
        await expect(stat(env.temp)).rejects.toMatchObject({ code: 'ENOENT' });
        return env;
      } finally { await child.dispose(); }
    }));
    expect(new Set(children.map(({ temp }) => temp)).size).toBe(3);
    expect(children[0]?.home).toBe(children[2]?.home);
    expect(children[0]?.home).not.toBe(children[1]?.home);
  });

  it('prepares real profile and temp homes and creates Windows skills junctions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-agy-runtime-'));
    roots.push(root);
    const userHome = join(root, 'user');
    const profileHome = join(root, 'profile');
    const tempHome = join(root, 'temp');
    const skillTargets = [join(userHome, '.gemini', 'config', 'skills'), join(userHome, '.gemini', 'antigravity-cli', 'skills')];
    await Promise.all(skillTargets.map((target) => mkdir(target, { recursive: true })));

    await prepareAntigravityRuntime({ profileHome, tempHome, userHome, platform: 'win32' });

    expect((await stat(profileHome)).isDirectory()).toBe(true);
    expect((await stat(tempHome)).isDirectory()).toBe(true);
    for (const [index, relative] of [join('config', 'skills'), join('antigravity-cli', 'skills')].entries()) {
      const link = join(profileHome, relative);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await realpath(link)).toBe(await realpath(skillTargets[index]!));
    }
  });

  it('removes the owned temp tree and tolerates a repeated cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-agy-temp-'));
    roots.push(root);
    const temporary = join(root, 'temp');
    await mkdir(join(temporary, 'nested'), { recursive: true });
    await writeFile(join(temporary, 'nested', 'file'), 'temporary');

    await removeAntigravityRuntimeTemp(temporary);
    await removeAntigravityRuntimeTemp(temporary);

    await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects a newly written real SQLite 429 step and its quota reset timestamp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-agy-turn-'));
    roots.push(root);
    const profile = join(root, 'profile');
    const sessionId = 'session-429';
    const directory = join(profile, 'antigravity-acp', 'conversations');
    await mkdir(directory, { recursive: true });
    const databasePath = join(directory, `${sessionId}.db`);
    const create = new DatabaseSync(databasePath);
    create.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, step_payload BLOB)');
    create.prepare('INSERT INTO steps(idx, step_type, step_payload) VALUES (?, ?, ?)')
      .run(0, 1, Buffer.from('prior success'));
    create.close();

    const outcome = await watchAntigravityTurnOutcome(profile, sessionId, () => Date.parse('2026-11-12T00:00:00.000Z'));
    const update = new DatabaseSync(databasePath);
    update.prepare('INSERT INTO steps(idx, step_type, step_payload) VALUES (?, ?, ?)')
      .run(1, 17, Buffer.from('Error 429, Message: quota exhausted, Status: RESOURCE_EXHAUSTED reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-13T00:00:00Z'));
    update.close();

    await expect(outcome('end_turn')).resolves.toEqual({
      kind: 'usage_limit',
      message: 'You have reached your Antigravity quota for this period.',
      code: 'RESOURCE_EXHAUSTED',
      retryable: true,
      resetAt: '2026-11-13T00:00:00Z',
    });
  });

  it.each([
    ['quotaResetDelay:1h2m3.5s', '2026-11-12T01:02:03.500Z'],
    ['retryDelay:250ms', '2026-11-12T00:00:00.250Z'],
  ])('extracts a 429 relative reset time from %s', async (delay, resetAt) => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-agy-delay-'));
    roots.push(root);
    const directory = join(root, 'antigravity-cli', 'conversations');
    await mkdir(directory, { recursive: true });
    const outcome = await watchAntigravityTurnOutcome(root, 'new-session', () => Date.parse('2026-11-12T00:00:00Z'));
    const db = new DatabaseSync(join(directory, 'new-session.db'));
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
    db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 17, Buffer.from(`Error 429, Message: busy, Status: RESOURCE_EXHAUSTED [${delay}]`));
    db.close();
    await expect(outcome('end_turn')).resolves.toMatchObject({ kind: 'usage_limit', retryable: true, resetAt });
  });

  it('does not carry an older turn rejection into a new ordinary success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-agy-turn-reset-'));
    roots.push(root);
    const profile = join(root, 'profile');
    const sessionId = 'session-reset';
    const directory = join(profile, 'antigravity-acp', 'conversations');
    await mkdir(directory, { recursive: true });
    const databasePath = join(directory, `${sessionId}.db`);
    const create = new DatabaseSync(databasePath);
    create.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, step_payload BLOB)');
    create.prepare('INSERT INTO steps(idx, step_type, step_payload) VALUES (?, ?, ?)')
      .run(0, 17, Buffer.from('Error 429, Message: old quota exhausted, Status: RESOURCE_EXHAUSTED reason:QUOTA_EXHAUSTED'));
    create.close();

    const outcome = await watchAntigravityTurnOutcome(profile, sessionId);
    const update = new DatabaseSync(databasePath);
    update.prepare('INSERT INTO steps(idx, step_type, step_payload) VALUES (?, ?, ?)').run(1, 1, Buffer.from('turn completed'));
    update.close();

    await expect(outcome('end_turn')).resolves.toBeUndefined();
  });
});

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function encodeLengthDelimitedField(fieldNumber: number, payload: Buffer): Buffer {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  return Buffer.concat([tag, encodeVarint(payload.length), payload]);
}

describe('Antigravity official 1.5+ installer, leases, SSH guard, auth flows, probe scrub, and quota', () => {
  it('parses official live manifest, rejects wrong digest/origin, validates handshake, and preserves leased versions during prune', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-agy-official-'));
    roots.push(root);
    const payload = Buffer.from('official-agy-1.5.8-binary');
    const sha512 = createHash('sha512').update(payload).digest('hex');
    const parsed = parseAntigravityCliRelease({
      version: '1.5.8',
      url: `${ANTIGRAVITY_STORAGE_BASE}/1.5.8-999/windows-x64/cli_windows_x64.exe`,
      sha512,
    }, 'win32', 'x64');
    expect(parsed).toMatchObject({
      version: '1.5.8',
      layout: 'official-cli',
      entry: 'agy.exe',
      sha512,
      args: ['acp'],
    });

    const versionsRoot = join(root, 'versions');
    await expect(installOfficialAntigravityBinary({
      url: 'https://evil.example.test/1.5.8-999/agy.exe',
      version: '1.5.8',
      sha512,
      format: 'executable',
      executableName: 'agy.exe',
      versionsRoot,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => new Response(payload),
    })).rejects.toThrow();

    await expect(installOfficialAntigravityBinary({
      url: `${ANTIGRAVITY_STORAGE_BASE}/1.5.8-999/agy.exe`,
      version: '1.5.8',
      sha512: '0'.repeat(128),
      format: 'executable',
      executableName: 'agy.exe',
      versionsRoot,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => new Response(payload),
    })).rejects.toThrow('SHA-512');

    const oldPayload = Buffer.from('official-agy-1.5.4-binary');
    const oldSha = createHash('sha512').update(oldPayload).digest('hex');
    const installedOld = await installOfficialAntigravityBinary({
      url: `${ANTIGRAVITY_STORAGE_BASE}/1.5.4-100/agy.exe`,
      version: '1.5.4',
      sha512: oldSha,
      format: 'executable',
      executableName: 'agy.exe',
      versionsRoot,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => new Response(oldPayload),
    });

    const validatedPaths: string[] = [];
    const installedNew = await installOfficialAntigravityBinary({
      url: `${ANTIGRAVITY_STORAGE_BASE}/1.5.8-999/agy.exe`,
      version: '1.5.8',
      sha512,
      format: 'executable',
      executableName: 'agy.exe',
      versionsRoot,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => new Response(payload),
      validate: async (executablePath) => { validatedPaths.push(executablePath); },
    });
    expect(validatedPaths).toHaveLength(1);
    expect(await readFile(installedNew.executablePath, 'utf8')).toBe('official-agy-1.5.8-binary');

    const releaseLease = acquireAntigravityBinaryLease(installedOld.executablePath, root);
    try {
      await pruneUnusedOfficialVersions(versionsRoot, installedNew.directory, new Set([installedOld.directory]), 'win32');
      expect((await stat(installedOld.executablePath)).isFile()).toBe(true);
    } finally {
      releaseLease();
    }
    await pruneUnusedOfficialVersions(versionsRoot, installedNew.directory, new Set(), 'win32');
    await expect(stat(installedOld.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(installedNew.executablePath)).isFile()).toBe(true);
  });

  it('rejects remote SSH runtimes before launch and sets ownedProcessTree, SSH_CONNECTION, and rule sync for official CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-agy-ssh-guard-'));
    roots.push(root);
    const bootstrap = { homeDir: root, osHomeDir: root, platform: 'win32', arch: 'x64', getEnv: () => undefined } as unknown as IBootstrapService;
    const descriptor = { id: 'antigravity-acp', protocol: 'acp-v1', revision: 'fixture', args: [], selectedSource: 'agy-cli' } as const;

    class SshHostProcessService implements HostProcessServiceLike {
      spawn = vi.fn(async () => { throw new Error('must not spawn'); });
    }
    const remote = new SshHostProcessService();
    const wrappedDirect = antigravityProcessService(remote, descriptor, bootstrap);
    await expect(wrappedDirect.spawn('agy', ['acp'])).rejects.toThrow('local runtime');

    const wrappedThroughShim = antigravityProcessService(
      wrapWindowsNodeShims(remote, undefined, () => bootstrap),
      descriptor,
      bootstrap,
    );
    await expect(wrappedThroughShim.spawn('agy', ['acp'])).rejects.toThrow('local runtime');
    expect(remote.spawn).not.toHaveBeenCalled();

    const userHome = join(root, 'user-home');
    const profileHome = join(root, 'profile-home');
    const tempHome = join(root, 'temp-home');
    await mkdir(join(userHome, '.gemini', 'config'), { recursive: true });
    await writeFile(join(userHome, '.gemini', 'GEMINI.md'), 'user-rule-v1');
    await writeFile(join(userHome, '.gemini', 'config', 'skills.json'), '{"skills":[]}');
    await syncAntigravityUserConfig({ profileHome, tempHome, userHome, platform: 'win32' });
    expect(await readFile(join(profileHome, 'GEMINI.md'), 'utf8')).toBe('user-rule-v1');
    await writeFile(join(profileHome, 'GEMINI.md'), 'profile-edited');
    await writeFile(join(userHome, '.gemini', 'GEMINI.md'), 'user-rule-v2');
    await syncAntigravityUserConfig({ profileHome, tempHome, userHome, platform: 'win32' });
    expect(await readFile(join(profileHome, 'GEMINI.md'), 'utf8')).toBe('profile-edited');

    let capturedArgs: readonly string[] = [];
    let capturedOptions: Record<string, unknown> | undefined;
    const fakeProcesses: HostProcessServiceLike = {
      spawn: async (_command, args, options) => {
        capturedArgs = args ?? [];
        capturedOptions = options as Record<string, unknown>;
        return {
          pid: 42,
          exitCode: 0,
          stdin: new Writable({ write(_chunk, _encoding, done) { done(); } }),
          stdout: Readable.from([]),
          stderr: Readable.from([]),
          wait: async () => 0,
          kill: async () => {},
          dispose: async () => {},
        };
      },
    };
    const wrappedLocal = antigravityProcessService(fakeProcesses, { ...descriptor, homeEnv: 'GEMINI_HOME', homeDir: profileHome }, bootstrap);
    const child = await wrappedLocal.spawn('C:/tools/agy.exe', ['acp']);
    await child.wait();
    expect(capturedArgs).toEqual(['acp', '--gemini-dir', profileHome, '--app-data-dir', 'antigravity-acp']);
    expect(capturedOptions?.['ownedProcessTree']).toBe(true);
    expect((capturedOptions?.['env'] as Record<string, string>)['AGY_CLI_DISABLE_AUTO_UPDATE']).toBe('1');
    expect((capturedOptions?.['env'] as Record<string, string>)['SSH_CONNECTION']).toBe(ANTIGRAVITY_SSH_CONNECTION_SENTINEL);
    expect((capturedOptions?.['env'] as Record<string, string>)['ANTIGRAVITY_HARNESS_PATH']).toBeUndefined();
  });

  it('completes official --login code_paste flow, validates state, runs disposable probe, caches models, and scrubs probe trajectory DB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-agy-code-login-'));
    roots.push(root);
    const profileHome = join(root, 'profile');
    const authUrl = 'https://accounts.google.com/o/oauth2/auth?response_type=code&state=state-xyz&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback';
    const parsedAuth = parseAntigravityCodeAuthUrl(authUrl);
    expect(parsedAuth).toEqual({
      authorizationUrl: authUrl,
      redirectUri: 'https://antigravity.google/oauth-callback',
      state: 'state-xyz',
    });
    expect(validateAntigravityLoginCodeResponse(parsedAuth!, '4/0AcvDMr-raw-code')).toBe('4/0AcvDMr-raw-code');
    expect(validateAntigravityLoginCodeResponse(parsedAuth!, 'https://antigravity.google/oauth-callback?state=wrong&code=abc')).toBeUndefined();
    expect(validateAntigravityLoginCodeResponse(parsedAuth!, 'https://antigravity.google/oauth-callback?state=state-xyz&code=abc')).toBe('https://antigravity.google/oauth-callback?state=state-xyz&code=abc');

    const probeSessionId = '11111111-2222-3333-4444-555555555555';
    const otherSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    let receivedLoginCode = '';
    const recordedNegotiated: unknown[] = [];

    const context = await fixture((services) => {
      services.set(IBootstrapService, { osHomeDir: root, homeDir: root, platform: 'win32', arch: 'x64', getEnv: () => undefined } as unknown as IBootstrapService);
      services.set(IAtomicTomlDocumentStore, { get: async () => undefined, set: async () => {} } as unknown as IAtomicTomlDocumentStore);
      services.set(IAgentExecutorRegistry, {
        get: (id: string) => id === 'antigravity-acp'
          ? { id: 'antigravity-acp', protocol: 'acp-v1', revision: 'rev-1', args: [], homeEnv: 'GEMINI_HOME', homeDir: profileHome, selectedSource: 'agy-cli' }
          : undefined,
        resolveExecutable: async () => ({
          descriptor: {
            id: 'antigravity-acp', protocol: 'acp-v1', revision: 'rev-1', command: 'C:/tools/agy.exe',
            launchArgs: ['acp'], args: [], homeEnv: 'GEMINI_HOME', homeDir: profileHome, selectedSource: 'agy-cli', version: '1.5.8',
          },
        }),
        recordNegotiated: (...args: unknown[]) => { recordedNegotiated.push(args); },
      } as unknown as IAgentExecutorRegistry);
      services.set(IHostProcessService, {
        spawn: async (_command: string, args: readonly string[] = [], options?: { readonly cwd?: string }) => {
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          let resolveWait!: (code: number) => void;
          const waitPromise = new Promise<number>((resolve) => { resolveWait = resolve; });
          if (args.includes('--login')) {
            setImmediate(() => { stdout.write(`Open this URL:\n${authUrl}\n`); });
            const stdin = new Writable({
              write(chunk, _encoding, done) {
                receivedLoginCode += chunk.toString('utf8');
                done();
              },
              final(done) {
                const tokenDir = join(profileHome, 'antigravity-acp');
                void mkdir(tokenDir, { recursive: true })
                  .then(() => writeFile(join(tokenDir, 'antigravity-oauth-token'), JSON.stringify({
                    token: { access_token: 'fresh-access-token', expiry: new Date(Date.now() + 3600_000).toISOString() },
                  })))
                  .then(() => { resolveWait(0); done(); });
              },
            });
            return {
              _serviceBrand: undefined,
              pid: 101,
              exitCode: null,
              stdin,
              stdout,
              stderr,
              wait: () => waitPromise,
              kill: async () => { resolveWait(0); },
              dispose: async () => { stdout.end(); stderr.end(); },
            };
          }
          const probeCwd = options?.cwd ?? root;
          let rpcBuffer = '';
          const stdin = new Writable({
            write(chunk, _encoding, done) {
              rpcBuffer += chunk.toString('utf8');
              for (const line of rpcBuffer.split('\n')) {
                if (!line.trim().startsWith('{')) continue;
                const msg = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
                if (msg.method === 'initialize') {
                  stdout.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: { agentInfo: { name: 'Antigravity ACP Server', version: '1.5.8' }, agentCapabilities: { loadSession: true } },
                  })}\n`);
                } else if (msg.method === 'session/new') {
                  const convDir = join(profileHome, 'antigravity-acp', 'conversations');
                  void mkdir(convDir, { recursive: true }).then(() => {
                    const db = new DatabaseSync(join(convDir, `${probeSessionId}.db`));
                    db.exec('CREATE TABLE trajectory_metadata_blob (data BLOB)');
                    const uriBuf = Buffer.from(pathToFileURL(probeCwd).href, 'utf8');
                    const blob = Buffer.concat([
                      encodeLengthDelimitedField(6, Buffer.from(probeSessionId, 'utf8')),
                      encodeLengthDelimitedField(7, uriBuf),
                    ]);
                    db.prepare('INSERT INTO trajectory_metadata_blob(data) VALUES (?)').run(blob);
                    db.close();
                    const keepDb = new DatabaseSync(join(convDir, `${otherSessionId}.db`));
                    keepDb.exec('CREATE TABLE trajectory_metadata_blob (data BLOB)');
                    const keepBlob = encodeLengthDelimitedField(7, Buffer.from(pathToFileURL(join(root, 'unrelated')).href, 'utf8'));
                    keepDb.prepare('INSERT INTO trajectory_metadata_blob(data) VALUES (?)').run(keepBlob);
                    keepDb.close();
                    stdout.write(`${JSON.stringify({
                      jsonrpc: '2.0',
                      method: 'session/update',
                      params: { sessionId: probeSessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] } },
                    })}\n`);
                    stdout.write(`${JSON.stringify({
                      jsonrpc: '2.0',
                      id: msg.id,
                      result: {
                        sessionId: probeSessionId,
                        modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'auto' }] },
                        configOptions: [
                          { id: 'model', category: 'model', type: 'select', currentValue: 'gemini-3-pro', options: [{ value: 'gemini-3-pro', name: 'Gemini 3 Pro' }, { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }] },
                          { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] },
                        ],
                      },
                    })}\n`);
                  });
                } else if (msg.method === 'session/set_config_option') {
                  const chosen = msg.params?.['value'];
                  stdout.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {
                      configOptions: [
                        { id: 'model', category: 'model', type: 'select', currentValue: chosen, options: [{ value: 'gemini-3-pro' }, { value: 'claude-sonnet-4-6' }] },
                        { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'medium', options: chosen === 'claude-sonnet-4-6' ? [{ value: 'medium' }, { value: 'max' }] : [{ value: 'low' }, { value: 'high' }] },
                      ],
                    },
                  })}\n`);
                }
              }
              rpcBuffer = '';
              done();
            },
          });
          return {
            _serviceBrand: undefined,
            pid: 102,
            exitCode: null,
            stdin,
            stdout,
            stderr,
            wait: () => waitPromise,
            kill: async () => { resolveWait(0); },
            dispose: async () => { stdout.end(); stderr.end(); },
          };
        },
      } as unknown as IHostProcessService);
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/oauth2/v2/userinfo')) {
        return new Response(JSON.stringify({ id: 'google-123', email: 'alice@example.test' }));
      }
      return new Response('{}', { status: 404 });
    });

    try {
      const started = await context.service.beginLogin({ methodId: 'oauth-personal' });
      expect(started).toMatchObject({
        alreadySignedIn: false,
        flowKind: 'code_paste',
        authUrl,
        redirectUri: 'https://antigravity.google/oauth-callback',
      });
      if (started.alreadySignedIn) throw new Error('expected code login');

      const mismatch = await context.service.completeLogin(started.handle, 'https://antigravity.google/oauth-callback?state=other&code=abc');
      expect(mismatch).toMatchObject({ signedIn: false, retryable: true, messageCode: 'callback_mismatch' });

      const outcome = await context.service.completeLogin(started.handle, '4/0AcvDMr-raw-code');
      expect(receivedLoginCode.trim()).toBe('4/0AcvDMr-raw-code');
      expect(outcome).toMatchObject({
        signedIn: true,
        retryable: false,
        profile: {
          signedIn: true,
          accountLabel: 'alice@example.test',
          eligibility: 'ready',
          autoModeSupported: true,
          commands: ['compact'],
          models: [
            { id: 'gemini-3-pro', label: 'Gemini 3 Pro', thinkingLevels: ['low', 'high'] },
            { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', thinkingLevels: ['medium', 'max'] },
          ],
        },
      });
      expect(recordedNegotiated).toHaveLength(1);
      const cacheText = await readFile(join(profileHome, 'kiki-agy-cache.json'), 'utf8');
      expect(cacheText).not.toContain('fresh-access-token');
      await expect(stat(join(profileHome, 'antigravity-acp', 'conversations', `${probeSessionId}.db`))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(join(profileHome, 'antigravity-acp', 'conversations', `${otherSessionId}.db`))).isFile()).toBe(true);

      await scrubAntigravityProbeSession({ profileHome, sessionId: otherSessionId, cwd: join(root, 'wrong-cwd') });
      expect((await stat(join(profileHome, 'antigravity-acp', 'conversations', `${otherSessionId}.db`))).isFile()).toBe(true);
    } finally {
      await context.service.dispose();
      await context.services.dispose();
    }
  });

  it('fetches CloudCode PA 5h and weekly quota with endpoint precedence, rolling-reset filtering, fallback, and expired token handling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-agy-quota-'));
    roots.push(root);
    const acpDir = join(root, 'antigravity-acp');
    await mkdir(acpDir, { recursive: true });
    const nowMs = Date.parse('2026-11-24T12:00:00.000Z');
    await writeFile(join(acpDir, 'settings.json'), JSON.stringify({ auth: { type: 'oauth-personal' } }));
    await writeFile(join(acpDir, 'antigravity-oauth-token'), JSON.stringify({
      token: { access_token: 'valid-token', expiry: new Date(nowMs + 3_600_000).toISOString() },
    }));

    const collector = new AntigravityQuotaCollector();
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes('/oauth2/v2/userinfo')) {
        return new Response(JSON.stringify({ id: 'gid-42', email: 'dev@example.test' }));
      }
      if (url.startsWith('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary')) {
        return new Response(JSON.stringify({
          groups: [
            {
              buckets: [
                { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.72, resetTime: '2026-11-24T15:00:00.000Z' },
                { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1, resetTime: new Date(nowMs + 7 * 24 * 60 * 60_000).toISOString() },
                { bucketId: '3p-5h', window: '5h', remainingFraction: 0.4, resetTime: '2026-11-24T16:00:00.000Z' },
              ],
            },
          ],
        }));
      }
      if (url.startsWith('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary')) {
        return new Response(JSON.stringify({
          groups: [
            {
              buckets: [
                { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.1, resetTime: '2026-11-24T13:00:00.000Z' },
                { bucketId: 'gemini-argon-5h', window: '5h', remainingFraction: 0.9, resetTime: '2026-11-24T14:00:00.000Z' },
              ],
            },
          ],
        }));
      }
      return new Response('{}', { status: 404 });
    };

    const result = await collector.read({
      profileHome: root,
      platform: 'win32',
      arch: 'x64',
      fetchImpl,
      now: () => nowMs,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected quota ok');
    expect(result.accountLabel).toBe('dev@example.test');
    expect(result.windows.find((w) => w.id === 'gemini-5h')).toMatchObject({ remainingFraction: 0.72, kind: 'session', resetAt: '2026-11-24T15:00:00.000Z' });
    expect(result.windows.find((w) => w.id === 'gemini-weekly')?.resetAt).toBeUndefined();
    expect(result.windows.find((w) => w.id === 'gemini-argon-5h')).toMatchObject({ family: 'Gemini Argon', remainingFraction: 0.9 });
    expect(result.windows.find((w) => w.id === '3p-5h')).toMatchObject({ family: 'Claude & GPT (shared)', remainingFraction: 0.4 });
    const readings = antigravityQuotaToHarnessReadings({
      accountId: 'agy-work',
      accountLabel: result.accountLabel,
      windows: result.windows,
      modelIds: ['gemini-3-pro', 'gemini-4-argon', 'claude-sonnet-4-6'],
      readAt: result.checkedAt,
    });
    expect(readings.find((r) => r.pool === 'claude-gpt')).toMatchObject({
      accountId: 'agy-work',
      modelIds: ['claude-sonnet-4-6'],
      unit: 'percent',
      window: '5h',
      remaining: 40,
    });
    const unscopedReadings = antigravityQuotaToHarnessReadings({
      accountId: 'agy-work',
      accountLabel: result.accountLabel,
      windows: result.windows,
      readAt: result.checkedAt,
    });
    expect(unscopedReadings.find((r) => r.pool === 'claude-gpt')).toMatchObject({
      accountId: 'agy-work',
      pool: 'claude-gpt',
      modelIds: undefined,
      remaining: 40,
    });

    await writeFile(join(acpDir, 'antigravity-oauth-token'), JSON.stringify({
      token: { access_token: 'expired-token', expiry: new Date(nowMs - 1_000).toISOString() },
    }));
    const expired = await collector.read({
      profileHome: root,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => { throw new Error('must not call network for expired CLI token'); },
      now: () => nowMs,
    });
    expect(expired).toMatchObject({ ok: false, reason: 'token_expired' });
    expect(parseAntigravitySummaryWindows({ groups: [{ buckets: [{ bucketId: 'gemini-carbon-weekly', window: 'weekly', remainingFraction: 0.5 }] }] }, nowMs)[0])
      .toMatchObject({ family: 'Gemini Carbon', kind: 'weekly', usedPercent: 50 });
    expect(calls.some((u) => u.includes('daily-cloudcode-pa.googleapis.com'))).toBe(true);
  });

  it('installs official binary on a clean home with empty PATH, resolves exact versions/<ver>-<sha12> binary, and runs beginLogin + completeLogin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-agy-clean-e2e-'));
    roots.push(root);
    const payload = Buffer.from('official-agy-1.5.12-clean-binary');
    const sha512 = createHash('sha512').update(payload).digest('hex');
    const expectedDirName = officialReleaseDirectoryName('1.5.12', sha512);
    const expectedExePath = join(root, 'tools', 'antigravity-acp', 'versions', expectedDirName, 'agy.exe');
    const authUrl = 'https://accounts.google.com/o/oauth2/auth?response_type=code&state=e2e-state&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback';

    const docStore = new Map<string, unknown>();
    const documents = {
      get: async <T>(scope: string, key: string) => docStore.get(`${scope}:${key}`) as T | undefined,
      set: async (scope: string, key: string, value: unknown) => { docStore.set(`${scope}:${key}`, value); },
    } as unknown as IAtomicTomlDocumentStore;
    const bootstrap = {
      osHomeDir: root,
      homeDir: root,
      platform: 'win32' as const,
      arch: 'x64',
      getEnv: (name: string) => name.toUpperCase() === 'PATH' ? '' : undefined,
    } as unknown as IBootstrapService;
    const spawnedCommands: string[] = [];
    const processes = {
      spawn: async (command: string, args: readonly string[] = [], options?: { readonly env?: Record<string, string> }) => {
        spawnedCommands.push(command);
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let resolveWait!: (code: number) => void;
        const waitPromise = new Promise<number>((resolve) => { resolveWait = resolve; });
        if (args.includes('--login')) {
          const profileHome = options?.env?.['GEMINI_HOME'] ?? root;
          setImmediate(() => { stdout.write(`${authUrl}\n`); });
          const stdin = new Writable({
            write(_chunk, _encoding, done) { done(); },
            final(done) {
              const tokenDir = join(profileHome, 'antigravity-acp');
              void mkdir(tokenDir, { recursive: true })
                .then(() => writeFile(join(tokenDir, 'antigravity-oauth-token'), JSON.stringify({
                  token: { access_token: 'clean-e2e-token', expiry: new Date(Date.now() + 3_600_000).toISOString() },
                })))
                .then(() => { resolveWait(0); done(); });
            },
          });
          return {
            _serviceBrand: undefined,
            pid: 201,
            exitCode: null,
            stdin,
            stdout,
            stderr,
            wait: () => waitPromise,
            kill: async () => { resolveWait(0); },
            dispose: async () => { stdout.end(); stderr.end(); },
          };
        }
        const stdin = new Writable({
          write(chunk, _encoding, done) {
            for (const line of chunk.toString('utf8').split('\n')) {
              if (!line.trim().startsWith('{')) continue;
              const msg = JSON.parse(line) as { id: number; method: string };
              if (msg.method === 'initialize') {
                stdout.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: {
                    protocolVersion: 1,
                    agentInfo: { name: 'Antigravity ACP Server', version: '1.5.12' },
                    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, auth: { logout: {} } },
                    authMethods: [{ id: 'oauth-personal' }],
                  },
                })}\n`);
              } else if (msg.method === 'session/new') {
                stdout.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: {
                    sessionId: '22222222-3333-4444-5555-666666666666',
                    modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'auto' }] },
                    configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'gemini-3-pro', options: [{ value: 'gemini-3-pro' }] }],
                  },
                })}\n`);
              }
            }
            done();
          },
        });
        return {
          _serviceBrand: undefined,
          pid: 202,
          exitCode: null,
          stdin,
          stdout,
          stderr,
          wait: () => waitPromise,
          kill: async () => { resolveWait(0); },
          dispose: async () => { stdout.end(); stderr.end(); },
        };
      },
    } as unknown as IHostProcessService;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/manifests/windows_amd64.json')) {
        return new Response(JSON.stringify({
          version: '1.5.12',
          url: `${ANTIGRAVITY_STORAGE_BASE}/1.5.12-42/windows-x64/cli_windows_x64.exe`,
          sha512,
        }));
      }
      if (url.startsWith(`${ANTIGRAVITY_STORAGE_BASE}/1.5.12-42/`)) {
        return new Response(payload);
      }
      if (url.includes('/oauth2/v2/userinfo')) {
        return new Response(JSON.stringify({ id: 'u-e2e', email: 'clean@example.test' }));
      }
      return new Response('not found', { status: 404 });
    });

    const services = new TestInstantiationService();
    services.set(IConfigService, { get: () => undefined, ready: Promise.resolve() } as unknown as IConfigService);
    services.set(IBootstrapService, bootstrap);
    services.set(IHostFileSystem, new HostFileSystem());
    services.set(IHostProcessService, processes);
    services.set(IAtomicTomlDocumentStore, documents);
    services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
    services.set(IAntigravityService, new SyncDescriptor(AntigravityService));

    const registry = services.get(IAgentExecutorRegistry);
    const service = services.get(IAntigravityService) as AntigravityService;
    try {
      const status = await service.install();
      expect(status.activeVersion).toBe('1.5.12');
      expect(docStore.get('managed-binaries:antigravity-acp')).toEqual({
        activeVersion: '1.5.12',
        activeDirectory: expectedDirName,
        layout: 'official-cli',
      });

      const resolved = await registry.resolveExecutable('antigravity-acp');
      expect(resolved.descriptor.selectedSource).toBe('kiki-managed');
      expect(resolved.descriptor.command).toBe(expectedExePath);
      expect(resolved.descriptor.launchArgs).toEqual(['acp']);

      const started = await service.beginLogin({ methodId: 'oauth-personal' });
      expect(started.alreadySignedIn).toBe(false);
      if (started.alreadySignedIn) throw new Error('expected pending code login');
      expect(spawnedCommands).toContain(expectedExePath);

      const completed = await service.completeLogin(started.handle, '4/0CleanE2ECode');
      expect(completed).toMatchObject({
        signedIn: true,
        retryable: false,
        profile: { signedIn: true, accountLabel: 'clean@example.test', eligibility: 'ready' },
      });

      docStore.set('managed-binaries:antigravity-acp', {
        activeVersion: '1.5.12',
        activeDirectory: sha512.slice(0, 64),
        layout: 'official-cli',
      });
      const resolvedStale = await registry.resolveExecutable('antigravity-acp');
      expect(resolvedStale.descriptor.command).toBe(expectedExePath);
      await service.status();
      expect(docStore.get('managed-binaries:antigravity-acp')).toEqual({
        activeVersion: '1.5.12',
        activeDirectory: expectedDirName,
        layout: 'official-cli',
      });
    } finally {
      await service.dispose();
      await services.dispose();
    }
  });

  it('rolls back invalid API key credentials on failed probe, rejects failed OAuth probe, and fails logout if credentials cannot be removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-agy-f5-'));
    roots.push(root);
    const profileHome = join(root, 'profile');
    const acpDir = join(profileHome, 'antigravity-acp');
    await mkdir(acpDir, { recursive: true });
    const originalSettings = JSON.stringify({ auth: { type: 'oauth-personal' }, keep: true });
    await writeFile(join(acpDir, 'settings.json'), originalSettings);

    const context = await fixture((services) => {
      services.set(IBootstrapService, { osHomeDir: root, homeDir: root, platform: 'win32', arch: 'x64', getEnv: () => undefined } as unknown as IBootstrapService);
      services.set(IAtomicTomlDocumentStore, { get: async () => undefined, set: async () => {} } as unknown as IAtomicTomlDocumentStore);
      services.set(IAgentExecutorRegistry, {
        get: () => ({ id: 'antigravity-acp', protocol: 'acp-v1', revision: 'rev', args: [], homeEnv: 'GEMINI_HOME', homeDir: profileHome, selectedSource: 'agy-cli' }),
        resolveExecutable: async () => ({
          descriptor: {
            id: 'antigravity-acp', protocol: 'acp-v1', revision: 'rev', command: 'C:/tools/agy.exe',
            launchArgs: ['acp'], args: [], homeEnv: 'GEMINI_HOME', homeDir: profileHome, selectedSource: 'agy-cli',
          },
        }),
      } as unknown as IAgentExecutorRegistry);
      services.set(IHostProcessService, {
        spawn: async (_command: string, args: readonly string[] = []) => {
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          let resolveWait!: (code: number) => void;
          const waitPromise = new Promise<number>((resolve) => { resolveWait = resolve; });
          if (args.includes('--login')) {
            setImmediate(() => {
              stdout.write('https://accounts.google.com/o/oauth2/auth?response_type=code&state=st1&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback\n');
            });
            const stdin = new Writable({
              write(_chunk, _encoding, done) { done(); },
              final(done) {
                void writeFile(join(acpDir, 'antigravity-oauth-token'), JSON.stringify({
                  token: { access_token: 'written-but-rejected', expiry: new Date(Date.now() + 3_600_000).toISOString() },
                })).then(() => { resolveWait(0); done(); });
              },
            });
            return {
              _serviceBrand: undefined, pid: 301, exitCode: null, stdin, stdout, stderr,
              wait: () => waitPromise, kill: async () => { resolveWait(0); }, dispose: async () => {},
            };
          }
          const stdin = new Writable({
            write(chunk, _encoding, done) {
              for (const line of chunk.toString('utf8').split('\n')) {
                if (!line.trim().startsWith('{')) continue;
                const msg = JSON.parse(line) as { id: number; method: string };
                if (msg.method === 'initialize') {
                  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { agentInfo: { name: 'Antigravity ACP Server', version: '1.5.8' } } })}\n`);
                } else if (msg.method === 'session/new') {
                  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'INVALID_API_KEY' } })}\n`);
                }
              }
              done();
            },
          });
          return {
            _serviceBrand: undefined, pid: 302, exitCode: null, stdin, stdout, stderr,
            wait: () => waitPromise, kill: async () => { resolveWait(0); }, dispose: async () => {},
          };
        },
      } as unknown as IHostProcessService);
    });

    try {
      await expect(context.service.beginLogin({ methodId: 'gemini-api-key', apiKey: 'invalid-key-123' }))
        .rejects.toThrow('INVALID_API_KEY');
      expect(await readFile(join(acpDir, 'settings.json'), 'utf8')).toBe(originalSettings);
      await expect(stat(join(acpDir, 'kiki-credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });

      const started = await context.service.beginLogin({ methodId: 'oauth-personal' });
      if (started.alreadySignedIn) throw new Error('expected code login');
      const outcome = await context.service.completeLogin(started.handle, '4/0BadAccountCode');
      expect(outcome).toMatchObject({ signedIn: false, retryable: false, messageCode: 'signin_failed' });
      const reloadedStatus = await context.service.status();
      expect(reloadedStatus.profile?.signedIn).toBe(false);
      const retried = await context.service.beginLogin({ methodId: 'oauth-personal' });
      expect(retried.alreadySignedIn).toBe(false);
      if (!retried.alreadySignedIn) await context.service.cancelLogin(retried.handle);

      await rm(join(acpDir, 'antigravity-oauth-token'), { force: true });
      await mkdir(join(acpDir, 'antigravity-oauth-token'), { recursive: true });
      await writeFile(join(acpDir, 'antigravity-oauth-token', 'blocker'), 'locked');
      await expect(context.service.logout()).rejects.toThrow();
    } finally {
      await context.service.dispose();
      await context.services.dispose();
    }
  });

  it('uses Linux musl manifests, enforces full initialize handshake capabilities, and reports external CLI activeVersion in status()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-agy-f10-f11-'));
    roots.push(root);
    const payload = Buffer.from('linux-musl-1.5.10');
    const sha512 = createHash('sha512').update(payload).digest('hex');
    const requestedUrls: string[] = [];

    vi.spyOn(antigravityHostOps, 'detectLinuxMusl').mockResolvedValue(true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requestedUrls.push(url);
      if (url.endsWith('/manifests/linux_amd64_musl.json')) {
        return new Response(JSON.stringify({
          version: '1.5.10',
          url: `${ANTIGRAVITY_STORAGE_BASE}/1.5.10-7/linux-x64-musl/cli_linux_x64_musl.tar.gz`,
          sha512,
        }));
      }
      return new Response('missing', { status: 404 });
    });

    let resolveExecutableCalls = 0;
    let initResult: Record<string, unknown> = {
      protocolVersion: 1,
      agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
      agentCapabilities: { loadSession: true },
    };

    const context = await fixture((services) => {
      services.set(IBootstrapService, { osHomeDir: root, homeDir: root, platform: 'linux', arch: 'x64', getEnv: () => undefined } as unknown as IBootstrapService);
      services.set(IHostFileSystem, {
        stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
        readdir: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
        remove: async () => {},
      } as unknown as IHostFileSystem);
      services.set(IAtomicTomlDocumentStore, { get: async () => undefined, set: async () => {} } as unknown as IAtomicTomlDocumentStore);
      services.set(IAgentExecutorRegistry, {
        get: () => ({ id: 'antigravity-acp', protocol: 'acp-v1', revision: 'rev', args: [] }),
        discoverMetadata: async () => ({
          id: 'antigravity-acp',
          label: 'Antigravity',
          protocol: 'acp-v1',
          installed: true,
          status: 'installed',
          checked_at: new Date().toISOString(),
          version: '1.5.9',
          path: '/usr/local/bin/antigravity',
          source: 'antigravity-cli',
          components: [],
        }),
        resolveExecutable: async () => {
          resolveExecutableCalls += 1;
          return {
            descriptor: { id: 'antigravity-acp', protocol: 'acp-v1', revision: 'rev', command: '/usr/local/bin/antigravity', selectedSource: 'antigravity-cli', version: '1.5.9', args: [] },
          };
        },
      } as unknown as IAgentExecutorRegistry);
      services.set(IHostProcessService, {
        spawn: async () => {
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          let resolveWait!: (code: number) => void;
          const waitPromise = new Promise<number>((resolve) => { resolveWait = resolve; });
          const stdin = new Writable({
            write(chunk, _encoding, done) {
              for (const line of chunk.toString('utf8').split('\n')) {
                if (!line.trim().startsWith('{')) continue;
                const msg = JSON.parse(line) as { id: number; method: string };
                if (msg.method === 'initialize') {
                  stdout.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: initResult,
                  })}\n`);
                }
              }
              done();
            },
          });
          return {
            _serviceBrand: undefined, pid: 401, exitCode: null, stdin, stdout, stderr,
            wait: () => waitPromise, kill: async () => { resolveWait(0); }, dispose: async () => {},
          };
        },
      } as unknown as IHostProcessService);
    });

    try {
      const checked = await context.service.status({ checkUpdates: true });
      expect(resolveExecutableCalls).toBe(0);
      expect(requestedUrls).toContain('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64_musl.json');
      expect(checked.latestRelease).toEqual({ version: '1.5.10', updateAvailable: true });
      expect(checked.activeVersion).toBe('1.5.9');

      vi.spyOn(antigravityHostOps, 'installOfficialAntigravityBinary').mockImplementation(async (options) => {
        await options.validate?.('/tmp/staged/antigravity');
        throw new Error('should not reach after validate failure');
      });
      await expect(context.service.install()).rejects.toThrow('sessionCapabilities.resume');

      initResult = {
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, authCapabilities: { logout: {} } },
        authMethods: [{ id: 'oauth-personal' }],
      };
      await expect(context.service.install()).rejects.toThrow('protocolVersion');

      initResult = {
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: false }, authCapabilities: { logout: {} } },
        authMethods: [{ id: 'oauth-personal' }],
      };
      await expect(context.service.install()).rejects.toThrow('sessionCapabilities.resume');

      initResult = {
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        authMethods: [{ id: 'oauth-personal' }],
      };
      await expect(context.service.install()).rejects.toThrow('both auth logout and oauth-personal');

      initResult = {
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, authCapabilities: { logout: {} } },
        authMethods: [],
      };
      await expect(context.service.install()).rejects.toThrow('both auth logout and oauth-personal');
    } finally {
      await context.service.dispose();
      await context.services.dispose();
    }
  });
});
