// @vitest-environment jsdom

/**
 * Find in this conversation: counting, stepping, revealing folded matches,
 * focus return, selection prefill, and the route rule for Ctrl+F.
 */

import { act, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createViewState, type ActivitySummary, type Block, type SessionViewState, SessionController } from '@kiki/session-core/session';

import { I18nProvider } from '../../i18n';
import type { SearchMessageHit } from '../../lib/client';
import { resetTimelineLocatorsForTests } from '../../lib/timelineLocate';
import {
  buildFindPattern,
  collectMatches,
  handleFindShortcut,
  matchOffsets,
  resetFindHostsForTests,
  selectionPrefill,
} from '../../lib/timelineFind';
import { useTimelineView } from '../message/messageViewMode';
import { Transcript } from '../Transcript';
import { FindBar, classifyOutsideHits, setFindSearchForTests } from './FindBar';
import { TranscriptDetailProvider } from '../transcriptDetail';
import { buildFindItems } from './findItems';

vi.mock('../markdown/streamdown-plugins', async (importOriginal) => {
  const original = await importOriginal<typeof import('../markdown/streamdown-plugins')>();
  return { ...original, useStreamdownPlugins: () => ({}) };
});

// jsdom has no layout: give the scroll box and rows fixed sizes (the same
// minimal geometry Transcript.test.tsx uses) so the virtualizer mounts rows.
const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
function install(key: PropertyKey, descriptor: PropertyDescriptor): void {
  descriptors.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
  Object.defineProperty(HTMLElement.prototype, key, { configurable: true, ...descriptor });
}
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  install('offsetHeight', {
    get(this: HTMLElement) {
      if (this.hasAttribute('data-transcript-scroll')) return 2000;
      return this.hasAttribute('data-transcript-virtual-item') ? 60 : 0;
    },
  });
  install('offsetWidth', { get(this: HTMLElement) { return this.hasAttribute('data-transcript-scroll') ? 760 : 0; } });
  install('clientHeight', { get(this: HTMLElement) { return this.hasAttribute('data-transcript-scroll') ? 2000 : 0; } });
  install('scrollTo', {
    value(this: HTMLElement, options: ScrollToOptions | number, y?: number) {
      this.scrollTop = typeof options === 'number' ? (y ?? 0) : (options.top ?? this.scrollTop);
      this.dispatchEvent(new Event('scroll'));
    },
  });
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
});

afterAll(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<PropertyKey, unknown>)[key];
    else Object.defineProperty(HTMLElement.prototype, key, descriptor);
  }
  vi.unstubAllGlobals();
});

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => { flushSync(() => { root.unmount(); }); });
  }
  document.body.innerHTML = '';
  resetFindHostsForTests();
  resetTimelineLocatorsForTests();
  setFindSearchForTests(undefined);
});

const at = '2026-01-01T00:00:00.000Z';
const user = (id: string, text: string, turnId: string): Block => ({ kind: 'user', id, text, createdAt: at, turnId });
const answer = (id: string, text: string, turnId: string): Block => ({ kind: 'assistant', id, text, streaming: false, createdAt: at, turnId });
const think = (id: string, text: string, turnId: string): Block => ({ kind: 'thinking', id, text, streaming: false, createdAt: at, turnId });
const tool = (id: string, command: string, output: string, turnId: string): Block => ({
  kind: 'tool', id, toolCallId: id, name: 'Bash', argsText: '', args: { command }, display: undefined,
  description: undefined, status: 'done', output, isError: undefined, durationMs: undefined, progressText: undefined, turnId,
});

/** Turn 1 settles into a history fold; its thinking and tool hold the needle. */
function foldedSession(): Block[] {
  return [
    user('u1', 'please check the needle', 't1'),
    think('th1', 'the needle is probably in config', 't1'),
    tool('tool1', 'grep -r needle .', 'src/needle.ts: export const needle = 1', 't1'),
    tool('tool2', 'cat readme', 'nothing here', 't1'),
    answer('a1', 'Found it: **needle** lives in `src/needle.ts`.', 't1'),
    user('u2', 'thanks', 't2'),
    answer('a2', 'You are welcome.', 't2'),
  ];
}

