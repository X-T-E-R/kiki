// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { FsSearchHit } from '@kiki/protocol';

import {
  FS_SEARCH_FEED_KEY,
  FS_SEARCH_STALE_CURSOR,
  fsSearchRequestBody,
  isStaleFsSearchCursor,
  mergeFsSearchPages,
  normalizeFsSearchPage,
  useFsSearchFeed,
  type FsSearchFeedSearch,
  type FsSearchFeedView,
  type FsSearchPage,
} from './fsSearchFeed';

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

function page(items: readonly FsSearchHit[], nextCursor?: string): FsSearchPage {
  return {
    items,
    nextCursor,
    sortScope: 'page',
    truncated: nextCursor !== undefined,
  };
}

describe('normalizeFsSearchPage', () => {
  it('treats a bare hit list as one finished page', () => {
    const items = [hit('a.ts', 1)];
    expect(normalizeFsSearchPage(items)).toEqual({
      items,
      nextCursor: undefined,
      sortScope: 'page',
      truncated: false,
    });
  });

  it('keeps a cursor on an empty wire page and forces truncated to match it', () => {
    expect(normalizeFsSearchPage({
      items: [],
      next_cursor: 'budget',
      truncated: false,
      sort_scope: 'page',
    })).toEqual({
      items: [],
      nextCursor: 'budget',
      sortScope: 'page',
      truncated: true,
    });
  });

  it('drops a truncated flag that has no cursor', () => {
    expect(normalizeFsSearchPage({
      items: [hit('a.ts', 1)],
      truncated: true,
      sort_scope: 'page',
    }).truncated).toBe(false);
  });
});

