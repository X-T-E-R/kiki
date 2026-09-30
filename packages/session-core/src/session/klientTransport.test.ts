import { describe, expect, it, vi } from 'vitest';
import { RPCError } from '@kiki/klient/session-view';
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

describe('session command runtime admission', () => {
  it.each(actions)('awaits resume before $command and never while reading', async ({ command, args, invoke }) => {
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

  it.each(actions)('does not execute $command when the session is missing', async ({ command, invoke }) => {
    const operation = vi.fn();
    const transport = createSessionTransport({ session: () => ({ resume: async () => false, commands: { [command]: operation } as never }) });
    await expect(invoke(transport)).rejects.toMatchObject({ code: 40401 });
    expect(operation).not.toHaveBeenCalled();
  });

  it.each(actions)('preserves resume errors without executing $command', async ({ command, invoke }) => {
    const operation = vi.fn();
    const failure = new RPCError(40901, 'session locked');
    const transport = createSessionTransport({ session: () => ({ resume: async () => { throw failure; }, commands: { [command]: operation } as never }) });
    await expect(invoke(transport)).rejects.toBeInstanceOf(ApiError);
    await expect(invoke(transport)).rejects.toMatchObject({ code: 40901, message: 'session locked (code 40901)' });
    expect(operation).not.toHaveBeenCalled();
  });
});
