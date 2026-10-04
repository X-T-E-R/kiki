// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { PluginImportArchive } from './PluginImportArchive';

const read = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { klient: { global: { imports: { read } } } }, scopeId: 'scope-1' }),
}));

const ARCHIVE = {
  schemaVersion: 1 as const,
  id: 'archive-1',
  pluginId: 'claude-code-import',
  sourceId: 'claude-code',
  sourceHome: 'C:/Users/ada/.claude',
  externalId: '7a1b9c3d-2e4f-4a6b-8c0d-1e2f3a4b5c6d',
  targetHome: 'main',
  title: 'Draft the release checklist',
  revision: 'bb12cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899aabb',
  formatVersion: 'claude-code.history.v1',
  createdAt: 0,
  updatedAt: 0,
  status: 'preserved' as const,
  losses: [],
  records: 5,
  pages: 2,
  jobId: 'job-1',
  previousJobIds: [],
};

const page = (index: number, records: unknown[]) => ({ archive: ARCHIVE, records, cursor: index + 1 < ARCHIVE.pages ? String(index + 1) : null });

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  shared = undefined;
  read.mockReset().mockImplementation(async ({ cursor }: { cursor?: string }) => (
    cursor === undefined
      ? page(0, [
        { id: 'r1', part: 0, role: 'user', text: 'Draft the release checklist.' },
        // One record's body split across pages, the way the host splits a long
        // text: the same id and part, with its own offset and total.
        { id: 'r2', part: 0, role: 'assistant', text: 'Here is the shipping order. ', textOffset: 0, textTotal: 62 },
      ])
      : page(1, [
        { id: 'r2', part: 0, role: 'assistant', text: 'The rollback step is one command.', textOffset: 28, textTotal: 62 },
        { id: 'r3', part: 0, role: 'system', text: 'You are Claude Code, a helpful assistant.' },
      ])
  ));
});
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

/** The Dialog renders through a body portal, so assertions read the document. */
/** One client for a whole test, so a reopen meets a warm cache. */
let shared: QueryClient | undefined;

async function render(): Promise<HTMLElement> { return mount('archive-1'); }

/** Re-renders the existing panel on a new archive, as an in-page switch does. */
async function switchTo(archiveId: string): Promise<HTMLElement> {
  const container = containers.at(-1)!;
  const root = roots.at(-1)!;
  const queryClient = shared!;
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <PluginImportArchive archiveId={archiveId} onClose={() => {}} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  // The panel is portalled into the body, so assertions read the document.
  return document.body;
}

async function mount(archiveId: string): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = shared ??= new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <PluginImportArchive archiveId={archiveId} onClose={() => {}} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return document.body;
}

const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };

