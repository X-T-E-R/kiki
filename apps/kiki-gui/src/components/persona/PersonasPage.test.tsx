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
import { readDraft, resetDraftMemoryForTests, writeDraft } from '@kiki/session-core/composer';
import { clearToasts } from '../../lib/toasts';

import { I18nProvider } from '../../i18n';
import { PersonasPage } from './PersonasPage';

const navigate = vi.fn();
const listPersonas = vi.fn();
const getPersona = vi.fn();
const putPersona = vi.fn();
const createSession = vi.fn();
const listWorkspaces = vi.fn();
const listNamedAgentProfiles = vi.fn();
const listModels = vi.fn();
const listCronTasks = vi.fn();
const listSessions = vi.fn();
const listRooms = vi.fn();
const listAgentCapabilities = vi.fn();

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
      listWorkspaces,
      listNamedAgentProfiles,
      listModels,
      listCronTasks,
      listSessions,
      listAgentCapabilities,
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
  for (const fn of [navigate, listPersonas, getPersona, putPersona, createSession, listWorkspaces, listNamedAgentProfiles, listModels, listCronTasks, listSessions, listRooms, listAgentCapabilities]) fn.mockReset();
  clearToasts();
  resetDraftMemoryForTests();
  localStorage.setItem('kiki.locale', 'zh');
  listWorkspaces.mockResolvedValue({ items: [] });
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

  it('leaves the new-persona draft with the same page scope', async () => {
    listPersonas.mockResolvedValue([LIN_LAN]);
    const container = await render('/personas?new=1');

    const identity = container.querySelector('[data-settings-card="persona-card-identity"]')!;
    expect(identity.querySelector('[data-settings-panel-scope="server"]')!.className).toContain('sr-only');
    expect(container.querySelector('[data-persona-editor="new"]')).not.toBeNull();
  });
});

describe('handing a new persona to Kiki', () => {
  beforeEach(() => {
    writeDraft('new', 'half-typed question about personas');
    writeDraft('session-other', 'another conversation unsent');
    // The most recent workspace is what a plain New conversation here inherits.
    listWorkspaces.mockResolvedValue({ items: [{ id: 'wd_recent_000000000000', name: 'Recent', root: '/recent' }] });
  });

  it('sits beside New persona as a short secondary action, and carries the full intent for assistive tech', async () => {
    listPersonas.mockResolvedValue([LIN_LAN]);
    const container = await render('/personas');

    const ask = container.querySelector<HTMLButtonElement>('[data-persona-ask-kiki]')!;
    expect(ask.textContent).toBe('帮我创建');
    expect(ask.getAttribute('aria-label')).toBe('让 Kiki 帮你创建角色');
    expect(ask.getAttribute('title')).toBe('让 Kiki 帮你创建角色');
    // It is the same second-level weight as Import, never the primary verb.
    const primary = container.querySelector<HTMLButtonElement>('[data-persona-new]')!;
    const importButton = container.querySelector<HTMLButtonElement>('[data-persona-import]')!;
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
    listWorkspaces.mockResolvedValue({ items: [] });
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
    listWorkspaces.mockRejectedValue(new Error('list unavailable'));
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

});
