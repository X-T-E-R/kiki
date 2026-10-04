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
import { clearToasts } from '../../lib/toasts';

import { I18nProvider } from '../../i18n';
import { PersonasPage } from './PersonasPage';

const navigate = vi.fn();
const listPersonas = vi.fn();
const getPersona = vi.fn();
const putPersona = vi.fn();
const listWorkspaces = vi.fn();
const listNamedAgentProfiles = vi.fn();
const listModels = vi.fn();
const listCronTasks = vi.fn();
const listSessions = vi.fn();
const listRooms = vi.fn();
const listAgentCapabilities = vi.fn();

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
  for (const fn of [navigate, listPersonas, getPersona, putPersona, listWorkspaces, listNamedAgentProfiles, listModels, listCronTasks, listSessions, listRooms, listAgentCapabilities]) fn.mockReset();
  clearToasts();
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