describe('PluginImportArchive', () => {
  it('says it is a read-only record, not a live session', async () => {
    const container = await render();
    const dialog = container.querySelector('[role="dialog"]')!;
    const text = dialog.textContent ?? '';
    // The boundary is stated once, in the reader's terms, and never implied away.
    expect(text).toContain('read-only record');
    expect(text).toContain('cannot be continued here');
  });

  it('reads the first page only, and no more', async () => {
    const container = await render();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ archiveId: 'archive-1', limit: 50 });
    expect(container.querySelectorAll('[data-plugin-import-archive-record]')).toHaveLength(2);
  });

  it('appends the next page without collapsing the earlier records', async () => {
    const container = await render();
    await click(container.querySelector('[data-plugin-import-archive-more]')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // Both the earlier and the continued record are present, so a repeated
    // `id`+`part` across pages does not overwrite what is already drawn.
    const bodies = [...container.querySelectorAll('[data-plugin-import-archive-record] p:nth-of-type(2)')].map((node) => node.textContent);
    expect(bodies).toHaveLength(4);
    expect(bodies.join('\n')).toContain('Here is the shipping order.');
    expect(bodies.join('\n')).toContain('The rollback step is one command.');
  });

  it('offers no next page once the archive is exhausted', async () => {
    const container = await render();
    await click(container.querySelector('[data-plugin-import-archive-more]')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-plugin-import-archive-more]')).toBeNull();
  });

  it('shows the body again when the reader reopens the same archive', async () => {
    // The ordinary path: close the archive, open it again. React Query still
    // holds a fresh first page, so the panel must render it rather than clearing
    // the body and waiting for a fetch that will not come.
    await render();
    // Unmount the way closing the panel does, then mount it again against the
    // same client — the ordinary reopen, with a warm cache.
    for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
    for (const container of containers.splice(0)) container.remove();
    const second = await render();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(second.querySelectorAll('[data-plugin-import-archive-record]')).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not claim the record is fully read while the first page is loading', async () => {
    let release: (() => void) | undefined;
    read.mockImplementation(() => new Promise((resolve) => { release = () => resolve(page(0, [])); }));
    const container = await render();
    const footer = container.querySelector('[data-plugin-import-archive-footer]')!.textContent ?? '';
    expect(footer).not.toContain('Whole record read');
    expect(footer).toContain('one bounded page at a time');
    await act(async () => { release?.(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  });

  it('keeps both halves of a body the host split across pages', async () => {
    const container = await render();
    await click(container.querySelector('[data-plugin-import-archive-more]')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // The continuation shares id and part with the first half. Appending must
    // not overwrite it, and the two halves must read as one body.
    const halves = [...container.querySelectorAll('[data-plugin-import-archive-record]')]
      .map((row) => row.textContent ?? '')
      .filter((text) => text.includes('shipping order') || text.includes('rollback step'));
    expect(halves).toHaveLength(2);
    expect(halves[0]).toContain('Here is the shipping order.');
    expect(halves[1]).toContain('The rollback step is one command.');
  });

  it('drops a page that arrives after the reader moved to another archive', async () => {
    let releaseLate: ((page: unknown) => void) | undefined;
    read.mockImplementation(async ({ archiveId, cursor }: { archiveId: string; cursor?: string }) => {
      if (archiveId === 'archive-2') return page(0, [{ id: 'r2', part: 0, role: 'user', text: 'Second archive.' }]);
      if (cursor === undefined) return page(0, [{ id: 'r1', part: 0, role: 'user', text: 'First archive.' }]);
      // The first archive's second page stalls until after the reader moved on.
      return new Promise((resolve) => { releaseLate = resolve as (page: unknown) => void; });
    });
    const container = await render();
    const first = container;
    await click(first.querySelector('[data-plugin-import-archive-more]')!);

    const second = await switchTo('archive-2');
    const before = second.querySelectorAll('[data-plugin-import-archive-record]').length;
    await act(async () => { releaseLate?.(page(0, [{ id: 'r1', part: 0, role: 'user', text: 'First archive.' }])); await new Promise((resolve) => setTimeout(resolve, 0)); });
    // The late page belongs to archive-1; it must not appear in archive-2.
    expect(second.querySelectorAll('[data-plugin-import-archive-record]')).toHaveLength(before);
    // And archive-2 must still be able to continue its own reading.
    expect(second.querySelector('[data-plugin-import-archive-more]')).not.toBeNull();
    expect(second.querySelector('[data-plugin-import-archive-more]')!.hasAttribute('disabled')).toBe(false);
  });

  it('keeps the revision folded away and one disclosure away', async () => {
    const container = await render();
    // The digest, the parser version and the page arithmetic are mechanism; the
    // first screen carries the source, the target and what was kept.
    const facts = container.querySelector('[role="dialog"]')!.textContent ?? '';
    expect(facts).toContain(ARCHIVE.sourceHome);
    expect(facts).toContain(ARCHIVE.targetHome);
    const details = container.querySelector<HTMLElement>('[data-plugin-import-archive-details]')!;
    expect(details.dataset['open']).toBe('false');
    // The body stays mounted under the fold (the shared disclosure keeps its
    // children for the grid transition), so what matters is that it is not
    // visible before the reader asks for it.
    const body = details.querySelector<HTMLElement>('[data-open] div div')!;
    expect(body.getBoundingClientRect().height).toBe(0);
    await click(details.querySelector('button')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(details.dataset['open']).toBe('true');
    expect(container.querySelector('[role="dialog"]')!.textContent ?? '').toContain(ARCHIVE.revision);
  });

  it('states read-only once, and does not describe an action it does not offer', async () => {
    const container = await render();
    const dialog = container.querySelector('[role="dialog"]')!.textContent ?? '';
    expect(dialog).toContain('cannot be continued here');
    // The footer used to repeat the boundary and then describe what "opening it
    // in a live conversation" would do — an action this surface has no button
    // for. One statement, no invented affordance.
    expect(dialog).not.toContain('replay');
    expect(container.querySelectorAll('button').length).toBeLessThan(6);
  });
});
