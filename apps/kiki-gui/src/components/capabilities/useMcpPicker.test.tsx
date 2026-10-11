// @vitest-environment jsdom

/**
 * A conversation's MCP write belongs to the conversation that sent it.
 *
 * The composer mount survives session switches, and a pending mutation picks up
 * the callbacks of the latest render: without an identity travelling with the
 * request, a reply for A would update B's row, B's busy flag and B's failure.
 * These cases pin the identity at the send, for the success and the refusal.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { McpServerLocator, McpSessionCapability } from '@kiki/klient';

import { I18nProvider } from '../../i18n';
import { useMcpPicker } from './useMcpPicker';

const surface = vi.hoisted(() => {
  const state = {
    sessionId: 'session-a',
    scopeId: 'scope-a',
    spaceKey: 'space-a',
    connectionId: null as string | null,
    client: undefined as unknown as { klient: unknown },
    list: vi.fn(),
    write: vi.fn(),
  };
  state.client = {
    klient: {
      session: (id: string) => ({
        agent: () => ({
          listMcpSessionCapabilities: () => state.list(id),
          setMcpSessionOverride: (input: { locator: McpServerLocator; override: string }) => state.write(id, input),
          getMcpServers: async () => [],
        }),
      }),
      global: { mcp: { list: async () => [] } },
    },
  };
  return state;
});
const initialClient = surface.client;

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    scopeId: surface.scopeId,
    spaceKey: surface.spaceKey,
    connectionId: surface.connectionId,
    client: surface.client,
  }),
}));

const LOCATOR: McpServerLocator = { source: 'global', name: 'files' };

const capability = (overrides: Partial<McpSessionCapability> = {}): McpSessionCapability => ({
  locator: LOCATOR,
  runtimeName: 'files',
  origin: 'global',
  config: { transport: 'stdio', command: 'npx', enabled: true },
  authStatus: 'not-applicable',
  connection: 'connected',
  override: 'inherit',
  ...overrides,
});

type Picker = ReturnType<typeof useMcpPicker>;

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
  vi.clearAllMocks();
  surface.sessionId = 'session-a';
  surface.scopeId = 'scope-a';
  surface.spaceKey = 'space-a';
  surface.connectionId = null;
  surface.client = initialClient;
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

/** The picker's current answer, captured on every render. */
let picker: Picker | undefined;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * One mount, rendered again per switch: the composer's own lifetime, which is
 * what makes a reply land on a render that is no longer the request's.
 */
function harness(queryClient: QueryClient): () => Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  return async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <Host />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
    await settle();
  };
}

function Host() {
  picker = useMcpPicker(surface.sessionId);
  return <span data-picker>{picker.items.map((row) => `${row.name}:${row.connection}`).join(',')}</span>;
}

function rowsFor(
  queryClient: QueryClient,
  session: string,
  connectionKey = `${surface.scopeId}:${surface.spaceKey}:${surface.connectionId ?? ''}`,
): readonly McpSessionCapability[] {
  const data = queryClient.getQueryData<{ readonly capabilities?: readonly McpSessionCapability[] }>(
    ['session-mcp-capabilities', connectionKey, session],
  );
  return data?.capabilities ?? [];
}