function state(blocks: Block[], overrides: Partial<SessionViewState> = {}): SessionViewState {
  // Transcript gates on `loaded && transcriptReady`; a mounted timeline must
  // mark both, or the fold, rows and find host never render.
  return { ...createViewState('session_find'), loaded: true, transcriptReady: true, blocks, ...overrides };
}

async function mount(node: ReactNode): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    flushSync(() => { root.render(<MemoryRouter><I18nProvider>{node}</I18nProvider></MemoryRouter>); });
  });
  await settle();
  return { root, container };
}

function timeline(blocks: Block[], overrides: Partial<SessionViewState> = {}, extra: ReactNode = null): ReactNode {
  return (
    <>
      <Transcript
        state={state(blocks, overrides)}
        onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => Promise.resolve()}
        onAnswerQuestion={() => Promise.resolve()}
        onDismissQuestion={() => Promise.resolve()}
      />
      {extra}
    </>
  );
}

async function settle(ms = 40): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** App.tsx's Ctrl+F listener, for the session route. */
function installSessionShortcut(route: 'session' | 'settings' | 'other' = 'session', focusSettingsSearch = () => {}) {
  const listener = (event: KeyboardEvent) => {
    handleFindShortcut(event, route, { overlayOpen: () => false, focusSettingsSearch });
  };
  window.addEventListener('keydown', listener, true);
  return () => { window.removeEventListener('keydown', listener, true); };
}

async function typeQuery(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(80);
}

