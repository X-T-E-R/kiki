import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  BeforeToolExecuteEvent,
  ToolDidExecuteContext,
} from '#/agent/toolExecutor/toolHooks';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { ToolCall } from '#/kosong/contract/message';
import { IStaleGuardService } from '#/features/staleGuard/staleGuard';
import { StaleGuardService } from '#/features/staleGuard/staleGuardService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { ToolAccesses, type ExecutableToolResult } from '#/tool/toolContract';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';

import { createTestAgent, hostEnvironmentServices } from '../../harness';
import { stubWireJournal } from '../../wire/stubs';

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

interface CapturedHooks {
  readonly before: ((event: BeforeToolExecuteEvent) => unknown)[];
  readonly did: ((ctx: ToolDidExecuteContext, next: () => Promise<void>) => Promise<void>)[];
}

function stubToolExecutor(captured: CapturedHooks): IAgentToolExecutorService {
  return {
    _serviceBrand: undefined,
    onBeforeExecuteTool: (listener: (event: BeforeToolExecuteEvent) => unknown) => {
      captured.before.push(listener);
      return toDisposable(() => {});
    },
    hooks: {
      onDidExecuteTool: {
        register: (
          _name: string,
          handler: (ctx: ToolDidExecuteContext, next: () => Promise<void>) => Promise<void>,
        ) => {
          captured.did.push(handler);
          return toDisposable(() => {});
        },
      },
    },
  } as unknown as IAgentToolExecutorService;
}

let activeFs: IHostFileSystem;
let fireRuntimeChange: () => void = () => {};

function stubRuntime(): IAgentRuntimeService {
  return {
    _serviceBrand: undefined,
    onDidChange: (listener: () => void) => {
      fireRuntimeChange = listener;
      return toDisposable(() => {});
    },
    acquire: () => ({
      runtime: { fs: activeFs },
      track: (resource: unknown) => resource,
      dispose: () => {},
    }),
  } as unknown as IAgentRuntimeService;
}

function stubFs(stat: Partial<HostFileStat> | Error): IHostFileSystem {
  return {
    _serviceBrand: undefined,
    stat: async () => {
      if (stat instanceof Error) throw stat;
      return { isFile: true, isDirectory: false, size: 0, ...stat };
    },
  } as unknown as IHostFileSystem;
}

function enoent(): Error {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
}

function outputText(result: ExecutableToolResult | undefined): string {
  const output = result?.output;
  if (typeof output !== 'string') throw new TypeError('expected string output');
  return output;
}

function toolCallOf(id: string, name: string, args: unknown): ToolCall {
  return { type: 'function', id, name, arguments: JSON.stringify(args) } as ToolCall;
}

async function runBeforeExecute(
  captured: CapturedHooks,
  input: { name: string; args?: unknown; accesses?: ToolAccesses; batch?: ToolCall[]; toolCall?: ToolCall },
): Promise<ExecutableToolResult | undefined> {
  const pending: (() => Promise<BeforeExecuteDecision | undefined>)[] = [];
  let veto: ExecutableToolResult | undefined;
  const toolCall = input.toolCall ?? toolCallOf('call_1', input.name, input.args ?? {});
  const event = {
    turnId: 0,
    signal: new AbortController().signal,
    toolCall,
    toolCalls: input.batch ?? [toolCall],
    args: input.args,
    execution: { accesses: input.accesses },
    veto: (result: ExecutableToolResult) => {
      veto = result;
    },
    allow: () => {},
    pass: () => {},
    waitUntil: (factory: () => Promise<BeforeExecuteDecision | undefined>) => {
      pending.push(factory);
    },
  } as unknown as BeforeToolExecuteEvent;
  for (const listener of captured.before) await listener(event);
  for (const factory of pending) {
    const decision = await factory();
    if (decision?.veto !== undefined) veto = decision.veto;
  }
  return veto;
}

