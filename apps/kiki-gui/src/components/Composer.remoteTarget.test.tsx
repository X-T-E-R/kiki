// @vitest-environment jsdom

/**
 * The composer's target line: a message typed inside a remote space is
 * delivered on another machine's home, so the card says where it goes. A local
 * space says nothing — the line is there for the case that would otherwise be
 * invisible, not as a permanent banner.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONNECTION_PROTOCOL } from '@kiki/protocol';
import { writeSettings } from '@kiki/session-core/settings';
import { I18nProvider } from '../i18n';
import { Composer } from './Composer';

const listModels = vi.fn();
const listConnections = vi.fn();
const connection = { connectionId: null as string | null };

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    connectionId: connection.connectionId,
    localClient: { klient: { rest: { connections: { list: listConnections } } } },
    client: {
      listModels,
      listSessionSkills: vi.fn().mockResolvedValue({ skills: [] }),
      listWorkspaceSkills: vi.fn().mockResolvedValue({ skills: [] }),
      listNamedAgentProfiles: vi.fn().mockResolvedValue({ items: [] }),
      uploadFile: vi.fn(),
    },
  }),
}));
vi.mock('../host', () => ({ useHost: () => ({ kind: 'tauri' }) }));
vi.mock('../host/vscode', () => ({ isVscodeWebview: () => false, vscodeHost: {} }));

const REMOTE_ID = '2b6c3f1a-7d2e-4b3f-8c4f-3a1b2c3d4e50';

function record(label: string) {
  return {
    id: REMOTE_ID, label, endpoint: 'https://acme.test',
    target: { homeId: '1a5b2f0e-6c1d-4a2f-9b3e-2f0c1d2e3f40', hostId: 'acme-box', protocol: CONNECTION_PROTOCOL },
    credentialRef: 'cred-1', enabled: true, backgroundSummary: false, purposes: ['gui'],
    state: 'online', activeLeases: 0,
  };
}

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  writeSettings({ sendShortcut: 'enter' });
  connection.connectionId = null;
  listConnections.mockReset().mockResolvedValue([record('ACME')]);
  listModels.mockReset().mockResolvedValue({ items: [{ id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', max_context_size: 128000 }] });
});
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function renderComposer() {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <MemoryRouter>
            <Composer
              busy={false} disabled={false} value="" onChange={() => {}}
              model={undefined} defaultModel={undefined} serverDefaultModel="fixture/kiki-pro"
              modelSource="server-default" agentProfileCatalogMode={{ mode: 'global' }}
              permissionMode="manual" planMode={false} efforts={undefined} effort={undefined}
              attachments={[]} onChangeAttachments={() => {}} onChangeModel={() => {}}
              onChangePermissionMode={() => {}} onChangePlanMode={() => {}} onChangeEffort={() => {}}
              onSend={() => {}}
            />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  return container;
}

const target = (container: HTMLElement) => container.querySelector('[data-composer-remote-target]');

describe('Composer target in a remote space', () => {
  it('says nothing in a local space', async () => {
    const container = await renderComposer();
    expect(target(container)).toBeNull();
  });

  it('names the space a message would be delivered to', async () => {
    connection.connectionId = REMOTE_ID;
    const container = await renderComposer();
    await act(async () => { await Promise.resolve(); });
    expect(target(container)?.textContent).toContain('ACME');
  });

  it('falls back to the address when the record has no label of its own', async () => {
    connection.connectionId = REMOTE_ID;
    listConnections.mockResolvedValue([record('   ')]);
    const container = await renderComposer();
    await act(async () => { await Promise.resolve(); });
    expect(target(container)?.textContent).toContain('https://acme.test');
  });

  it('says nothing while the remote record has not been read yet', async () => {
    connection.connectionId = REMOTE_ID;
    listConnections.mockReturnValue(new Promise(() => { }));
    const container = await renderComposer();
    await act(async () => { await Promise.resolve(); });
    expect(target(container)).toBeNull();
  });
});
