
import { describe, expect, it } from 'vitest';

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { ISessionManager, type UnguardedSessionLifecycle } from '#/app/sessionManager/sessionManager';
import {
  ISessionIndex,
  ISessionIndexMirror,
  CREATED_BY_SESSION_ID_KEY,
  type SessionSummary,
} from '#/app/sessionIndex/sessionIndex';
import { readSessionArchiveFamily } from '#/app/sessionIndex/sessionArchiveFamily';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import type { ILogService } from '#/_base/log/log';
import { IUsageFactStore } from '#/app/usageFacts/usageFactStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import {
  setColdSessionArchived,
  setSessionArchivedBatch,
  updateColdSessionProfile,
} from '#/workspace/sessionLifecycle/coldSessionArchive';

function accessor(
  entries: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>,
): ServicesAccessor {
  return {
    get<T>(id: ServiceIdentifier<T>): T {
      for (const [key, value] of entries) {
        if (key === id) return value as T;
      }
      throw new Error(`Unexpected service request: ${String(id)}`);
    },
  };
}

const summary: SessionSummary = {
  id: 's1',
  workspaceId: 'wd',
  cwd: '/workspace',
  createdAt: 1,
  updatedAt: 1,
  archived: false,
};

interface ColdPathOptions {
  readonly storeGet: (scope: string, key: string) => Promise<SessionMeta | undefined>;
  readonly indexSummary?: SessionSummary;
  readonly onMirrorRecord?: (recorded: SessionSummary) => void;
  readonly onStoreSet?: (scope: string, key: string, value: unknown) => void;
  readonly onStoreDelete?: (scope: string, key: string) => void;
  readonly onSetSessionPrivacy?: (recorded: SessionSummary) => void | Promise<void>;
  readonly resumeError?: Error;
}

function coldPathAccessor(options: ColdPathOptions): ServicesAccessor {
  return accessor([
    [
      ISessionManager,
      {
        withLifecycleSerialization: <T>(
          _id: string,
          work: (unguarded: UnguardedSessionLifecycle) => Promise<T>,
        ): Promise<T> => work({ archive: async () => {}, restore: async () => undefined, delete: async () => {} }),
        whenResumeSettled: async () => {
          if (options.resumeError !== undefined) throw options.resumeError;
        },
        get: () => undefined,
      },
    ],
    [ISessionIndex, { get: async () => options.indexSummary ?? summary }],
    [IBootstrapService, { scope: () => 'sessions' }],
    [
      IAtomicDocumentStore,
      {
        get: (scope: string, key: string) => options.storeGet(scope, key),
        set: async (scope: string, key: string, value: unknown) => {
          options.onStoreSet?.(scope, key, value);
        },
        delete: async (scope: string, key: string) => {
          options.onStoreDelete?.(scope, key);
        },
      },
    ],
    [
      ISessionIndexMirror,
      { record: (recorded: SessionSummary) => options.onMirrorRecord?.(recorded) },
    ],
    [
      IUsageFactStore,
      { setSessionPrivacy: async (recorded: SessionSummary) => options.onSetSessionPrivacy?.(recorded) },
    ],
    [IEventService, { publish: () => {} }],
  ]);
}