async function runDidExecute(
  captured: CapturedHooks,
  input: { name: string; accesses?: ToolAccesses; isError?: boolean; toolCall?: ToolCall },
): Promise<ExecutableToolResult> {
  const ctx = {
    turnId: 0,
    signal: new AbortController().signal,
    toolCall: input.toolCall ?? { id: 'call_1', name: input.name },
    toolCalls: [],
    args: {},
    outcome: 'executed',
    accesses: input.accesses,
    result: input.isError === true ? { output: 'failed', isError: true } : { output: 'ok' },
  } as unknown as ToolDidExecuteContext;
  for (const handler of captured.did) await handler(ctx, async () => {});
  return ctx.result;
}

describe('StaleGuardService', () => {
  let disposables: DisposableStore;
  let records: WireRecord[];
  let hooks: CapturedHooks;
  let freshness: IStaleGuardService;

  function buildStack(journal: WireRecord[]): {
    freshness: IStaleGuardService;
    dispatcher: IEventDispatcher;
    hooks: CapturedHooks;
  } {
    const captured: CapturedHooks = { before: [], did: [] };
    const ix = disposables.add(new TestInstantiationService());
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.set(IAgentBlobService, noopBlob);
    ix.set(IWireService, stubWireJournal(journal));
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    ix.set(IAgentToolExecutorService, stubToolExecutor(captured));
    ix.set(IAgentRuntimeService, stubRuntime());
    ix.set(IStaleGuardService, new SyncDescriptor(StaleGuardService));
    return {
      freshness: ix.get(IStaleGuardService),
      dispatcher: ix.get(IEventDispatcher),
      hooks: captured,
    };
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    records = [];
    activeFs = stubFs({});
    const stack = buildStack(records);
    hooks = stack.hooks;
    freshness = stack.freshness;
  });

  afterEach(async () => {
    await disposables.dispose();
  });

  it('records the mtime of a successfully read file into state and the wire journal', async () => {
    activeFs = stubFs({ mtimeMs: 111 });

    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });

    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBe(111);
    expect(records).toEqual([
      { type: 'staleGuard.recorded', path: '/tmp/a.txt', mtimeMs: 111, time: expect.any(Number) },
    ]);
  });

  it('does not dispatch another durable record when the mtime is unchanged', async () => {
    activeFs = stubFs({ mtimeMs: 111 });

    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });

    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBe(111);
    expect(records).toHaveLength(1);
  });

  it('does not record when the read failed', async () => {
    activeFs = stubFs({ mtimeMs: 111 });

    await runDidExecute(hooks, {
      name: 'Read',
      accesses: ToolAccesses.readFile('/tmp/a.txt'),
      isError: true,
    });

    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBeUndefined();
    expect(records).toEqual([]);
  });

  it('ignores tools without file semantics', async () => {
    const veto = await runBeforeExecute(hooks, { name: 'Bash', args: { command: 'ls' } });
    expect(veto).toBeUndefined();

    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Bash' });
    expect(records).toEqual([]);
  });

  it('vetoes overwriting an existing file the agent never read', async () => {
    activeFs = stubFs({ mtimeMs: 5 });

    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'),
    });

    expect(veto?.isError).toBe(true);
    expect(outputText(veto)).toContain('has not been read');
    expect(outputText(veto)).toContain('/tmp/a.txt');
  });

  it('lets an Edit of an unread file through, notes it, and does not count it as a read', async () => {
    activeFs = stubFs({ mtimeMs: 5 });
    const edit = toolCallOf('call_edit', 'Edit', { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' });

    const veto = await runBeforeExecute(hooks, {
      name: 'Edit',
      args: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'),
      toolCall: edit,
    });
    activeFs = stubFs({ mtimeMs: 6 });
    const result = await runDidExecute(hooks, {
      name: 'Edit',
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'),
      toolCall: edit,
    });

    expect(veto).toBeUndefined();
    expect(result.note).toBe(
      'Note: you had not read /tmp/a.txt; the edit was applied because the text it replaced matched the file exactly.',
    );
    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBeUndefined();
    const overwrite = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'),
    });
    expect(outputText(overwrite)).toContain('has not been read');
  });

  it('does not check appends', async () => {
    activeFs = stubFs({ mtimeMs: 5 });
    const append = toolCallOf('call_append', 'Write', { path: '/tmp/a.txt', content: 'x', mode: 'append' });

    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/a.txt', content: 'x', mode: 'append' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'),
      toolCall: append,
    });
    const result = await runDidExecute(hooks, { name: 'Write', accesses: ToolAccesses.writeFile('/tmp/a.txt'), toolCall: append });

    expect(veto).toBeUndefined();
    expect(result.note).toBeUndefined();
    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBeUndefined();
  });

  it('allows the write when the on-disk mtime matches the last read', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });

    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'),
    });

    expect(veto).toBeUndefined();
  });

  it('vetoes the overwrite when the file changed on disk since the last read', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });
    activeFs = stubFs({ mtimeMs: 222 });

    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'),
    });

    expect(veto?.isError).toBe(true);
    expect(outputText(veto)).toContain('modified on disk');
  });

  it('lets an Edit through after an external change and notes the change', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });
    activeFs = stubFs({ mtimeMs: 222 });
    const edit = toolCallOf('call_edit', 'Edit', { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' });

    const veto = await runBeforeExecute(hooks, {
      name: 'Edit',
      args: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'),
      toolCall: edit,
    });
    activeFs = stubFs({ mtimeMs: 333 });
    const result = await runDidExecute(hooks, { name: 'Edit', accesses: ToolAccesses.readWriteFile('/tmp/a.txt'), toolCall: edit });

    expect(veto).toBeUndefined();
    expect(result.note).toContain('/tmp/a.txt changed on disk since you last read it; the edit was applied');
    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBe(111);
  });

  it('treats an earlier Edit of the same file in the batch as coverage for a later write', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });
    const edit = toolCallOf('call_0', 'Edit', { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' });
    const write = toolCallOf('call_1', 'Write', { path: '/tmp/a.txt', content: 'x' });

    await runBeforeExecute(hooks, {
      name: 'Edit', args: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'), batch: [edit, write], toolCall: edit,
    });
    activeFs = stubFs({ mtimeMs: 222 });
    const veto = await runBeforeExecute(hooks, {
      name: 'Write', args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'), batch: [edit, write], toolCall: write,
    });

    expect(veto).toBeUndefined();
  });

  it('does not let an earlier Edit of an unread file in the batch cover an overwrite', async () => {
    activeFs = stubFs({ mtimeMs: 5 });
    const edit = toolCallOf('call_0', 'Edit', { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' });
    const write = toolCallOf('call_1', 'Write', { path: '/tmp/a.txt', content: 'x' });

    await runBeforeExecute(hooks, {
      name: 'Edit', args: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'), batch: [edit, write], toolCall: edit,
    });
    const veto = await runBeforeExecute(hooks, {
      name: 'Write', args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'), batch: [edit, write], toolCall: write,
    });

    expect(outputText(veto)).toContain('has not been read');
  });

  it('allows a write covered by an earlier Read of the same path in the same batch', async () => {
    activeFs = stubFs({ mtimeMs: 5 });
    const readCall: ToolCall = {
      type: 'function',
      id: 'call_0',
      name: 'Read',
      arguments: JSON.stringify({ path: '/tmp/a.txt' }),
    };
    const writeCall: ToolCall = {
      type: 'function',
      id: 'call_1',
      name: 'Write',
      arguments: JSON.stringify({ path: '/tmp/a.txt', content: 'x' }),
    };

    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'),
      batch: [readCall, writeCall],
    });

    expect(veto).toBeUndefined();
  });

  it('still vetoes when the earlier batch Read targets a different path', async () => {
    activeFs = stubFs({ mtimeMs: 5 });
    const readCall: ToolCall = {
      type: 'function',
      id: 'call_0',
      name: 'Read',
      arguments: JSON.stringify({ path: '/tmp/other.txt' }),
    };
    const writeCall: ToolCall = {
      type: 'function',
      id: 'call_1',
      name: 'Write',
      arguments: JSON.stringify({ path: '/tmp/a.txt', content: 'x' }),
    };

    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'),
      batch: [readCall, writeCall],
    });

    expect(veto?.isError).toBe(true);
    expect(outputText(veto)).toContain('has not been read');
  });

  it('clears recorded mtimes when the runtime changes', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });
    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBe(111);

    fireRuntimeChange();

    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBeUndefined();
    expect(records).toContainEqual({
      type: 'staleGuard.cleared',
      time: expect.any(Number),
    });
    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'),
    });
    expect(outputText(veto)).toContain('has not been read');
  });

  it('allows writing a file that does not exist yet', async () => {
    activeFs = stubFs(enoent());

    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/new.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/new.txt'),
    });

    expect(veto).toBeUndefined();
  });

  it('skips the check when the runtime stat carries no mtimeMs', async () => {
    activeFs = stubFs({});

    const veto = await runBeforeExecute(hooks, {
      name: 'Edit',
      args: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'),
    });

    expect(veto).toBeUndefined();
  });

  it('skips the check when the path is not a regular file', async () => {
    activeFs = stubFs({ isFile: false, isDirectory: true, mtimeMs: 5 });

    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/dir', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/dir'),
    });

    expect(veto).toBeUndefined();
  });

  it('refreshes the record after a successful write so consecutive writes are not blocked', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });

    activeFs = stubFs({ mtimeMs: 222 });
    await runDidExecute(hooks, { name: 'Edit', accesses: ToolAccesses.readWriteFile('/tmp/a.txt') });

    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBe(222);
    const veto = await runBeforeExecute(hooks, {
      name: 'Edit',
      args: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'),
    });
    expect(veto).toBeUndefined();
  });

  it('rebuilds recorded mtimes from the wire journal on restore', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });

    const replayed = buildStack([...records]);
    await replayed.dispatcher.restore();

    expect(replayed.freshness.recordedMtimeMs('/tmp/a.txt')).toBe(111);
    activeFs = stubFs({ mtimeMs: 999 });
    const veto = await runBeforeExecute(replayed.hooks, {
      name: 'Write',
      args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'),
    });
    expect(outputText(veto)).toContain('modified on disk');
  });

  it('keeps records isolated between independent agent stacks', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });

    const other = buildStack([]);

    expect(other.freshness.recordedMtimeMs('/tmp/a.txt')).toBeUndefined();
    const veto = await runBeforeExecute(other.hooks, {
      name: 'Write',
      args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'),
    });
    expect(outputText(veto)).toContain('has not been read');
  });

  it('detects an external mtime change through the real filesystem', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'file-freshness-'));
    const file = join(dir, 'a.txt');
    await writeFile(file, 'one', 'utf8');
    try {
      activeFs = new HostFileSystem();
      await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile(file) });

      const past = new Date(Date.now() - 60_000);
      await utimes(file, past, past);

      const veto = await runBeforeExecute(hooks, {
        name: 'Write',
        args: { path: file, content: 'two' },
        accesses: ToolAccesses.writeFile(file),
      });
      expect(outputText(veto)).toContain('modified on disk');

      await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile(file) });
      const allowed = await runBeforeExecute(hooks, {
        name: 'Write',
        args: { path: file, content: 'two' },
        accesses: ToolAccesses.writeFile(file),
      });
      expect(allowed).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});

