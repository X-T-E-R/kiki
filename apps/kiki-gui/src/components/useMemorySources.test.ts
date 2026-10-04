// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonaSnapshot, PersonaSummary, Session, Workspace } from '@kiki/protocol';
import { I18nProvider } from '../i18n';
import { KikiClient, type MemorySettings, type MemoryTarget } from '../lib/client';
import { memoryTargetKey } from './persona/PersonaMemoryScope';
import { memorySourceTargets, useMemorySources } from './useMemorySources';

const listBots = vi.hoisted(() => vi.fn(async () => [] as { personaId: string; name: string; homeSessionId: string }[]));
vi.mock('../lib/botRooms', () => ({ BOTS_QUERY_KEY: ['bots'], useBotRoomApi: () => ({ listBots }) }));
const client = new KikiClient({ baseUrl: 'http://example.test', token: 'example-token' });
vi.mock('../state/connection', () => ({ useConnection: () => ({ client }) }));
const mounted: { root: Root; container: HTMLDivElement; queryClient: QueryClient }[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => {
  localStorage.setItem('kiki.locale', 'en');
  listBots.mockReset().mockResolvedValue([{ personaId: 'persona-example', name: 'Example Bot', homeSessionId: 'session-home' }]);
  vi.spyOn(client, 'getPersona').mockResolvedValue({
    definition: { id: 'persona-example', name: 'Example persona', description: 'Example memory policy', memory: { shared: ['global', 'workspace'] } },
    revision: 'revision-example', examples: '',
  } satisfies PersonaSnapshot);
  vi.spyOn(client, 'getSession').mockResolvedValue({ id: 'session-home', workspace_id: 'bot-home' } as Session);
});
afterEach(async () => {
  for (const { root, container, queryClient } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
    queryClient.clear();
    container.remove();
  }
  vi.restoreAllMocks();
  localStorage.clear();
});

// Only enablement and workspace overrides affect the display composition.
const settings = { enabled: true, workspaces: {} } as MemorySettings;
const targetKeys = (targets: readonly MemoryTarget[]) => targets.map(memoryTargetKey);

