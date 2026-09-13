import { rm } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';
import { ConfigTarget, IConfigService } from '@kiki/agent-core-v2';
import { Error2, ErrorCodes } from '@kiki/agent-core-v2/errors';

import { defineKlientConformance } from './helpers/conformance.js';
import { createKlient } from '../src/transports/memory/index.js';
import { createContractDispatcher } from '../src/transports/contractDispatcher.js';
import {
  createMemoryDispatcher,
  type ScopeLike,
} from '../src/transports/memory/dispatcher.js';
import { RPCError, toRPCError } from '../src/core/errors.js';
import { makeEngine } from './helpers/engine.js';

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

defineKlientConformance('memory', async () => {
  const { homeDir, app } = await makeEngine();
  // Thread communication is opt-in (BK11); the conformance suite exercises it,
  // so enable it explicitly for this engine.
  await app.accessor
    .get(IConfigService)
    .replace('threadCommunication', { enabled: true }, ConfigTarget.Memory);
  const klient = createKlient({ scope: app });
  return {
    klient,
    app,
    cleanup: async () => {
      await klient.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
});

describe('memory dispatcher specifics', () => {
  it('acknowledges only attached subscriptions and cancels pending attach on dispose', async () => {
    const dispose = vi.fn();
    const attach = vi.fn(() => ({ dispose }));
    const dispatcher = createMemoryDispatcher({ accessor: { get: () => ({ onDidChange: attach }) } } as unknown as ScopeLike);
    const ready = vi.fn();
    const error = vi.fn();
    const source = { kind: 'emitter' as const, service: 'configService', event: 'onDidChange' };
    const cancelled = dispatcher.listen({}, source, vi.fn(), error, ready);
    cancelled.dispose();
    await Promise.resolve();
    expect(attach).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    const active = dispatcher.listen({}, source, vi.fn(), error, ready);
    await Promise.resolve();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
    active.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    dispatcher.listen({}, { kind: 'stream', name: 'missing' }, vi.fn(), error, ready);
    await Promise.resolve();
    expect(error).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it.each([
    [ErrorCodes.THREAD_NOT_FOUND, 40421],
    [ErrorCodes.THREAD_ARCHIVED, 40927],
    [ErrorCodes.THREAD_DISABLED, 40928],
    [ErrorCodes.THREAD_CROSS_HOST, 40929],
    [ErrorCodes.THREAD_SELF_SEND, 40930],
    [ErrorCodes.THREAD_CURSOR_INVALID, 40931],
    [ErrorCodes.THREAD_IDEMPOTENCY_CONFLICT, 40932],
    [ErrorCodes.THREAD_LIMIT_EXCEEDED, 42903],
    ['dispatch.limit_exceeded' as const, 42904],
    [ErrorCodes.THREAD_DELIVERY_FAILED, 50005],
  ])('maps engine error %s to RPC code %i', (reason, code) => {
    expect(toRPCError(new Error2(reason, 'failure', { details: { field: 'value' } }))).toMatchObject({
      name: 'RPCError',
      code,
      reason,
      details: { field: 'value' },
    });
  });

  it('rejects unknown services and methods with RPCError(40001)', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'noSuchService', 'get', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    await expect(dispatcher.call({}, 'sessionIndex', 'noSuchMethod', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    await expect(
      dispatcher.call({}, 'threadCommunicationService', 'sendPeerThreadMessage', []),
    ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('reads non-function members as properties', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'bootstrapService', 'platform', [])).resolves.toBe(
      process.platform,
    );
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('rejects session/agent scopes for now', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(
      dispatcher.call({ sessionId: 's1' }, 'sessionIndex', 'list', [{}]),
    ).rejects.toBeInstanceOf(RPCError);
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('delivers wire-cloned payloads (no live object identity)', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    const list = await klient.global.workspaces.list();
    // Mutating the result must not affect what a second call returns.
    (list as unknown[]).push({ id: 'polluted' });
    const again = await klient.global.workspaces.list();
    expect(again.some((w) => w.id === 'polluted')).toBe(false);
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });
});

function scopeReturning(value: unknown): ScopeLike {
  return {
    accessor: {
      get<T>(): T {
        return value as T;
      },
    },
  };
}

describe('contract dispatcher boundary', () => {
  it('rejects undeclared procedures and invalid declared input', async () => {
    const dispatcher = createContractDispatcher(scopeReturning({ platform: process.platform }));
    await expect(dispatcher.call({}, 'sessionManager', 'list', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    await expect(
      dispatcher.call({}, 'bootstrapService', 'platform', ['unexpected']),
    ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
  });

  it('normalizes JSON null only for optional positional arguments', async () => {
    const inspectServers = vi.fn(async () => []);
    const dispatcher = createContractDispatcher(scopeReturning({ inspectServers }));
    const query = { cwd: process.cwd() };
    await expect(
      dispatcher.call({}, 'mcpManagementService', 'inspectServers', [null, query]),
    ).resolves.toEqual([]);
    expect(inspectServers).toHaveBeenCalledWith(undefined, query);
  });

  it('validates declared procedure output', async () => {
    const dispatcher = createContractDispatcher(scopeReturning({ platform: 42 }));
    await expect(dispatcher.call({}, 'bootstrapService', 'platform', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 50001,
    });
  });

  it('enforces streaming procedure kind and validates chunks', async () => {
    const returnIterator = vi.fn(async () => ({ done: true as const, value: undefined }));
    const iterator: AsyncIterator<unknown> = {
      next: async () => ({ done: false, value: { text: 'missing type' } }),
      return: returnIterator,
    };
    const dispatcher = createContractDispatcher(
      scopeReturning({
        getRequester: () => ({
          request: () => ({
            [Symbol.asyncIterator]: () => iterator,
          }),
        }),
      }),
    );
    expect(() => dispatcher.stream({}, 'bootstrapService', 'platform', [])).toThrow(RPCError);
    await expect(
      dispatcher.call({}, 'modelResolver', 'generate', [
        'test-model',
        { systemPrompt: '', messages: [] },
      ]),
    ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
    const source = dispatcher.stream({}, 'modelResolver', 'generate', [
      'test-model',
      { systemPrompt: '', messages: [] },
    ]);
    await expect(source[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      name: 'RPCError',
      code: 50001,
    });
    expect(returnIterator).toHaveBeenCalledOnce();
  });
});
