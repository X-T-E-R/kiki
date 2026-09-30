import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import type { IBootstrapService, IConfigService, IEventService, IFlagService, ILogService, ISessionIndex } from '@kiki/agent-core-v2';
import type { SearchIndexStateChanged } from '../../src/search/events';
import { GlobalSearchService, drainGlobalSearchDisposals } from '../../src/search/searchService';

const homes: string[] = [];
afterEach(async () => {
  await drainGlobalSearchDisposals();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

function service(home: string, enabled?: boolean, backend = 'sqlite', events?: IEventService): GlobalSearchService {
  const index = {
    prepare: async () => ({ source: 'authoritative', state: 'ready' }),
    status: () => ({ source: 'authoritative', state: 'ready' }),
    onDidChangeStatus: () => ({ dispose: () => {} }),
    listRecent: async () => ({ items: [{ id: 's1', workspaceId: 'ws', title: 'Search result', updatedAt: 1_700_000_000_000 }], nextCursor: undefined }),
    count: async () => 1,
    get: async () => undefined,
  } as unknown as ISessionIndex;
  const config = { get: (section: string) => section === 'search' ? { enabled } :
    section === 'search_backend' ? backend : undefined } as unknown as IConfigService;
  const flags = { enabled: () => false } as unknown as IFlagService;
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as ILogService;
  const bootstrap = { homeDir: home, scope: (scope: string) => scope } as unknown as IBootstrapService;
  const search = new GlobalSearchService(index, bootstrap, log, flags, config, events);
  search.syncDebounceMs = 0;
  search.setLiveTranscriptSource({ forSessionLive: () => undefined, whenReady: async () => {},
    ensureAgentHistory: async () => {} });
  return search;
}

it('serves partial building progress then locatable SQLite hits while indexing in the background', async () => {
  const home = await mkdtemp(join(process.cwd(), '.tmp-search-s4-'));
  homes.push(home);
  const dir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'wire.jsonl'), JSON.stringify({ type: 'context.append_message', time: 1_700_000_000_000,
    message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'unique search needle' }] } }) + '\n');
  const search = service(home, process.env['KIKI_DESKTOP_BUNDLED'] === '1' ? true : undefined);
  try {
    let page = await search.search({ query: 'needle', indexOnly: true });
    expect(['building', 'ready']).toContain(page.indexState.state);
    const deadline = Date.now() + 15_000;
    while (!page.items.length && Date.now() < deadline) {
      await delay(50);
      page = await search.search({ query: 'needle', indexOnly: true });
    }
    expect(page.items[0]).toMatchObject({ sessionId: 's1', agentId: 'main', role: 'user', turn: 0 });
    expect(page.indexState).toMatchObject({ indexedSessions: 1, totalSessions: 1 });
    expect((await search.status()).indexer?.indexerStatus?.documents).toBeGreaterThan(0);
  } finally { search.dispose(); }
});

it('keeps desktop default disabled and allows explicit opt-in after restart', async () => {
  const home = await mkdtemp(join(process.cwd(), '.tmp-search-s4-gate-'));
  homes.push(home);
  const previous = process.env['KIKI_DESKTOP_BUNDLED'];
  process.env['KIKI_DESKTOP_BUNDLED'] = '1';
  try {
    const off = service(home);
    expect((await off.search({ query: 'needle', indexOnly: true })).indexState).toMatchObject({
      state: 'unavailable', reason: 'disabled',
    });
    expect((await off.status()).indexer?.indexerPid).toBeUndefined();
    off.dispose();
    await drainGlobalSearchDisposals();
    const on = service(home, true);
    expect((await on.search({ query: 'needle', indexOnly: true })).indexState.state).not.toBe('unavailable');
    on.dispose();
  } finally {
    if (previous === undefined) delete process.env['KIKI_DESKTOP_BUNDLED'];
    else process.env['KIKI_DESKTOP_BUNDLED'] = previous;
  }
});

it('selects the MiniDb rollback without creating a SQLite indexer', async () => {
  const home = await mkdtemp(join(process.cwd(), '.tmp-search-s4-minidb-'));
  homes.push(home);
  const search = service(home, undefined, 'minidb');
  try {
    const status = await search.status();
    expect(status.indexer).toBeUndefined();
    expect(status.lifecycle.state).not.toBe('degraded');
  } finally { search.dispose(); }
});

it('pushes cold-build progress without a search or status polling loop', async () => {
  const home = await mkdtemp(join(process.cwd(), '.tmp-search-ws-progress-'));
  homes.push(home);
  const dir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'wire.jsonl'), JSON.stringify({ type: 'context.append_message', time: 1_700_000_000_000,
    message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'background progress' }] } }) + '\n');
  const progress: Array<{ state: string; indexed_sessions: number; total_sessions: number }> = [];
  let ready!: () => void;
  const completion = new Promise<void>((resolve) => { ready = resolve; });
  const events = { publish: (event: SearchIndexStateChanged) => {
    expect(event.type).toBe('event.search.index_state_changed');
    const state = event.serialize()['payload'] as (typeof progress)[number];
    progress.push(state);
    if (state.state === 'ready' && state.indexed_sessions === 1) ready();
  } } as unknown as IEventService;
  const search = service(home, true, 'sqlite', events);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([completion, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('no ready push')), 15_000);
    })]);
    expect(progress.some((s) => s.state === 'building' && s.total_sessions === 1)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ state: 'ready', indexed_sessions: 1, total_sessions: 1 });
  } finally { clearTimeout(timer); search.dispose(); }
});
