// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { FsSearchHit } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import type { FsSearchFeedResult, FsSearchFeedSearch } from '../lib/fsSearchFeed';
import { AddMenu, type AddMenuView } from './ComposerControls';

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const onMention = vi.fn();

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
  onMention.mockReset();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function hit(path: string, score: number, kind: FsSearchHit['kind'] = 'file'): FsSearchHit {
  const slash = path.lastIndexOf('/');
  return {
    path,
    name: slash === -1 ? path : path.slice(slash + 1),
    kind,
    score,
    match_positions: [],
  };
}

function wire(items: readonly FsSearchHit[], cursor?: string): FsSearchFeedResult {
  return {
    items,
    truncated: cursor !== undefined,
    next_cursor: cursor,
    sort_scope: 'page',
  };
}

interface Call {
  readonly query: string;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

function defer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function mount(search: FsSearchFeedSearch, initial: AddMenuView = 'mention'): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MenuHarness search={search} initial={initial} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}

function MenuHarness({ search, initial }: { search: FsSearchFeedSearch; initial: AddMenuView }) {
  const [view, setView] = useState(initial);
  return (
    <AddMenu
      view={view}
      onViewChange={setView}
      attachDisabled={false}
      onAttach={() => {}}
      files={{ search, scopeKey: 'ws-1', onMention }}
    />
  );
}

function rows(): string[] {
  return [...document.querySelectorAll('[data-add-file]')].map((node) => node.getAttribute('data-add-file') ?? '');
}

function more(): HTMLButtonElement | null {
  return document.querySelector('[data-add-file-more]');
}

async function click(selector: string): Promise<void> {
  const node = document.querySelector<HTMLElement>(selector);
  expect(node, selector).not.toBeNull();
  await act(async () => { node!.click(); });
  await flush();
}

async function typeQuery(value: string): Promise<void> {
  const search = document.querySelector<HTMLInputElement>('[data-add-search]');
  expect(search).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, value);
    search!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
  await flush();
}

function key(target: Element, keyName: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }));
  });
}

