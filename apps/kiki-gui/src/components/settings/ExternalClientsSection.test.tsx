// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExternalClientConnection, ExternalClientListener } from '@kiki/klient';
import { I18nProvider } from '../../i18n';
import { listenerReadiness, readExternalClientMark } from '../../lib/externalClients';
import { ExternalClientsSection, policyChangeOf } from './ExternalClientsSection';

const HOUR = 3_600_000;

const chatgpt: ExternalClientConnection = {
  id: 'conn_chatgpt', name: 'ChatGPT', workspace: 'C:/Users/you/Projects/kiki',
  mode: 'auto', tools: ['Read', 'Write', 'kiki_save_text'], allowCommands: false,
  memoryScopes: ['workspace'], historyScope: 'current', status: 'active',
  createdAt: Date.now() - 6 * HOUR, updatedAt: Date.now() - 20 * 60_000,
};
const desktop: ExternalClientConnection = {
  id: 'conn_desktop', name: 'Desktop MCP', workspace: 'C:/Users/you/Projects/kiki',
  mode: 'review', tools: ['Read', 'Glob', 'Grep'], allowCommands: true,
  memoryScopes: ['workspace', 'global'], historyScope: 'connection', status: 'paused',
  createdAt: Date.now() - 3 * HOUR, updatedAt: Date.now() - 40 * 60_000,
};
const revoked: ExternalClientConnection = {
  ...chatgpt, id: 'conn_old', name: 'Old client', status: 'revoked', updatedAt: Date.now() - 40 * HOUR,
};

const stopped: ExternalClientListener = { enabled: false, state: 'stopped' };
const reachable: ExternalClientListener = {
  enabled: true, state: 'listening', origin: '127.0.0.1:59412',
  mcpUrl: 'https://mcp.example.test/mcp', publicUrl: 'https://mcp.example.test', discovery: 'reachable',
};

const { client, facade } = vi.hoisted(() => {
  const facade = {
    list: vi.fn(), create: vi.fn(), update: vi.fn(), revoke: vi.fn(), sessions: vi.fn(),
    stdio: vi.fn(), listener: vi.fn(), configureListener: vi.fn(), authorizations: vi.fn(),
    respondAuthorization: vi.fn(), saveText: vi.fn(), continue: vi.fn(),
    closeSession: vi.fn(), stopSession: vi.fn(),
  };
  return { facade, client: { klient: { rest: { externalClients: facade } } } };
});
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));

