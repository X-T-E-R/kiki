import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import {
  IWorkspaceTrust,
  type WorkspaceTrustChange,
} from '#/workspace/workspaceTrust/workspaceTrust';
import {
  WorkspaceTrustService,
  workspaceTrustTrustedKey,
} from '#/workspace/workspaceTrust/workspaceTrustService';
import {
  deleteWorkspaceTrust,
  readWorkspaceTrust,
  writeWorkspaceTrust,
} from '#/workspace/workspaceTrust/trustRecord';

import { registerStateServices } from '../../state/stubs';

describe('WorkspaceTrustService', () => {
  let homeDir: string;
  let cwd: string;
  let disposables: DisposableStore;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-workspace-trust-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'kimi-workspace-trust-cwd-'));
    disposables = new DisposableStore();
  });

  afterEach(async () => {
    await disposables.dispose();
    await Promise.all([
      rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
      rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
    ]);
  });

  function createService(
    root: string,
    events?: WorkspaceTrustChange[],
  ): { service: IWorkspaceTrust; states: IWorkspaceStateService } {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerStateServices(reg);
        reg.definePartialInstance(IWorkspaceContext, { cwd: root });
        reg.defineInstance(
          IAtomicDocumentStore,
          new JsonAtomicDocumentStore(new FileStorageService(homeDir)),
        );
        reg.define(IWorkspaceTrust, WorkspaceTrustService);
      },
    });
    const service = ix.get(IWorkspaceTrust);
    if (events !== undefined) {
      service.onDidChange((change) => events.push(change));
    }
    return { service, states: ix.get(IWorkspaceStateService) };
  }

  it('defaults to untrusted when no marker exists', async () => {
    const { service } = createService(cwd);
    await service.ready;

    expect(service.isTrusted()).toBe(false);
    expect(await service.get()).toBe(false);
  });

  it('trust() flips the state, fires once, and stays idempotent', async () => {
    const events: WorkspaceTrustChange[] = [];
    const { service } = createService(cwd, events);
    await service.ready;

    await service.trust();
    await service.trust();

    expect(service.isTrusted()).toBe(true);
    expect(await service.get()).toBe(true);
    expect(events).toEqual([{ trusted: true }]);
  });

  it('untrust() revokes the state and both directions stay idempotent', async () => {
    const events: WorkspaceTrustChange[] = [];
    const { service } = createService(cwd, events);
    await service.ready;

    await service.untrust();
    await service.trust();
    await service.untrust();
    await service.untrust();

    expect(service.isTrusted()).toBe(false);
    expect(events).toEqual([{ trusted: true }, { trusted: false }]);
  });

  it('keeps the marker across a restart', async () => {
    const { service: first } = createService(cwd);
    await first.ready;
    await first.trust();

    const { service: second } = createService(cwd);
    await second.ready;

    expect(second.isTrusted()).toBe(true);
  });

  it('reads a historical typed-root marker without writing and migrates only in the owner', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    const root = 'C:/Users/Example/Project';
    const legacyKey = 'wd_project_aba194281633';
    const canonicalKey = 'wd_project_b891d593d88e';
    const record = { root, trustedAt: 1 };
    await docs.set('workspace-trust', legacyKey, record);
    expect(encodeWorkDirKey(root)).toBe(canonicalKey);
    expect(await readWorkspaceTrust(docs, root)).toBe(true);
    expect(await docs.get('workspace-trust', canonicalKey)).toBeUndefined();
    expect(await docs.get('workspace-trust', legacyKey)).toEqual(record);

    const { service } = createService(root);
    await service.ready;
    expect(await docs.get('workspace-trust', canonicalKey)).toEqual(record);
    expect(await docs.get('workspace-trust', legacyKey)).toBeUndefined();
    await service.untrust();
    expect(await readWorkspaceTrust(docs, root)).toBe(false);
  });

  it('shares one trust key across UNC and drive-letter spelling variants', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    await writeWorkspaceTrust(docs, '//server/share/repo', 1);
    expect(await readWorkspaceTrust(docs, '\\\\SERVER\\SHARE\\REPO')).toBe(true);
    expect(await readWorkspaceTrust(docs, '//Server/Share/Repo')).toBe(true);

    await writeWorkspaceTrust(docs, 'C:\\Users\\Foo\\Repo', 2);
    expect(await readWorkspaceTrust(docs, 'c:/users/foo/repo')).toBe(true);
  });

  it('deletes both canonical and legacy trust markers', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    const root = 'C:/Users/Example/Project';
    const legacyKey = 'wd_project_aba194281633';
    await docs.set('workspace-trust', legacyKey, { root, trustedAt: 1 });
    await writeWorkspaceTrust(docs, root, 2);
    await writeWorkspaceTrust(docs, '/srv/other', 3);

    await deleteWorkspaceTrust(docs, 'c:/users/example/project');
    expect(await readWorkspaceTrust(docs, '/srv/other')).toBe(true);

    await expect(docs.get('workspace-trust', legacyKey)).resolves.toBeUndefined();
    await expect(readWorkspaceTrust(docs, root)).resolves.toBe(false);
  });

  it('tracks different roots independently', async () => {
    const other = mkdtempSync(join(tmpdir(), 'kimi-workspace-trust-other-'));
    try {
      const { service: first } = createService(cwd);
      await first.ready;
      await first.trust();

      const { service: second } = createService(other);
      await second.ready;

      expect(second.isTrusted()).toBe(false);
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('registers the trusted flag into the workspace state container', async () => {
    const { service, states } = createService(cwd);
    await service.ready;

    expect(states.has(workspaceTrustTrustedKey)).toBe(true);
    expect(states.get(workspaceTrustTrustedKey)).toBe(false);

    const seen: boolean[] = [];
    states.onDidChange(workspaceTrustTrustedKey)((value) => seen.push(value));
    await service.trust();
    await service.untrust();

    expect(seen).toEqual([true, false]);
    expect(states.get(workspaceTrustTrustedKey)).toBe(false);
    expect(states.snapshot()['workspaceTrust.trusted']).toBe(false);
  });
});
