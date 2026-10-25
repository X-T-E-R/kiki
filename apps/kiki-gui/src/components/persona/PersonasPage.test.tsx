// @vitest-environment jsdom

/**
 * /personas as a page, not an editor.
 *
 * The page writes personas to the connected server and says so once for the
 * whole page. Each of the editor's cards therefore keeps its scope as an
 * assistive-technology fact and stops printing "适用于：已连接的服务器" under
 * its own heading — the repetition was five lines saying one thing.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonaDefinition, PersonaSnapshot, PersonaSummary } from '@kiki/protocol';
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mockNavigate,
}));
import { readDraft, resetDraftMemoryForTests, writeDraft } from '@kiki/session-core/composer';
import { clearToasts } from '../../lib/toasts';

import { I18nProvider } from '../../i18n';
import { PersonasPage } from './PersonasPage';

const navigate = vi.fn();
const listPersonas = vi.fn();
const getPersona = vi.fn();
const putPersona = vi.fn();
const createSession = vi.fn();
const listWorkspaceCatalog = vi.fn();
const listNamedAgentProfiles = vi.fn();
const listModels = vi.fn();
const listCronTasks = vi.fn();
const listSessions = vi.fn();
const listRooms = vi.fn();
const listAgentCapabilities = vi.fn();
const previewPersonaImport = vi.fn();
const importPersonaCard = vi.fn();

// No `runAction` here on purpose: this file models a page that is not dirty, so
// the handoff creates and leaves without a prompt. The cancel-the-leave order is
// covered against the real guard in askKiki.dirtyOrder.test.tsx.
vi.mock('../dirtyGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dirtyGuard')>()),
  useGuardedNavigate: () => navigate,
}));
vi.mock('../../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../../state/connection', () => {
  const value = () => ({
    client: {
      listPersonas,
      getPersona,
      putPersona,
      createSession,
      listWorkspaceCatalog,
      listNamedAgentProfiles,
      listModels,
      listCronTasks,
      listSessions,
      listAgentCapabilities,
      previewPersonaImport,
      importPersonaCard,
      klient: { rest: { personas: {}, rooms: { list: listRooms } } },
    },
    scopeId: 'local',
    sshLabel: null,
  });
  return { useConnection: value, useOptionalConnection: value };
});

const mounted: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => {
  for (const fn of [navigate, listPersonas, getPersona, putPersona, createSession, listWorkspaceCatalog, listNamedAgentProfiles, listModels, listCronTasks, listSessions, listRooms, listAgentCapabilities]) fn.mockReset();
  clearToasts();
  resetDraftMemoryForTests();
  localStorage.setItem('kiki.locale', 'zh');
  listWorkspaceCatalog.mockResolvedValue({ items: [] });
  listNamedAgentProfiles.mockResolvedValue({ items: [] });
  listModels.mockResolvedValue({ items: [] });
  listCronTasks.mockResolvedValue({ items: [], has_more: false });
  listSessions.mockResolvedValue({ items: [], has_more: false });
  listRooms.mockResolvedValue([]);
  listAgentCapabilities.mockResolvedValue({ context: 'live', available: true, targets: [], tools: [], skills: [] });
});
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

const LIN_LAN: PersonaSummary = { id: 'lin-lan', name: '林岚', title: '发布协调', job: '负责发布节奏', revision: 'revision-1', archived: false };

function snapshot(definition: Partial<PersonaDefinition> & Pick<PersonaDefinition, 'id' | 'name' | 'description'>): PersonaSnapshot {
  return { definition: definition as PersonaDefinition, revision: 'revision-1' };
}

async function render(path: string): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient },
      createElement(I18nProvider, null,
        createElement(MemoryRouter, { initialEntries: [path] },
          createElement(PersonasPage, { onToggleSidebar: vi.fn() })))));
  });
  for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

describe('the personas page scope', () => {
  it('says where its cards write once, without repeating it under every heading', async () => {
    listPersonas.mockResolvedValue([LIN_LAN]);
    getPersona.mockResolvedValue(snapshot({ id: 'lin-lan', name: '林岚', title: '发布协调', job: '负责发布节奏', description: '负责发布节奏。' }));
    const container = await render('/personas?persona=lin-lan&view=settings');

    // All five cards are on this page: 身份 / 运行 / 可见性 / 记忆 / 任务与连接.
    const cards = [...container.querySelectorAll('[data-settings-card]')];
    expect(cards.length).toBeGreaterThan(1);
    // The tag is still on every card, so the scope is still announced …
    for (const card of cards) {
      const tag = card.querySelector('[data-settings-panel-scope="server"]');
      expect(tag, `${card.id} lost its scope`).not.toBeNull();
      expect(tag!.textContent).toBe('适用于： 已连接的服务器');
    }
    // … but the page that owns that scope does not print it five times over:
    // every occurrence on screen is the screen-reader copy.
    for (const card of cards) {
      expect(card.querySelector('[data-settings-panel-scope="server"]')!.className).toContain('sr-only');
    }
    const visible = [...container.querySelectorAll('[data-settings-panel-scope="server"]')]
      .filter((tag) => !tag.className.includes('sr-only'));
    expect(visible).toEqual([]);
  });

  it('leaves the new-persona draft with the same page scope and a sticky save bar', async () => {
    listPersonas.mockResolvedValue([LIN_LAN]);
    const container = await render('/personas?new=1');

    const identity = container.querySelector('[data-settings-card="persona-card-identity"]')!;
    expect(identity.querySelector('[data-settings-panel-scope="server"]')!.className).toContain('sr-only');
    expect(identity.querySelector('h3')?.className).toContain('text-[12px]');
    expect(identity.querySelector('h3')?.className).toContain('text-section-ink');
    expect(container.querySelector('[data-persona-editor="new"]')).not.toBeNull();
    expect(container.querySelector('[data-persona-save-bar]')?.className).toContain('sticky');
  });

  it('shows the lede only in the empty state and hides it once personas exist', async () => {
    listPersonas.mockResolvedValueOnce([]);
    const emptyContainer = await render('/personas');
    expect(emptyContainer.querySelector('[data-persona-empty]')?.textContent).toContain('角色决定「谁」来和你说话');

    listPersonas.mockResolvedValueOnce([LIN_LAN]);
    const filledContainer = await render('/personas');
    expect(filledContainer.textContent).not.toContain('角色决定「谁」来和你说话');
  });
});

describe('handing a new persona to Kiki', () => {
  beforeEach(() => {
    writeDraft('new', 'half-typed question about personas');
    writeDraft('session-other', 'another conversation unsent');
    // The most recent workspace is what a plain New conversation here inherits.
    listWorkspaceCatalog.mockResolvedValue({ items: [{ id: 'wd_recent_000000000000', name: 'Recent', root: '/recent' }] });
  });

  it('sits beside New persona in Ask Kiki -> Import -> New order, and carries the full intent for assistive tech', async () => {
    listPersonas.mockResolvedValue([LIN_LAN]);
    const container = await render('/personas');

    const ask = container.querySelector<HTMLButtonElement>('[data-persona-ask-kiki]')!;
    expect(ask.textContent).toBe('帮我创建');
    expect(ask.getAttribute('aria-label')).toBe('让 Kiki 帮你创建角色');
    expect(ask.getAttribute('title')).toBe('让 Kiki 帮你创建角色');
    // It is the same second-level weight as Import, never the primary verb.
    const primary = container.querySelector<HTMLButtonElement>('[data-persona-new]')!;
    const importButton = container.querySelector<HTMLButtonElement>('[data-persona-import]')!;
    const headerButtons = [...container.querySelectorAll('header button')].filter((button) =>
      button.hasAttribute('data-persona-ask-kiki') || button.hasAttribute('data-persona-import') || button.hasAttribute('data-persona-new'));
    expect(headerButtons.map((button) => button.getAttribute('data-persona-ask-kiki') !== null ? 'ask' : button.getAttribute('data-persona-import') !== null ? 'import' : 'new'))
      .toEqual(['ask', 'import', 'new']);
    // The only addition is shrink-0, so a wrapped header never squeezes the
    // label into an ellipsis; the border, type and colour roles are identical.
    expect([...ask.classList].filter((name) => name !== 'shrink-0').sort())
      .toEqual([...importButton.classList].sort());
    expect(ask.className).not.toBe(primary.className);
    expect(ask.className).not.toContain('bg-accent');
  });

  it('opens one new session whose composer waits for an editable /kiki-persona line, and sends nothing', async () => {
    listPersonas.mockResolvedValue([LIN_LAN]);
    createSession.mockResolvedValue({ id: 'persona-ask-session' });
    const container = await render('/personas');

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-persona-ask-kiki]')!.click(); });
    for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(createSession).toHaveBeenCalledTimes(1);
    // Personas carry no address of their own, so the session inherits the most
    // recent workspace — the same one a plain New conversation here would use.
    // An empty body would make the server mint a fresh "Untitled workspace".
    expect(createSession).toHaveBeenCalledWith({ workspace_id: 'wd_recent_000000000000' });
    expect(navigate).toHaveBeenCalledWith('/s/persona-ask-session', { state: { createdSession: { id: 'persona-ask-session', scopeId: 'local' } } });
    // The draft is a real slash line, so the composer chips the skill and the
    // ordinary submit flow resolves it to kiki-persona.
    expect(readDraft('persona-ask-session')).toMatch(/^\/kiki-persona /);
    // The user edits before sending: nothing else on screen moved.
    expect(readDraft('new')).toBe('half-typed question about personas');
    expect(readDraft('session-other')).toBe('another conversation unsent');
    expect(putPersona).not.toHaveBeenCalled();
  });

  it('falls back to the auto-workspace mechanism only when this machine truly has none', async () => {
    listPersonas.mockResolvedValue([LIN_LAN]);
    listWorkspaceCatalog.mockResolvedValue({ items: [] });
    createSession.mockResolvedValue({ id: 'persona-ask-empty' });
    const container = await render('/personas');

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-persona-ask-kiki]')!.click(); });
    for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // Same body /new sends when there is nothing to inherit.
    expect(createSession).toHaveBeenCalledWith({});
    expect(readDraft('persona-ask-empty')).toMatch(/^\/kiki-persona /);
  });

  it('does not pretend a failed workspace list is an empty one', async () => {
    listPersonas.mockResolvedValue([LIN_LAN]);
    listWorkspaceCatalog.mockRejectedValue(new Error('list unavailable'));
    createSession.mockResolvedValue({ id: 'persona-ask-unknown' });
    const container = await render('/personas');

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-persona-ask-kiki]')!.click(); });
    for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // We never learned where this belongs, so the button must not have fired:
    // silently landing in a new folder would be the F1 defect all over again.
    expect(createSession).not.toHaveBeenCalled();
    expect(readDraft('persona-ask-unknown')).toBe('');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('creates one session even when the button is clicked twice', async () => {
    listPersonas.mockResolvedValue([LIN_LAN]);
    createSession.mockResolvedValue({ id: 'persona-ask-session' });
    const container = await render('/personas');
    const button = container.querySelector<HTMLButtonElement>('[data-persona-ask-kiki]')!;

    await act(async () => { button.click(); button.click(); button.click(); });
    for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the button usable after a failed create, so the press can be retried', async () => {
    listPersonas.mockResolvedValue([LIN_LAN]);
    createSession.mockRejectedValueOnce(new Error('server offline')).mockResolvedValueOnce({ id: 'persona-ask-retry' });
    const container = await render('/personas');
    const button = container.querySelector<HTMLButtonElement>('[data-persona-ask-kiki]')!;

    await act(async () => { button.click(); });
    for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(button.disabled).toBe(false);
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => { button.click(); });
    for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith('/s/persona-ask-retry', { state: { createdSession: { id: 'persona-ask-retry', scopeId: 'local' } } });
  });

  it('reports persona import memory failure accurately with view action in toast', async () => {
    const { PersonaImportDialog } = await import('./PersonaImportDialog');
    previewPersonaImport.mockResolvedValue({
      definition: { id: 'imported-bot', name: 'Imported Bot', description: 'Bot description' },
      avatar: null,
      greetings: [],
      examples: 'Example dialogue',
      memoryEntries: [{ title: 'Memory 1', body: 'Body 1' }],
      lorebookCount: 3,
      ignoredFields: [],
    });
    importPersonaCard.mockResolvedValue({
      snapshot: { definition: { id: 'imported-bot', name: 'Imported Bot' } },
      memory: { status: 'failed', count: 3, error: 'Database locked' },
    });
    const onImported = vi.fn();
    const onClose = vi.fn();

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <MemoryRouter>
              <PersonaImportDialog takenIds={new Set()} onClose={onClose} onImported={onImported} />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });

    const file = new File(['{}'], 'card.json', { type: 'application/json' });
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((res) => setTimeout(res, 0)); });

    const importBtn = document.body.querySelector<HTMLButtonElement>('[data-persona-import-confirm]');
    expect(importBtn).not.toBeNull();
    await act(async () => { importBtn!.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((res) => setTimeout(res, 0)); });

    const toasts = (await import('../../lib/toasts')).getToasts();
    const lastToast = toasts.at(-1);
    expect(lastToast).toBeDefined();
    expect(lastToast?.tone).toBe('error');
    expect(lastToast?.text).toContain('已导入「Imported Bot」，但记忆未能写入');
    expect(lastToast?.detail).toBe('Database locked');
    expect(lastToast?.retry?.label).toBe('查看记忆');

    // Clicking the retry action calls navigate to /memory?persona=imported-bot
    expect(typeof lastToast?.retry?.run).toBe('function');
    await act(async () => {
      lastToast?.retry?.run();
    });
    expect(mockNavigate).toHaveBeenCalledWith('/memory?persona=imported-bot');
  });

});