describe('mergeFsSearchPages', () => {
  const low = hit('b.ts', 0.2);
  const high = hit('a.ts', 0.9);

  it('keeps arrival order, including across an empty cursor page', () => {
    const merged = mergeFsSearchPages([
      page([low, hit('c.ts', 0.1)], 'p2'),
      page([], 'p3'),
    ], 'q');
    expect(merged.exhausted).toBe(false);
    expect(merged.nextCursor).toBe('p3');
    expect(merged.items.map((item) => item.path)).toEqual(['b.ts', 'c.ts']);
  });

  it('sorts a non-empty query only once the cursor is gone', () => {
    const open = mergeFsSearchPages([
      page([low], 'p2'),
      page([high], 'p3'),
    ], 'q');
    expect(open.items.map((item) => item.path)).toEqual(['b.ts', 'a.ts']);
    const done = mergeFsSearchPages([
      page([low], 'p2'),
      page([high]),
    ], 'q');
    expect(done.exhausted).toBe(true);
    expect(done.items.map((item) => item.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('breaks equal scores by path and does not mutate the page', () => {
    const original = [hit('b.ts', 0.5), hit('a.ts', 0.5)];
    const done = mergeFsSearchPages([page(original)], 'q');
    expect(done.items.map((item) => item.path)).toEqual(['a.ts', 'b.ts']);
    expect(original.map((item) => item.path)).toEqual(['b.ts', 'a.ts']);
  });

  it('puts directories first only for an exhausted empty query', () => {
    const dir = hit('z', 1, 'directory');
    const file = hit('a.ts', 1);
    const open = mergeFsSearchPages([
      page([file], 'p2'),
      page([dir], 'p3'),
    ], '');
    expect(open.items.map((item) => item.path)).toEqual(['a.ts', 'z']);
    const done = mergeFsSearchPages([
      page([file], 'p2'),
      page([dir]),
    ], '');
    expect(done.items.map((item) => item.path)).toEqual(['z', 'a.ts']);
  });
});

describe('fsSearchRequestBody', () => {
  it('repeats the same filters and adds a cursor only when continuing', () => {
    const filters = {
      limit: 30,
      include_globs: ['src/**'],
      exclude_globs: ['**/*.png'],
      follow_gitignore: true,
    };
    expect(fsSearchRequestBody('parser', undefined, filters)).toEqual({
      query: 'parser',
      limit: 30,
      include_globs: ['src/**'],
      exclude_globs: ['**/*.png'],
      follow_gitignore: true,
      cursor: undefined,
    });
    expect(fsSearchRequestBody('parser', { cursor: 'p2' }, filters)).toMatchObject({
      query: 'parser',
      cursor: 'p2',
      limit: 30,
      include_globs: ['src/**'],
      exclude_globs: ['**/*.png'],
      follow_gitignore: true,
    });
  });
});

describe('isStaleFsSearchCursor', () => {
  it('matches only the cursor validation code', () => {
    expect(FS_SEARCH_STALE_CURSOR).toBe(40001);
    expect(isStaleFsSearchCursor(Object.assign(new Error('changed'), { code: 40001 }))).toBe(true);
    expect(isStaleFsSearchCursor(Object.assign(new Error('down'), { code: 50001 }))).toBe(false);
    expect(isStaleFsSearchCursor(new Error('down'))).toBe(false);
  });
});

function FeedProbe({
  enabled,
  search,
  viewRef,
  scopeKey = 'scope',
  query = '',
}: {
  readonly enabled: boolean;
  readonly search: FsSearchFeedSearch;
  readonly viewRef: { current: FsSearchFeedView | null };
  readonly scopeKey?: string;
  readonly query?: string;
}) {
  viewRef.current = useFsSearchFeed({ enabled, scopeKey, query, search });
  return null;
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

describe('useFsSearchFeed', () => {
  it('reopens a fresh chain as-is and reloads only the first page once that chain is stale', async () => {
    const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    reactAct.IS_REACT_ACT_ENVIRONMENT = true;
    const calls: Array<string | undefined> = [];
    const search: FsSearchFeedSearch = (_query, page) => {
      calls.push(page?.cursor);
      const cursor = page?.cursor;
      if (cursor === undefined) {
        const firsts = calls.filter((item) => item === undefined).length;
        return Promise.resolve({
          items: [hit(firsts === 1 ? 'a.ts' : 'a2.ts', 0.2)],
          next_cursor: firsts === 1 ? 'p2' : 'p2b',
          sort_scope: 'page',
        });
      }
      if (cursor === 'p2') return Promise.resolve({ items: [hit('m.ts', 0.9)], next_cursor: 'p3', sort_scope: 'page' });
      if (cursor === 'p3') return Promise.resolve({ items: [hit('z.ts', 0.1)], sort_scope: 'page' });
      if (cursor === 'p2b') return Promise.resolve({ items: [hit('m2.ts', 0.9)], sort_scope: 'page' });
      return Promise.reject(new Error(`unexpected cursor ${cursor}`));
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const viewRef: { current: FsSearchFeedView | null } = { current: null };
    let enabled = true;
    const container = document.createElement('div');
    document.body.append(container);
    const root: Root = createRoot(container);
    const render = () => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(FeedProbe, { enabled, search, viewRef }),
      ));
    };
    try {
      await act(async () => { render(); });
      await settle();
      await act(async () => { viewRef.current?.loadMore(); });
      await settle();
      await act(async () => { viewRef.current?.loadMore(); });
      await settle();
      expect(calls).toEqual([undefined, 'p2', 'p3']);
      expect(viewRef.current?.items.map((item) => item.path)).toEqual(['a.ts', 'm.ts', 'z.ts']);
      expect(viewRef.current?.order).toBe('complete');

      enabled = false;
      await act(async () => { render(); });
      enabled = true;
      await act(async () => { render(); });
      await settle();
      expect(calls).toEqual([undefined, 'p2', 'p3']);
      expect(viewRef.current?.items.map((item) => item.path)).toEqual(['a.ts', 'm.ts', 'z.ts']);

      enabled = false;
      await act(async () => { render(); });
      const cached = queryClient.getQueryCache().findAll({ queryKey: [FS_SEARCH_FEED_KEY, 'scope', ''] });
      expect(cached).toHaveLength(1);
      await act(async () => { cached[0]?.setState({ dataUpdatedAt: Date.now() - 31_000 }); });
      enabled = true;
      await act(async () => { render(); });
      await settle();
      expect(calls).toEqual([undefined, 'p2', 'p3', undefined]);
      expect(viewRef.current?.items.map((item) => item.path)).toEqual(['a2.ts']);
      expect(viewRef.current?.order).toBe('page');

      await act(async () => { viewRef.current?.loadMore(); });
      await settle();
      expect(calls).toEqual([undefined, 'p2', 'p3', undefined, 'p2b']);
      expect(viewRef.current?.items.map((item) => item.path)).toEqual(['a2.ts', 'm2.ts']);
      expect(viewRef.current?.exhausted).toBe(true);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('returns to a stale query at its first page and leaves a fresh or still-open chain in place', async () => {
    const calls: Array<{ query: string; cursor?: string }> = [];
    const search: FsSearchFeedSearch = (query, page) => {
      calls.push({ query, cursor: page?.cursor });
      const cursor = page?.cursor;
      if (query === 'beta') return Promise.resolve({ items: [hit('beta.ts', 1)], sort_scope: 'page' });
      if (cursor === undefined) {
        const firsts = calls.filter((call) => call.query === 'alpha' && call.cursor === undefined).length;
        return Promise.resolve({
          items: [hit(firsts === 1 ? 'a.ts' : 'a2.ts', 0.2)],
          next_cursor: firsts === 1 ? 'p2' : 'p2b',
          sort_scope: 'page',
        });
      }
      if (cursor === 'p2') return Promise.resolve({ items: [hit('m.ts', 0.9)], next_cursor: 'p3', sort_scope: 'page' });
      if (cursor === 'p3') return Promise.resolve({ items: [hit('z.ts', 0.1)], sort_scope: 'page' });
      if (cursor === 'p2b') return Promise.resolve({ items: [hit('m2.ts', 0.9)], sort_scope: 'page' });
      return Promise.reject(new Error(`unexpected cursor ${cursor}`));
    };
    const harness = mountFeed(search);
    try {
      await harness.set({ query: 'alpha' });
      await settle();
      await act(async () => { harness.viewRef.current?.loadMore(); });
      await settle();
      await act(async () => { harness.viewRef.current?.loadMore(); });
      await settle();
      expect(calls).toEqual([
        { query: 'alpha', cursor: undefined },
        { query: 'alpha', cursor: 'p2' },
        { query: 'alpha', cursor: 'p3' },
      ]);
      expect(harness.paths()).toEqual(['m.ts', 'a.ts', 'z.ts']);

      await harness.set({ query: 'beta' });
      await settle();
      expect(calls.at(-1)).toEqual({ query: 'beta', cursor: undefined });
      await harness.set({ query: 'alpha' });
      await settle();
      expect(calls.filter((call) => call.query === 'alpha')).toHaveLength(3);
      expect(harness.paths()).toEqual(['m.ts', 'a.ts', 'z.ts']);

      await ageChain(harness.queryClient, [FS_SEARCH_FEED_KEY, 'scope', 'alpha']);
      await settle();
      expect(calls.filter((call) => call.query === 'alpha')).toHaveLength(3);
      expect(harness.paths()).toEqual(['m.ts', 'a.ts', 'z.ts']);

      await harness.set({ query: 'beta' });
      await settle();
      await harness.set({ query: 'alpha' });
      await settle();
      expect(calls.filter((call) => call.query === 'alpha').slice(3)).toEqual([
        { query: 'alpha', cursor: undefined },
      ]);
      expect(harness.paths()).toEqual(['a2.ts']);
      expect(harness.viewRef.current?.order).toBe('page');
      await act(async () => { harness.viewRef.current?.loadMore(); });
      await settle();
      expect(calls.filter((call) => call.query === 'alpha').slice(3)).toEqual([
        { query: 'alpha', cursor: undefined },
        { query: 'alpha', cursor: 'p2b' },
      ]);
      expect(harness.paths()).toEqual(['m2.ts', 'a2.ts']);
    } finally {
      await harness.unmount();
    }
  });

  it('applies the same first-page reentry when the scope key returns to a stale chain', async () => {
    const box = { scopeKey: 's1' };
    const calls: Array<{ scopeKey: string; cursor?: string }> = [];
    const search: FsSearchFeedSearch = (_query, page) => {
      const scopeKey = box.scopeKey;
      calls.push({ scopeKey, cursor: page?.cursor });
      const cursor = page?.cursor;
      const firsts = calls.filter((call) => call.scopeKey === scopeKey && call.cursor === undefined).length;
      if (cursor === undefined) {
        return Promise.resolve({
          items: [hit(firsts === 1 ? 'a.ts' : 'a2.ts', 0.2)],
          next_cursor: firsts === 1 ? 'p2' : 'p2b',
          sort_scope: 'page',
        });
      }
      if (cursor === 'p2') return Promise.resolve({ items: [hit('m.ts', 0.9)], next_cursor: 'p3', sort_scope: 'page' });
      if (cursor === 'p3') return Promise.resolve({ items: [hit('z.ts', 0.1)], sort_scope: 'page' });
      if (cursor === 'p2b') return Promise.resolve({ items: [hit('m2.ts', 0.9)], sort_scope: 'page' });
      return Promise.reject(new Error(`unexpected cursor ${cursor}`));
    };
    const harness = mountFeed(search);
    try {
      await harness.set({ scopeKey: 's1', query: '' });
      box.scopeKey = 's1';
      await settle();
      await act(async () => { harness.viewRef.current?.loadMore(); });
      await settle();
      await act(async () => { harness.viewRef.current?.loadMore(); });
      await settle();
      expect(calls.map((call) => call.scopeKey)).toEqual(['s1', 's1', 's1']);
      expect(harness.paths()).toEqual(['a.ts', 'm.ts', 'z.ts']);

      box.scopeKey = 's2';
      await harness.set({ scopeKey: 's2' });
      await settle();
      expect(calls.at(-1)).toEqual({ scopeKey: 's2', cursor: undefined });
      box.scopeKey = 's1';
      await harness.set({ scopeKey: 's1' });
      await settle();
      expect(calls.filter((call) => call.scopeKey === 's1')).toHaveLength(3);
      expect(harness.paths()).toEqual(['a.ts', 'm.ts', 'z.ts']);

      await ageChain(harness.queryClient, [FS_SEARCH_FEED_KEY, 's1', '']);
      await settle();
      expect(calls.filter((call) => call.scopeKey === 's1')).toHaveLength(3);
      expect(harness.paths()).toEqual(['a.ts', 'm.ts', 'z.ts']);

      box.scopeKey = 's2';
      await harness.set({ scopeKey: 's2' });
      await settle();
      box.scopeKey = 's1';
      await harness.set({ scopeKey: 's1' });
      await settle();
      expect(calls.filter((call) => call.scopeKey === 's1').slice(3)).toEqual([
        { scopeKey: 's1', cursor: undefined },
      ]);
      expect(harness.paths()).toEqual(['a2.ts']);
      await act(async () => { harness.viewRef.current?.loadMore(); });
      await settle();
      expect(calls.filter((call) => call.scopeKey === 's1').slice(3)).toEqual([
        { scopeKey: 's1', cursor: undefined },
        { scopeKey: 's1', cursor: 'p2b' },
      ]);
    } finally {
      await harness.unmount();
    }
  });
});

function mountFeed(search: FsSearchFeedSearch) {
  const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const viewRef: { current: FsSearchFeedView | null } = { current: null };
  let enabled = true;
  let scopeKey = 'scope';
  let query = '';
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  const render = () => {
    root.render(createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(FeedProbe, { enabled, scopeKey, query, search, viewRef }),
    ));
  };
  return {
    queryClient,
    viewRef,
    paths: () => viewRef.current?.items.map((item) => item.path) ?? [],
    async set(next: { enabled?: boolean; scopeKey?: string; query?: string }) {
      if (next.enabled !== undefined) enabled = next.enabled;
      if (next.scopeKey !== undefined) scopeKey = next.scopeKey;
      if (next.query !== undefined) query = next.query;
      await act(async () => { render(); });
    },
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

async function ageChain(queryClient: QueryClient, queryKey: readonly unknown[]): Promise<void> {
  const cached = queryClient.getQueryCache().findAll({ queryKey: [...queryKey] });
  expect(cached).toHaveLength(1);
  await act(async () => { cached[0]?.setState({ dataUpdatedAt: Date.now() - 31_000 }); });
}
