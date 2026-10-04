// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDraft, resetDraftMemoryForTests, writeDraft } from '@kiki/session-core/composer';
import { I18nProvider } from '../../i18n';
import type { PersonaSummary } from '@kiki/protocol';
import { PersonaDailyRoute } from './PersonaDailyRoute';
import { useNewSessionDraft } from '../NewSessionDraft';
import { personaDailyDraftKey, personaDailySettingsKey, personaNewConversationUrl, resolvePersonaDailyRoute } from './personaNavigation';

const { scope, client, navigate, route, draftPage } = vi.hoisted(() => ({
  scope: { id: 'local', label: null as string | null },
  route: { personaId: 'a', data: [] as PersonaSummary[], isLoading: false, isError: false },
  draftPage: vi.fn(),
  navigate: vi.fn(),
  client: {
    listWorkspaces: vi.fn(), getConfig: vi.fn(), listModels: vi.fn(), listNamedAgentProfiles: vi.fn(), getAuth: vi.fn(), getPersona: vi.fn(), createSession: vi.fn(),
    klient: { rest: { workspaces: { inspect: vi.fn() }, ssh: { addSessionHost: vi.fn() } } },
  },
}));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client, scopeId: scope.id, sshLabel: scope.label }) }));
vi.mock('../../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../dirtyGuard', () => ({ useGuardedNavigate: () => navigate }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ personaId: route.personaId }), useNavigate: () => navigate }));
vi.mock('./usePersonas', () => ({ usePersonaList: () => route }));
vi.mock('../NewSessionPage', () => ({ NewSessionPage: (props: unknown) => { draftPage(props); return null; } }));
const mounted: { root: Root; container: HTMLDivElement; queryClient: QueryClient }[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => {
  scope.id = 'local'; scope.label = null; localStorage.clear(); resetDraftMemoryForTests();
  route.personaId = 'a'; route.data = []; route.isLoading = false; route.isError = false; draftPage.mockReset();
  client.listWorkspaces.mockReset().mockResolvedValue({ items: [] });
  client.getConfig.mockReset().mockResolvedValue({}); client.listModels.mockReset().mockResolvedValue({ items: [] });
  client.listNamedAgentProfiles.mockReset().mockResolvedValue({ items: [{ name: 'agent', main: true }] });
  client.getAuth.mockReset().mockResolvedValue({ ready: true });
  client.getPersona.mockReset().mockImplementation(async (id: string) => ({ definition: { id, name: id, description: 'Fixture persona' }, revision: 'revision-1' }));
  client.createSession.mockReset().mockResolvedValue({ id: 'created-session' });
  client.klient.rest.workspaces.inspect.mockReset().mockResolvedValue({ isGit: false }); navigate.mockReset();
});
afterEach(async () => {
  await unmountDrafts(); resetDraftMemoryForTests(); localStorage.clear();
});
async function unmountDrafts() {
  for (const { root, container, queryClient } of mounted.splice(0)) {
    await act(async () => { root.unmount(); }); queryClient.clear(); container.remove();
  }
}
async function mountDraft(personaId: string, isDailyDraft = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container, queryClient });
  let latest!: ReturnType<typeof useNewSessionDraft>;
  function Probe() { latest = useNewSessionDraft({ initialPersona: personaId, isDailyDraft }); return null; }
  await act(async () => { root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(I18nProvider, null, createElement(Probe)))); });
  for (let index = 0; index < 10; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return () => latest;
}

describe('daily draft consumer integration', () => {
  it('retains the existing local daily:<personaId> draft, keeps A/B apart and restores A', async () => {
    writeDraft('daily:a', 'existing A draft');
    const a = await mountDraft('a'); expect(a().draft).toBe('existing A draft');
    await act(async () => { a().updateDraft('A unsent'); }); await unmountDrafts();
    const b = await mountDraft('b'); expect(b().draft).toBe('');
    await act(async () => { b().updateDraft('B unsent'); }); await unmountDrafts();
    const restoredA = await mountDraft('a'); expect(restoredA().draft).toBe('A unsent');
    expect(readDraft('daily:b')).toBe('B unsent');
  });

  it('does not read the local daily draft from the same persona on an SSH connection', async () => {
    writeDraft('daily:a', 'local A unsent');
    scope.id = 'ssh:fixture'; scope.label = 'Fixture remote';
    const remote = await mountDraft('a'); expect(remote().draft).toBe('');
  });

  it('does not overwrite local text while drafting on SSH and restores each scope', async () => {
    const local = await mountDraft('a');
    await act(async () => { local().updateDraft('local A'); }); await unmountDrafts();
    scope.id = 'ssh:fixture'; scope.label = 'Fixture remote';
    const remote = await mountDraft('a');
    await act(async () => { remote().updateDraft('remote A'); }); await unmountDrafts();
    scope.id = 'local'; scope.label = null;
    const restoredLocal = await mountDraft('a'); expect(restoredLocal().draft).toBe('local A'); await unmountDrafts();
    scope.id = 'ssh:fixture'; scope.label = 'Fixture remote';
    const restoredRemote = await mountDraft('a'); expect(restoredRemote().draft).toBe('remote A');
  });

  it('sends persona+persona_home on the first daily send through the real draft consumer', async () => {
    const current = await mountDraft('a');
    expect(current().persona?.definition.id).toBe('a');
    await act(async () => { await current().send('first daily message', []); });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ persona: 'a', persona_home: true }));
    expect(navigate).toHaveBeenCalledWith('/s/created-session', expect.objectContaining({ state: expect.objectContaining({ initialPrompt: 'first daily message' }) }));
  });
});