describe('find matching', () => {
  it('counts literal, case-sensitive and whole-word matches (CJK included)', () => {
    expect(matchOffsets('Needle needle NEEDLE', buildFindPattern('needle', { caseSensitive: false, wholeWord: false })!)).toHaveLength(3);
    expect(matchOffsets('Needle needle NEEDLE', buildFindPattern('needle', { caseSensitive: true, wholeWord: false })!)).toEqual([[7, 13]]);
    expect(matchOffsets('needles needle', buildFindPattern('needle', { caseSensitive: false, wholeWord: true })!)).toEqual([[8, 14]]);
    expect(matchOffsets('查找功能和查找', buildFindPattern('查找', { caseSensitive: false, wholeWord: false })!)).toHaveLength(2);
    expect(matchOffsets('a.b axb', buildFindPattern('a.b', { caseSensitive: false, wholeWord: false })!)).toEqual([[0, 3]]);
    expect(buildFindPattern('', { caseSensitive: false, wholeWord: false })).toBeNull();
  });

  it('indexes conversation text by default and only tool output when selected', () => {
    const items = buildFindItems(foldedSession());
    const pattern = buildFindPattern('needle', { caseSensitive: false, wholeWord: false });
    const count = (items: ReturnType<typeof buildFindItems>) => {
      const byBlock = new Map<string, number>();
      for (const match of collectMatches(items, pattern)) byBlock.set(match.item.blockId, (byBlock.get(match.item.blockId) ?? 0) + 1);
      return Object.fromEntries(byBlock);
    };
    expect(count(items)).toEqual({ u1: 1, a1: 2 });
    expect(count(buildFindItems(foldedSession(), true))).toEqual({ u1: 1, tool1: 2, a1: 2 });
    const sources = [user('body', 'body-token', 't1'), think('thought', 'thought-token', 't1'), tool('result', 'param-token', 'output-token', 't1')];
    for (const include of [false, true]) {
      const indexed = buildFindItems(sources, include).map((item) => item.text).join('\n');
      expect(indexed).toContain('body-token');
      expect(indexed.includes('output-token')).toBe(include);
      expect(indexed).not.toContain('thought-token');
      expect(indexed).not.toContain('param-token');
    }
    expect(items.find((item) => item.blockId === 'a1')?.text).toBe('Found it: needle lives in src/needle.ts.');
  });

  it('indexes a delivered message by its text', () => {
    const message: Block = {
      kind: 'message', id: 'm1', origin: 'send_message', status: 'sent', text: '证书那边还差一步', attachments: [], deliveredTo: [], turnId: 't1',
    };
    expect(buildFindItems([message])).toEqual([expect.objectContaining({ blockId: 'm1', text: '证书那边还差一步' })]);
  });

  it('searches the tool output a message-view summary folds away, only with the tool option', () => {
    const pattern = buildFindPattern('needle', { caseSensitive: false, wholeWord: false });
    const count = (items: ReturnType<typeof buildFindItems>) => {
      const byBlock = new Map<string, number>();
      for (const match of collectMatches(items, pattern)) byBlock.set(match.item.blockId, (byBlock.get(match.item.blockId) ?? 0) + 1);
      return Object.fromEntries(byBlock);
    };
    const group: ActivitySummary = {
      kind: 'activity-summary', id: 'activity-tool1', turnId: 't1',
      members: [think('th1', 'the needle is probably in config', 't1'), tool('tool1', 'grep needle', 'src/needle.ts: export const needle = 1', 't1')],
      counts: { tools: 1, reads: 0, commands: 1, thinking: 1, subagents: 0, memories: 0 },
      running: false, failed: 0,
    };
    const nodes = [user('u1', 'check the cache', 't1'), group];
    // The message view keeps its own scope: the folded activity is not searched
    // unless the tool option asks for its tool output.
    expect(count(buildFindItems(nodes))).toEqual({});
    const withTools = buildFindItems(nodes, true);
    expect(count(withTools)).toEqual({ tool1: 2 });
    // The member belongs to the process view: it is marked, and its reveal
    // opens the summary and the tool leaf on the way in.
    expect(withTools.find((item) => item.blockId === 'tool1')).toMatchObject({
      processViewOnly: true, reveal: ['activity-tool1', 'tool1'], toolCallId: 'tool1',
    });
    // Neither the summary's thinking member nor the tool's own input is searched.
    expect(withTools.some((item) => item.text.includes('config'))).toBe(false);
    expect(withTools.some((item) => item.text.includes('grep needle'))).toBe(false);
  });

  it('splits server hits into still-loadable and compacted history', () => {
    const hit = (turn: number, snippet: string): SearchMessageHit => ({
      session_id: 's', workspace_id: 'w', session_title: '', agent_id: 'main', role: 'assistant', snippet, time: 0, turn, score: 1,
    });
    const pattern = buildFindPattern('needle', { caseSensitive: false, wholeWord: false })!;
    const loaded = new Set([10, 11]);
    const outside = classifyOutsideHits({
      hits: [hit(11, 'needle'), hit(4, 'a needle and a needle'), hit(6, 'needle'), hit(12, 'needle')],
      loadedTurns: loaded, hasMoreHistory: true, pattern, more: false,
    });
    // Turn 11 is already counted locally; 4 and 6 are older pages; 12 sits
    // past the oldest loaded turn but on no loaded page — compacted away.
    expect(outside).toMatchObject({ earlier: 3, compacted: 1, nearestTurn: 6, known: true });
    const exhausted = classifyOutsideHits({ hits: [hit(4, 'needle')], loadedTurns: loaded, hasMoreHistory: false, pattern, more: true });
    expect(exhausted).toMatchObject({ earlier: 0, compacted: 1, more: true });
  });

  it('prefills from a single-line selection only', () => {
    const input = document.createElement('textarea');
    document.body.append(input);
    input.value = 'find this word\nsecond line';
    input.setSelectionRange(5, 9);
    expect(selectionPrefill(input)).toBe('this');
    input.setSelectionRange(0, input.value.length);
    expect(selectionPrefill(input)).toBeUndefined();
  });
});