describe('memorySourceTargets', () => {
  it.each([undefined, 'bot-home'])('keeps persona long-term memory free of workspace slices with bot home %s', (botWorkspaceId) => {
    expect(targetKeys(memorySourceTargets(undefined, 'persona-example', botWorkspaceId, settings, [])))
      .toEqual(['persona:persona-example']);
  });

  it('adds only the selected persona workspace slice when it differs from the bot home', () => {
    expect(targetKeys(memorySourceTargets('project', 'persona-example', 'bot-home', settings, [])))
      .toEqual(['persona:persona-example', 'workspace:project/persona:persona-example']);
  });

  it('does not duplicate the persona workspace slice when it is also the bot home', () => {
    expect(targetKeys(memorySourceTargets('bot-home', 'persona-example', 'bot-home', settings, [])))
      .toEqual(['persona:persona-example', 'workspace:bot-home/persona:persona-example']);
  });

  describe.each([
    { name: 'long-term', workspaceId: undefined, effectiveWorkspace: 'bot-home', ownKeys: ['persona:persona-example'] },
    { name: 'project', workspaceId: 'project', effectiveWorkspace: 'project', ownKeys: ['persona:persona-example', 'workspace:project/persona:persona-example'] },
  ])('persona shared projections in $name memory', ({ workspaceId, effectiveWorkspace, ownKeys }) => {
    it('places global and effective-workspace sharing before own memory', () => {
      expect(targetKeys(memorySourceTargets(workspaceId, 'persona-example', 'bot-home', settings, ['global', 'workspace'])))
        .toEqual(['global', `workspace:${effectiveWorkspace}`, ...ownKeys]);
    });

    it('projects only global sharing when workspace sharing is absent', () => {
      expect(targetKeys(memorySourceTargets(workspaceId, 'persona-example', 'bot-home', settings, ['global'])))
        .toEqual(['global', ...ownKeys]);
    });

    it('projects no shared sources for an empty sharing list', () => {
      expect(targetKeys(memorySourceTargets(workspaceId, 'persona-example', 'bot-home', settings, [])))
        .toEqual(ownKeys);
    });
  });

  it('defaults persona sharing to global and the effective workspace without adding a bot-home persona slice', () => {
    expect(targetKeys(memorySourceTargets(undefined, 'persona-example', 'bot-home', settings)))
      .toEqual(['global', 'workspace:bot-home', 'persona:persona-example']);
  });

  it('omits workspace sharing when neither a workspace nor a bot home is available', () => {
    expect(targetKeys(memorySourceTargets(undefined, 'persona-example', undefined, settings, ['global', 'workspace'])))
      .toEqual(['global', 'persona:persona-example']);
  });

  it('returns only global memory without a persona or workspace', () => {
    expect(targetKeys(memorySourceTargets(undefined, undefined, undefined, settings)))
      .toEqual(['global']);
  });

  it('preserves global sharing before workspace memory when the workspace follows global enablement', () => {
    expect(targetKeys(memorySourceTargets('project', undefined, undefined, settings)))
      .toEqual(['global', 'workspace:project']);
  });

  it.each([true, false])('does not project global memory for an explicit workspace override of %s', (enabled) => {
    expect(targetKeys(memorySourceTargets('project', undefined, undefined, { ...settings, workspaces: { project: enabled } })))
      .toEqual(['workspace:project']);
  });

  it.each([undefined, { ...settings, enabled: false }])('keeps workspace-owned memory without projecting global when settings are unavailable or disabled', (currentSettings) => {
    expect(targetKeys(memorySourceTargets('project', undefined, undefined, currentSettings)))
      .toEqual(['workspace:project']);
  });

  it('does not let another workspace override change the selected workspace sources', () => {
    expect(targetKeys(memorySourceTargets('project', undefined, undefined, { ...settings, workspaces: { other: false } })))
      .toEqual(['global', 'workspace:project']);
  });

  it.each([true, false])('keeps persona sharing policy separate from global enablement %s and workspace overrides', (enabled) => {
    expect(targetKeys(memorySourceTargets('project', 'persona-example', 'bot-home', {
      ...settings, enabled, workspaces: { project: false, 'bot-home': true },
    }, ['workspace', 'global', 'workspace', 'global'])))
      .toEqual(['global', 'workspace:project', 'persona:persona-example', 'workspace:project/persona:persona-example']);
  });

  it('supports workspace-only persona sharing without adding global or a bot-home slice', () => {
    expect(targetKeys(memorySourceTargets('project', 'persona-example', 'bot-home', settings, ['workspace'])))
      .toEqual(['workspace:project', 'persona:persona-example', 'workspace:project/persona:persona-example']);
  });
});

const persona = { id: 'persona-example', name: 'Example persona', archived: false, revision: 'revision-example' } satisfies PersonaSummary;
const project = { id: 'project', name: 'Example project', root: '/fixture/project', created_at: '2026-01-01', last_opened_at: '2026-01-01', session_count: 0, pinned: false, isGit: false } satisfies Workspace;

async function flushSources() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function renderSources(workspaceId: string | undefined, workspaces: readonly Workspace[] = [project], workspacesLoading = false, workspacesError: Error | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container, queryClient });
  let latest!: ReturnType<typeof useMemorySources>;
  function Probe() {
    latest = useMemorySources({ workspaceId, workspaces, workspacesLoading, workspacesError, persona, settings });
    return null;
  }
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(I18nProvider, { children: createElement(Probe) })));
  });
  await flushSources();
  return () => latest;
}

const sourceTargetKeys = (snapshot: ReturnType<typeof useMemorySources>) => targetKeys(snapshot.sources.map((source) => source.target));