describe('persona navigation contract', () => {
  const directory = [{ id: 'a', archived: false, homeSessionId: 'old-bot-home' }, { id: 'b', archived: false }];
  it('waits for a real directory result and never converts loading, errors or unknown identities into a draft', () => {
    expect(resolvePersonaDailyRoute({ personaId: 'a', directory: [], isLoading: true, isError: false })).toEqual({ kind: 'loading' });
    expect(resolvePersonaDailyRoute({ personaId: 'a', directory: [], isLoading: false, isError: true })).toEqual({ kind: 'error' });
    expect(resolvePersonaDailyRoute({ personaId: 'a', directory, isLoading: false, isError: true })).toEqual({ kind: 'error' });
    expect(resolvePersonaDailyRoute({ personaId: 'missing', directory, isLoading: false, isError: false })).toEqual({ kind: 'missing' });
    expect(resolvePersonaDailyRoute({ personaId: 'a', directory: [{ id: 'a', archived: true }], isLoading: false, isError: false })).toEqual({ kind: 'missing' });
  });

  it('opens the unchanged old Bot home for A and a separate daily draft for B', () => {
    expect(resolvePersonaDailyRoute({ personaId: 'a', directory, isLoading: false, isError: false })).toEqual({ kind: 'home', personaId: 'a', sessionId: 'old-bot-home', href: '/s/old-bot-home' });
    expect(resolvePersonaDailyRoute({ personaId: 'b', directory, isLoading: false, isError: false })).toEqual({ kind: 'draft', personaId: 'b' });
  });

  it('keeps text and target settings keyed independently by persona and connection without migrating ambiguous remote drafts', () => {
    expect(personaDailyDraftKey('local', 'a')).toBe('daily:a');
    const pairs = [['local', 'a'], ['local', 'b'], ['ssh:fixture', 'a'], ['ssh:other', 'a'], ['direct:http://example.test', 'a']];
    expect(new Set(pairs.map(([scopeId, id]) => personaDailyDraftKey(scopeId!, id!))).size).toBe(5);
    expect(new Set(pairs.map(([scopeId, id]) => personaDailySettingsKey(scopeId!, id!))).size).toBe(5);
  });

  it('starts same-role project A/B conversations with separate workspace targets and no daily claim', () => {
    expect(personaNewConversationUrl('a', 'project-a')).toBe('/new?persona=a&workspace=project-a');
    expect(personaNewConversationUrl('a', 'project-b')).toBe('/new?persona=a&workspace=project-b');
    expect(personaNewConversationUrl('a')).toBe('/new?persona=a');
    const parsed = new URL(personaNewConversationUrl('a', 'project a&b'), 'http://example.test');
    expect(parsed.searchParams.get('workspace')).toBe('project a&b');
    expect(parsed.searchParams.has('daily')).toBe(false);
  });
});


describe('daily route rendering boundary', () => {
  async function mountRoute() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container); mounted.push({ root, container, queryClient });
    await act(async () => { root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(I18nProvider, null, createElement(PersonaDailyRoute)))); });
  }

  it.each(['loading', 'error', 'missing'] as const)('does not publish a daily draft while the directory is %s', async (status) => {
    route.isLoading = status === 'loading'; route.isError = status === 'error';
    await mountRoute(); expect(draftPage).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });

  it('opens old home rather than rendering another draft and uses replace navigation', async () => {
    route.data = [{ id: 'a', name: 'A', revision: 'revision-1', archived: false, homeSessionId: 'old-bot-home' }];
    await mountRoute(); expect(draftPage).not.toHaveBeenCalled(); expect(navigate).toHaveBeenCalledWith('/s/old-bot-home', { replace: true });
  });
});


describe('daily target/settings isolation', () => {
  const workspaces = ['project-a', 'project-b'].map((id) => ({ id, name: id, root: `/fixture/${id}`, created_at: '2026-10-01T00:00:00Z', last_opened_at: '2026-10-02T00:00:00Z', pinned: false, session_count: 0 }));
  it('does not copy A\'s chosen workspace into B\'s daily draft and restores A\'s explicit target', async () => {
    client.listWorkspaces.mockResolvedValue({ items: workspaces });
    const a = await mountDraft('a');
    await act(async () => { a().selectWorkspace('project-a'); }); await unmountDrafts();
    const b = await mountDraft('b');
    expect(b().workspaceId).not.toBe('project-a');
    await act(async () => { b().selectWorkspace('project-b'); }); await unmountDrafts();
    const restoredA = await mountDraft('a'); expect(restoredA().workspaceId).toBe('project-a');
  });

  it('lets the persona default determine a fresh daily target instead of silently sending to the most recent registered project', async () => {
    client.listWorkspaces.mockResolvedValue({ items: workspaces });
    const current = await mountDraft('a');
    await act(async () => { await current().send('first message', []); });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ persona: 'a', persona_home: true }));
    expect(client.createSession.mock.calls[0]?.[0]?.workspace_id).toBeUndefined();
  });
});


it('does not apply a stale persona read after a newer draft selection has completed', async () => {
  const current = await mountDraft('a', false);
  let resolveB!: (value: unknown) => void;
  let resolveC!: (value: unknown) => void;
  client.getPersona.mockImplementation((id: string) => new Promise((resolve) => {
    if (id === 'b') resolveB = resolve;
    if (id === 'c') resolveC = resolve;
  }));
  await act(async () => { current().selectPersona('b'); current().selectPersona('c'); });
  await act(async () => { resolveC({ definition: { id: 'c', name: 'C', description: 'Fixture C' }, revision: 'revision-c' }); });
  expect(current().persona?.definition.id).toBe('c');
  await act(async () => { resolveB({ definition: { id: 'b', name: 'B', description: 'Fixture B' }, revision: 'revision-b' }); });
  expect(current().persona?.definition.id).toBe('c');
});
