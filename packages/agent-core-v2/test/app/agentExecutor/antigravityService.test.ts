import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { AcpLoginHelper } from '@kiki/acp-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { AntigravityService, IAntigravityService } from '#/app/agentExecutor/antigravityService';
import { antigravitySettingsHome } from '#/app/agentExecutor/antigravityProcess';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
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
    } finally { await context.service.dispose(); context.services.dispose(); }
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
    } finally { context.services.dispose(); }
  });
});
