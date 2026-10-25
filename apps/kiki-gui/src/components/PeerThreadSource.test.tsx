// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@kiki/protocol';
import { I18nProvider } from '../i18n';
import { ConnectionScope, type ConnectionValue } from '../state/connection';
import { PeerThreadSource } from './PeerThreadSource';

const mounted: { root: Root; element: HTMLElement; query: QueryClient }[] = [];
afterEach(async () => {
  for (const { root, element, query } of mounted.splice(0)) {
    await act(async () => root.unmount());
    element.remove();
    query.clear();
  }
});

function Location() {
  const location = useLocation();
  return <output data-location>{JSON.stringify({ path: location.pathname, state: location.state })}</output>;
}

async function setup(sourceHost: string | null = 'host-source', cached = true, sourceWorkspace: string | null = 'workspace-source') {
  const session = { id: 'session-source', workspace_id: 'workspace-source', title: 'Design review', updated_at: '2026-01-01T00:00:00Z' } as Session;
  const getSession = vi.fn(async () => session);
  const hostId = vi.fn(async () => 'host-source');
  const connection = { spaceKey: 'space-source', scopeId: 'remote:registered-source', connectionRef: 'registered-source',
    meta: { server_home_id: 'home-source' }, client: { getSession }, klient: { global: { threads: { hostId } } } } as unknown as ConnectionValue;
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  query.setQueryData(['thread-host-id'], 'host-source');
  if (cached) query.setQueryData(['thread-ref', session.id], session);
  query.setQueryData(['workspaces', 'catalog'], { items: [{ id: session.workspace_id, name: 'Design workspace' }] });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  mounted.push({ root, element, query });
  await act(async () => {
    root.render(<MemoryRouter><I18nProvider><QueryClientProvider client={query}><ConnectionScope value={connection}>
      {[1, 2].map((key) => <PeerThreadSource key={key} source={{ hostId: sourceHost ?? undefined, workspaceId: sourceWorkspace ?? undefined, sessionId: session.id, senderName: 'Persona, not a thread title' }} />)}
      <Location />
    </ConnectionScope></QueryClientProvider></I18nProvider></MemoryRouter>);
  });
  return { element, getSession, root, query, connection, session };
}

describe('peer thread source', () => {
  it('uses a cached title, exposes its complete address and opens the same scope by keyboard', async () => {
    const { element, getSession } = await setup();
    const link = element.querySelector<HTMLAnchorElement>('[data-peer-thread]')!;
    expect(link.textContent).toBe('From thread Design review');
    expect(link.title).toContain('session-source');
    expect(link.title).toContain('workspace-source');
    expect(link.title).toContain('Design workspace');
    expect(link.title).toContain('host-source');
    expect(link.title).toContain('home-source');
    link.focus();
    expect(document.activeElement).toBe(link);
    await act(async () => { link.click(); });
    expect(JSON.parse(element.querySelector('[data-location]')!.textContent!)).toEqual({ path: '/s/session-source', state: {
      kikiNav: { scope: { homeId: 'space-source', scopeId: 'remote:registered-source', serverHomeId: 'home-source', connectionRef: 'registered-source' } },
    } });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('deduplicates a cold metadata lookup across source rows', async () => {
    const { element, getSession } = await setup('host-source', false);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(getSession).toHaveBeenCalledTimes(1);
    expect([...element.querySelectorAll('[data-peer-thread]')].map((node) => node.textContent)).toEqual(['From thread Design review', 'From thread Design review']);
  });

  it('keeps old source records without location metadata usable', async () => {
    const { element, getSession } = await setup(null, true, null);
    const link = element.querySelector<HTMLAnchorElement>('[data-peer-thread]')!;
    expect(link.tagName).toBe('A');
    expect(link.textContent).toBe('From thread Design review');
    expect(link.title).toContain('workspace-source');
    expect(link.title).toContain('host-source');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('opens the exact id when two cached threads have the same title', async () => {
    const { element, root, query, connection, session } = await setup();
    const other = { ...session, id: 'session-other' };
    query.setQueryData(['thread-ref', other.id], other);
    await act(async () => {
      root.render(<MemoryRouter><I18nProvider><QueryClientProvider client={query}><ConnectionScope value={connection}>
        {[session.id, other.id].map((id) => <PeerThreadSource key={id} source={{ hostId: 'host-source', sessionId: id }} />)}
        <Location />
      </ConnectionScope></QueryClientProvider></I18nProvider></MemoryRouter>);
    });
    const links = element.querySelectorAll<HTMLAnchorElement>('[data-peer-thread]');
    expect([...links].map((link) => link.textContent)).toEqual(['From thread Design review', 'From thread Design review']);
    await act(async () => { links[1]!.click(); });
    expect(JSON.parse(element.querySelector('[data-location]')!.textContent!).path).toBe('/s/session-other');
  });

  it('does not link a cached id whose workspace conflicts with the source', async () => {
    const { element } = await setup('host-source', true, 'workspace-other');
    const source = element.querySelector<HTMLElement>('[data-peer-thread]')!;
    expect(source.tagName).toBe('SPAN');
    expect(source.textContent).not.toContain('Design review');
    expect(source.title).toContain('workspace-other');
  });

  it('does not resolve a different host through this scope even when the session id is cached', async () => {
    const { element, getSession } = await setup('another-host');
    const source = element.querySelector<HTMLElement>('[data-peer-thread]')!;
    expect(source.tagName).toBe('SPAN');
    expect(source.textContent).not.toContain('Design review');
    expect(source.title).toContain('another-host');
    expect(getSession).not.toHaveBeenCalled();
  });
});
