// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LocalSessionSummary } from '@kiki/protocol';
import { ApiError } from '@kiki/session-core/transport';

import { I18nProvider } from '../../i18n';
import { LocalSessionsDialog } from './LocalSessionsDialog';

const { client } = vi.hoisted(() => ({ client: {
  listExecutors: vi.fn(), listLocalSessions: vi.fn(), getLocalSession: vi.fn(), resumeLocalSession: vi.fn(),
} }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }), useOptionalConnection: () => ({ client }) }));

const summary = (id: string, patch: Partial<LocalSessionSummary> = {}): LocalSessionSummary => ({
  id: `external:claude:${id}`, engine: 'claude', external_id: id, source_path: `/h/${id}.jsonl`, source_home: '/home/.claude',
  resume: { supported: true }, cwd: '/w/app', updated_at: '2026-01-01T00:00:00.000Z', partial: false, title: `Session ${id}`, ...patch,
});

let root: Root;
let container: HTMLDivElement;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

function Where() {
  return <span data-where>{useLocation().pathname}</span>;
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  client.listExecutors.mockResolvedValue({ items: [
    { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
    { id: 'claude-acp', label: 'Claude Code', protocol: 'acp-v1', status: 'ready', model_binding: 'mapped', thinking_binding: 'unavailable' },
  ] });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function render() {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(
    <QueryClientProvider client={queries}><I18nProvider><MemoryRouter initialEntries={['/new']}>
      <Routes><Route path="*" element={<><Where /><LocalSessionsDialog onClose={() => {}} /></>} /></Routes>
    </MemoryRouter></I18nProvider></QueryClientProvider>,
  ));
  await settle();
}

const body = () => document.body;

describe('LocalSessionsDialog', () => {
  it('shows the partial preview with its warnings and translates why a row cannot continue', async () => {
    client.listLocalSessions.mockResolvedValue({ root: '/home/.claude/projects', exists: true, truncated: false, unreadable_files: 0, resume_enabled: true,
      items: [summary('a', { partial: true }), summary('b', { resume: { supported: false, reason: 'working_directory_missing' }, cwd: undefined })] });
    client.getLocalSession.mockImplementation(async (_executor: string, id: string) => ({
      summary: summary(id.split(':').pop()!, { partial: true }), warnings: ['transcript_sampled', 'mystery_code'],
      messages: [{ id: 'm1', role: 'user', blocks: [{ kind: 'text', text: 'Fix the parser' }] }],
    }));
    await render();
    expect(client.listLocalSessions).toHaveBeenCalledWith('claude-acp', 100);
    expect(body().querySelector('[data-local-partial]')?.textContent).toContain('Partial preview');
    expect(body().querySelector('[data-local-warning="transcript_sampled"]')?.textContent).toContain('only the beginning and the end');
    expect(body().querySelector('[data-local-warning="mystery_code"]')?.textContent).toBe('mystery_code');
    expect(body().querySelector('[data-local-message="user"]')?.textContent).toContain('Fix the parser');
    const blocked = body().querySelector('[data-local-session="external:claude:b"]')!;
    expect(blocked.querySelector('[data-local-unsupported="working_directory_missing"]')?.textContent).toBe('Its working folder is not recorded.');
    await act(async () => { (blocked as HTMLButtonElement).click(); });
    await settle();
    expect(body().querySelector<HTMLButtonElement>('[data-local-continue]')?.disabled).toBe(true);
  });

  it('posts the source home verbatim and opens the returned session, attached or not', async () => {
    client.listLocalSessions.mockResolvedValue({ root: '/r', exists: true, truncated: false, unreadable_files: 0, resume_enabled: true, items: [summary('a')] });
    client.getLocalSession.mockResolvedValue({ summary: summary('a'), warnings: [], messages: [] });
    client.resumeLocalSession.mockResolvedValue({ session_id: 'session_existing', executor_id: 'claude-acp', created: false });
    await render();
    await act(async () => { body().querySelector<HTMLButtonElement>('[data-local-continue]')!.click(); });
    await settle();
    expect(client.resumeLocalSession).toHaveBeenCalledWith('claude-acp', 'external:claude:a', { source_home: '/home/.claude' });
    expect(body().querySelector('[data-where]')?.textContent).toBe('/s/session_existing');
  });

  it('says what to do when continuing fails and keeps the dialog open', async () => {
    client.listLocalSessions.mockResolvedValue({ root: '/r', exists: true, truncated: false, unreadable_files: 0, resume_enabled: true, items: [summary('a')] });
    client.getLocalSession.mockResolvedValue({ summary: summary('a'), warnings: [], messages: [] });
    client.resumeLocalSession.mockRejectedValue(new ApiError({ code: 40933, msg: 'locked', data: null }));
    await render();
    await act(async () => { body().querySelector<HTMLButtonElement>('[data-local-continue]')!.click(); });
    await settle();
    expect(body().querySelector('[data-local-error]')?.textContent).toContain('Another Kiki window');
    expect(body().querySelector('[data-where]')?.textContent).toBe('/new');
  });

  it('disables continuing when the server turned it off', async () => {
    client.listLocalSessions.mockResolvedValue({ root: '/r', exists: true, truncated: false, unreadable_files: 0, resume_enabled: false, items: [summary('a')] });
    client.getLocalSession.mockResolvedValue({ summary: summary('a'), warnings: [], messages: [] });
    await render();
    expect(body().querySelector('[data-local-disabled]')).not.toBeNull();
    expect(body().querySelector<HTMLButtonElement>('[data-local-continue]')?.disabled).toBe(true);
  });
});
