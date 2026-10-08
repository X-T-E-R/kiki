import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { AcpLoginHelper, type HostProcessServiceLike } from '@kiki/acp-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import {
  ANTIGRAVITY_INSTALL_TIMEOUT_MS, AntigravityService, IAntigravityService,
  type AntigravityInstallProgress, type AntigravityInstallProgressed,
} from '#/app/agentExecutor/antigravityService';
import { IEventService } from '#/app/event/event';
import * as archive from '#/os/backends/node-local/binaryArchive';
import { antigravityProcessService, antigravitySettingsHome } from '#/app/agentExecutor/antigravityProcess';
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
  services.set(IHostFileSystem, {} as IHostFileSystem);
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
      expect(await context.service.beginLogin('oauth-business')).toEqual({ alreadySignedIn: true });
      expect(JSON.parse(await readFile(join(context.root, 'custom-gemini/antigravity-acp/settings.json'), 'utf8'))).toMatchObject({ auth: { type: 'oauth-business' } });
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

      const spawn = vi.fn<HostProcessServiceLike['spawn']>();
      const processes: HostProcessServiceLike = { spawn };
      const descriptor = { id: 'antigravity-acp', protocol: 'acp-v1', revision: 'fixture', args: [], homeEnv: 'GEMINI_HOME', homeDir: '~/profile' } as const;
      const settingsPath = join(childHome, 'profile', 'antigravity-acp', 'settings.json');
      await mkdir(join(childHome, 'profile', 'antigravity-acp'), { recursive: true });
      const originalSettings = '{broken';
      await writeFile(settingsPath, originalSettings);
      const wrapped = antigravityProcessService(processes, descriptor, bootstrap);
      await wrapped.spawn('antigravity', [], { env: { HOME: childHome, GEMINI_API_KEY: 'fixture-secret' } });
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
      await context.service.install();
      expect(install.mock.calls[0]?.[0].timeoutMs).toBe(ANTIGRAVITY_INSTALL_TIMEOUT_MS);
      expect(context.published.map((event) => event.stage)).toEqual(['download', 'download', 'extract', 'activate', 'done']);
      expect(new Set(context.published.map((event) => event.installId)).size).toBe(1);
      expect(context.published.every((event) => event.version === '1.2.1')).toBe(true);
    } finally { await context.service.dispose(); await context.services.dispose(); }
  });

  it('ends a timed-out download with one failed event and no activate', async () => {
    const context = await installFixture();
    vi.spyOn(archive, 'installBinaryArchive').mockImplementation(async (options) => {
      options.onProgress?.({ stage: 'download', receivedBytes: 0 });
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    try {
      await expect(context.service.install()).rejects.toThrow('timeout');
      expect(context.published.map((event) => event.stage)).toEqual(['download', 'failed']);
      expect(context.published.at(-1)).toMatchObject({ stage: 'failed', timedOut: true });
      expect((await context.service.status()).phase).toBe('failed');
    } finally { await context.service.dispose(); await context.services.dispose(); }
  });

  it('marks an ordinary failure as not timed out', async () => {
    const context = await installFixture();
    vi.spyOn(archive, 'installBinaryArchive').mockRejectedValue(new Error('Binary download failed (HTTP 404)'));
    try {
      await expect(context.service.install('1.9.9')).rejects.toThrow('HTTP 404');
      expect(context.published).toEqual([expect.objectContaining({ stage: 'failed', timedOut: false, version: '1.9.9', error: 'Binary download failed (HTTP 404)' })]);
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
        .toEqual({ signedIn: true, retryable: false });
    } finally { await context.service.dispose(); await context.services.dispose(); }
  });
});