describe('Add menu file search', () => {
  it('shows the first page and does not continue on its own', async () => {
    const calls: Call[] = [];
    const search: FsSearchFeedSearch = (query, page) => {
      calls.push({ query, cursor: page?.cursor, signal: page?.signal });
      return Promise.resolve(wire([hit('zeta.ts', 0.2), hit('mid.ts', 0.5)], 'p2'));
    };
    await mount(search);
    expect(rows()).toEqual(['zeta.ts', 'mid.ts']);
    expect(more()?.textContent).toContain('Load more results');
    expect(document.querySelector('[data-add-file-list]')?.getAttribute('data-file-order')).toBe('page');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ query: '', cursor: undefined });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('appends the next page in arrival order and sorts only when the cursor ends', async () => {
    const calls: Call[] = [];
    const search: FsSearchFeedSearch = (query, page) => {
      calls.push({ query, cursor: page?.cursor });
      if (page?.cursor === undefined) return Promise.resolve(wire([hit('zeta.ts', 0.2)], 'p2'));
      if (page.cursor === 'p2') return Promise.resolve(wire([], 'p3'));
      return Promise.resolve(wire([hit('alpha.ts', 0.9)]));
    };
    await mount(search);
    await click('[data-add-file-more]');
    expect(rows()).toEqual(['zeta.ts']);
    expect(document.body.textContent).not.toContain('No files');
    expect(more()).not.toBeNull();
    expect(calls[1]).toMatchObject({ query: '', cursor: 'p2' });
    await click('[data-add-file-more]');
    expect(rows()).toEqual(['alpha.ts', 'zeta.ts']);
    expect(document.querySelector('[data-add-file-list]')?.getAttribute('data-file-order')).toBe('complete');
    expect(more()).toBeNull();
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ query: '', cursor: 'p3' });
  });

  it('keeps the rows when the next page fails and retries that cursor', async () => {
    const calls: Call[] = [];
    let failed = false;
    const search: FsSearchFeedSearch = (query, page) => {
      calls.push({ query, cursor: page?.cursor });
      if (page?.cursor === undefined) return Promise.resolve(wire([hit('kept.ts', 0.4)], 'p2'));
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('down'));
      }
      return Promise.resolve(wire([hit('next.ts', 0.1)]));
    };
    await mount(search);
    await click('[data-add-file-more]');
    expect(rows()).toEqual(['kept.ts']);
    expect(more()?.getAttribute('data-add-file-more')).toBe('retry');
    expect(more()?.getAttribute('aria-label')).toContain('File search failed');
    await click('[data-add-file-more]');
    expect(rows()).toEqual(['kept.ts', 'next.ts']);
    expect(calls.map((call) => call.cursor)).toEqual([undefined, 'p2', 'p2']);
  });

  it('keeps shown rows and restarts without the stale cursor after 40001', async () => {
    const calls: Call[] = [];
    const search: FsSearchFeedSearch = (query, page) => {
      calls.push({ query, cursor: page?.cursor });
      if (page?.cursor === 'p2') return Promise.reject(Object.assign(new Error('changed'), { code: 40001 }));
      if (calls.length === 1) return Promise.resolve(wire([hit('old.ts', 0.4)], 'p2'));
      return Promise.resolve(wire([hit('new.ts', 0.8)], 'n2'));
    };
    await mount(search);
    await click('[data-add-file-more]');
    await flush();
    expect(rows()).toEqual(['new.ts']);
    expect(calls.map((call) => call.cursor)).toEqual([undefined, 'p2', undefined]);
    expect(document.body.textContent).not.toContain('old.ts');
  });

  it('recovers a failed first page without hiding the retry', async () => {
    let failed = true;
    const search: FsSearchFeedSearch = () => {
      if (failed) {
        failed = false;
        return Promise.reject(new Error('offline'));
      }
      return Promise.resolve(wire([hit('back.ts', 1)]));
    };
    await mount(search);
    expect(document.body.textContent).toContain('File search failed');
    expect(rows()).toEqual([]);
    await click('[data-add-file-more]');
    expect(rows()).toEqual(['back.ts']);
    expect(document.body.textContent).not.toContain('File search failed');
  });

  it('drops an in-flight page when the query changes', async () => {
    const calls: Call[] = [];
    const pending = new Map<string, ReturnType<typeof defer<FsSearchFeedResult>>>();
    const search: FsSearchFeedSearch = (query, page) => {
      calls.push({ query, cursor: page?.cursor, signal: page?.signal });
      const gate = defer<FsSearchFeedResult>();
      pending.set(`${query}:${page?.cursor ?? ''}`, gate);
      return gate.promise;
    };
    await mount(search);
    expect(calls).toHaveLength(1);
    await typeQuery('beta');
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls.map((call) => call.query)).toEqual(['', 'beta']);
    pending.get(':')?.resolve(wire([hit('old.ts', 1)], 'stale'));
    await flush();
    expect(rows()).not.toContain('old.ts');
    pending.get('beta:')?.resolve(wire([hit('beta.ts', 1)]));
    await flush();
    expect(rows()).toEqual(['beta.ts']);
  });

  it('cancels the open search when the menu closes and ignores the late page', async () => {
    const calls: Call[] = [];
    const gates: Array<ReturnType<typeof defer<FsSearchFeedResult>>> = [];
    const search: FsSearchFeedSearch = (query, page) => {
      calls.push({ query, cursor: page?.cursor, signal: page?.signal });
      const gate = defer<FsSearchFeedResult>();
      gates.push(gate);
      return gate.promise;
    };
    await mount(search);
    await click('[data-add-menu-trigger]');
    expect(document.querySelector('[data-add-panel]')).toBeNull();
    expect(calls[0]?.signal?.aborted).toBe(true);
    gates[0]?.resolve(wire([hit('late.ts', 1)]));
    await flush();
    expect(document.body.textContent).not.toContain('late.ts');
    await click('[data-add-menu-trigger]');
    await click('[data-add-menu-mention]');
    expect(calls).toHaveLength(2);
    expect(rows()).not.toContain('late.ts');
    gates[1]?.resolve(wire([hit('fresh.ts', 1)]));
    await flush();
    expect(rows()).toEqual(['fresh.ts']);
  });

  it('continues from the end of the mention list and not from a short scroll', async () => {
    const calls: Call[] = [];
    const search: FsSearchFeedSearch = (query, page) => {
      calls.push({ query, cursor: page?.cursor });
      if (page?.cursor === undefined) return Promise.resolve(wire([hit('one.ts', 1)], 'p2'));
      return Promise.resolve(wire([hit('two.ts', 1)]));
    };
    await mount(search);
    const list = document.querySelector<HTMLDivElement>('[data-add-file-list]')!;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, value: 10 });
    await act(async () => { list.dispatchEvent(new Event('scroll')); });
    await flush();
    expect(calls).toHaveLength(1);
    Object.defineProperty(list, 'scrollTop', { configurable: true, value: 370 });
    await act(async () => { list.dispatchEvent(new Event('scroll')); });
    await flush();
    expect(calls.map((call) => call.cursor)).toEqual([undefined, 'p2']);
    expect(rows()).toEqual(['one.ts', 'two.ts']);
  });

  it('walks from the search field to the continue row', async () => {
    const search: FsSearchFeedSearch = (_query, page) => (
      page?.cursor === undefined
        ? Promise.resolve(wire([hit('src/one.ts', 1)], 'p2'))
        : Promise.resolve(wire([hit('src/two.ts', 0.2)]))
    );
    await mount(search);
    const field = document.querySelector<HTMLInputElement>('[data-add-search]')!;
    expect(document.activeElement).toBe(field);
    key(field, 'ArrowDown');
    expect(document.activeElement?.getAttribute('data-add-file')).toBe('src/one.ts');
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement?.getAttribute('data-add-file-more')).toBe('more');
    await act(async () => { (document.activeElement as HTMLButtonElement).click(); });
    await flush();
    expect(onMention).not.toHaveBeenCalled();
  });

  it('mentions the focused file and leaves the non-file menu alone', async () => {
    const search: FsSearchFeedSearch = () => Promise.resolve(wire([hit('src/one.ts', 1, 'file')]));
    await mount(search);
    const field = document.querySelector<HTMLInputElement>('[data-add-search]')!;
    key(field, 'ArrowDown');
    await act(async () => { (document.activeElement as HTMLButtonElement).click(); });
    expect(onMention).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/one.ts' }));
    expect(document.querySelector('[data-add-panel]')).toBeNull();
  });

  it('says the workspace is empty only when the finished page has nothing', async () => {
    await mount(() => Promise.resolve(wire([])));
    expect(document.body.textContent).toContain('No files in this workspace.');
    expect(more()).toBeNull();
  });

  it('keeps going when the first page is empty but still has a cursor', async () => {
    await mount(() => Promise.resolve(wire([], 'budget')));
    expect(document.body.textContent).not.toContain('No files');
    expect(more()?.textContent).toContain('Load more results');
    expect(document.querySelector('[data-add-file-list]')?.getAttribute('data-file-order')).toBe('page');
  });

  it('keeps a legacy hit list as a finished page', async () => {
    const search: FsSearchFeedSearch = () => Promise.resolve([hit('only.ts', 1)]);
    await mount(search);
    expect(rows()).toEqual(['only.ts']);
    expect(more()).toBeNull();
    expect(document.querySelector('[data-add-file-list]')?.getAttribute('data-file-order')).toBe('complete');
  });

  it('previews five root hits and reveals the rest of the page without another read', async () => {
    const calls: Call[] = [];
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, index) => hit(`${name}.ts`, 1 - index / 10));
    const search: FsSearchFeedSearch = (query, page) => {
      calls.push({ query, cursor: page?.cursor });
      return Promise.resolve(wire(items, 'p2'));
    };
    await mount(search, 'root');
    await typeQuery('file');
    expect(document.querySelectorAll('[data-add-results] [data-add-file]')).toHaveLength(5);
    expect(more()?.textContent).toContain('Load more results');
    await click('[data-add-file-more]');
    expect(document.querySelector('[data-add-mention-view]')).not.toBeNull();
    expect(rows()).toEqual(items.map((item) => item.path));
    expect(calls).toHaveLength(1);
    expect(document.querySelector('[data-add-menu-skills]')).toBeNull();
  });
});