describe('find bar in the timeline', () => {
  it('opens on Ctrl+F, counts every loaded match, and steps with Enter / Shift+Enter / F3', async () => {
    const off = installSessionShortcut();
    const { container } = await mount(timeline(foldedSession()));
    expect(container.querySelector('[data-history-fold]')).not.toBeNull();
    const event = press(document.body, { key: 'f', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    await settle();
    const input = container.querySelector<HTMLInputElement>('[data-find-input]')!;
    expect(document.activeElement).toBe(input);
    await typeQuery(input, 'needle');
    const count = () => container.querySelector('[data-find-count]')?.textContent;
    expect(count()).toBe('1 / 3');
    await act(async () => { press(input, { key: 'Enter' }); });
    await settle();
    expect(count()).toBe('2 / 3');
    await act(async () => { press(input, { key: 'Enter', shiftKey: true }); });
    await act(async () => { press(input, { key: 'Enter', shiftKey: true }); });
    await settle();
    expect(count()).toBe('3 / 3');
    await act(async () => { press(document.body, { key: 'F3' }); });
    await settle();
    expect(count()).toBe('1 / 3');
    const tools = container.querySelector<HTMLInputElement>('[data-find-tools]')!;
    expect(tools.checked).toBe(false);
    await act(async () => { tools.click(); });
    await settle();
    expect(count()).toBe('1 / 5');
    await act(async () => { tools.click(); });
    await settle();
    expect(count()).toBe('1 / 3');
    await typeQuery(input, 'haystack');
    expect(count()).toBe('No results');
    expect(container.querySelector<HTMLButtonElement>('[data-find-next]')?.disabled).toBe(true);
    off();
  });

  it('repaints the current match as the query grows on the same block', async () => {
    const off = installSessionShortcut();
    const registry = new Map<string, { items: Range[] }>();
    vi.stubGlobal('CSS', {
      highlights: {
        set: (name: string, value: { items: Range[] }) => { registry.set(name, value); },
        delete: (name: string) => { registry.delete(name); },
      },
    });
    vi.stubGlobal('Highlight', class { readonly items: Range[]; constructor(...items: Range[]) { this.items = items; } });
    const { container } = await mount(timeline(foldedSession()));
    press(document.body, { key: 'f', ctrlKey: true });
    await settle();
    const input = container.querySelector<HTMLInputElement>('[data-find-input]')!;
    await typeQuery(input, 'Found');
    await settle(120);
    await typeQuery(input, 'Found it');
    await settle(120);
    expect(registry.get('kiki-find-current')?.items.map((range) => range.toString())).toEqual(['Found it']);
    vi.unstubAllGlobals();
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    off();
  });

  it('opens the fold and the row a match is hidden in', async () => {
    const off = installSessionShortcut();
    const { container } = await mount(timeline(foldedSession()));
    expect(container.querySelector('[data-history-fold-open]')).toBeNull();
    press(document.body, { key: 'f', ctrlKey: true });
    await settle();
    const input = container.querySelector<HTMLInputElement>('[data-find-input]')!;
    await typeQuery(input, 'probably in config');
    await settle(120);
    expect(container.querySelector('[data-find-count]')?.textContent).toBe('No results');
    expect(container.querySelector('[data-history-fold-open]')).toBeNull();
    await act(async () => { container.querySelector<HTMLInputElement>('[data-find-tools]')!.click(); });
    await settle();
    expect(container.querySelector('[data-find-count]')?.textContent).toBe('No results');
    await typeQuery(input, 'export const');
    await settle(120);
    const card = container.querySelector('[data-tool-id="tool1"]');
    expect(card?.querySelector('[aria-expanded="true"]')).not.toBeNull();
    expect(card?.textContent).toContain('export const needle = 1');
    off();
  });

  it('returns focus to where Ctrl+F was pressed and prefills the composer selection', async () => {
    const off = installSessionShortcut();
    const composer = <textarea data-test-composer defaultValue="where is the needle" />;
    const { container } = await mount(timeline(foldedSession(), {}, composer));
    const field = container.querySelector<HTMLTextAreaElement>('[data-test-composer]')!;
    field.focus();
    field.setSelectionRange(13, 19);
    const event = press(field, { key: 'f', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    await settle();
    const input = container.querySelector<HTMLInputElement>('[data-find-input]')!;
    expect(input.value).toBe('needle');
    expect(document.activeElement).toBe(input);
    await act(async () => { press(input, { key: 'Escape' }); });
    await settle();
    expect(container.querySelector('[data-find-bar]')).toBeNull();
    expect(document.activeElement).toBe(field);
    off();
  });

  it('notes matches the loaded pages cannot hold and links the global search', async () => {
    const off = installSessionShortcut();
    const searchMessages = vi.fn(async () => ({
      items: [
        { session_id: 'session_find', workspace_id: 'w', session_title: '', agent_id: 'main', role: 'assistant' as const,
          snippet: 'an old needle', time: 0, turn: 1, score: 1 },
      ],
      has_more: false,
      index_state: { state: 'ready' as const, indexed_sessions: 1, total_sessions: 1, documents: 1 },
      source: 'index' as const,
    }));
    setFindSearchForTests({ searchMessages });
    // Loaded pages start at turn 5 and nothing older remains: turn 1 was compacted away.
    const blocks = [user('u5', 'the needle again', 't5'), answer('a5', 'ok', 't5')];
    const { container } = await mount(timeline(blocks, { hasMoreHistory: false }));
    press(document.body, { key: 'f', ctrlKey: true });
    await settle();
    await typeQuery(container.querySelector<HTMLInputElement>('[data-find-input]')!, 'needle');
    await settle(400);
    expect(searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'needle', container: { session_id: 'session_find', agent_id: 'main' } }),
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-find-count]')?.textContent).toBe('1 / 1');
    expect(container.querySelector('[data-find-compacted]')?.textContent).toContain('1');
    const opened = vi.fn();
    window.addEventListener('kiki:open-quick-switcher', opened);
    await act(async () => { (container.querySelector('[data-find-global]') as HTMLButtonElement).click(); });
    expect((opened.mock.calls[0]?.[0] as CustomEvent<{ query: string }>).detail.query).toBe('needle');
    window.removeEventListener('kiki:open-quick-switcher', opened);
    off();
  });

  it('leaves Ctrl+F alone off the session routes and hands it to settings search there', () => {
    const offOther = installSessionShortcut('other');
    const plain = press(document.body, { key: 'f', ctrlKey: true });
    expect(plain.defaultPrevented).toBe(false);
    offOther();
    const focusSettingsSearch = vi.fn();
    const offSettings = installSessionShortcut('settings', focusSettingsSearch);
    const onSettings = press(document.body, { key: 'f', ctrlKey: true });
    expect(onSettings.defaultPrevented).toBe(true);
    expect(focusSettingsSearch).toHaveBeenCalledTimes(1);
    // F3 on settings is not ours.
    expect(press(document.body, { key: 'F3' }).defaultPrevented).toBe(false);
    offSettings();
  });
});

it('keeps a server tail hit in an already loaded but incomplete turn even when older history is complete', () => {
  const hit = { role: 'assistant', turn: 7, snippet: 'hidden output tail needle' } as SearchMessageHit;
  const outside = classifyOutsideHits({ hits: [hit], loadedTurns: new Set([7]), incompleteTurns: new Set([7]), hasMoreHistory: false, pattern: /needle/gu, more: false });
  expect(outside).toMatchObject({ earlier: 1, compacted: 0, nearestTurn: 7, known: true });
  expect(classifyOutsideHits({ hits: [hit], loadedTurns: new Set([7]), incompleteTurns: new Set(), hasMoreHistory: false, pattern: /needle/gu, more: false }).earlier).toBe(0);
});


it('clears the prior query failure and ignores an old read failing after the query changes', async () => {
  setFindSearchForTests({ searchMessages: vi.fn(async ({ query }) => ({ items: [{ role: 'assistant', turn: 7, snippet: query } as SearchMessageHit], has_more: false, index_state: { state: 'ready' } } as never)) });
  let failOld!: (error: Error) => void;
  const find = vi.fn().mockRejectedValueOnce(new Error('first read failed')).mockImplementationOnce(() => new Promise((_resolve, reject) => { failOld = reject; }));
  const controller = { incompleteTurnOrdinals: () => new Set([7]), findTurnContentRange: find } as unknown as SessionController;
  const { container } = await mount(<TranscriptDetailProvider controller={controller} load={async () => false} loads={{}}><FindBar items={[]} sessionId="s" agentId="main" hasMoreHistory={false} loadedTurns={new Set([7])} request={{ prefill: 'needle', nonce: 1 }} onLand={async () => true} onClear={() => {}} startIndex={() => 0} onLoadOlder={async () => false} onLocateTurn={async () => true} onClose={() => {}} stepRef={{ current: null }} /></TranscriptDetailProvider>);
  await settle(350);
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-find-look-back]')!.click(); });
  expect(container.textContent).toContain('Could not read the matching content');
  await typeQuery(container.querySelector<HTMLInputElement>('[data-find-input]')!, 'other');
  expect(container.textContent).not.toContain('Could not read the matching content');
  await settle(350);
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-find-look-back]')!.click(); });
  await typeQuery(container.querySelector<HTMLInputElement>('[data-find-input]')!, 'fresh');
  await act(async () => { failOld(new Error('late old read failure')); });
  expect(find).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain('Could not read the matching content');
});


