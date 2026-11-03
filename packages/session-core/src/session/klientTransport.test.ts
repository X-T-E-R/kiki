import { describe, expect, it, vi } from 'vitest';
import { RPCError } from '@kiki/klient/session-view';
import { createRebindableKlient } from '@kiki/klient/http';
import { createSessionTransport } from './klientTransport';
import { ApiError, type SessionTransport } from '../transport';

const actions = [
  { command: 'submit', args: [{ content: [{ type: 'text', text: 'hello' }] }], invoke: (t: SessionTransport) => t.submitPrompt('s1', { content: [{ type: 'text', text: 'hello' }] }) },
  { command: 'edit', args: ['m1', { content: [{ type: 'text', text: 'edited' }], expected_cursor: { seq: 7, epoch: 'cold:s1' } }], invoke: (t: SessionTransport) => t.editMessage('s1', 'm1', { content: [{ type: 'text', text: 'edited' }], expected_cursor: { seq: 7, epoch: 'cold:s1' } }) },
  { command: 'regenerate', args: ['m1', { expected_cursor: { seq: 7, epoch: 'cold:s1' } }], invoke: (t: SessionTransport) => t.regenerateMessage('s1', 'm1', { expected_cursor: { seq: 7, epoch: 'cold:s1' } }) },
  { command: 'steer', args: ['p1', 'child-1'], invoke: (t: SessionTransport) => t.steerPrompt('s1', 'p1', 'child-1') },
  { command: 'approve', args: ['a1', { decision: 'approved' }], invoke: (t: SessionTransport) => t.resolveApproval('s1', 'a1', { decision: 'approved' }) },
  { command: 'answer', args: ['q1', { answers: { q1: { kind: 'single', option_id: 'yes' } } }], invoke: (t: SessionTransport) => t.resolveQuestion('s1', 'q1', { answers: { q1: { kind: 'single', option_id: 'yes' } } }) },
  { command: 'dismiss', args: ['q1'], invoke: (t: SessionTransport) => t.dismissQuestion('s1', 'q1') },
  { command: 'cancelTask', args: ['task1', { agent_id: 'child-1' }], invoke: (t: SessionTransport) => t.cancelTask('s1', 'task1', { agent_id: 'child-1' }) },
];
const resumeActions = actions.filter(({ command }) => command !== 'submit');

describe('session command runtime admission', () => {
  it('submits through the durable command boundary without waiting for history resume', async () => {
    const resume = vi.fn(() => new Promise<boolean>(() => {}));
    const submit = vi.fn(async () => ({ accepted: true }));
    const session = vi.fn(() => ({ resume, commands: { submit } as never }));
    const transport = createSessionTransport({ session });
    await expect(transport.submitPrompt('s1', { content: [{ type: 'text', text: 'hello' }] })).resolves.toEqual({ accepted: true });
    expect(resume).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
  });
  it('preserves deadline details and identity across the session error adapter', async () => {
    const requestId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const details = { method: 'GET', path: '/api/sessions/s1', phase: 'headers', timeoutMs: 100, elapsedMs: 101, request_id: requestId };
    const failure = new RPCError(50001, 'call timed out after 100ms', details, 'transport.timeout', requestId, undefined, 'transport');
    const transport = createSessionTransport({ session: () => ({ resume: async () => true, commands: { read: async () => { throw failure; } } as never }) });
    await expect(transport.getSession('s1')).rejects.toMatchObject({ name: 'ApiError', details, requestId, source: 'transport', reason: 'transport.timeout' });
  });
  it.each(resumeActions)('awaits resume before $command and never while reading', async ({ command, args, invoke }) => {
    let settle!: (value: boolean) => void;
    const resume = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const operation = vi.fn(async () => ({ accepted: true }));
    const commands = { read: vi.fn(async () => ({})), [command]: operation };
    const session = vi.fn(() => ({ resume, commands: commands as never }));
    const transport = createSessionTransport({ session });
    await transport.getSession('s1');
    expect(resume).not.toHaveBeenCalled();
    const pending = invoke(transport);
    expect(session).toHaveBeenCalledWith('s1');
    expect(resume).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
    settle(true);
    await expect(pending).resolves.toEqual({ accepted: true });
    expect(operation).toHaveBeenCalledExactlyOnceWith(...args);
  });

  it.each(resumeActions)('does not execute $command when the session is missing', async ({ command, invoke }) => {
    const operation = vi.fn();
    const transport = createSessionTransport({ session: () => ({ resume: async () => false, commands: { [command]: operation } as never }) });
    await expect(invoke(transport)).rejects.toMatchObject({ code: 40401 });
    expect(operation).not.toHaveBeenCalled();
  });

  it.each(resumeActions)('preserves resume errors without executing $command', async ({ command, invoke }) => {
    const operation = vi.fn();
    const failure = new RPCError(40901, 'session locked');
    const transport = createSessionTransport({ session: () => ({ resume: async () => { throw failure; }, commands: { [command]: operation } as never }) });
    await expect(invoke(transport)).rejects.toBeInstanceOf(ApiError);
    await expect(invoke(transport)).rejects.toMatchObject({ code: 40901, message: 'session locked (code 40901)' });
    expect(operation).not.toHaveBeenCalled();
  });
});


