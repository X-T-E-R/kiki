import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';

import { ndJsonStream } from '@agentclientprotocol/sdk';
import {
  IInstantiationService,
  ISessionIndex,
  ISessionIndexMirror,
  IThreadMailboxStore,
  InstantiationService,
  SyncDescriptor,
  type IInstantiationService as InstantiationServiceApi,
  type SessionIndexStatus,
  type SessionSummary,
} from '@kiki/agent-core-v2';
import { describe, expect, it } from 'vitest';

import { runAcpServerWithStream } from '../src/start';

describe('runAcpServerWithStream session index readiness', () => {
  it(
    'refuses to serve when the first prepare returns a degraded read-model',
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'acp-session-index-degraded-'));
      const toAgent = new PassThrough();
      const toClient = new PassThrough();
      const degraded: SessionIndexStatus = {
        source: 'read-model',
        state: 'degraded',
        degradedCount: 1,
        reason: 'injected projection crash',
      };
      let instantiation: InstantiationService | undefined;

      class DegradedSessionIndex {
        declare readonly _serviceBrand: undefined;

        constructor(@IInstantiationService inst: InstantiationServiceApi) {
          instantiation = inst as InstantiationService;
        }

        prepare(): Promise<SessionIndexStatus> {
          return Promise.resolve(degraded);
        }

        readonly onDidChangeStatus = () => ({ dispose() {} });

        status(): SessionIndexStatus {
          return degraded;
        }

        get(_id: string): Promise<SessionSummary | undefined> {
          return Promise.resolve(undefined);
        }

        listRecent(): Promise<{ readonly items: readonly SessionSummary[] }> {
          return Promise.resolve({ items: [] });
        }

        count(): Promise<number> {
          return Promise.resolve(0);
        }

        remove(_id: string): Promise<void> {
          return Promise.resolve();
        }
      }

      try {
        const stream = ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent));
        await expect(
          runAcpServerWithStream(stream, {
            homeDir,
            extraSeeds: [[ISessionIndex, new SyncDescriptor(DegradedSessionIndex)]],
          }),
        ).rejects.toThrow(/session index is not ready/i);
        expect(instantiation).toBeDefined();
        expect(instantiation!.cascadeDisposed).toBe(true);
      } finally {
        toAgent.end();
        toClient.end();
        await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    30_000,
  );
});

describe('runAcpServerWithStream close', () => {
  it(
    'runs every teardown step after one fails and reports the failure without an unhandled rejection',
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'acp-close-failure-'));
      const toAgent = new PassThrough();
      const toClient = new PassThrough();
      try {
        const stream = ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent));
        const running = await runAcpServerWithStream(stream, { homeDir });
        const failure = new Error('injected mailbox close failure');
        const mailbox = running.core.accessor.get(IThreadMailboxStore);
        mailbox.close = () => Promise.reject(failure);
        const mirror = running.core.accessor.get(ISessionIndexMirror);
        const drain = mirror.drain.bind(mirror);
        let drained = false;
        mirror.drain = async () => {
          drained = true;
          await drain();
        };

        toAgent.end();
        await running.conn.closed;
        await expect(running.close()).rejects.toBe(failure);
        expect(drained).toBe(true);
        await expect(running.close()).rejects.toBe(failure);
      } finally {
        toAgent.end();
        toClient.end();
        await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    30_000,
  );
});