it('lands a large non-tool frame by its actual projected source and passes the range offset', async () => {
  setFindSearchForTests({ searchMessages: vi.fn(async () => ({ items: [{ role: 'assistant', turn: 7, snippet: 'range needle' } as SearchMessageHit], has_more: false, index_state: { state: 'ready' } } as never)) });
  const ref = { source: { kind: 'frame' as const, id: 'answer-frame', turnId: 't7', stepId: 's7' }, revision: 'answer-range', kind: 'text' as const, path: ['text'], offset: 3, total: 600_000 };
  const controller = { incompleteTurnOrdinals: () => new Set([7]), findTurnContentRange: async () => ({ ref, offset: 12345 }), getAgentState: () => ({ blocks: [{ kind: 'assistant', id: 'answer-row', frameId: 'answer-frame' }] }) } as unknown as SessionController;
  const land = vi.fn(async () => true);
  const item = { blockId: 'answer-row', turnId: 't7', text: 'prefix', reveal: [] };
  const { container } = await mount(<TranscriptDetailProvider controller={controller} load={async () => false} loads={{}}><FindBar items={[item]} sessionId="s" agentId="main" hasMoreHistory={false} loadedTurns={new Set([7])} request={{ prefill: 'needle', nonce: 1 }} onLand={land} onClear={() => {}} startIndex={() => 0} onLoadOlder={async () => false} onLocateTurn={async () => true} onClose={() => {}} stepRef={{ current: null }} /></TranscriptDetailProvider>);
  await settle(350);
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-find-look-back]')!.click(); });
  expect(land).toHaveBeenCalledWith(expect.objectContaining({ item, start: 12345 }), expect.any(RegExp), expect.objectContaining({ ref, offset: 12345 }));
});