describe('Add menu SSH view availability', () => {
  function sshProp() {
    return {
      count: 1,
      renderPanel: () => <div data-ssh-panel-content>hosts</div>,
      hosts: [{ id: 'h1', name: 'Host One', joined: true }],
      onToggleHost: () => {},
    };
  }

  // Flip the SSH source off inside the SAME mounted tree: the view stays 'ssh'
  // (the parent keeps it), only the `ssh` prop collapses to undefined — the
  // exact shape the flag/meta read produces when it briefly resolves undefined.
  let flipOff: (() => void) | null = null;

  function SshHarness() {
    const [view, setView] = useState<AddMenuView>('ssh');
    const [available, setAvailable] = useState(true);
    flipOff = () => { setAvailable(false); };
    return (
      <AddMenu
        view={view}
        onViewChange={setView}
        attachDisabled={false}
        onAttach={() => {}}
        // A second always-present source keeps the menu a menu (attachOnly stays
        // false), so the ssh collapse exercises the view fallback, not the
        // whole-menu collapse into a bare attach button.
        skills={{ items: [], status: 'ready', onInsert: () => {} }}
        ssh={available ? sshProp() : undefined}
      />
    );
  }

  it('does not render an empty popover when the SSH source becomes unavailable', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <SshHarness />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flush();

    // SSH view open with content.
    const panel = document.querySelector('[data-add-panel]');
    expect(panel?.getAttribute('data-add-panel')).toBe('ssh');
    expect(panel?.querySelector('[data-ssh-panel-content]')).not.toBeNull();

    // The flag/meta read briefly resolves undefined: the source goes away
    // while the view is still 'ssh'. The popover must not go blank.
    await act(async () => { flipOff!(); });
    await flush();

    const after = document.querySelector('[data-add-panel]');
    // The bug is precisely: popover still open on the ssh view with no content.
    if (after !== null) {
      expect(
        (after.textContent ?? '').trim(),
        'ssh popover rendered an empty card after the source went away',
      ).not.toBe('');
    }
  });
});