describe('session command connection generations (F1)', () => {
  const envelope = (data: unknown) => Response.json({ code: 0, msg: 'success', data });
  const old = { endpoint: 'http://127.0.0.1:41001', token: 'old-token' };
  const replacement = { endpoint: 'http://127.0.0.1:42002', token: 'new-token' };

  it.each(resumeActions)('rejects $command after a successful resume continuation changes connection before dispatch', async ({ command, invoke }) => {
    let finishResume!: (resumed: boolean) => void;
    let generation = 0;
    const mutation = vi.fn(async () => ({ accepted: true }));
    const transport = createSessionTransport({
      captureOperation: () => {
        const started = generation;
        return () => { if (started !== generation) throw new RPCError(-1, 'Connection changed', undefined, 'transport.connection_changed', undefined, undefined, 'transport'); };
      },
      session: () => ({ resume: () => new Promise<boolean>((resolve) => { finishResume = resolve; }), commands: { [command]: mutation } as never }),
    });
    const pending = invoke(transport);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'ApiError', reason: 'transport.connection_changed', source: 'transport' });
    finishResume(true);
    generation += 1;
    await rejected;
    expect(mutation).not.toHaveBeenCalled();
  });

  it.each(resumeActions)('fences the production HTTP resume-to-$command microtask gap without dispatching to the replacement', async ({ invoke }) => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) return envelope({ id: 's1', kind: 'session' });
      throw new Error('A stale action must not dispatch another request');
    });
    const { klient, rebind } = createRebindableKlient({ ...old, fetch: fetcher });
    const resumed = vi.fn();
    const transport = createSessionTransport({
      captureOperation: klient.captureOperation!.bind(klient),
      session: (id) => {
        const session = klient.session(id);
        return { commands: session.commands, resume: () => session.resume().then((result) => {
          resumed(result);
          queueMicrotask(() => rebind(replacement));
          return result;
        }) };
      },
    });
    try {
      await expect(invoke(transport)).rejects.toMatchObject({ reason: 'transport.connection_changed' });
      expect(resumed).toHaveBeenCalledExactlyOnceWith(true);
      expect(calls).toEqual([`${old.endpoint}/api/klient/call`]);
    } finally { await klient.close(); }
  });

  it('permits explicit new actions on both sides of a rebind with each endpoint and bearer paired', async () => {
    const calls: Array<[string, string | undefined]> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(input), new Headers(init?.headers).get('authorization') ?? undefined]);
      return String(input).endsWith('/api/klient/call') ? envelope({ id: 's1', kind: 'session' }) : envelope({ cancelled: true });
    });
    const { klient, rebind } = createRebindableKlient({ ...old, fetch: fetcher });
    const transport = createSessionTransport(klient);
    try {
      await expect(transport.cancelTask('s1', 'task1')).resolves.toEqual({ cancelled: true });
      rebind(replacement);
      await expect(transport.cancelTask('s1', 'task1')).resolves.toEqual({ cancelled: true });
      expect(calls).toEqual([
        [`${old.endpoint}/api/klient/call`, 'Bearer old-token'],
        [`${old.endpoint}/api/sessions/s1/tasks/task1:cancel`, 'Bearer old-token'],
        [`${replacement.endpoint}/api/klient/call`, 'Bearer new-token'],
        [`${replacement.endpoint}/api/sessions/s1/tasks/task1:cancel`, 'Bearer new-token'],
      ]);
    } finally { await klient.close(); }
  });

  it('rejects a late completed action result while a fresh-generation action succeeds', async () => {
    let generation = 0;
    let finishOld!: (value: { cancelled: boolean }) => void;
    const mutation = vi.fn().mockImplementationOnce(() => new Promise<{ cancelled: boolean }>((resolve) => { finishOld = resolve; }))
      .mockResolvedValue({ cancelled: true });
    const transport = createSessionTransport({
      captureOperation: () => {
        const started = generation;
        return () => { if (started !== generation) throw new RPCError(-1, 'Connection changed', undefined, 'transport.connection_changed'); };
      },
      session: () => ({ resume: async () => true, commands: { cancelTask: mutation } as never }),
    });
    const pending = transport.cancelTask('s1', 'old-task');
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'transport.connection_changed' });
    await Promise.resolve();
    generation += 1;
    await expect(transport.cancelTask('s1', 'new-task')).resolves.toEqual({ cancelled: true });
    finishOld({ cancelled: true });
    await rejected;
    expect(mutation.mock.calls.map(([target]) => target)).toEqual(['old-task', 'new-task']);
  });
});