describe('setSessionArchivedBatch', () => {
  it('resolves cold archive dependencies before the invocation accessor expires', async () => {
    const recorded: SessionSummary[] = [];
    const source = coldPathAccessor({
      storeGet: async () => ({ id: 's1', createdAt: 1, updatedAt: 2, archived: false }),
      onMirrorRecord: (value) => recorded.push(value),
    });
    let expired = false;
    const scopedAccessor: ServicesAccessor = {
      get<T>(id: ServiceIdentifier<T>): T {
        if (expired) throw new Error('invocation accessor expired');
        return source.get(id);
      },
    };
    const archiving = setColdSessionArchived(scopedAccessor, 's1', true);
    expired = true;
    await expect(archiving).resolves.toBe('updated');
    expect(recorded).toEqual([expect.objectContaining({ id: 's1', archived: true })]);
  });

  it('maps a metadata read failure to a per-item internal error, not not_found', async () => {
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({
        storeGet: async () => {
          throw new Error('disk on fire');
        },
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: false, reason: 'error', message: 'disk on fire' }]);
  });

  it('maps a missing metadata document to not_found', async () => {
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({ storeGet: async () => undefined }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([
      { id: 's1', ok: false, reason: 'not_found', message: 'session s1 does not exist' },
    ]);
  });

  it('mirrors the persisted metadata, not a stale index summary', async () => {
    const recorded: SessionSummary[] = [];
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({
        indexSummary: { ...summary, title: 'stale', lastPrompt: 'stale-p', updatedAt: 1 },
        storeGet: async () => ({
          id: 's1',
          title: 'fresh',
          lastPrompt: 'fresh-p',
          createdAt: 1,
          updatedAt: 9,
          archived: false,
        }),
        onMirrorRecord: (r) => recorded.push(r),
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: true }]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      workspaceId: 'wd',
      title: 'fresh',
      lastPrompt: 'fresh-p',
      updatedAt: 9,
      archived: true,
    });
    expect(typeof recorded[0]?.archivedAt).toBe('number');
  });

  it('normalizes legacy v1 metadata before persisting and mirroring', async () => {
    const recorded: SessionSummary[] = [];
    const written: unknown[] = [];
    const legacy = {
      workDir: '/workspace',
      customTitle: 'legacy title',
      createdAt: '2026-07-21T19:40:00.000Z',
      updatedAt: '2026-07-22T02:00:00.000Z',
      archived: false,
    } as unknown as SessionMeta;
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({
        storeGet: async () => legacy,
        onMirrorRecord: (r) => recorded.push(r),
        onStoreSet: (_scope, _key, value) => written.push(value),
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: true }]);

    const rec = recorded[0];
    expect(rec?.title).toBe('legacy title');
    expect(rec?.updatedAt).toBe(Date.parse('2026-07-22T02:00:00.000Z'));

    const persisted = written[0] as Record<string, unknown>;
    expect(persisted['version']).toBe(2);
    expect(typeof persisted['updatedAt']).toBe('number');
    expect(persisted['customTitle']).toBeUndefined();
    expect(persisted['isCustomTitle']).toBe(true);
  });

  it('cold-classifies the item when a concurrent resume failed', async () => {
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({
        storeGet: async () => ({ id: 's1', createdAt: 1, updatedAt: 2, archived: false }),
        resumeError: new Error('resume boom'),
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: true }]);
  });

  it('reads and migrates the legacy session-meta location before answering not_found', async () => {
    const written: Array<{ scope: string; value: unknown }> = [];
    const deleted: string[] = [];
    const meta: SessionMeta = { id: 's1', createdAt: 1, updatedAt: 2, archived: false };
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({
        storeGet: async (scope) => (scope.endsWith('/session-meta') ? meta : undefined),
        onStoreSet: (scope, _key, value) => written.push({ scope, value }),
        onStoreDelete: (scope) => deleted.push(scope),
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: true }]);
    expect(written).toHaveLength(1);
    expect(written[0]?.scope.endsWith('/session-meta')).toBe(false);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.endsWith('/session-meta')).toBe(true);
  });

  it('preserves private flag in mirrored summary when archiving a cold session', async () => {
    const recorded: SessionSummary[] = [];
    const outcome = await setColdSessionArchived(
      coldPathAccessor({
        storeGet: async () => ({
          id: 's1',
          createdAt: 1,
          updatedAt: 5,
          archived: false,
          private: true,
        }),
        onMirrorRecord: (r) => recorded.push(r),
      }),
      's1',
      true,
    );
    expect(outcome).toBe('updated');
    expect(recorded).toEqual([expect.objectContaining({ id: 's1', archived: true, private: true })]);
  });
});

