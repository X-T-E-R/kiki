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

import { createViewState, projectAgentTranscriptView, type AssistantBlock, type Block, type SessionViewState, type ToolBlock, type UserBlock } from '@kiki/session-core/session';

type TranscriptTurn = Parameters<typeof projectAgentTranscriptView>[2]['items'][number];

import { I18nProvider } from '../i18n';
import { TranscriptDetailProvider } from './transcriptDetail';
import { MessageViewContext, type MessageViewContextValue } from './message/messageViewContext';
import { readTimelineView, type TimelineView } from './message/messageViewMode';
import { Transcript } from './Transcript';
import { outputLayerStore } from './output-layer';
import { OutputLayerClient } from '../lib/outputLayerClient';
import { setActiveOutputLayerClient } from './output-layer/useOutputLayerClient';

vi.mock('./markdown/streamdown-plugins', async (importOriginal) => {
  const original = await importOriginal<typeof import('./markdown/streamdown-plugins')>();
  return { ...original, useStreamdownPlugins: () => ({}) };
});

// The gallery order seam wraps each row's original block in a context provider
// and renders no DOM of its own, so its props are what the seam is observed by.
const galleryOrderProbe = vi.hoisted(() => ({ calls: [] as { agentId: string; order: number; blockId: string }[] }));

