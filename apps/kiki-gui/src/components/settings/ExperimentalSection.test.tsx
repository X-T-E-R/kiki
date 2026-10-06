// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRestartRequirement, restartRequirementSnapshot } from '@kiki/session-core/settings';
import { I18nProvider } from '../../i18n';
import { ExperimentalRows } from './ExperimentalRows';

const client = {
  getConfig: vi.fn(),
  patchConfig: vi.fn(),
  meta: vi.fn(),
};

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client }),
}));

let root: Root;
let container: HTMLDivElement;
let query: QueryClient;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(section: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={query}>
        <I18nProvider>
          <ExperimentalRows section={section} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.getConfig.mockReset().mockResolvedValue({ experimental: { task_wait: true } });
  client.meta.mockReset().mockResolvedValue({
    experimental_flags: {
      task_wait: true,
      task_board: false,
      search_worker: true,
      auto_session_title: false,
      vendor_extension: true,
    },
  });
  client.patchConfig.mockReset().mockImplementation(async (patch) => ({ experimental: { ...patch.experimental } }));
  clearRestartRequirement();
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  query.clear();
});

describe('ExperimentalRows', () => {
  it('lists only the flags whose home is this page, each with the tag, description and timing', async () => {
    await render('tasks');
    const block = container.querySelector('#st-card-exp-tasks')!;
    expect(block.querySelector('h2')?.textContent).toBe('Experimental');
    const rows = [...block.querySelectorAll('[data-experimental-row]')];
    expect(rows.map((row) => row.getAttribute('data-experimental-row'))).toEqual(['task_wait', 'task_board']);
    const wait = rows[0]!;
    expect(wait.querySelector('[data-experimental-tag]')?.textContent).toBe('Experimental');
    expect(wait.textContent).toContain('Wait for background tasks');
    expect(wait.querySelector('[data-experimental-effect]')?.textContent).toBe('Applies right away.');
    expect(wait.querySelector('[data-flag-effective]')?.textContent).toBe('Currently on');
    // The saved override is the selected choice; the flag id stays visible but quiet.
    expect(wait.querySelector('[data-experimental-choice="on"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(wait.textContent).toContain('task_wait');
  });

  it('renders nothing on a page that owns no reported flag', async () => {
    await render('permissions');
    expect(container.querySelector('[data-experimental-rows]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('skips a flag whose feature card already has the switch', async () => {
    await render('sessions');
    expect(container.querySelector('[data-experimental-row="auto_session_title"]')).toBeNull();
  });

  it('puts server-specific flags nobody claims on Developer', async () => {
    await render('developer');
    const row = container.querySelector('[data-experimental-row="vendor_extension"]')!;
    expect(row.textContent).toContain('Server-specific feature');
  });

  it('names the shipped feature flag and never offers a switch for history import', async () => {
    client.meta.mockResolvedValue({
      experimental_flags: { usage_export: false, plugin_import: false, vendor_extension: true },
    });
    await render('developer');
    const exportRow = container.querySelector('[data-experimental-row="usage_export"]')!;
    expect(exportRow.textContent).toContain('Send usage to other tools');
    expect(exportRow.textContent).toContain('Turning it on needs a server restart.');
    // History import is a shipped capability, so the old flag id gets no
    // switch and no product copy here: a server still reporting it draws the
    // fallback row instead of pretending it can be enabled.
    expect(container.querySelector('[data-experimental-row="plugin_import"]')?.textContent)
      .not.toContain('Import history from other tools');
    // A flag nobody claims still lands on the same page under the fallback name.
    expect(container.querySelector('[data-experimental-row="vendor_extension"]')?.textContent)
      .toContain('Server-specific feature');
  });

  it('marks a restart when a restart-only flag is turned on', async () => {
    await render('search');
    const on = container.querySelector<HTMLButtonElement>('[data-experimental-row="search_worker"] [data-experimental-choice="off"]')!;
    expect(container.querySelector('[data-experimental-row="search_worker"] [data-experimental-effect]')?.textContent)
      .toBe('Turning it on needs a server restart.');
    await act(async () => { on.click(); });
    await flush();
    expect(client.patchConfig).toHaveBeenCalledWith({
      experimental: { task_wait: true, search_worker: false },
      replace_domains: ['experimental'],
    });
    // Turning a restart-only flag off applies on the next check; no restart prompt.
    expect(restartRequirementSnapshot().required).toBe(false);
    const again = container.querySelector<HTMLButtonElement>('[data-experimental-row="search_worker"] [data-experimental-choice="on"]')!;
    await act(async () => { again.click(); });
    await flush();
    expect(restartRequirementSnapshot().fields).toContain('search_worker');
  });

  it('rolls the choice back and explains the failure when the save fails', async () => {
    client.patchConfig.mockRejectedValueOnce(new Error('offline'));
    await render('tasks');
    const off = container.querySelector<HTMLButtonElement>('[data-experimental-row="task_wait"] [data-experimental-choice="off"]')!;
    await act(async () => { off.click(); });
    await flush();
    const row = container.querySelector('[data-experimental-row="task_wait"]')!;
    expect(row.querySelector('[role="alert"]')?.textContent).toContain('offline');
    expect(row.querySelector('[data-experimental-choice="on"]')?.getAttribute('aria-pressed')).toBe('true');
  });
});
