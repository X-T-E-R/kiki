import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import { ILogService } from '#/_base/log/log';
import { SKIP_BUILTIN_PROFILE_INSTALLATION_SECTION } from '#/workspace/workspaceAgentProfileLoader/configSection';
import {
  SHIPPED_AGENT_PROFILE_TEMPLATES,
  type ShippedAgentProfileTemplate,
} from '#/app/shippedAgentProfiles/shippedAgentProfiles';
import {
  ShippedAgentProfileManagerService,
} from '#/app/shippedAgentProfiles/shippedAgentProfileManagerService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

import { stubBootstrap } from '../bootstrap/stubs';

const capturedWarnings: string[] = [];

function logStub(): ILogService {
  return {
    _serviceBrand: undefined,
    warn: (m: unknown) => capturedWarnings.push(String(m)),
    info: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    setLevel: () => {},
  } as unknown as ILogService;
}

function configStub(options?: { skipInstallation?: readonly string[] }): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidSectionChange: () => ({ dispose: () => {} }),
    get: (domain: string) => {
      if (domain === SKIP_BUILTIN_PROFILE_INSTALLATION_SECTION) return options?.skipInstallation;
      return undefined;
    },
    inspect: () => ({ value: undefined, defaultValue: undefined, userValue: undefined, memoryValue: undefined }),
    getAll: () => ({}),
    set: async () => {},
    replace: async () => {},
    reload: async () => {},
    diagnostics: () => [],
  } as unknown as IConfigService;
}

function template(
  id: string,
  text: string,
  options?: { fresh?: boolean },
): ShippedAgentProfileTemplate {
  return {
    id,
    fileName: `${id}.md`,
    text,
    materializeOnFreshInstall: options?.fresh ?? true,
  };
}

function agentText(body = 'agent body'): string {
  return `---\nname: agent\ndescription: Default agent\nmain: true\ntools:\n  - Read\nsubagents: "*"\n---\n\n${body}\n`;
}

