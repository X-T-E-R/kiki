import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BoardReadSchema, BoardWriteSchema } from '@kiki/agent-core-v2/app/taskBoard/boardContract';
import { ITaskBoardService } from '@kiki/agent-core-v2/app/taskBoard/taskBoard';
import { boardReadSchema, boardWriteSchema, boardReadResultSchema, boardWriteResultSchema } from '../src/contract/board/schemas';
import { createKlient as memory, type ScopeLike } from '../src/transports/memory/index';
import { createKlient as ipc, serveKlientIpc } from '../src/transports/ipc/index';
import type { BoardClient as Engine, BoardReadInput as EngineRead, BoardWriteInput as EngineWrite } from '@kiki/agent-core-v2/app/taskBoard/boardContract';
import type { BoardClient, BoardReadInput, BoardWriteInput } from '../src/contract/board/types';

type Assert<T extends true> = T;
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Both<A, B> = [Mutable<A>] extends [Mutable<B>] ? [Mutable<B>] extends [Mutable<A>] ? true : false : false;
const parity: [Assert<Both<BoardClient, Engine>>, Assert<Both<BoardReadInput, EngineRead>>, Assert<Both<BoardWriteInput, EngineWrite>>] = [true, true, true];
it('pins the browser board boundary to the engine contract', () => {
  const schemas: [Assert<Both<z.infer<typeof boardReadSchema>, EngineRead>>, Assert<Both<z.infer<typeof boardWriteSchema>, EngineWrite>>,
    Assert<Both<z.infer<typeof boardReadResultSchema>, Awaited<ReturnType<Engine['read']>>>>,
    Assert<Both<z.infer<typeof boardWriteResultSchema>, Awaited<ReturnType<Engine['write']>>>>] = [true, true, true, true];
  expect(parity).toEqual([true, true, true]);
  expect(schemas).toEqual([true, true, true, true]);
});

it('exposes in_progress for reads and updates while keeping create status-free', () => {
  const read = { action: 'list' as const, status: 'in_progress' as const };
  const update = {
    action: 'update' as const,
    workspaceId: 'workspace-one',
    storage: { root: '/board', storageId: 'store-one', kind: 'embedded' as const },
    id: 'task-one',
    expectedRevision: 0,
    patch: { status: 'in_progress' as const },
  };
  expect(BoardReadSchema.parse(read)).toEqual(boardReadSchema.parse(read));
  expect(BoardWriteSchema.parse(update)).toEqual(boardWriteSchema.parse(update));
  expect(BoardWriteSchema.safeParse({ action: 'create', requestKey: 'request-one', title: 'Example', status: 'in_progress' }).success).toBe(false);
  expect(boardWriteSchema.safeParse({ action: 'create', requestKey: 'request-one', title: 'Example', status: 'in_progress' }).success).toBe(false);
});

it('mirrors native request bounds instead of accepting arbitrary roots or patches as authority', () => {
  const inputs = [
    { action: 'preview', configuration: { mode: 'fixed', path: '  relative/board  ' } },
    { action: 'preview', configuration: { mode: 'fixed', path: '\nsecret' } },
    { action: 'overview', workspaceIds: [] },
    { action: 'list', limit: 101 },
    { action: 'list', root: '/not-authority' },
  ];
  for (const input of inputs) {
    const expected = BoardReadSchema.safeParse(input);
    const actual = boardReadSchema.safeParse(input);
    expect(actual.success).toBe(expected.success);
    if (actual.success && expected.success) expect(actual.data).toEqual(expected.data);
  }
  const input = { action: 'create', title: '  Example  ', requestKey: 'request-one' };
  expect(boardWriteSchema.parse(input)).toEqual(BoardWriteSchema.parse(input));
});

it.each(['memory', 'ipc'] as const)('routes board read/write/overview over %s to the host service and preserves conflict results', async (transport) => {
  const read = vi.fn(async () => ({ ok: true as const, value: { workspaceId: 'workspace-one', cards: [], issues: [] } }));
  const write = vi.fn(async () => ({ ok: false as const, error: { code: 'REVISION_CONFLICT', message: 'Reload before retrying.' } }));
  const overview = vi.fn(async () => ({ ok: true as const, value: [] }));
  const service = { _serviceBrand: undefined, read, write, overview };
  const scope: ScopeLike = { accessor: { get<T>(token: unknown): T {
    if (token !== ITaskBoardService) throw new Error('Unexpected service');
    return service as T;
  } } };
  const host = transport === 'ipc' ? await serveKlientIpc({ scope, socketPath: join(tmpdir(), `board-${randomUUID()}.sock`) }) : undefined;
  const client = host === undefined ? memory({ scope }) : ipc({ socketPath: host.socketPath });
  try {
    await expect(client.global.board.read({ action: 'list', workspaceId: 'workspace-one' })).resolves.toEqual({ ok: true, value: { workspaceId: 'workspace-one', cards: [], issues: [] } });
    const update: BoardWriteInput = { action: 'update', workspaceId: 'workspace-one', storage: { root: '/original-board', storageId: 'store-one', kind: 'embedded' }, id: 'task-one', expectedRevision: 4, patch: { title: 'Changed' } };
    await expect(client.global.board.write(update)).resolves.toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
    expect(write).toHaveBeenCalledWith(update);
    await expect(client.global.board.overview()).resolves.toEqual({ ok: true, value: [] });
    expect(overview).toHaveBeenCalledTimes(1);
    await expect(client.global.board.read({ action: 'overview', workspaceIds: [] })).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await host?.close();
  }
});