async function coldFindHarness(range: boolean, waitForPage?: Promise<void>) {
  const text = range ? 'a'.repeat(8190) + ' cold needle ' + 'b'.repeat(600_000) : 'ordinary cold needle';
  const ref = { source: { kind: 'frame' as const, id: 'cold-frame', turnId: 't1', stepId: 's1' }, path: ['output'], revision: 'cold-body', kind: 'text' as const, offset: 3, total: text.length };
  const turn = (ordinal: number, output: string, pending = false) => ({ kind: 'turn' as const, turnId: `t${ordinal}`, ordinal, state: 'completed' as const, origin: { kind: 'user' as const }, steps: [{ kind: 'step' as const, stepId: `s${ordinal}`, turnId: `t${ordinal}`, ordinal: 1, state: 'completed' as const, frames: [{ kind: 'tool' as const, frameId: ordinal === 1 ? 'cold-frame' : 'new-frame', toolCallId: ordinal === 1 ? 'cold-call' : 'new-call', name: 'ExampleTool', state: 'done' as const, output, ...(pending ? { contentRefs: [ref] } : {}) }] }] });
  const read = vi.fn(async ({ ref: request }: { ref: typeof ref }) => ({ ref: request, value: text.slice(request.offset, request.offset + 4097), contentRefs: [] }));
  const page = vi.fn(async () => { await waitForPage; return { session_id: 'cold-test', agent_id: 'main', items: [turn(1, range ? 'aaa' : text, range)], has_more: false }; });
  const view = { snapshot: async () => ({ session: { id: 'cold-test', title: 'Cold find' }, as_of_seq: 1, epoch: 'cold', in_flight_turn: null }), transcript: { page, content: read }, subscribe: () => ({ updateSessionCursor() {}, setTranscriptGrades() {}, updateTranscriptCursor() {}, restart() {}, nudge() {}, close() {} }) } as unknown as import('@kiki/klient/session-view').SessionViewFacade;
  const controller = new SessionController({} as import('@kiki/session-core/transport').SessionTransport, view, 'cold-test', { scheduler: { schedule: (callback) => { callback(); return 0; }, cancel() {} } });
  await controller.open();
  controller.handleTranscript({ type: 'transcript.reset', session_id: 'cold-test', agent_id: 'main', grade: 'delta', cursor: { seq: 1, epoch: 'cold' }, coverage: { kind: 'tail', hasMoreOlder: true, fromTurnId: 't2', throughTurnId: 't2' }, snapshot: { items: [turn(2, 'newest preview')], tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {}, hasMoreOlder: true } });
  controller.flushFrames();
  const land = vi.fn(async () => true);
  const locate = vi.fn(async () => { const loaded = await controller.loadOlderMessages(); await new Promise((resolve) => setTimeout(resolve, 0)); return loaded; });
  function ColdHarness() {
    const state = useSyncExternalStore(controller.subscribe, controller.getState);
    const items = state.blocks.filter((block) => block.kind === 'tool').map((block) => ({ blockId: block.id, toolCallId: block.toolCallId, turnId: block.turnId, text: typeof block.output === 'string' ? block.output : '', reveal: [] }));
    return <TranscriptDetailProvider controller={controller} load={async () => false} loads={state.detailLoads} contentRefs={state.contentRefs} sessionId="cold-test" agentId="main"><FindBar items={items} sessionId="cold-test" agentId="main" hasMoreHistory={state.hasMoreHistory} loadedTurns={new Set(items.map((item) => Number(item.turnId?.slice(1))))} request={{ prefill: 'needle', nonce: 1 }} onLand={land} onClear={() => {}} startIndex={() => 0} onLoadOlder={() => controller.loadOlderMessages()} onLocateTurn={locate} onClose={() => {}} stepRef={{ current: null }} /></TranscriptDetailProvider>;
  }
  setFindSearchForTests({ searchMessages: vi.fn(async ({ query }) => ({ items: [{ role: 'assistant', turn: 1, snippet: `cold ${query}` } as SearchMessageHit], has_more: false, index_state: { state: 'ready' } } as never)) });
  const mounted = await mount(<ColdHarness />);
  await act(async () => { mounted.container.querySelector<HTMLInputElement>('[data-find-tools]')!.click(); });
  await settle(350);
  return { ...mounted, controller, read, page, locate, land, ref };
}