describe('ShippedAgentProfileManagerService', () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'shipped-profiles-')));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function manager(
    templates: readonly ShippedAgentProfileTemplate[] = SHIPPED_AGENT_PROFILE_TEMPLATES,
    config: IConfigService = configStub(),
  ): ShippedAgentProfileManagerService {
    return new ShippedAgentProfileManagerService(
      stubBootstrap(home),
      new HostFileSystem(),
      logStub(),
      config,
      undefined,
      templates,
    );
  }

  async function activeText(id: string): Promise<string> {
    return readFile(join(home, 'agents', 'builtin', `${id}.md`), 'utf8');
  }

  async function activeExists(id: string): Promise<boolean> {
    try {
      await readFile(join(home, 'agents', 'builtin', `${id}.md`), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  it('materializes the fresh-install set on first run', async () => {
    const service = manager();
    await service.ready;
    if (!(await activeExists('agent'))) {
      const fsp = await import('node:fs/promises');
      const manifest = await fsp.readFile(join(home, 'agent-profile-state', 'manifest.json'), 'utf8').catch(() => 'NO MANIFEST');
      const builtinList = await fsp.readdir(join(home, 'agents', 'builtin')).catch(() => 'NO DIR');
      const statDir = await fsp.stat(join(home, 'agents', 'builtin')).catch((e) => String(e));
      throw new Error('DBG2 manifest=' + manifest + ' builtinList=' + JSON.stringify(builtinList) + ' statDir=' + String(statDir) + ' warnings=' + JSON.stringify(capturedWarnings));
    }

    for (const id of ['agent', 'explore', 'general']) {
      expect(await activeExists(id), id).toBe(true);
      expect(await activeText(id), id).toBe(
        SHIPPED_AGENT_PROFILE_TEMPLATES.find((candidate) => candidate.id === id)!.text,
      );
    }
    expect(await activeExists('coder')).toBe(false);
    expect(await activeExists('plan')).toBe(false);

    const entries = await service.status();
    for (const id of ['agent', 'explore', 'general']) {
      const entry = entries.find((candidate) => candidate.templateId === id)!;
      expect(entry.status, id).toBe('clean');
      expect(entry.managed, id).toBe(true);
      expect(entry.baselineHash, id).toBeDefined();
    }
  });

  it('skips materializing the main profile when SYSTEM.md provides it', async () => {
    await writeFile(join(home, 'SYSTEM.md'), 'You are a custom main agent.\n');
    const service = manager();
    await service.ready;

    expect(await activeExists('agent')).toBe(false);
    expect((await service.status()).find((entry) => entry.templateId === 'agent')?.status).toBe('adopted');
    for (const id of ['explore', 'general']) {
      expect(await activeExists(id), id).toBe(true);
    }
  });

  it('adopts same-name user files instead of materializing over them', async () => {
    await mkdir(join(home, 'agents'), { recursive: true });
    await writeFile(join(home, 'agents', 'explore.md'), '---\nname: explore\ndescription: mine\n---\n\nMy explore.\n');
    const service = manager();
    await service.ready;

    expect(await activeExists('explore')).toBe(false);
    const entry = (await service.status()).find((candidate) => candidate.templateId === 'explore')!;
    expect(entry.status).toBe('adopted');
    expect(entry.managed).toBe(false);
    expect(await readFile(join(home, 'agents', 'explore.md'), 'utf8')).toContain('My explore.');
  });

  it('uses the renamed policy only for installation and leaves managed copies active', async () => {
    const templates = [template('agent', agentText('v1'))];
    const skipped = manager(templates, configStub({ skipInstallation: ['agent'] }));
    await skipped.ready;
    expect(await activeExists('agent')).toBe(false);
    skipped.dispose();

    const installed = manager(templates, configStub({ skipInstallation: [] }));
    await installed.ready;
    expect(await activeText('agent')).toBe(agentText('v1'));
    installed.dispose();

    const updated = manager([template('agent', agentText('v2'))], configStub({ skipInstallation: ['agent'] }));
    await updated.ready;
    expect(await activeText('agent')).toBe(agentText('v2'));
    expect((await updated.status())[0]).toMatchObject({ status: 'clean', managed: true });
  });

  it('advances unmodified managed files to the installed original and keeps a backup', async () => {
    const v1 = [template('agent', agentText('v1'))];
    const first = manager(v1);
    await first.ready;
    first.dispose();
    const before = await activeText('agent');

    const v2 = [template('agent', agentText('v2'))];
    const second = manager(v2);
    await second.ready;

    expect(await activeText('agent')).toBe(agentText('v2'));
    const entry = (await second.status())[0]!;
    expect(entry.status).toBe('clean');
    expect(entry.baselineHash).toBeDefined();
    const backups = await readdir(join(home, 'agent-profile-state', 'backups'));
    expect(backups.length).toBe(1);
    const backedUp = await readFile(
      join(home, 'agent-profile-state', 'backups', backups[0]!, 'agent.md'),
      'utf8',
    );
    expect(backedUp).toBe(before);
  });

  it('never overwrites user-modified files and stores the offered original', async () => {
    const v1 = [template('agent', agentText('v1'))];
    const first = manager(v1);
    await first.ready;
    first.dispose();

    const customized = agentText('my customization');
    await writeFile(join(home, 'agents', 'builtin', 'agent.md'), customized);

    const v2 = [template('agent', agentText('v2'))];
    const second = manager(v2);
    await second.ready;

    expect(await activeText('agent')).toBe(customized);
    const entry = (await second.status())[0]!;
    expect(entry.status).toBe('update-available');
    expect(entry.offeredHash).toBeDefined();
    const offered = await readFile(
      join(home, 'agent-profile-state', 'originals', `${entry.offeredHash}.md`),
      'utf8',
    );
    expect(offered).toBe(agentText('v2'));
  });

  it('recognizes user content that already matches the new original', async () => {
    const v1 = [template('agent', agentText('v1'))];
    const first = manager(v1);
    await first.ready;
    first.dispose();

    await writeFile(join(home, 'agents', 'builtin', 'agent.md'), agentText('v2'));

    const v2 = [template('agent', agentText('v2'))];
    const second = manager(v2);
    await second.ready;

    expect(await activeText('agent')).toBe(agentText('v2'));
    expect((await second.status())[0]!.status).toBe('clean');
  });

  it('treats content modified back to the baseline as custom, not updated', async () => {
    const v1 = [template('agent', agentText('v1'))];
    const first = manager(v1);
    await first.ready;
    first.dispose();

    await writeFile(join(home, 'agents', 'builtin', 'agent.md'), agentText('rolled back'));

    const second = manager(v1);
    await second.ready;

    expect(await activeText('agent')).toBe(agentText('rolled back'));
    expect((await second.status())[0]!.status).toBe('custom');
  });

  it('materializes newly shipped templates on upgrade', async () => {
    const v1 = [template('agent', agentText())];
    const first = manager(v1);
    await first.ready;
    first.dispose();
    expect(await activeExists('general')).toBe(false);

    const v2 = [template('agent', agentText()), template('general', '---\nname: general\ndescription: general\n---\n\nGeneral.\n')];
    const second = manager(v2);
    await second.ready;

    expect(await activeExists('general')).toBe(true);
    const entry = (await second.status()).find((candidate) => candidate.templateId === 'general')!;
    expect(entry.status).toBe('clean');
    expect(entry.managed).toBe(true);
  });

  it('restores the installed original after customization and backs up the custom version', async () => {
    const v1 = [template('agent', agentText('v1'))];
    const first = manager(v1);
    await first.ready;
    first.dispose();

    const customized = agentText('my customization');
    await writeFile(join(home, 'agents', 'builtin', 'agent.md'), customized);

    const service = manager(v1);
    await service.ready;
    const restored = await service.restoreOriginal('agent');

    expect(restored.status).toBe('clean');
    expect(await activeText('agent')).toBe(agentText('v1'));
    const backups = await readdir(join(home, 'agent-profile-state', 'backups'));
    expect(backups.some((name) => name.startsWith('restore-'))).toBe(true);
  });

  it('refuses to restore unmanaged templates', async () => {
    await mkdir(join(home, 'agents'), { recursive: true });
    await writeFile(join(home, 'agents', 'explore.md'), '---\nname: explore\ndescription: mine\n---\n\nMy explore.\n');
    const service = manager();
    await service.ready;

    await expect(service.restoreOriginal('explore')).rejects.toThrow(/not managed/);
  });

  it('treats a deleted managed file as removal intent and does not resurrect it', async () => {
    const v1 = [template('agent', agentText('v1'))];
    const first = manager(v1);
    await first.ready;
    first.dispose();

    await rm(join(home, 'agents', 'builtin', 'agent.md'));

    const second = manager(v1);
    await second.ready;
    expect((await second.status())[0]!.status).toBe('removed');
    expect(await activeExists('agent')).toBe(false);

    second.dispose();
    const third = manager(v1);
    await third.ready;
    expect((await third.status())[0]!.status).toBe('removed');
    expect(await activeExists('agent')).toBe(false);
  });

  it('protects pre-existing unmanaged files at the managed path', async () => {
    await mkdir(join(home, 'agents', 'builtin'), { recursive: true });
    const foreign = agentText('foreign content');
    await writeFile(join(home, 'agents', 'builtin', 'agent.md'), foreign);

    const service = manager([template('agent', agentText('v1'))]);
    await service.ready;

    expect(await activeText('agent')).toBe(foreign);
    const entry = (await service.status())[0]!;
    expect(entry.status).toBe('unmanaged');
    expect(entry.managed).toBe(false);
  });

  it('materializes once the adoption condition disappears', async () => {
    await writeFile(join(home, 'SYSTEM.md'), 'custom main\n');
    const first = manager([template('agent', agentText('v1'))]);
    await first.ready;
    first.dispose();
    expect(await activeExists('agent')).toBe(false);

    await rm(join(home, 'SYSTEM.md'));
    const second = manager([template('agent', agentText('v1'))]);
    await second.ready;

    expect(await activeExists('agent')).toBe(true);
    expect((await second.status())[0]!.status).toBe('clean');
  });

  it('reconciles again are idempotent for a clean install', async () => {
    const templates = [template('agent', agentText())];
    const first = manager(templates);
    await first.ready;
    first.dispose();

    const second = manager(templates);
    await second.ready;
    const third = manager(templates);
    await third.ready;

    expect((await third.status())[0]!.status).toBe('clean');
    const backups = await readdir(join(home, 'agent-profile-state', 'backups')).catch(() => [] as string[]);
    expect(backups).toEqual([]);
  });
});