describe('an MCP write that outlives its conversation', () => {
  it('records the answer in the conversation that sent it, not the one on screen', async () => {
    const deferred = (() => {
      let resolve!: (value: McpSessionCapability) => void;
      const promise = new Promise<McpSessionCapability>((next) => { resolve = next; });
      return { promise, resolve };
    })();
    surface.list.mockResolvedValue([capability()]);
    surface.write.mockReturnValue(deferred.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const render = harness(queryClient);
    await render();

    // The user turns the server off here, and leaves before the engine answers.
    await act(async () => { picker!.setOverride(LOCATOR, 'off', 'files'); });
    expect(picker?.busyName).toBe('files');
    surface.sessionId = 'session-b';
    await render();
    expect(picker?.busyName).toBeUndefined();

    await act(async () => { deferred.resolve(capability({ override: 'off', connection: 'disabled' })); });
    await settle();

    // A's own record moved; B's row is exactly what B's engine said.
    expect(rowsFor(queryClient, 'session-a')[0]?.override).toBe('off');
    expect(rowsFor(queryClient, 'session-b')[0]?.override).toBe('inherit');
    expect(rowsFor(queryClient, 'session-b')[0]?.connection).toBe('connected');
    expect(picker?.items[0]?.connection).toBe('connected');
  });

  it('does not report a refusal in a conversation that did not send it', async () => {
    const deferred = (() => {
      let reject!: (reason: Error) => void;
      const promise = new Promise<McpSessionCapability>((_next, fail) => { reject = fail; });
      return { promise, reject };
    })();
    surface.list.mockResolvedValue([capability()]);
    surface.write.mockReturnValue(deferred.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const render = harness(queryClient);
    await render();

    await act(async () => { picker!.setOverride(LOCATOR, 'off', 'files'); });
    surface.sessionId = 'session-b';
    await render();

    await act(async () => { deferred.reject(new Error('the engine refused the write')); });
    await settle();

    expect(picker?.failure).toBeUndefined();
    expect(picker?.busyName).toBeUndefined();

    // Back in A, the refusal is the one reported — it happened here.
    surface.sessionId = 'session-a';
    await render();
    expect(picker?.failure?.name).toBe('files');
    expect(picker?.failure?.message).toContain('the engine refused the write');
  });

  it('keeps a same-session late success on the original connection cache', async () => {
    const deferred = (() => {
      let resolve!: (value: McpSessionCapability) => void;
      const promise = new Promise<McpSessionCapability>((next) => { resolve = next; });
      return { promise, resolve };
    })();
    surface.list.mockResolvedValue([capability()]);
    surface.write.mockReturnValue(deferred.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const render = harness(queryClient);
    await render();
    const originalKey = 'scope-a:space-a:';

    await act(async () => { picker!.setOverride(LOCATOR, 'off', 'files'); });
    surface.scopeId = 'scope-b';
    surface.spaceKey = 'space-b';
    surface.connectionId = 'remote-b';
    surface.client = { klient: (initialClient as { klient: unknown }).klient };
    await render();
    expect(picker?.busyName).toBeUndefined();

    await act(async () => { deferred.resolve(capability({ override: 'off', connection: 'disabled' })); });
    await settle();

    expect(rowsFor(queryClient, 'session-a', originalKey)[0]?.override).toBe('off');
    expect(rowsFor(queryClient, 'session-a')[0]?.override).toBe('inherit');
    expect(picker?.items[0]?.override).toBe('inherit');
  });

  it('does not surface a same-session late refusal on a replacement connection', async () => {
    const deferred = (() => {
      let reject!: (reason: Error) => void;
      const promise = new Promise<McpSessionCapability>((_next, fail) => { reject = fail; });
      return { promise, reject };
    })();
    surface.list.mockResolvedValue([capability()]);
    surface.write.mockReturnValue(deferred.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const render = harness(queryClient);
    await render();
    await act(async () => { picker!.setOverride(LOCATOR, 'off', 'files'); });

    surface.scopeId = 'scope-b';
    surface.spaceKey = 'space-b';
    surface.connectionId = 'remote-b';
    surface.client = { klient: (initialClient as { klient: unknown }).klient };
    await render();
    await act(async () => { deferred.reject(new Error('the old host refused the write')); });
    await settle();

    expect(picker?.failure).toBeUndefined();
    expect(picker?.busyName).toBeUndefined();
    surface.scopeId = 'scope-a';
    surface.spaceKey = 'space-a';
    surface.connectionId = null;
    surface.client = initialClient;
    await render();
    expect(picker?.failure?.message).toContain('the old host refused the write');
  });
});
