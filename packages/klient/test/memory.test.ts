import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { Error2, ErrorCodes } from '@moonshot-ai/agent-core-v2/errors';

import { defineKlientConformance } from './helpers/conformance.js';
import { createKlient } from '../src/transports/memory/index.js';
import { createMemoryDispatcher } from '../src/transports/memory/dispatcher.js';
import { RPCError, toRPCError } from '../src/core/errors.js';
import { makeEngine } from './helpers/engine.js';

defineKlientConformance('memory', async () => {
  const { homeDir, app } = await makeEngine();
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
  it.each([
    [ErrorCodes.THREAD_NOT_FOUND, 40421],
    [ErrorCodes.THREAD_ARCHIVED, 40927],
    [ErrorCodes.THREAD_DISABLED, 40928],
    [ErrorCodes.THREAD_CROSS_HOST, 40929],
    [ErrorCodes.THREAD_SELF_SEND, 40930],
    [ErrorCodes.THREAD_CURSOR_INVALID, 40931],
    [ErrorCodes.THREAD_IDEMPOTENCY_CONFLICT, 40932],
    [ErrorCodes.THREAD_LIMIT_EXCEEDED, 42903],
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