describe('useMemorySources persona range validation', () => {
  it.each([
    { workspaceId: undefined, workspaces: [project], expected: ['global', 'workspace:bot-home', 'persona:persona-example'] },
    { workspaceId: 'project', workspaces: [project], expected: ['global', 'workspace:project', 'persona:persona-example', 'workspace:project/persona:persona-example'] },
    { workspaceId: 'bot-home', workspaces: [], expected: ['global', 'workspace:bot-home', 'persona:persona-example', 'workspace:bot-home/persona:persona-example'] },
    { workspaceId: 'wd_removed', workspaces: [project], expected: ['global', 'workspace:bot-home', 'persona:persona-example'] },
    { workspaceId: 'garbage-range', workspaces: [], expected: ['global', 'workspace:bot-home', 'persona:persona-example'] },
  ])('projects only a known project or the current Bot home for $workspaceId', async ({ workspaceId, workspaces, expected }) => {
    const snapshot = await renderSources(workspaceId, workspaces);
    expect(snapshot().loading).toBe(false);
    expect(snapshot().error).toBeNull();
    expect(sourceTargetKeys(snapshot())).toEqual(expected);
  });

  it('falls back to long-term without workspace sharing when the persona has no Bot home', async () => {
    listBots.mockResolvedValue([]);
    const snapshot = await renderSources('wd_removed');
    expect(snapshot().loading).toBe(false);
    expect(sourceTargetKeys(snapshot())).toEqual(['global', 'persona:persona-example']);
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it('does not accept another persona’s Bot home as this persona’s range', async () => {
    listBots.mockResolvedValue([{ personaId: 'other-persona', name: 'Other Bot', homeSessionId: 'session-other' }]);
    const snapshot = await renderSources('bot-home', []);
    expect(sourceTargetKeys(snapshot())).toEqual(['global', 'persona:persona-example']);
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it('keeps the range loading until an out-of-directory Bot home is resolved', async () => {
    let resolveHome!: (session: Session) => void;
    vi.mocked(client.getSession).mockReturnValue(new Promise((resolve) => { resolveHome = resolve; }));
    const snapshot = await renderSources('bot-home', []);
    expect(snapshot().loading).toBe(true);
    await act(async () => { resolveHome({ id: 'session-home', workspace_id: 'bot-home' } as Session); });
    await flushSources();
    expect(snapshot().loading).toBe(false);
    expect(sourceTargetKeys(snapshot())).toEqual(['global', 'workspace:bot-home', 'persona:persona-example', 'workspace:bot-home/persona:persona-example']);
  });
});

describe('useMemorySources pending directory contract', () => {
  it('exposes no fallback sources while the requested range is still unverified', async () => {
    const snapshot = await renderSources('project', [], true);
    expect(snapshot().loading).toBe(true);
    expect(snapshot().rangeLoading).toBe(true);
    expect(snapshot().effectiveWorkspaceId).toBeUndefined();
    expect(sourceTargetKeys(snapshot())).toEqual([]);
  });

  it('exposes an error instead of accepting the fallback after a directory failure', async () => {
    const error = new Error('Workspace directory unavailable');
    const snapshot = await renderSources('project', [], false, error);
    expect(snapshot().loading).toBe(false);
    expect(snapshot().rangeError).toBe(error);
    expect(snapshot().error).toBe(error);
    expect(sourceTargetKeys(snapshot())).toEqual([]);
  });

  it.each([
    { workspaceId: undefined, workspaces: [] },
    { workspaceId: 'project', workspaces: [project] },
    { workspaceId: 'bot-home', workspaces: [] },
  ])('does not wait on an unrelated directory for validated range $workspaceId', async ({ workspaceId, workspaces }) => {
    const snapshot = await renderSources(workspaceId, workspaces, true, new Error('Unrelated directory failure'));
    expect(snapshot().loading).toBe(false);
    expect(snapshot().error).toBeNull();
    expect(snapshot().effectiveWorkspaceId).toBe(workspaceId);
    expect(sourceTargetKeys(snapshot())).toContain('persona:persona-example');
  });
});