let root: Root;
let container: HTMLDivElement;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  facade.list.mockResolvedValue({ connections: [chatgpt], listener: stopped });
  facade.authorizations.mockResolvedValue({ authorizations: [] });
  facade.stdio.mockResolvedValue({ command: 'kiki', args: ['mcp', '--client', 'conn_chatgpt', '--tools'] });
  facade.sessions.mockResolvedValue({ sessions: [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

/** Where the router ended up, so a click can be checked against a real path. */
let landedAt = '';
function RouteProbe() {
  const location = useLocation();
  landedAt = location.pathname;
  return null;
}

async function render() {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(
    <MemoryRouter>
      <QueryClientProvider client={queries}>
        <I18nProvider><ExternalClientsSection /><RouteProbe /></I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  ));
  await settle();
}

const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-xc-row]')];
/** The single row under test; every case below renders exactly one. */
const firstRow = (): HTMLElement => {
  const found = rows()[0];
  if (found === undefined) throw new Error('expected one connection row');
  return found;
};

describe('external clients settings panel', () => {
  it('names the section as the reverse of external engines, not as another engine', async () => {
    await render();
    const card = container.querySelector('[data-settings-card="st-card-external-clients"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('External clients');
    // The panel must not borrow the engine vocabulary: a client is authorized,
    // not signed in, and nothing here is installed or versioned.
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/install hint|sign in to|executor|binary|not found|never checked/i);
  });

  it('states the four grant facts for a connection, and its real status word', async () => {
    await render();
    expect(rows()).toHaveLength(1);
    const row = firstRow();
    expect(row.dataset['xcStatus']).toBe('active');
    // The summary carries workspace and effective mode without opening the row.
    expect(row.querySelector('[data-xc-summary]')?.textContent).toContain('C:/Users/you/Projects/kiki');
    (row.querySelector('summary') as HTMLElement).click();
    await settle();
    for (const fact of ['workspace', 'mode', 'tools', 'commands', 'history']) {
      expect(row.querySelector(`[data-xc-fact="${fact}"]`)).not.toBeNull();
    }
    // Host commands are off, and the row says so in words rather than by colour.
    expect(row.querySelector('[data-xc-fact="commands"]')?.textContent).toContain('Not allowed');
    expect(row.querySelector('[data-xc-fact="commands"]')?.textContent).not.toContain('can run shell commands');
  });

  it('says a command grant plainly when it is on, instead of only colouring it', async () => {
    facade.list.mockResolvedValue({ connections: [desktop], listener: stopped });
    await render();
    const row = firstRow();
    (row.querySelector('summary') as HTMLElement).click();
    await settle();
    expect(row.dataset['xcStatus']).toBe('paused');
    expect(row.querySelector('[data-xc-fact="commands"]')?.textContent).toContain('can run shell commands as you');
    // Paused keeps the records, so the row says what pausing did rather than
    // leaving the reader to infer it from the dot.
    expect(row.querySelector('[data-xc-paused]')?.textContent).toContain('saved text stay');
  });

  it('keeps a revoked connection readable and offers no way to bring it back', async () => {
    facade.list.mockResolvedValue({ connections: [revoked], listener: stopped });
    await render();
    const row = firstRow();
    expect(row.dataset['xcStatus']).toBe('revoked');
    (row.querySelector('summary') as HTMLElement).click();
    await settle();
    expect(row.querySelector('[data-xc-revoked]')?.textContent).toContain('can no longer reach Kiki');
    expect(row.querySelector('[data-xc-revoke]')).toBeNull();
    expect(row.querySelector('[data-xc-pause]')).toBeNull();
    expect(row.querySelector('[data-xc-edit]')).toBeNull();
  });

  it('shows a local client its copyable native config and no tunnel', async () => {
    await render();
    const row = firstRow();
    (row.querySelector('summary') as HTMLElement).click();
    await settle();
    const config = row.querySelector('[data-xc-local-config] code')?.textContent;
    expect(config).toBe('kiki mcp --client conn_chatgpt --tools');
    // The stdio path needs no public address, so it must not demand one.
    expect(row.querySelector('[data-xc-remote-missing]')).toBeNull();
    expect(facade.configureListener).not.toHaveBeenCalled();
  });

  it('shows the config the server returned, and adds no credential of its own', async () => {
    await render();
    const row = firstRow();
    (row.querySelector('summary') as HTMLElement).click();
    await settle();
    // Whatever the facade returned is what gets pasted: the panel never
    // rewrites it, and never splices an owner token or a signed URL in.
    const config = row.querySelector('[data-xc-local-config] code')?.textContent ?? '';
    expect(config).toBe('kiki mcp --client conn_chatgpt --tools');
    expect(row.textContent ?? '').not.toMatch(/server\.token|owner token|bearer|authorization:/i);
    // The connection id is a name, not a credential, and the copy says so.
    expect(row.textContent).toContain('knowing the connection id is not access');
  });

  it('separates a bound listener from a reachable one', async () => {
    facade.list.mockResolvedValue({ connections: [], listener: { enabled: true, state: 'listening', origin: '127.0.0.1:59412', discovery: 'unchecked' } });
    await render();
    const listener = container.querySelector('[data-xc-listener]') as HTMLElement;
    expect(listener.dataset['xcReadiness']).toBe('bound');
    expect(listener.textContent).toContain('Nothing has checked whether a client can reach it');
  });

  it('does not read a tunnel reporting ready as a reachable public address', () => {
    // A connector that is merely up is not a fact this panel can observe, so
    // readiness must stay `off` when the listener is stopped.
    expect(listenerReadiness({ enabled: false, state: 'stopped' })).toBe('off');
    expect(listenerReadiness({ enabled: true, state: 'listening', discovery: 'reachable' })).toBe('reachable');
    expect(listenerReadiness({ enabled: true, state: 'listening', discovery: 'failed' })).toBe('unreachable');
    expect(listenerReadiness({ enabled: true, state: 'error' })).toBe('failed');
  });

  it('offers a remote client the address, the client-side step and the official help', async () => {
    facade.list.mockResolvedValue({ connections: [], listener: reachable });
    await render();
    expect(container.querySelector('[data-xc-remote-url] code')?.textContent).toBe('https://mcp.example.test/mcp');
    const help = container.querySelector('[data-xc-remote-help]') as HTMLAnchorElement;
    expect(help.href).toContain('developers.openai.com');
    // A write-capability limit belongs to the client, so the copy points at the
    // client's own rule instead of promising anything about an account tier.
    expect(container.textContent).not.toMatch(/\b(Plus|Pro|Business|Enterprise)\b/);
  });

  it('requires https for a public address and refuses it in place', async () => {
    facade.list.mockResolvedValue({ connections: [], listener: stopped });
    await render();
    const input = container.querySelector('[data-xc-public-url]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'http://mcp.example.test');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    (container.querySelector('[data-xc-public-url-save]') as HTMLElement).click();
    await settle();
    expect(facade.configureListener).not.toHaveBeenCalled();
    expect(container.textContent).toContain('must start with https://');
  });

  it('confirms a revoke with its consequence and the object it names', async () => {
    await render();
    const row = firstRow();
    (row.querySelector('summary') as HTMLElement).click();
    await settle();
    (row.querySelector('[data-xc-revoke]') as HTMLElement).click();
    await settle();
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Revoke “ChatGPT”?');
    expect(dialog.textContent).toContain('cannot be undone');
    expect(dialog.textContent).toContain('sub agents');
    expect(facade.revoke).not.toHaveBeenCalled();
  });

  it('pauses through the same connection object rather than deleting it', async () => {
    await render();
    const row = firstRow();
    (row.querySelector('summary') as HTMLElement).click();
    await settle();
    (row.querySelector('[data-xc-pause]') as HTMLElement).click();
    await settle();
    // Pausing narrows access, so it asks before it stops anything in flight.
    (document.querySelector('[data-confirm-action="confirm"]') as HTMLElement).click();
    await settle();
    expect(facade.update).toHaveBeenCalledWith('conn_chatgpt', { enabled: false });
    expect(facade.revoke).not.toHaveBeenCalled();
  });

  it('shows an empty list as an offer rather than a diagnostic wall', async () => {
    facade.list.mockResolvedValue({ connections: [], listener: stopped });
    await render();
    const empty = container.querySelector('[data-xc-empty]') as HTMLElement;
    expect(empty.textContent).toContain('Add a connection');
    expect(empty.textContent).not.toMatch(/diagnostic|code:|error \d/i);
  });

  it('says what failed and what is unchanged, instead of an empty table', async () => {
    facade.list.mockRejectedValue(new Error('404 not found'));
    await render();
    const failure = container.querySelector('[data-xc-load-error]') as HTMLElement;
    expect(failure.textContent).toContain('404 not found');
    expect(failure.textContent).toContain('older Kiki');
    expect(container.querySelector('[data-xc-empty]')).toBeNull();
  });

  it('creates the one authorization object whichever way the client connects', async () => {
    facade.list.mockResolvedValue({ connections: [], listener: stopped });
    await render();
    (container.querySelector('[data-xc-add]') as HTMLElement).click();
    await settle();
    (container.querySelector('[data-xc-access="remote"]') as HTMLElement).click();
    await settle();
    const name = container.querySelector('[data-xc-new-name]') as HTMLInputElement;
    const workspace = container.querySelector('[data-xc-new-workspace]') as HTMLInputElement;
    const set = async (el: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
      await settle();
    };
    await set(name, 'ChatGPT');
    await set(workspace, 'C:/Users/you/Projects/kiki');
    (container.querySelector('[data-xc-create-submit]') as HTMLElement).click();
    await settle();
    expect(facade.create).toHaveBeenCalledTimes(1);
    const body = facade.create.mock.calls[0]?.[0] as Record<string, unknown>;
    // The form opens on the server's own default, so the value sent is the one
    // that will actually be in effect.
    expect(body).toMatchObject({ name: 'ChatGPT', workspace: 'C:/Users/you/Projects/kiki', mode: 'manual' });
    // A create has nothing saved to compare against, so the whole grant
    // travels; the delta rule only applies once there is something to keep.
    expect(body['tools']).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'ReadMedia', 'AgentRun',
      'TaskList', 'TaskOutput', 'TaskStop', 'HistoryList', 'HistoryRead', 'HistorySearch', 'kiki_save_text']);
  });

  it('refuses to create a connection with no name, without calling the server', async () => {
    facade.list.mockResolvedValue({ connections: [], listener: stopped });
    await render();
    (container.querySelector('[data-xc-add]') as HTMLElement).click();
    await settle();
    (container.querySelector('[data-xc-create-submit]') as HTMLElement).click();
    await settle();
    expect(facade.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Give this connection a name');
  });

  it('sends only what the form changed, so a rename cannot look like a policy change', async () => {
    await render();
    const row = firstRow();
    (container.querySelector('[data-xc-row="conn_chatgpt"] summary') as HTMLElement).click();
    await settle();
    (row.querySelector('[data-xc-edit]') as HTMLElement).click();
    await settle();
    const name = row.querySelector('[data-xc-name]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(name, 'ChatGPT (work)');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    (row.querySelector('[data-xc-save]') as HTMLElement).click();
    await settle();
    expect(facade.update).toHaveBeenCalledTimes(1);
    // Only the name travels: the untouched policy fields would make the server
    // re-check values nobody edited.
    expect(facade.update).toHaveBeenCalledWith('conn_chatgpt', { name: 'ChatGPT (work)' });
  });

  it('saves an unchanged form without asking about cancelled work', async () => {
    await render();
    (container.querySelector('[data-xc-row="conn_chatgpt"] summary') as HTMLElement).click();
    await settle();
    const row = firstRow();
    (row.querySelector('[data-xc-edit]') as HTMLElement).click();
    await settle();
    (row.querySelector('[data-xc-save]') as HTMLElement).click();
    await settle();
    // Nothing changed, so there is nothing to confirm and nothing to send.
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(facade.update).toHaveBeenCalledWith('conn_chatgpt', {});
  });

  it('treats a reordered tool list as no change', () => {
    const saved = { ...chatgpt, tools: ['Read', 'Write'] };
    expect(policyChangeOf(saved, { tools: ['Write', 'Read'] })).toBe('none');
    expect(policyChangeOf(saved, { tools: ['Read', 'Write', 'Edit'] })).toBe('access');
    // A rename is not a policy change.
    expect(policyChangeOf(saved, { name: 'Renamed' })).toBe('none');
    expect(policyChangeOf(saved, { mode: 'yolo' })).toBe('access');
    expect(policyChangeOf(saved, { allowCommands: true })).toBe('access');
    expect(policyChangeOf(saved, { historyScope: 'workspace' })).toBe('access');
    expect(policyChangeOf(saved, { workspace: 'C:/elsewhere' })).toBe('access');
    expect(policyChangeOf(saved, { memoryScopes: ['global'] })).toBe('access');
  });

  it('counts a pause as a policy change, and a resume as the state change it is', () => {
    expect(policyChangeOf(chatgpt, { enabled: false })).toBe('pause');
    // A resume is a real transition on the connection, so it is classified
    // with the other state changes rather than guessed at as harmless.
    expect(policyChangeOf({ ...chatgpt, status: 'paused' }, { enabled: true })).toBe('pause');
    // It carries nothing else, so it never doubles as a re-grant.
    expect(policyChangeOf({ ...chatgpt, status: 'paused' }, { enabled: true, mode: 'auto' })).toBe('pause');
  });

  it('confirms a narrowing save once, naming what stops without inventing a count', async () => {
    await render();
    (container.querySelector('[data-xc-row="conn_chatgpt"] summary') as HTMLElement).click();
    await settle();
    const row = firstRow();
    (row.querySelector('[data-xc-edit]') as HTMLElement).click();
    await settle();
    const mode = row.querySelector('[data-xc-mode="yolo"]') as HTMLElement;
    (mode).click();
    await settle();
    (row.querySelector('[data-xc-save]') as HTMLElement).click();
    await settle();
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Change what this client may do?');
    expect(dialog.textContent).toContain('running right now is stopped');
    // The panel cannot know how much is in flight, so it must not claim zero.
    expect(dialog.textContent).not.toMatch(/\b0 (tasks|operations|agents)\b/i);
    expect(facade.update).not.toHaveBeenCalled();
    (dialog.querySelector('[data-confirm-action="confirm"]') as HTMLElement).click();
    await settle();
    expect(facade.update).toHaveBeenCalledWith('conn_chatgpt', { mode: 'yolo' });
  });

  it('confirms a pause for the same reason, and resumes without asking', async () => {
    await render();
    (container.querySelector('[data-xc-row="conn_chatgpt"] summary') as HTMLElement).click();
    await settle();
    (firstRow().querySelector('[data-xc-pause]') as HTMLElement).click();
    await settle();
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Pause this connection?');
    expect(dialog.textContent).toContain('can be resumed');
    expect(facade.update).not.toHaveBeenCalled();
    (dialog.querySelector('[data-confirm-action="confirm"]') as HTMLElement).click();
    await settle();
    expect(facade.update).toHaveBeenCalledWith('conn_chatgpt', { enabled: false });
    expect(facade.revoke).not.toHaveBeenCalled();
  });

  it('resumes without asking, because it stops nothing', async () => {
    facade.list.mockResolvedValue({ connections: [desktop], listener: stopped });
    await render();
    (container.querySelector('[data-xc-row="conn_desktop"] summary') as HTMLElement).click();
    await settle();
    (firstRow().querySelector('[data-xc-resume]') as HTMLElement).click();
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(facade.update).toHaveBeenCalledWith('conn_desktop', { enabled: true });
  });

  it('opens a session from the settings page without copying the session manager', async () => {
    facade.sessions.mockResolvedValue({
      sessions: [{
        sessionId: 'sess_ext_1', sessionRef: 'extref_1', connectionId: 'conn_chatgpt',
        clientName: 'ChatGPT', workspace: 'C:/Users/you/Projects/kiki', status: 'open',
        createdAt: Date.now() - HOUR, updatedAt: Date.now() - 5 * 60_000,
      }],
    });
    await render();
    const row = firstRow();
    (row.querySelector('summary') as HTMLElement).click();
    await settle();
    expect(row.querySelector('[data-xc-session="sess_ext_1"]')).not.toBeNull();
    // The link is the ordinary session route, not a second session surface.
    (row.querySelector('[data-xc-session-open]') as HTMLElement).click();
    await settle();
    // A path that misses `/s/:id` does not error — it falls through to the
    // session list, so the click reads as though nothing happened.
    expect(landedAt).toBe('/s/sess_ext_1');
  });

  it('lets a waiting client be answered here, which the tool catalog cannot do', async () => {
    facade.authorizations.mockResolvedValue({
      authorizations: [{ id: 'auth_1', clientId: 'conn_chatgpt', clientName: 'ChatGPT', redirectUri: 'https://chatgpt.com/callback', scopes: ['tools:read', 'tools:write'], createdAt: Date.now() }],
    });
    await render();
    const panel = container.querySelector('[data-xc-authorizations]') as HTMLElement;
    expect(panel.textContent).toContain('Waiting for your approval');
    (panel.querySelector('[data-xc-auth-approve]') as HTMLElement).click();
    await settle();
    expect(facade.respondAuthorization).toHaveBeenCalledWith('auth_1', { connectionId: 'conn_chatgpt', approved: true });
  });
});

describe('reading the external mark off a session', () => {
  it('reads the wire shape a real server sends, with the driver spread flat', () => {
    const mark = { driver: 'external', connectionId: 'conn_1', clientName: 'ChatGPT', sessionRef: 'extref_1' };
    // kap-server's buildWireMetadata spreads SessionMeta.custom into the wire
    // metadata, so this is the shape a live session actually arrives in. A
    // reader that only understood `custom.externalClient` would treat a real
    // driven session as an ordinary one and offer it a prompt composer.
    expect(readExternalClientMark({ cwd: 'C:/x', externalClient: mark })).toEqual(mark);
  });

  it('still accepts the engine-level nested shape', () => {
    const mark = { driver: 'external', connectionId: 'conn_1', clientName: 'ChatGPT', sessionRef: 'extref_1' };
    expect(readExternalClientMark({ cwd: 'C:/x', custom: { externalClient: mark } })).toEqual(mark);
  });

  it('accepts a complete mark and rejects anything partial', () => {
    const mark = { driver: 'external', connectionId: 'conn_1', clientName: 'ChatGPT', sessionRef: 'extref_1' };
    // A half-written mark must not make an ordinary session look driven.
    expect(readExternalClientMark({ custom: { externalClient: { driver: 'external', clientName: 'ChatGPT' } } })).toBeUndefined();
    expect(readExternalClientMark({ custom: { externalClient: { ...mark, driver: 'native' } } })).toBeUndefined();
    expect(readExternalClientMark({ cwd: 'C:/x' })).toBeUndefined();
    expect(readExternalClientMark(undefined)).toBeUndefined();
    expect(readExternalClientMark('nonsense')).toBeUndefined();
  });
});
