// @vitest-environment jsdom

/**
 * The message view (Bot mode): only delivered speech is shown, the draft
 * grows from the SendMessage argument stream, a cancelled call leaves one
 * line, activity summaries count what the process view shows, "查看过程"
 * flips the session to the process view, and a handoff reads the same on
 * both sides.
 */

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createViewState, type Block, type SessionViewState, type ToolBlock, type UserBlock } from '@kiki/session-core/session';

import { I18nProvider } from '../i18n';
import { MessageViewContext, type MessageViewContextValue } from './message/messageViewContext';
import { readTimelineView, type TimelineView } from './message/messageViewMode';
import { Transcript } from './Transcript';

vi.mock('./markdown/streamdown-plugins', async (importOriginal) => {
  const original = await importOriginal<typeof import('./markdown/streamdown-plugins')>();
  return { ...original, useStreamdownPlugins: () => ({}) };
});

const roots: Root[] = [];
const originals = new Map<PropertyKey, PropertyDescriptor | undefined>();

function install(key: PropertyKey, descriptor: PropertyDescriptor): void {
  originals.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
  Object.defineProperty(HTMLElement.prototype, key, { configurable: true, ...descriptor });
}

class StillResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'zh');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // A tall viewport so the virtualizer renders every row of these short timelines.
  install('offsetHeight', { get(this: HTMLElement) { return this.hasAttribute('data-transcript-scroll') ? 4000 : 40; } });
  install('offsetWidth', { get(this: HTMLElement) { return this.hasAttribute('data-transcript-scroll') ? 760 : 0; } });
  install('clientHeight', { get(this: HTMLElement) { return this.hasAttribute('data-transcript-scroll') ? 4000 : 0; } });
  install('scrollHeight', { get(this: HTMLElement) { return this.hasAttribute('data-transcript-scroll') ? 4000 : 0; } });
  install('scrollTo', { value() {} });
  vi.stubGlobal('ResizeObserver', StillResizeObserver);
});

afterAll(async () => {
  for (const root of roots) await act(async () => { flushSync(() => { root.unmount(); }); });
  for (const [key, descriptor] of originals) {
    if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<PropertyKey, unknown>)[key];
    else Object.defineProperty(HTMLElement.prototype, key, descriptor);
  }
  vi.unstubAllGlobals();
  localStorage.clear();
});

const LIN = { id: 'lin-lan', name: '林岚' };
const BOT_CONTEXT: MessageViewContextValue = { persona: LIN, sessionId: 'session_bot', internalProse: true };

function state(blocks: Block[], overrides: Partial<SessionViewState> = {}): SessionViewState {
  return { ...createViewState('session_bot'), loaded: true, blocks, ...overrides };
}

async function render(node: ReactNode): Promise<{ container: HTMLDivElement; rerender: (next: ReactNode) => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const paint = async (next: ReactNode) => {
    await act(async () => {
      flushSync(() => {
        root.render(<QueryClientProvider client={queryClient}><MemoryRouter><I18nProvider>{next}</I18nProvider></MemoryRouter></QueryClientProvider>);
      });
    });
  };
  await paint(node);
  return { container, rerender: paint };
}

function timeline(blocks: Block[], view: TimelineView, overrides: Partial<SessionViewState> = {}, context = BOT_CONTEXT): ReactNode {
  return (
    <MessageViewContext.Provider value={context}>
      <Transcript
        state={state(blocks, overrides)}
        view={view}
        onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => Promise.resolve()}
        onAnswerQuestion={() => Promise.resolve()}
        onDismissQuestion={() => Promise.resolve()}
      />
    </MessageViewContext.Provider>
  );
}

function user(id: string, text: string, turnId: string, extra: Partial<UserBlock> = {}): UserBlock {
  return { kind: 'user', id, text, turnId, createdAt: '2026-10-01T09:00:00.000Z', ...extra };
}

