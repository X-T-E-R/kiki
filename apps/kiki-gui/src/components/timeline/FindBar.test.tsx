// @vitest-environment jsdom

/**
 * Find in this conversation: counting, stepping, revealing folded matches,
 * focus return, selection prefill, and the route rule for Ctrl+F.
 */

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createViewState, type Block, type SessionViewState } from '@kiki/session-core/session';

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
import { Transcript } from '../Transcript';
import { classifyOutsideHits, setFindSearchForTests } from './FindBar';
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

  it('indexes folded work: thinking, tool input and output, message text without markdown', () => {
    const items = buildFindItems(foldedSession());
    const pattern = buildFindPattern('needle', { caseSensitive: false, wholeWord: false });
    const matches = collectMatches(items, pattern);
    const byBlock = new Map<string, number>();
    for (const match of matches) byBlock.set(match.item.blockId, (byBlock.get(match.item.blockId) ?? 0) + 1);
    expect(Object.fromEntries(byBlock)).toEqual({ u1: 1, th1: 1, tool1: 3, a1: 2 });
    // Markdown markers are not part of what the reader sees.
    expect(items.find((item) => item.blockId === 'a1')?.text).toBe('Found it: needle lives in src/needle.ts.');
  });

  it('indexes a delivered message by its text', () => {
    const message: Block = {
      kind: 'message', id: 'm1', origin: 'send_message', status: 'sent', text: '证书那边还差一步', attachments: [], deliveredTo: [], turnId: 't1',
    };
    expect(buildFindItems([message])).toEqual([expect.objectContaining({ blockId: 'm1', text: '证书那边还差一步' })]);
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
    expect(count()).toBe('1 / 7');
    await act(async () => { press(input, { key: 'Enter' }); });
    await settle();
    expect(count()).toBe('2 / 7');
    await act(async () => { press(input, { key: 'Enter', shiftKey: true }); });
    await act(async () => { press(input, { key: 'Enter', shiftKey: true }); });
    await settle();
    expect(count()).toBe('7 / 7');
    // F3 from anywhere steps too.
    await act(async () => { press(document.body, { key: 'F3' }); });
    await settle();
    expect(count()).toBe('1 / 7');
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
    await typeQuery(input, 'prob');
    await settle(120);
    await typeQuery(input, 'probably in');
    await settle(120);
    expect(registry.get('kiki-find-current')?.items.map((range) => range.toString())).toEqual(['probably in']);
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
    expect(container.querySelector('[data-find-count]')?.textContent).toBe('1 / 1');
    // The history fold opened, and inside it the thinking row's own body.
    const thinking = container.querySelector('[data-history-fold-open] [data-block-id="th1"]');
    expect(thinking).not.toBeNull();
    expect(thinking?.textContent).toContain('the needle is probably in config');
    // A tool's output inside the fold opens its card.
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