it.each([true, false])('one cold-turn intent uses the newly loaded real controller and rendered items (range: %s)', async (range) => {
  const fixture = await coldFindHarness(range);
  try {
    expect(fixture.controller.incompleteTurnOrdinals('main').has(1)).toBe(false);
    expect(fixture.controller.getState().blocks.some((block) => 'turnId' in block && block.turnId === 't1')).toBe(false);
    await act(async () => { fixture.container.querySelector<HTMLButtonElement>('[data-find-look-back]')!.click(); });
    await settle(100);
    expect(fixture.page).toHaveBeenCalledTimes(1);
    expect(fixture.locate).toHaveBeenCalledTimes(1);
    if (range) {
      expect(fixture.read).toHaveBeenCalled();
      expect(fixture.land).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ toolCallId: 'cold-call' }) }), expect.any(RegExp), expect.objectContaining({ ref: fixture.ref, offset: 8196 }));
    } else {
      expect(fixture.read).not.toHaveBeenCalled();
      expect(fixture.land).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ toolCallId: 'cold-call' }) }), expect.any(RegExp), undefined);
    }
    expect(fixture.container.textContent).not.toContain('Could not read the matching content');
  } finally { fixture.controller.close(); }
});

it('a query change while locating a cold turn prevents its late arrival from starting the old range read', async () => {
  let arrive!: () => void;
  const pageReady = new Promise<void>((resolve) => { arrive = resolve; });
  const fixture = await coldFindHarness(true, pageReady);
  try {
    await act(async () => { fixture.container.querySelector<HTMLButtonElement>('[data-find-look-back]')!.click(); });
    await typeQuery(fixture.container.querySelector<HTMLInputElement>('[data-find-input]')!, 'different');
    await act(async () => { arrive(); });
    await settle(80);
    expect(fixture.page).toHaveBeenCalledTimes(1);
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.land).not.toHaveBeenCalled();
    expect(fixture.container.textContent).not.toContain('Could not read the matching content');
  } finally { fixture.controller.close(); }
});

