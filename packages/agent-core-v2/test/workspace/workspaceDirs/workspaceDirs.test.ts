import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Emitter, Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService, type HostFsChange } from '#/os/interface/hostFsWatch';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import { IWorkspaceTrust, type WorkspaceTrustChange } from '#/workspace/workspaceTrust/workspaceTrust';

import { registerStateServices } from '../../state/stubs';

describe('WorkspaceDirsService project-local trust', () => {
  let root: string;
  let workDir: string;
  let homeDir: string;
  let disposables: DisposableStore;

  beforeEach(async () => {
    disposables = new DisposableStore();
    root = await mkdtemp(join(tmpdir(), 'kiki-local-dirs-'));
    workDir = join(root, 'repo');
    homeDir = join(root, 'home');
    await Promise.all([join(workDir, '.git'), join(workDir, '.kiki'), homeDir].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(join(workDir, '.kiki', 'local.toml'), '[workspace]\nadditional_dir = ["~"]\n');
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function createService(initiallyTrusted: boolean) {
    let trusted = initiallyTrusted;
    const emitter = new Emitter<WorkspaceTrustChange>();
    disposables.add(emitter);
    const trust: IWorkspaceTrust = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: async () => trusted,
      isTrusted: () => trusted,
      trust: async () => {
        trusted = true;
        emitter.fire({ trusted: true });
      },
      untrust: async () => {
        trusted = false;
        emitter.fire({ trusted: false });
      },
      onDidChange: emitter.event,
    };
    const fs = new HostFileSystem();
    const readText = vi.spyOn(fs, 'readText');
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerStateServices(reg);
        reg.definePartialInstance(IWorkspaceContext, { cwd: workDir });
        reg.definePartialInstance(IBootstrapService, { osHomeDir: homeDir });
        reg.defineInstance(IWorkspaceTrust, trust);
        reg.defineInstance(IHostFileSystem, fs);
        reg.define(IProjectLocalConfigService, FileProjectLocalConfigService);
        reg.definePartialInstance(ILogService, { warn: () => {} });
        reg.definePartialInstance(IHostFsWatchService, { watch: () => ({ ready: Promise.resolve(), onDidChange: Event.None as Event<HostFsChange>, dispose: () => {} }) });
        reg.define(IWorkspaceDirs, WorkspaceDirsService);
      },
    });
    return { dirs: ix.get(IWorkspaceDirs), trust, readText };
  }

  it('does not load untrusted additional_dir or expand ~ on open', async () => {
    const { dirs, readText } = createService(false);
    await dirs.ready;
    expect(dirs.additionalDirs).toEqual([]);
    expect(dirs.sessionInfo().additionalDirs).toEqual([]);
    expect(readText).not.toHaveBeenCalled();
    await expect(dirs.addDir({ path: homeDir })).rejects.toThrow('Trust the workspace');
    expect(readText).not.toHaveBeenCalled();
  });

  it('loads a trusted additional_dir and withdraws it when trust is revoked', async () => {
    const { dirs, trust } = createService(true);
    await dirs.ready;
    expect(dirs.additionalDirs).toEqual([homeDir.replaceAll('\\', '/')]);
    await trust.untrust();
    expect(dirs.additionalDirs).toEqual([]);
    expect(dirs.sessionInfo().additionalDirs).toEqual([]);
  });

  it('loads disk directories on trust while keeping explicit ephemeral dirs separate', async () => {
    const { dirs, trust } = createService(false);
    await dirs.ready;
    await dirs.addDir({ path: workDir, persist: false });
    expect(dirs.additionalDirs).toEqual([workDir.replaceAll('\\', '/')]);
    const loaded = new Promise<void>((resolve) => {
      const listener = dirs.onDidChange(() => {
        if (!dirs.additionalDirs.includes(homeDir.replaceAll('\\', '/'))) return;
        listener.dispose();
        resolve();
      });
    });
    await trust.trust();
    await loaded;
    expect(dirs.sessionInfo().additionalDirs).toEqual([homeDir, workDir].map((path) => path.replaceAll('\\', '/')));
    await trust.untrust();
    expect(dirs.additionalDirs).toEqual([workDir.replaceAll('\\', '/')]);
  });
});