describe('updateColdSessionProfile', () => {
  it('updates custom title on a cold session without bumping updatedAt or losing custom metadata', async () => {
    const recorded: SessionSummary[] = [];
    const written: unknown[] = [];
    const outcome = await updateColdSessionProfile(
      coldPathAccessor({
        indexSummary: { ...summary, cwd: '/deleted/worktree' },
        storeGet: async () => ({
          id: 's1',
          cwd: '/deleted/worktree',
          title: 'auto',
          titleKind: 'generated',
          createdAt: 10,
          updatedAt: 42,
          archived: false,
          custom: { 'kiki.pinned': true },
        }),
        onMirrorRecord: (r) => recorded.push(r),
        onStoreSet: (_scope, _key, value) => written.push(value),
      }),
      's1',
      { title: 'Renamed Cold' },
    );
    expect(outcome).toEqual({
      kind: 'updated',
      workspaceId: 'wd',
      cwd: '/deleted/worktree',
      meta: expect.objectContaining({
        id: 's1',
        title: 'Renamed Cold',
        titleKind: 'custom',
        updatedAt: 42,
        custom: { 'kiki.pinned': true },
      }),
    });
    expect(written[0]).toMatchObject({
      title: 'Renamed Cold',
      titleKind: 'custom',
      isCustomTitle: true,
      updatedAt: 42,
      custom: { 'kiki.pinned': true },
    });
    expect(recorded).toEqual([
      expect.objectContaining({
        id: 's1',
        title: 'Renamed Cold',
        updatedAt: 42,
        ownUpdatedAt: 42,
        cwd: '/deleted/worktree',
        custom: { 'kiki.pinned': true },
      }),
    ]);
  });

  it('preserves promotion provenance and internal goal state while replacing custom metadata', async () => {
    const promotedFrom = {
      sessionId: 'source-session',
      agentId: 'research-agent',
      agentName: 'Researcher',
      profile: 'researcher',
      promotedAt: 123,
    };
    let stored: SessionMeta = {
      id: 's1',
      cwd: '/deleted/worktree',
      createdAt: 10,
      updatedAt: 20,
      archived: false,
      custom: { goal: { objective: 'Preserve saved work', status: 'active' }, promoted_from: promotedFrom, 'kiki.pinned': true, pinned_at: 100, retained: 'drop' },
    };
    const apply = (metadata: Record<string, unknown>) => updateColdSessionProfile(
      coldPathAccessor({
        storeGet: async () => stored,
        onStoreSet: (_scope, _key, value) => {
          stored = value as SessionMeta;
        },
      }),
      's1',
      { metadata },
    );

    const unpinned = await apply({ 'kiki.pinned': false });
    expect(unpinned).toMatchObject({
      kind: 'updated',
      meta: { custom: { goal: { objective: 'Preserve saved work', status: 'active' }, promoted_from: promotedFrom, 'kiki.pinned': false } },
    });
    expect(unpinned.kind === 'updated' ? unpinned.meta.custom : undefined).not.toHaveProperty('pinned_at');
    expect(unpinned.kind === 'updated' ? unpinned.meta.custom : undefined).not.toHaveProperty('retained');

    const pinned = await apply({ 'kiki.pinned': true, pinned_at: 200 });
    expect(pinned).toMatchObject({
      kind: 'updated',
      meta: { custom: { goal: { objective: 'Preserve saved work', status: 'active' }, promoted_from: promotedFrom, 'kiki.pinned': true, pinned_at: 200 } },
    });

    const unpinnedAgain = await apply({ 'kiki.pinned': false });
    expect(unpinnedAgain).toMatchObject({
      kind: 'updated',
      meta: { custom: { goal: { objective: 'Preserve saved work', status: 'active' }, promoted_from: promotedFrom, 'kiki.pinned': false } },
    });
    expect(unpinnedAgain.kind === 'updated' ? unpinnedAgain.meta.custom : undefined).not.toHaveProperty('pinned_at');
  });

  it('orders usage privacy updates around persistence and strips statistics when marking private', async () => {
    const steps: string[] = [];
    const recorded: SessionSummary[] = [];
    let stored: SessionMeta = {
      id: 's1',
      cwd: '/deleted/worktree',
      createdAt: 10,
      updatedAt: 20,
      archived: false,
      usage: {
        total: { inputOther: 5, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
        byModel: { m: { inputOther: 5, output: 3, inputCacheRead: 0, inputCacheCreation: 0 } },
      },
      agents: {
        main: {
          type: 'main',
          model: 'm',
          toolCallCount: 4,
          usage: { inputOther: 5, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
        },
      },
    };
    const makePrivate = await updateColdSessionProfile(
      coldPathAccessor({
        storeGet: async () => stored,
        onSetSessionPrivacy: (s) => {
          steps.push(`privacy:${String(s.private)}`);
        },
        onStoreSet: (_scope, _key, value) => {
          steps.push('persist');
          stored = value as SessionMeta;
        },
        onMirrorRecord: (s) => {
          steps.push('mirror');
          recorded.push(s);
        },
      }),
      's1',
      { private: true },
    );
    expect(makePrivate.kind).toBe('updated');
    expect(steps).toEqual(['privacy:true', 'persist', 'mirror']);
    expect(stored.private).toBe(true);
    expect(stored.usage).toBeUndefined();
    expect(stored.agents?.['main']?.usage).toBeUndefined();
    expect(stored.agents?.['main']?.toolCallCount).toBeUndefined();
    expect(stored.updatedAt).toBeGreaterThan(20);
    expect(recorded[0]?.private).toBe(true);

    steps.length = 0;
    const exitPrivate = await updateColdSessionProfile(
      coldPathAccessor({
        storeGet: async () => stored,
        onSetSessionPrivacy: (s) => {
          steps.push(`privacy:${String(s.private)}`);
        },
        onStoreSet: (_scope, _key, value) => {
          steps.push('persist');
          stored = value as SessionMeta;
        },
        onMirrorRecord: () => {
          steps.push('mirror');
        },
      }),
      's1',
      { private: false },
    );
    expect(exitPrivate.kind).toBe('updated');
    expect(steps).toEqual(['persist', 'privacy:false', 'mirror']);
    expect(stored.private).toBe(false);
  });

  it('reuses unchanged non-attached session summaries across archive family reads while re-reading attached or modified files', async () => {
    const metas = new Map<string, SessionMeta>([
      ['sessions/wd/root', { id: 'root', createdAt: 1, updatedAt: 1, archived: false }],
      ['sessions/wd/child', { id: 'child', createdAt: 2, updatedAt: 2, archived: false, custom: { [CREATED_BY_SESSION_ID_KEY]: 'root' } }],
      ['sessions/wd/unrelated-1', { id: 'unrelated-1', createdAt: 3, updatedAt: 3, archived: false }],
      ['sessions/wd/unrelated-2', { id: 'unrelated-2', createdAt: 4, updatedAt: 4, archived: false }],
    ]);
    const revisions = new Map<string, number>([
      ['sessions/wd/root', 1],
      ['sessions/wd/child', 1],
      ['sessions/wd/unrelated-1', 1],
      ['sessions/wd/unrelated-2', 1],
    ]);
    const storage = {
      list: async (scope: string) => {
        if (scope === 'sessions') return ['wd'];
        if (scope === 'sessions/wd') return ['root', 'child', 'unrelated-1', 'unrelated-2'];
        return [];
      },
      mtime: async (scope: string, key: string) => (key === 'state.json' && metas.has(scope) ? (revisions.get(scope) ?? 1) * 1000 : undefined),
      size: async (scope: string, key: string) => (key === 'state.json' && metas.has(scope) ? 128 : undefined),
      stat: async (scope: string, key: string) => {
        if (key !== 'state.json' || !metas.has(scope)) return undefined;
        return { size: 128, mtimeMs: (revisions.get(scope) ?? 1) * 1000, identity: scope, revision: String(revisions.get(scope) ?? 1) };
      },
    } as unknown as IFileSystemStorageService;
    const reads: string[] = [];
    const docs = {
      get: async (scope: string, key: string) => {
        if (key !== 'state.json') return undefined;
        reads.push(scope);
        return metas.get(scope);
      },
    } as unknown as IAtomicDocumentStore;
    const noopLog = {
      level: 'off',
      setLevel: () => {},
      flush: async () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      child: () => noopLog,
    } as unknown as ILogService;

    const first = await readSessionArchiveFamily(storage, docs, 'sessions', 'root', [], noopLog);
    expect(first.map((s) => s.id)).toEqual(['root', 'child']);
    expect(reads).toHaveLength(4);

    reads.length = 0;
    const second = await readSessionArchiveFamily(storage, docs, 'sessions', 'root', [], noopLog);
    expect(second.map((s) => s.id)).toEqual(['root', 'child']);
    expect(reads.toSorted()).toEqual(['sessions/wd/child', 'sessions/wd/root']);

    reads.length = 0;
    metas.set('sessions/wd/unrelated-2', {
      id: 'unrelated-2',
      createdAt: 4,
      updatedAt: 5,
      archived: false,
      custom: { [CREATED_BY_SESSION_ID_KEY]: 'root' },
    });
    revisions.set('sessions/wd/unrelated-2', 2);
    const third = await readSessionArchiveFamily(storage, docs, 'sessions', 'root', [], noopLog);
    expect(third.map((s) => s.id).toSorted()).toEqual(['child', 'root', 'unrelated-2']);
    expect(reads.toSorted()).toEqual(['sessions/wd/child', 'sessions/wd/root', 'sessions/wd/unrelated-2']);
  });
});