/** Bot delivery draws the message view: speech rows, and one collapsed activity
 * line per stretch of internal work (its tool output stays in the process view). */
function messageViewSession(): Block[] {
  return [
    user('u1', 'please check the cache', 't1'),
    tool('tool1', 'grep cache', 'cache.ts: export const needle = 1', 't1'),
    answer('a1', 'Found it.', 't1'),
    user('u2', 'thanks', 't2'),
    answer('a2', 'You are welcome.', 't2'),
  ];
}

/** The session view owns the message/process choice; the find bar flips it. */
function MessageViewTimeline({ sessionId, blocks }: { sessionId: string; blocks: Block[] }) {
  const [view] = useTimelineView(sessionId, { delivery: 'message' });
  return (
    <Transcript
      state={state(blocks, { sessionId })}
      view={view}
      onLoadOlder={() => Promise.resolve(false)}
      onResolveApproval={() => Promise.resolve()}
      onAnswerQuestion={() => Promise.resolve()}
      onDismissQuestion={() => Promise.resolve()}
    />
  );
}

describe('find in the message view', () => {
  it('counts a folded tool output once the tool option is on, and its note shows the hit in the process view', async () => {
    const off = installSessionShortcut();
    const registry = new Map<string, { items: Range[] }>();
    vi.stubGlobal('CSS', {
      highlights: {
        set: (name: string, value: { items: Range[] }) => { registry.set(name, value); },
        delete: (name: string) => { registry.delete(name); },
      },
    });
    vi.stubGlobal('Highlight', class { readonly items: Range[]; constructor(...items: Range[]) { this.items = items; } });
    const { container } = await mount(<MessageViewTimeline sessionId="session_find_message" blocks={messageViewSession()} />);
    expect(container.querySelector('[data-message-view-row="activity-summary"]')).not.toBeNull();
    press(document.body, { key: 'f', ctrlKey: true });
    await settle();
    const input = container.querySelector<HTMLInputElement>('[data-find-input]')!;
    await typeQuery(input, 'needle');
    await settle(120);
    // Only the tool output holds the needle, and it is out of scope by default.
    expect(container.querySelector('[data-find-count]')?.textContent).toBe('No results');
    expect(container.querySelector('[data-find-process]')).toBeNull();
    await act(async () => { container.querySelector<HTMLInputElement>('[data-find-tools]')!.click(); });
    await settle(120);
    // The loaded tool hit counts now, and the bar says where it can be shown.
    expect(container.querySelector('[data-find-count]')?.textContent).toBe('1 / 1');
    const open = container.querySelector<HTMLButtonElement>('[data-find-process-open]')!;
    expect(open.textContent).toContain('process');
    await act(async () => { open.click(); });
    await settle(200);
    // The process view is on screen, opened at the call that holds the hit.
    expect(container.querySelector('[data-message-view-row]')).toBeNull();
    const card = container.querySelector('[data-tool-id="tool1"]');
    expect(card?.textContent).toContain('export const needle = 1');
    expect(card?.querySelector('[aria-expanded="true"]')).not.toBeNull();
    expect(registry.get('kiki-find-current')?.items.map((range) => range.toString())).toContain('needle');
    vi.unstubAllGlobals();
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    off();
  });

  it('steps onto a folded tool match by opening the process view', async () => {
    const off = installSessionShortcut();
    const { container } = await mount(<MessageViewTimeline sessionId="session_find_message_step" blocks={messageViewSession()} />);
    press(document.body, { key: 'f', ctrlKey: true });
    await settle();
    const input = container.querySelector<HTMLInputElement>('[data-find-input]')!;
    await typeQuery(input, 'needle');
    await act(async () => { container.querySelector<HTMLInputElement>('[data-find-tools]')!.click(); });
    await settle(120);
    expect(container.querySelector('[data-find-count]')?.textContent).toBe('1 / 1');
    await act(async () => { press(input, { key: 'F3' }); });
    await settle(200);
    expect(container.querySelector('[data-message-view-row]')).toBeNull();
    expect(container.querySelector('[data-tool-id="tool1"]')?.textContent).toContain('export const needle = 1');
    off();
  });
});