function assistant(id: string, text: string, turnId: string): Block {
  return { kind: 'assistant', id, text, streaming: false, turnId, createdAt: '2026-10-01T09:00:01.000Z' } as Block;
}

function tool(id: string, name: string, turnId: string, extra: Partial<ToolBlock> = {}): ToolBlock {
  return {
    kind: 'tool', id, toolCallId: `call_${id}`, name, argsText: '{}', args: {}, display: undefined,
    description: undefined, status: 'done', output: 'ok', isError: false, durationMs: 1200,
    durationSource: 'frame', progressText: undefined, turnId, startedAt: 1_790_000_000_000,
    ...extra,
  } as ToolBlock;
}

function sendMessage(id: string, turnId: string, text: string, extra: Partial<ToolBlock> = {}, output: Record<string, unknown> = {}): ToolBlock {
  const args = { text };
  return tool(id, 'SendMessage', turnId, {
    argsText: JSON.stringify(args),
    args,
    output: JSON.stringify({
      message_id: `msg_${id}`,
      delivered_to: ['user'],
      sender: { persona_id: LIN.id, name: LIN.name, session_id: 'session_bot' },
      ...output,
    }),
    ...extra,
  });
}

describe('message view (Bot mode)', () => {
  it('hides internal prose and says "没有回复" when a finished turn sent nothing (acceptance 1)', async () => {
    const blocks: Block[] = [
      user('u1', '这周能发 0.31 吗？', 't1'),
      assistant('a1', '我先想一想，内部笔记', 't1'),
      tool('r1', 'Read', 't1'),
    ];
    const { container } = await render(timeline(blocks, 'message'));
    expect(container.textContent).toContain('这周能发 0.31 吗？');
    expect(container.textContent).not.toContain('内部笔记');
    const outcome = container.querySelector('[data-message-outcome="no-reply"]');
    expect(outcome?.textContent).toContain('林岚 没有回复');
  });

  it('marks the same prose "内部" in the process view', async () => {
    const blocks: Block[] = [user('u1', '在吗', 't1'), assistant('a1', '内部笔记', 't1')];
    const { container } = await render(timeline(blocks, 'process'));
    expect(container.textContent).toContain('内部笔记');
    expect(container.querySelector('[data-assistant-internal]')?.textContent).toBe('内部');
  });

  it('hangs one-line status rows off the message above and draws no row for a silent stretch', async () => {
    const blocks: Block[] = [
      user('u1', '这周能发吗？', 't1'),
      tool('r1', 'Read', 't1'),
      sendMessage('s1', 't1', '能。'),
      user('u2', '在吗', 't2'),
      assistant('a2', '只是内部笔记', 't2'),
    ];
    const { container } = await render(timeline(blocks, 'message'));
    const wrapperOf = (selector: string) => container.querySelector(selector)?.closest('[data-transcript-virtual-item]')?.firstElementChild;
    expect(wrapperOf('[data-message-view-row="activity-summary"]')?.className).toContain('-mt-2.5');
    expect(wrapperOf('[data-message-outcome="no-reply"]')?.className).toContain('-mt-2.5');
    // t2 has only internal prose: its summary counts nothing and is not a row.
    expect(container.querySelectorAll('[data-message-view-row="activity-summary"]')).toHaveLength(1);
    expect([...container.querySelectorAll('[data-transcript-virtual-item]')].every((item) => item.textContent?.trim() !== '')).toBe(true);
  });

  it('grows the draft from the argument stream, then settles (acceptance 2)', async () => {
    const running = (argsText: string) => sendMessage('s1', 't1', '', { status: 'running', argsText, args: undefined, output: undefined });
    const base: Block[] = [user('u1', '发个消息', 't1')];
    const { container, rerender } = await render(timeline([...base, running('{"text":"能，差')], 'message', { busy: true }));
    const draft = () => container.querySelector('[data-message-status="sending"] [data-message-text]')?.textContent ?? '';
    expect(draft()).toContain('能，差');
    await rerender(timeline([...base, running('{"text":"能，差两件事。\\n@阿澈')], 'message', { busy: true }));
    expect(draft()).toContain('能，差两件事。');
    expect(draft()).toContain('@阿澈');
    await rerender(timeline([...base, sendMessage('s1', 't1', '能，差两件事。')], 'message'));
    expect(container.querySelector('[data-message-status="sending"]')).toBeNull();
    expect(container.querySelector('[data-message-status="sent"]')?.textContent).toContain('能，差两件事。');
  });

  it('leaves one line and no bubble when the send is cancelled', async () => {
    const blocks: Block[] = [
      user('u1', '发个消息', 't1'),
      sendMessage('s1', 't1', '写到一半', { status: 'stopped', output: undefined }),
    ];
    const { container } = await render(timeline(blocks, 'message'));
    const row = container.querySelector('[data-message-status="cancelled"]');
    expect(row?.textContent).toBe('消息已取消 · 查看过程');
    expect(container.textContent).not.toContain('写到一半');
  });

  it('counts the same work the process view shows and opens it at the turn (acceptance 3)', async () => {
    const blocks: Block[] = [
      user('u1', '查一下', 't1'),
      tool('r1', 'Read', 't1'),
      tool('r2', 'Read', 't1'),
      tool('b1', 'Bash', 't1'),
      tool('g1', 'Grep', 't1'),
      sendMessage('s1', 't1', '查好了'),
    ];
    const { container } = await render(timeline(blocks, 'message'));
    const summary = container.querySelector('[data-activity-summary]');
    expect(summary?.textContent).toContain('读 2 个文件');
    expect(summary?.textContent).toContain('跑 1 条命令');
    expect(summary?.textContent).toContain('另 1 步');
    await act(async () => {
      summary?.querySelector<HTMLButtonElement>('[data-activity-summary-toggle]')?.click();
    });
    expect(container.querySelectorAll('[data-activity-summary-members] [data-block-id]')).toHaveLength(4);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-activity-summary-process]')?.click();
    });
    expect(readTimelineView('session_bot', { delivery: 'message' })).toBe('process');
  });

  it('shows a handoff line on the sending side and on the receiving side (acceptance 4)', async () => {
    const outbound: Block[] = [
      user('u1', '让阿澈起草 changelog', 't1'),
      sendMessage('s1', 't1', 'changelog 还差三条，你来起草', { argsText: '{"to":"@阿澈","text":"changelog 还差三条，你来起草"}' }, {
        delivered_to: ['a-che'],
        handoff: { target_persona_id: 'a-che', target_session_id: 'session_ache', target_name: '阿澈', message_id: 'h1' },
      }),
    ];
    const sender = await render(timeline(outbound, 'message'));
    const sent = sender.container.querySelector('[data-message-handoff]');
    expect(sent?.textContent).toContain('林岚 → 阿澈');
    expect(sent?.textContent).toContain('changelog 还差三条');

    const inbound: Block[] = [
      user('u9', '来自 林岚：changelog 还差三条，你来起草', 't1', {
        peerThread: { sessionId: 'session_bot', personaId: LIN.id, senderName: LIN.name, messageId: 'h1' },
      }),
    ];
    const receiver = await render(timeline(inbound, 'message', {}, { persona: { id: 'a-che', name: '阿澈' }, sessionId: 'session_ache', internalProse: true }));
    const received = receiver.container.querySelector('[data-message-handoff]');
    expect(received?.textContent).toContain('林岚 → 阿澈');
    expect(received?.textContent).toContain('changelog 还差三条，你来起草');
    expect(received?.textContent).not.toContain('来自');
  });

  it('says who is working while the turn runs, without the process spinner', async () => {
    const blocks: Block[] = [user('u1', '查一下', 't1'), tool('r1', 'Read', 't1', { status: 'running', output: undefined })];
    const { container } = await render(timeline(blocks, 'message', { busy: true, turnStartedAt: Date.now() }));
    expect(container.querySelector('[data-message-presence]')?.textContent).toContain('林岚 正在处理');
  });
});
