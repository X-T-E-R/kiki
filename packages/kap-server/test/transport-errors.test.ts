import { APIProviderRateLimitError, Error2, ErrorCodes } from '@kiki/agent-core-v2';
import { ErrorCode } from '../src/protocol/error-codes';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { mapError } from '../src/transport/errors';
import { installErrorHandler } from '../src/error-handler';

describe('/api/debug transport mapError', () => {
  it.each([
    [ErrorCodes.OS_FS_NOT_FOUND, ErrorCode.FS_PATH_NOT_FOUND],
    [ErrorCodes.OS_FS_NOT_DIRECTORY, ErrorCode.FS_PATH_NOT_FOUND],
    [ErrorCodes.OS_FS_IS_DIRECTORY, ErrorCode.FS_IS_DIRECTORY],
    [ErrorCodes.OS_FS_ALREADY_EXISTS, ErrorCode.FS_ALREADY_EXISTS],
    [ErrorCodes.OS_FS_PERMISSION_DENIED, ErrorCode.FS_PERMISSION_DENIED],
    [ErrorCodes.STORAGE_IO_FAILED, ErrorCode.PERSISTENCE_FAILURE],
    [ErrorCodes.STORAGE_LOCKED, ErrorCode.SESSION_LOCKED],
    [ErrorCodes.CONFIG_INVALID, ErrorCode.VALIDATION_FAILED],
    [ErrorCodes.GOAL_UNSUPPORTED_AGENT, ErrorCode.GOAL_UNSUPPORTED_AGENT],
    [ErrorCodes.PROMPT_ID_CONFLICT, ErrorCode.PROMPT_ID_CONFLICT],
  ])('maps domain code %s to its wire equivalent', (code, wire) => {
    const env = mapError(new Error2(code, 'boom'), 'req-1');
    expect(env.code).toBe(wire);
  });

  it('preserves dispatch capacity rejection details across transport', () => {
    const details = { layer: 'tree', current: 2, limit: 2, owner: 'main' };
    const env = mapError(
      new Error2(ErrorCodes.DISPATCH_LIMIT_EXCEEDED, 'capacity exhausted', { details }),
      'req-capacity',
    );
    expect(env).toMatchObject({
      code: 42904,
      msg: 'capacity exhausted',
      request_id: 'req-capacity',
      details,
    });
  });

  it('falls back to INTERNAL_ERROR for coded errors without a wire equivalent', () => {
    const env = mapError(new Error2(ErrorCodes.OS_FS_UNKNOWN, 'boom'), 'req-1');
    expect(env.code).toBe(ErrorCode.INTERNAL_ERROR);
  });
});

describe('installErrorHandler (catch-all)', () => {
  function run(err: unknown): { code: number; msg: string; details?: unknown } {
    let installed: unknown;
    installErrorHandler({
      setErrorHandler: (h) => {
        installed = h;
        return undefined;
      },
    });
    const handler = installed as (
      e: unknown,
      req: { id: string; log: { error: () => void } },
      reply: { status: (code: number) => { send: (p: unknown) => void } },
    ) => void;
    let payload: { code: number; msg: string } | undefined;
    const reply = {
      type: () => reply,
      serializer: () => reply,
      removeHeader: () => reply,
      status: () => reply,
      send: (p: unknown) => void (payload = p as typeof payload),
    };
    handler(err, { id: 'req-1', log: { error: () => {} } }, reply);
    return payload!;
  }

  it('maps an escaped config.invalid to VALIDATION_FAILED', () => {
    const env = run(new Error2(ErrorCodes.CONFIG_INVALID, 'broken pool'));
    expect(env.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(env.msg).toContain('broken pool');
  });

  it('maps an escaped storage.locked to SESSION_LOCKED', () => {
    const env = run(new Error2(ErrorCodes.STORAGE_LOCKED, 'held by pid 1234'));
    expect(env.code).toBe(ErrorCode.SESSION_LOCKED);
    expect(env.msg).toContain('held by pid 1234');
  });

  it('replaces binary response framing and its success serializer when sending an error', async () => {
    const app = Fastify();
    installErrorHandler(app);
    app.addHook('onSend', async (_req, _reply, payload) => payload);
    app.get('/media', { schema: { response: { 200: { type: 'string', format: 'binary' } } } }, async (_req, reply) => {
      reply.type('image/png').header('content-length', 100).header('content-range', 'bytes 0-99/100').header('content-disposition', 'inline');
      throw new Error('preview failed');
    });
    app.get('/healthy', async () => ({ alive: true }));
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}/media`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('content-range')).toBeNull();
      expect(response.headers.get('content-disposition')).toBeNull();
      expect(await response.json()).toMatchObject({ code: 50001, msg: 'preview failed', data: null });
      expect(await (await fetch(`http://127.0.0.1:${port}/healthy`)).json()).toEqual({ alive: true });
    } finally { await app.close(); }
  });

  it('keeps unknown exceptions at INTERNAL_ERROR', () => {
    expect(run(new Error('boom')).code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it('forwards the stable provider error kind an escaped provider failure carries', () => {
    const env = run(new APIProviderRateLimitError('Too many requests', 'req-upstream'));
    expect(env.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(env.msg).toContain('Too many requests');
    expect(env.details).toEqual({ error_kind: 'rate_limit' });
  });

  it('forwards no details for a coded error without a provider kind', () => {
    const env = run(new Error2(ErrorCodes.OS_FS_UNKNOWN, 'boom', { details: { path: '/tmp/x' } }));
    expect(env.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(env.details).toBeUndefined();
  });
});