describe('StaleGuardService in the agent test harness', () => {
  it('is assembled by the feature seam with no manual registration', async () => {
    const ctx = createTestAgent();
    try {
      const svc = ctx.get(IStaleGuardService);
      expect(svc).toBeDefined();
      expect(typeof svc.recordedMtimeMs).toBe('function');
    } finally {
      await ctx.dispose();
    }
  });

  async function runBatch(
    ctx: ReturnType<typeof createTestAgent>,
    calls: ToolCall[],
  ): Promise<string[]> {
    ctx.mockNextResponse({ type: 'text', text: 'Working.' }, ...calls);
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Go' }] });
    await ctx.untilTurnEnd();
    return toolResultTexts(ctx.llmCalls.at(-1)!.history).slice(-calls.length);
  }

  it('applies an Edit after an external modification with a note but refuses a Write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'file-freshness-e2e-'));
    const file = join(dir, 'a.txt');
    await writeFile(file, 'alpha beta', 'utf8');
    const ctx = createTestAgent(
      { cwd: dir },
      hostEnvironmentServices(dir, process.platform === 'win32' ? 'win32' : 'posix'),
    );
    try {
      await ctx.rpc.setPermission({ mode: 'yolo' });
      await runBatch(ctx, [toolCallOf('call_read', 'Read', { path: file })]);

      const past = new Date(Date.now() - 60_000);
      await utimes(file, past, past);

      const [edited] = await runBatch(ctx, [
        toolCallOf('call_edit', 'Edit', { path: file, old_string: 'beta', new_string: 'gamma' }),
      ]);
      const [written] = await runBatch(ctx, [toolCallOf('call_write', 'Write', { path: file, content: 'replaced' })]);

      expect(edited).toContain('Replaced 1 occurrence');
      expect(edited).toContain('changed on disk since you last read it');
      expect(written).toContain('modified on disk');
      expect(await readFile(file, 'utf8')).toBe('alpha gamma');
    } finally {
      await ctx.dispose();
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('runs several edits of one file in one batch without stale-read refusals or notes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'file-freshness-batch-'));
    const file = join(dir, 'f.txt');
    const filler = Array.from({ length: 2000 }, (_, i) => `line ${String(i)} ${'y'.repeat(60)}`).join('\n');
    await writeFile(file, `${filler}\nalpha\nbeta\ngamma\n`, 'utf8');
    const ctx = createTestAgent(
      { cwd: dir },
      hostEnvironmentServices(dir, process.platform === 'win32' ? 'win32' : 'posix'),
    );
    try {
      await ctx.rpc.setPermission({ mode: 'yolo' });
      await runBatch(ctx, [toolCallOf('r1', 'Read', { path: 'f.txt', line_offset: -3 })]);

      const results = await runBatch(ctx, [
        toolCallOf('e1', 'Edit', { path: 'f.txt', old_string: 'alpha', new_string: 'ALPHA' }),
        toolCallOf('e2', 'Edit', { path: 'f.txt', old_string: 'beta', new_string: 'BETA' }),
        toolCallOf('e3', 'Edit', { path: 'f.txt', old_string: 'gamma', new_string: 'GAMMA' }),
        toolCallOf('w1', 'Write', { path: 'f.txt', content: 'rewritten\n', mode: 'overwrite' }),
      ]);

      expect(results.filter((text) => text.startsWith('Replaced 1 occurrence'))).toHaveLength(3);
      expect(results.filter((text) => text.startsWith('Wrote'))).toHaveLength(1);
      expect(results.join('\n')).not.toContain('Note:');
      expect(await readFile(file, 'utf8')).toBe('rewritten\n');
    } finally {
      await ctx.dispose();
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});

function toolResultTexts(history: readonly { role: string; content: readonly unknown[] }[]): string[] {
  return history
    .filter((message) => message.role === 'tool')
    .map((message) => message.content
      .map((part) => (part as { text?: unknown }).text)
      .filter((text): text is string => typeof text === 'string')
      .join('\n'));
}
