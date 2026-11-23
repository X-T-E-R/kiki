import { describe, expect, it } from 'vitest';
import {
  IAtomicDocumentStore,
  IBootstrapService,
  IFileSystemStorageService,
  ILogService,
  ISessionIndex,
  ISessionManager,
  IWorkAdmissionService,
  type Scope,
} from '@kiki/agent-core-v2';

import { PromptIngress } from '../src/services/promptIngress';

function createHarness(options?: { readonly failPayload?: boolean }) {
  const store = new Map<string, unknown>();
  const writeWaves: string[][] = [];
  let activeWave: string[] = [];
  let inFlightWrites = 0;

  const trackWrite = async <T>(tag: string, run: () => T): Promise<T> => {
    if (inFlightWrites === 0) {
      activeWave = [];
      writeWaves.push(activeWave);
    }
    inFlightWrites += 1;
    activeWave.push(tag);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    try {
      return run();
    } finally {
      inFlightWrites -= 1;
    }
  };

  const docs = {
    get: async <T>(scope: string, key: string): Promise<T | undefined> =>
      store.get(`${scope}/${key}`) as T | undefined,
    set: async (scope: string, key: string, value: unknown): Promise<void> => {
      const fullKey = `${scope}/${key}`;
      const tag = scope.endsWith('/payloads')
        ? 'payload'
        : scope.endsWith('/pages')
          ? 'page'
          : scope.endsWith('/requests')
            ? 'request'
            : key === 'index.json'
              ? 'index'
              : fullKey;
      await trackWrite(tag, () => {
        if (options?.failPayload === true && tag === 'payload') {
          throw new Error('simulated payload write failure');
        }
        store.set(fullKey, structuredClone(value));
      });
    },
    update: async <T>(
      scope: string,
      key: string,
      updater: (current: T | undefined) => T,
    ): Promise<T> => {
      const fullKey = `${scope}/${key}`;
      const current = store.get(fullKey) as T | undefined;
      const next = updater(current);
      if (next !== current) {
        const tag = scope.endsWith('/pages') ? 'page' : fullKey;
        await trackWrite(tag, () => {
          store.set(fullKey, structuredClone(next));
        });
      }
      return next;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.delete(`${scope}/${key}`);
    },
  };

  const storage = {
    acquireLock: async () => ({ release: async () => {} }),
    statMeta: async () => undefined,
  };

  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  const services = new Map<unknown, unknown>([
    [IAtomicDocumentStore, docs],
    [IFileSystemStorageService, storage],
    [IBootstrapService, { scope: (name: string) => name, getEnv: () => undefined }],
    [ILogService, log],
    [
      ISessionIndex,
      {
        get: async (id: string) => ({
          id,
          workspaceId: 'ws-1',
          createdAt: 1,
          updatedAt: 1,
          archived: false,
        }),
      },
    ],
    [ISessionManager, { get: () => undefined }],
    [
      IWorkAdmissionService,
      {
        state: () => ({ operationId: undefined }),
        onDidChange: () => ({ dispose: () => {} }),
        run: <T>(_kind: string, fn: () => Promise<T>) => fn(),
        acquire: () => ({ run: <T>(fn: () => Promise<T>) => fn(), dispose: () => {} }),
      },
    ],
  ]);

  const core = {
    accessor: {
      get: <T>(token: unknown): T => {
        if (!services.has(token)) throw new Error(`Missing stub service: ${String(token)}`);
        return services.get(token) as T;
      },
    },
  } as unknown as Scope;

  const ingress = new PromptIngress(core, {
    submit: async (_sessionId, execution) =>
      new Promise((_resolve, reject) => {
        execution.signal.addEventListener('abort', () => reject(execution.signal.reason ?? new Error('aborted')), { once: true });
      }),
    cancel: async () => {},
  });

  return { ingress, store, writeWaves };
}

describe('PromptIngress', () => {
  it('flushes payload, index, and page in parallel before publishing the request in two waves', async () => {
    const { ingress, writeWaves } = createHarness();
    try {
      const item = await ingress.submit(
        'sess-1',
        {
          prompt_id: 'p-1',
          admission: 'durable',
          content: [{ type: 'text', text: 'hello world' }],
        },
        'fp-1',
      );
      expect(item.prompt_id).toBe('p-1');
      expect(item.admission).toBe('restoring');
      expect(writeWaves.length).toBeGreaterThanOrEqual(2);
      expect(writeWaves[0]?.toSorted()).toEqual(['index', 'page', 'payload']);
      expect(writeWaves[1]).toEqual(['request']);
    } finally {
      await ingress.close();
    }
  });

  it('does not publish the request document if payload persistence fails', async () => {
    const { ingress, store, writeWaves } = createHarness({ failPayload: true });
    try {
      await expect(
        ingress.submit(
          'sess-1',
          {
            prompt_id: 'p-fail',
            admission: 'durable',
            content: [{ type: 'text', text: 'must not publish without payload' }],
          },
          'fp-fail',
        ),
      ).rejects.toThrow('simulated payload write failure');
      expect(writeWaves).toHaveLength(1);
      expect([...store.keys()].some((key) => key.includes('/requests/'))).toBe(false);
    } finally {
      await ingress.close();
    }
  });
});
