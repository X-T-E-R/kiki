// @vitest-environment jsdom

/**
 * `/settings/sessions/import` — the consumer half of the source handoff.
 *
 * A source plugin's own "import from here" arrives as a query on this address
 * (`?source=&sourcePlugin=`), written by the Capabilities/plugins surface. The
 * view below takes that link as props and never reads the address itself, so
 * the two halves only meet when this page passes the query on. These cases hold
 * the seam rather than the view: what the producer puts in the address is what
 * the consumer must open, and an older link that names only the source id still
 * resolves.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { SessionsImportPage } from './SessionsImportPage';

const sources = vi.fn();
const discover = vi.fn();
const preview = vi.fn();
const start = vi.fn();
const jobs = vi.fn();
const jobById = vi.fn();
const cancel = vi.fn();
const resume = vi.fn();
const archives = vi.fn();
const read = vi.fn();
const meta = vi.fn();
const listWorkspaces = vi.fn();
const listPlugins = vi.fn();
const getPluginSettings = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      meta,
      listWorkspaces,
      listPlugins,
      getPluginSettings,
      klient: { global: { imports: { sources, discover, preview, start, jobs, job: jobById, cancel, resume, archives, read } } },
    },
    scopeId: 'scope-1',
    meta: { server_id: 'fixture-server', server_home_id: '11111111-1111-4111-8111-111111111111' },
    sshLabel: null,
    connectionId: null,
  }),
}));

/** Two plugins contributing a source with the SAME id, which is what makes the
 *  plugin half of the link load-bearing rather than decorative. */
const SOURCES = [
  { schemaVersion: 1 as const, id: 'claude-code', label: 'Claude Code', formatVersion: 'claude-code.history.v1', pluginId: 'claude-code-import' },
  { schemaVersion: 1 as const, id: 'codex', label: 'Codex', formatVersion: 'codex.rollout.v1', pluginId: 'codex-import' },
  { schemaVersion: 1 as const, id: 'claude-code', label: 'Claude Code (mirror)', formatVersion: 'claude-code.history.v2', pluginId: 'mirror-import' },
];

/** The exact address the Capabilities/plugins handoff writes. */
const HANDOFF = '/settings/sessions/import?source=claude-code&sourcePlugin=mirror-import';

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  meta.mockReset().mockResolvedValue({});
  sources.mockReset().mockResolvedValue(SOURCES);
  discover.mockReset().mockResolvedValue({ entries: [], cursor: null });
  preview.mockReset().mockResolvedValue({ schemaVersion: 1, id: 'preview-1' });
  start.mockReset().mockResolvedValue({ id: 'job-1', status: 'queued' });
  jobs.mockReset().mockResolvedValue({ items: [], cursor: null });
  archives.mockReset().mockResolvedValue({ items: [], cursor: null });
  jobById.mockReset().mockRejectedValue(new Error('no such job'));
  read.mockReset().mockResolvedValue({ records: [], nextCursor: null });
  listWorkspaces.mockReset().mockResolvedValue({ items: [] });
  listPlugins.mockReset().mockResolvedValue({ plugins: [] });
  getPluginSettings.mockReset().mockResolvedValue({ schema: {}, values: {} });
  cancel.mockReset();
  resume.mockReset();
});
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function render(entry: string): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <I18nProvider><SessionsImportPage /></I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  return container;
}

const selectedSource = (container: HTMLDivElement) => {
  const selected = [...container.querySelectorAll('[data-plugin-import-source]')]
    .filter((tab) => tab.getAttribute('aria-selected') === 'true');
  return selected.length === 1 ? selected[0]!.textContent ?? '' : `selected=${selected.length}`;
};

describe('the source a link carries into the import page', () => {
  it('opens the plugin’s own source, not the first one with that id', async () => {
    const container = await render(HANDOFF);
    // The two halves together are the only thing that identifies the source:
    // the id alone matches both plugins, so a page that dropped the plugin
    // would open the first one and look like it worked.
    expect(selectedSource(container)).toContain('mirror');
  });

  it('still resolves a link that carries only the source id', async () => {
    const container = await render('/settings/sessions/import?source=codex');
    expect(selectedSource(container)).toContain('Codex');
  });

  it('treats an empty query value as no link at all', async () => {
    const container = await render('/settings/sessions/import?source=&sourcePlugin=');
    expect(container.querySelector('[data-sessions-import-page]')).not.toBeNull();
    expect(container.querySelectorAll('[data-plugin-import-source]').length).toBe(SOURCES.length);
  });
});