vi.mock('./mediaPreviewContext', async (importOriginal) => {
  const original = await importOriginal<typeof import('./mediaPreviewContext')>();
  return {
    ...original,
    MediaGalleryOrder: ({ agentId, order, blockId, children }: { agentId: string; order: number; blockId: string; children: ReactNode }) => {
      galleryOrderProbe.calls.push({ agentId, order, blockId });
      return children;
    },
  };
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
  // Transcript gates on `loaded && transcriptReady`; the shell flips `loaded`
  // alone, so an established transcript must also mark `transcriptReady`.
  return { ...createViewState('session_bot'), loaded: true, transcriptReady: true, blocks, ...overrides };
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

function assistant(id: string, text: string, turnId: string, extra: Partial<AssistantBlock> = {}): AssistantBlock {
  return { kind: 'assistant', id, text, streaming: false, turnId, createdAt: '2026-10-01T09:00:01.000Z', ...extra };
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
  it('speaks the reply a finished turn ended on when it sent nothing (acceptance 1)', async () => {
    const blocks: Block[] = [
      user('u1', '这周能发 0.31 吗？', 't1'),
      assistant('a1', '我先想一想，内部笔记', 't1'),
      tool('r1', 'Read', 't1'),
    ];
    const { container } = await render(timeline(blocks, 'message'));
    expect(container.textContent).toContain('这周能发 0.31 吗？');
    const row = container.querySelector('[data-message-origin="ordinary_final"]');
    expect(row?.querySelector('[data-message-text]')?.textContent).toContain('我先想一想，内部笔记');
    // The reply is the speech now: the work summary above it counts the read
    // and does not repeat the reply line as internal prose.
    expect(container.querySelector('[data-activity-summary]')?.textContent).not.toContain('内部笔记');
    expect(container.querySelector('[data-message-outcome="no-reply"]')).toBeNull();
  });

  it('keeps both turns when two turns end on the same short line', async () => {
    // Two turns may legitimately repeat a line; each keeps its own bubble.
    const blocks: Block[] = [
      user('u1', '第一问', 't1'), assistant('a1', '好的。', 't1'),
      user('u2', '第二问', 't2'), assistant('a2', '好的。', 't2'),
    ];
    const { container } = await render(timeline(blocks, 'message'));
    const rows = [...container.querySelectorAll('[data-message-view-row="message"]')]
      .filter((row) => row.querySelector('[data-message-origin="ordinary_final"]') !== null)
      .map((row) => row.getAttribute('data-block-id'));
    expect(rows).toEqual(['ordinary-final-a1', 'ordinary-final-a2']);
    expect(container.textContent?.match(/好的。/gu)).toHaveLength(2);
  });

  it('leaves a failed turn’s partial text in the process and keeps its failure line', async () => {
    // A turn that failed after writing text did not reply: the bubble says why,
    // the text stays process-only, and no promoted message appears.
    const blocks: Block[] = [
      user('u1', '看看构建', 't1', { promptOutcome: { status: 'failed', delivered: true, error: 'provider filtered the response' } }),
      assistant('a1', '构建看起来是绿的，但', 't1'),
    ];
    const message = await render(timeline(blocks, 'message'));
    expect(message.container.querySelector('[data-message-origin="ordinary_final"]')).toBeNull();
    expect(message.container.querySelector('[data-prompt-outcome="failed"]')).not.toBeNull();
    expect(message.container.querySelector('[data-message-outcome="no-reply"]')).toBeNull();
    // The bubble already carries the failure, so the view adds no second line.
    expect(message.container.querySelector('[data-message-outcome="danger"]')).toBeNull();
    const process = await render(timeline(blocks, 'process'));
    expect(process.container.textContent).toContain('构建看起来是绿的，但');
    expect(process.container.querySelector('[data-assistant-internal]')).not.toBeNull();
  });

  it('ends a turn that left nothing to read with one quiet status instead of silence', async () => {
    // The turn completed legally with no content and no text: the page must
    // not stop at the work summary and say nothing.
    const blocks: Block[] = [user('u1', '看看后台进度', 't1'), tool('r1', 'Read', 't1')];
    const { container } = await render(timeline(blocks, 'message', {
      turnTail: {
        turnId: 't1', state: 'completed', endedAt: '2026-10-01T09:00:05.000Z',
        durationMs: 4_000, ttftMs: undefined, usage: undefined, tokensPerSecond: undefined,
      },
    }));
    expect(container.querySelectorAll('[data-turn-tail-gap]')).toHaveLength(1);
    expect(container.querySelector('[data-turn-tail] [data-turn-tail-gap]')?.getAttribute('data-turn-tail-gap')).toBe('unknown');
    // The message view's own no-reply line belongs to a turn that wrote text
    // and stopped; an empty completion is not doubled up here.
    expect(container.querySelector('[data-message-outcome="no-reply"]')).toBeNull();
  });

  it('keeps a turn that answered free of the empty-turn status', async () => {
    const blocks: Block[] = [
      user('u1', '看看后台进度', 't1'), tool('r1', 'Read', 't1'), assistant('a1', '还在跑。', 't1'),
    ];
    const { container } = await render(timeline(blocks, 'message', {
      turnTail: {
        turnId: 't1', state: 'completed', endedAt: '2026-10-01T09:00:05.000Z',
        durationMs: 4_000, ttftMs: undefined, usage: undefined, tokensPerSecond: undefined,
      },
    }));
    expect(container.querySelector('[data-turn-tail-gap]')).toBeNull();
    expect(container.textContent).toContain('还在跑。');
  });

  it('leaves a turn the transcript reports as failed unsaid, and says once that it failed', async () => {
    // The fact comes from the loaded turn state, so it holds for an older turn
    // whose prompt record is not on the page: no speech, one readable failure
    // line that opens the process holding the text.
    const blocks: Block[] = [user('u1', '再试一次', 't1'), assistant('a1', '这次也差一点', 't1')];
    const { container } = await render(timeline(blocks, 'message', { failedTurnIds: ['t1'] }));
    expect(container.querySelector('[data-message-origin="ordinary_final"]')).toBeNull();
    expect(container.querySelector('[data-message-outcome="no-reply"]')).toBeNull();
    const outcome = [...container.querySelectorAll('[data-message-outcome="danger"]')];
    expect(outcome.map((row) => row.textContent)).toEqual(['轮次失败 · 查看过程']);
  });

  it('keeps an older failed turn readable as failed after a later turn answers, from the production projection', async () => {
    // Two loaded turns and no prompt records at all: the shape of a cold window
    // of an old session. The turn states are the only failure evidence, so this
    // walks the real projection the way the GUI receives it.
    const turn = (ordinal: number, state: 'failed' | 'completed', text: string): TranscriptTurn => ({
      kind: 'turn',
      turnId: `t${ordinal}`,
      ordinal,
      state,
      error: state === 'failed' ? 'provider filtered the response' : undefined,
      origin: { kind: 'user', payload: { promptId: `p${ordinal}`, userMessageId: `p${ordinal}` } },
      prompt: `第 ${ordinal} 问`,
      startedAt: '2026-10-01T09:00:00.000Z',
      endedAt: '2026-10-01T09:00:01.000Z',
      steps: [{
        kind: 'step', stepId: `t${ordinal}.1`, turnId: `t${ordinal}`, ordinal: 1, state,
        startedAt: '2026-10-01T09:00:00.000Z', endedAt: '2026-10-01T09:00:01.000Z',
        frames: [{ kind: 'text', frameId: `f${ordinal}`, role: 'assistant', text }],
      }],
    });
    const projected = projectAgentTranscriptView(createViewState('session_bot'), 'main', {
      items: [turn(7, 'failed', '这次也只写了一半'), turn(8, 'completed', '发布清单在这里。')],
      tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {}, hasMoreOlder: false,
    });
    expect(projected.failedTurnIds).toEqual(['t7']);
    const blocks = [...projected.blocks];

    const message = await render(timeline(blocks, 'message', { failedTurnIds: projected.failedTurnIds }));
    const spoken = [...message.container.querySelectorAll('[data-message-origin="ordinary_final"]')];
    expect(spoken.map((row) => row.textContent)).toEqual([expect.stringContaining('发布清单在这里。')]);
    expect(message.container.querySelector('[data-message-outcome="no-reply"]')).toBeNull();
    expect(message.container.querySelector('[data-prompt-outcome]')).toBeNull();
    // Exactly one line for the failed turn, and it is a failure, not a cancel.
    expect([...message.container.querySelectorAll('[data-message-outcome="danger"]')].map((row) => row.textContent))
      .toEqual(['轮次失败 · 查看过程']);

    // The cut-off text is readable where it belongs, still marked as not the reply.
    const process = await render(timeline(blocks, 'process', { failedTurnIds: projected.failedTurnIds }));
    expect(process.container.textContent).toContain('这次也只写了一半');
    expect(process.container.textContent).toContain('发布清单在这里。');
    expect(process.container.querySelector('[data-assistant-internal]')?.textContent).toContain('内部');
    expect(process.container.querySelector('[data-assistant-prose]')?.textContent).toContain('这次也只写了一半');
  });

  it('keeps the running turn’s text out of the message view until that turn ends', async () => {
    // The session says turn t2 is the running one; its settled text may still
    // grow or be superseded, so it is not speech yet. The turn before it is.
    const blocks: Block[] = [
      user('u1', '在吗', 't1'),
      assistant('a1', '在，先说结论。', 't1'),
      user('u2', '那再查一下', 't2'),
      assistant('a2', '正在查的中途结论', 't2'),
    ];
    const { container } = await render(timeline(blocks, 'message', { busy: true, abortableTurnId: 2 }));
    const rows = [...container.querySelectorAll('[data-message-origin="ordinary_final"]')];
    expect(rows.map((row) => row.querySelector('[data-message-text]')?.textContent)).toEqual(['在，先说结论。']);
  });

  it('marks mid-turn prose "内部" in the process view, but not the reply it speaks', async () => {
    // The same text is speech in the message view and prose in the process;
    // only the text the message view already says loses the internal label.
    const blocks: Block[] = [
      user('u1', '在吗', 't1'),
      assistant('a1', '先看一眼再答。', 't1'),
      tool('r1', 'Read', 't1'),
      assistant('a2', '在，先说结论。', 't1'),
    ];
    const { container } = await render(timeline(blocks, 'process'));
    expect(container.textContent).toContain('先看一眼再答。');
    const marked = (id: string) => container.querySelector(`[data-block-id="${id}"] [data-assistant-internal]`) !== null;
    expect(marked('a1')).toBe(true);
    expect(marked('a2')).toBe(false);
  });

  it('hangs one-line status rows off the message above and draws no row for a silent stretch', async () => {
    const blocks: Block[] = [
      user('u1', '这周能发吗？', 't1'),
      tool('r1', 'Read', 't1'),
      sendMessage('s1', 't1', '能。'),
      user('u2', '在吗', 't2'),
      assistant('a2', '只是内部笔记', 't2'),
      // Stopped mid-answer: the turn leaves the reader a reason, not speech.
      assistant('a3', '说到一半', 't3', { stopped: true }),
      user('u3', '还在吗', 't4'),
    ];
    const { container } = await render(timeline(blocks, 'message'));
    const wrapperOf = (selector: string) => container.querySelector(selector)?.closest('[data-transcript-virtual-item]')?.firstElementChild;
    expect(wrapperOf('[data-message-view-row="activity-summary"]')?.className).toContain('-mt-2');
    expect(wrapperOf('[data-message-outcome="no-reply"]')?.className).toContain('-mt-2');
    // t2 has only internal prose: its summary counts nothing and is not a row.
    expect(container.querySelectorAll('[data-message-view-row="activity-summary"]')).toHaveLength(1);
    expect([...container.querySelectorAll('[data-transcript-virtual-item]')].every((item) => item.textContent?.trim() !== '')).toBe(true);
  });

  it('offers the rest of a long body the window could only preview', async () => {
    // A 20 000-character message reaches the page as a ~433-character preview
    // plus a ref (the wire's own bounded-content contract). The row must read
    // the rest of its own field instead of stopping at the preview.
    const ref = { source: { kind: 'frame' as const, id: 'frame_s1', turnId: 't1', stepId: 't1.1' }, path: ['input', 'text'], kind: 'text' as const, offset: 433, total: 20_000, revision: 'rev-1' };
    const loadContent = vi.fn(() => Promise.resolve(true));
    const blocks: Block[] = [
      user('u1', '把清单发我', 't1'),
      sendMessage('s1', 't1', '清单开头', { frameId: 'frame_s1', stepId: 't1.1' }),
    ];
    const { container } = await render(
      <TranscriptDetailProvider load={() => Promise.resolve(false)} loads={{}} contentRefs={[ref]} sessionId="session_bot" agentId="main" loadContent={loadContent}>
        {timeline(blocks, 'message')}
      </TranscriptDetailProvider>,
    );
    const row = container.querySelector('[data-message-status="sent"]')!;
    const progress = row.querySelector('[data-content-continuation-progress]');
    expect(progress?.textContent).toContain('消息正文');
    expect(progress?.textContent).toContain('2%');
    await act(async () => (row.querySelector('[data-content-continuation-action]') as HTMLElement).click());
    expect(loadContent).toHaveBeenCalledWith(ref);
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

  it('shows only the body of a peer-thread bubble in the message view too', async () => {
    const blocks: Block[] = [
      user('u9', 'Message from thread "Design review" (sess-source):\n\nping', 't1', {
        peerThread: { sessionId: 'sess-source', messageId: 'm9' },
      }),
    ];
    const { container } = await render(timeline(blocks, 'message'));
    expect(container.querySelector('[data-source-block-id="u9"]')?.textContent).toBe('ping');
    expect(container.textContent).not.toContain('Message from thread');
    expect(container.textContent).toContain('来自线程 sess-source');
  });

  it('says who is working while the turn runs, without the process spinner', async () => {
    const blocks: Block[] = [user('u1', '查一下', 't1'), tool('r1', 'Read', 't1', { status: 'running', output: undefined })];
    const { container } = await render(timeline(blocks, 'message', { busy: true, turnStartedAt: Date.now() }));
    expect(container.querySelector('[data-message-presence]')?.textContent).toContain('林岚 正在处理');
  });

  it('hands each bot-mode row its original block’s place in the session blocks', async () => {
    galleryOrderProbe.calls.length = 0;
    const blocks: Block[] = [
      // A received handoff: a real user block, so it owns its own place.
      user('u9', '来自 林岚：changelog 还差三条，你来起草', 't1', {
        peerThread: { sessionId: 'session_bot', personaId: LIN.id, senderName: LIN.name, messageId: 'h1' },
      }),
      user('u1', '发个消息', 't1'),
      // A delivered message is projected from its SendMessage call: the call is
      // the block that lives in the session's blocks, so it owns the place.
      sendMessage('s1', 't1', '能。'),
    ];
    await render(timeline(blocks, 'message'));
    expect(galleryOrderProbe.calls).toEqual([
      { agentId: 'main', order: 0, blockId: 'u9' },
      { agentId: 'main', order: 1, blockId: 'u1' },
      { agentId: 'main', order: 2, blockId: 's1' },
    ]);
  });

  it('keeps native Assistant prose and row copy original with a selected blank-model preset and zero generation', async () => {
    const sessionId = 'session_bot';
    const preset = { id: 'native-empty', label: '未选模型预设', instruction: '翻译', modelId: '   ', contextWindow: 32768 };
    outputLayerStore.setConfiguration({ enabled: true, presets: [preset], settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 } }, `local::${sessionId}`);
    outputLayerStore.setActivePreset(sessionId, preset.id);
    const stream = vi.fn();
    const client = new OutputLayerClient({ configuration: vi.fn(), configure: vi.fn(), stream });
    const process = vi.spyOn(client, 'process');
    setActiveOutputLayerClient(client);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const original = 'Native Assistant original';
    const { container } = await render(timeline([assistant('native-empty-answer', original, 't1')], 'process'));
    expect(container.querySelector('[data-output-layer-unconfigured]')).not.toBeNull();
    expect(container.querySelector('[data-assistant-prose]')?.textContent).toContain(original);
    await act(async () => (container.querySelector('[data-row-action="copy"]') as HTMLElement).click());
    expect(writeText).toHaveBeenCalledWith(original);
    expect(process).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
    setActiveOutputLayerClient(null);
    outputLayerStore.setActivePreset(sessionId, null);
    outputLayerStore.setConfiguration(null, `local::${sessionId}`);
  });

  it('copies the current streamed reading version after the source stops and isolates preset/source changes', async () => {
    const sessionId = 'reading-copy-session';
    const context = { ...BOT_CONTEXT, sessionId };
    const preset = { id: 'reading-first', label: '翻译', instruction: 'Translate', modelId: 'explicit', contextWindow: 32768 };
    const secondPreset = { ...preset, id: 'reading-second', instruction: 'Rewrite' };
    const emptyPreset = { ...preset, id: 'reading-empty', modelId: '' };
    const configuration = { enabled: true, presets: [preset, secondPreset, emptyPreset], settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 } };
    const requests: { emit: Parameters<ConstructorParameters<typeof OutputLayerClient>[0]['stream']>[1]; finish: () => void; signal?: AbortSignal }[] = [];
    const stream = vi.fn<ConstructorParameters<typeof OutputLayerClient>[0]['stream']>(async (_input, emit, options) => {
      emit({ type: 'started', cycleId: 'reading-cycle', historyReset: false, contextWindow: 32768, inputTokensEstimate: 10 });
      await new Promise<void>(finish => requests.push({ emit, finish, signal: options?.signal }));
    });
    const client = new OutputLayerClient({ configuration: vi.fn().mockResolvedValue(configuration), configure: vi.fn(), stream });
    const process = vi.spyOn(client, 'process');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    outputLayerStore.setConfiguration(configuration, `local::${sessionId}`);
    outputLayerStore.setActivePreset(sessionId, preset.id);
    setActiveOutputLayerClient(client);
    const original = 'Stopped source original';
    const blockId = 'reading-copy-answer';
    const { container, rerender } = await render(timeline([assistant(blockId, original, 't1')], 'process', {}, context));
    const copy = async (expected: string) => {
      await act(async () => (container.querySelector('[data-row-action="copy"]') as HTMLElement).click());
      expect(writeText).toHaveBeenLastCalledWith(expected);
    };
    const switchView = async (label: string) => {
      const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === label)!;
      await act(async () => button.click());
    };
    try {
      expect(requests).toHaveLength(1);
      await act(async () => requests[0]!.emit({ type: 'delta', text: '译文一半' }));
      expect(container.querySelector('[data-assistant-prose]')?.textContent).toContain('译文一半');
      await copy('译文一半');
      await act(async () => { requests[0]!.emit({ type: 'completed', text: '译文完成' }); requests[0]!.finish(); });
      await copy('译文完成');
      await switchView('查看原文'); await copy(original);
      await switchView('查看处理版'); await copy('译文完成');
      const copyOriginal = Array.from(container.querySelectorAll('button')).find(item => item.textContent === '复制原文')!;
      await act(async () => copyOriginal.click());
      expect(writeText).toHaveBeenLastCalledWith(original);
      await copy('译文完成');

      await act(async () => outputLayerStore.setActivePreset(sessionId, secondPreset.id));
      await copy(original);
      expect(requests).toHaveLength(2);
      await act(async () => requests[1]!.emit({ type: 'delta', text: '改写一半' }));
      await copy('改写一半');
      const replacement = 'Replacement source';
      await rerender(timeline([assistant(blockId, replacement, 't1')], 'process', {}, context));
      await copy(replacement);
      expect(requests[1]!.signal?.aborted).toBe(true);
      await act(async () => { requests[1]!.emit({ type: 'completed', text: '旧源迟到文本' }); requests[1]!.finish(); });
      expect(requests).toHaveLength(3);
      await copy(replacement);
      await act(async () => requests[2]!.emit({ type: 'delta', text: '新源处理一半' }));
      await copy('新源处理一半');
      await act(async () => outputLayerStore.setActivePreset(sessionId, preset.id));
      await copy(replacement);
      expect(requests[2]!.signal?.aborted).toBe(true);
      await act(async () => { requests[2]!.emit({ type: 'completed', text: '旧预设迟到文本' }); requests[2]!.finish(); });
      expect(requests).toHaveLength(4);
      await copy(replacement);
      await act(async () => { requests[3]!.emit({ type: 'completed', text: '新预设完成' }); requests[3]!.finish(); });
      await copy('新预设完成');
      await act(async () => outputLayerStore.setActivePreset(sessionId, null));
      await copy(replacement);
      const processingCount = process.mock.calls.length;
      await act(async () => outputLayerStore.setActivePreset(sessionId, emptyPreset.id));
      await copy(replacement);
      expect(process).toHaveBeenCalledTimes(processingCount);
      expect(stream).toHaveBeenCalledTimes(4);
    } finally {
      await act(async () => { outputLayerStore.setActivePreset(sessionId, null); client.cancel(sessionId); for (const request of requests) request.finish(); });
      setActiveOutputLayerClient(null);
      outputLayerStore.setConfiguration(null, `local::${sessionId}`);
    }
  });

  it('immediately restores original block.text for prose and copyText when output layer is turned off', async () => {
    const sessionId = 'session_bot';
    const contextKey = `local::${sessionId}`;
    outputLayerStore.setConfiguration(
      {
        enabled: true,
        presets: [{ id: 'translate', label: '翻译', instruction: '翻译', contextWindow: 32768, maxOutputTokens: 2048 }],
        settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
      },
      contextKey,
    );

    const originalText = '这是原始的回复，不应被处理版覆盖。';
    const blocks: Block[] = [assistant('a-out-1', originalText, 't1')];

    // 1. Initial state: Output layer enabled and preset active
    outputLayerStore.setActivePreset(sessionId, 'translate');

    const { container, rerender } = await render(timeline(blocks, 'process'));
    // AssistantOutputContent is mounted
    expect(container.querySelector('[data-assistant-prose]')?.textContent).toContain('复制原文');

    // 2. User turns off output layer preset
    await act(async () => {
      outputLayerStore.setActivePreset(sessionId, null);
    });

    await rerender(timeline(blocks, 'process'));

    // Output layer specific controls unmount
    expect(container.querySelector('[data-assistant-prose]')?.textContent).not.toContain('复制原文');
    // Original block.text is rendered directly
    const prose = container.querySelector('[data-assistant-prose]');
    expect(prose?.textContent).toContain(originalText);

    // Row action copy button is present
    const copyButton = container.querySelector('[data-row-action="copy"]');
    expect(copyButton).not.toBeNull();

    // Reset store
    outputLayerStore.setActivePreset(sessionId, null);
    outputLayerStore.setConfiguration(null);
  });
});
