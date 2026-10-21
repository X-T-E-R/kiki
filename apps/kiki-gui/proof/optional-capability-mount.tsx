import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import type { PluginUsageResponse } from '@kiki/protocol';
import { I18nProvider } from '../src/i18n';
import type { KikiClient } from '../src/lib/client';
import { ConnectionScope, type ConnectionValue } from '../src/state/connection';
import { OptionalCapabilityRows, SessionMcpRail } from '../src/components/capabilities/optionalCapabilityUi';
import { SessionPluginsPanel } from '../src/components/capabilities/SessionPluginsPanel';
import { applyPendingNewSessionCapabilities, currentPendingCapabilityScope } from '../src/components/capabilities/newSessionCapabilities';
import '../src/index.css';

type CapabilityId = 'browser' | 'computer' | 'memory' | 'thread' | 'web';
type Choice = 'inherit' | 'on' | 'off';

const IDS: readonly CapabilityId[] = ['browser', 'computer', 'memory', 'thread', 'web'];
const FACTORY: Record<CapabilityId, boolean> = { browser: true, computer: true, memory: true, thread: false, web: true };
const sessions = new Map<string, Partial<Record<CapabilityId, Choice>>>();
const revisions = new Map<string, number>();
const mcpChoices = new Map<string, Choice>();
const pluginChoices = new Map<string, 'on' | 'off' | 'inherit'>([['session-b', 'off']]);

function projection() {
  return Object.fromEntries(IDS.map((id) => [id, {
    allowed: true,
    host_locked: false,
    default_on: FACTORY[id],
    origin: 'default',
    unresolved: false,
  }]));
}

function capabilityView(sessionId: string) {
  const choices = sessions.get(sessionId) ?? {};
  return {
    revision: revisions.get(sessionId) ?? 0,
    host_id: 'local',
    rows: IDS.map((id) => {
      const choice = choices[id] ?? 'inherit';
      const defaultOn = FACTORY[id];
      const effective = choice === 'on' || (choice === 'inherit' && defaultOn);
      return {
        id,
        choice,
        effective,
        source: choice === 'inherit' ? 'default' : 'session',
        reason: effective ? 'admitted' : choice === 'off' ? 'session_off' : 'default_off',
        allowed: true,
        host_locked: false,
        default_on: defaultOn,
        unresolved: false,
        applies: id === 'memory' || id === 'thread' ? 'next-step' : 'next-model-request',
      };
    }),
  };
}

function writeChoice(sessionId: string, id: CapabilityId, choice: Choice) {
  const current = { ...(sessions.get(sessionId) ?? {}) };
  if (choice === 'inherit') delete current[id];
  else current[id] = choice;
  sessions.set(sessionId, current);
  revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
  return capabilityView(sessionId);
}

function mcpCapability(sessionId: string) {
  const override = mcpChoices.get(sessionId) ?? 'inherit';
  return {
    locator: { source: 'global' as const, name: 'files' },
    runtimeName: 'files',
    origin: 'global' as const,
    config: { transport: 'stdio' as const, enabled: true },
    authStatus: 'unavailable' as const,
    connection: override === 'off' ? 'disabled' as const : 'connected' as const,
    override,
  };
}

function pluginUsage(sessionId: string): PluginUsageResponse {
  const sessionOverride = pluginChoices.get(sessionId) ?? 'inherit';
  const effective = sessionOverride !== 'off';
  return {
    home_id: 'fixture-home',
    target: { session_id: sessionId, workspace_id: 'fixture', name: sessionId, root: 'C:/fixture' },
    revision: 1,
    apply_state: 'applied',
    errors: [],
    plugins: [{
      id: 'notes',
      displayName: 'Notes',
      version: '1.0.0',
      enabled: true,
      global_enabled: true,
      home_enabled: true,
      state: 'ok',
      override: 'inherit',
      session_override: sessionOverride === 'inherit' ? undefined : sessionOverride,
      effective,
      app_service: false,
      skillCount: 1,
      mcpServerCount: 0,
    }],
  } as PluginUsageResponse;
}

const scope = { scopeId: 'mount', spaceKey: 'local', connectionId: 'mount' };

const client = {
  async getConfig() {
    return { optional_capabilities: projection() };
  },
  getSessionOptionalCapabilities(sessionId: string) {
    return Promise.resolve(capabilityView(sessionId));
  },
  setSessionOptionalCapability(sessionId: string, body: { id: CapabilityId; choice: Choice }) {
    return Promise.resolve(writeChoice(sessionId, body.id, body.choice));
  },
  getPluginUsage(target: { session_id?: string }) {
    return Promise.resolve(pluginUsage(target.session_id ?? ''));
  },
  setPluginUsage(input: { target: { session_id?: string }; plugin_id: string; override: 'on' | 'off' | 'inherit' }) {
    if (input.target.session_id !== undefined) pluginChoices.set(input.target.session_id, input.override);
    return Promise.resolve(pluginUsage(input.target.session_id ?? ''));
  },
  listPluginMarketplace: async () => ({ entries: [] }),
  klient: {
    global: { mcp: { list: async () => [{ name: 'files', source: 'global', config: { transport: 'stdio', enabled: true } }] } },
    session(sessionId: string) {
      return {
        agent() {
          return {
            listMcpSessionCapabilities: async () => [mcpCapability(sessionId)],
            setMcpSessionOverride: async (input: { override: Choice }) => {
              mcpChoices.set(sessionId, input.override);
              return mcpCapability(sessionId);
            },
          };
        },
      };
    },
  },
} as unknown as KikiClient;

const connection = {
  connectionId: scope.connectionId,
  scopeId: scope.scopeId,
  spaceKey: scope.spaceKey,
  client,
  klient: client.klient,
} as ConnectionValue;

function Column({ title, sessionId, marker }: { title: string; sessionId?: string; marker: string }) {
  return (
    <section data-mount-session={marker} className="w-[340px] rounded-md bg-paper p-3">
      <h2 className="mb-2 text-[15px] text-ink">{title}</h2>
      <OptionalCapabilityRows sessionId={sessionId} />
      <SessionMcpRail sessionId={sessionId} />
      {sessionId === undefined ? null : <SessionPluginsPanel sessionId={sessionId} />}
    </section>
  );
}

function Mount() {
  const [born, setBorn] = useState(false);
  return (
    <main className="flex flex-wrap gap-4 p-6">
      <p data-submitted-prompt="kept" className="w-full text-[13px] text-ink-soft">已提交的提示仍在这条会话里。</p>
      <Column title="会话 A" sessionId="session-a" marker="a" />
      <Column title="会话 B" sessionId="session-b" marker="b" />
      <section data-mount-draft="" className="w-[340px] rounded-md bg-paper p-3">
        <h2 className="mb-2 text-[15px] text-ink">新会话，尚未发送</h2>
        <OptionalCapabilityRows />
        <SessionMcpRail />
        <button
          type="button"
          data-mount-apply=""
          className="mt-2 rounded bg-ink px-2 py-1 text-[12px] text-paper"
          onClick={() => {
            void applyPendingNewSessionCapabilities(client, 'session-c', currentPendingCapabilityScope(scope)).then(() => { setBorn(true); });
          }}
        >
          用这些选择建立会话
        </button>
      </section>
      {born ? <Column title="刚建立的会话" sessionId="session-c" marker="c" /> : null}
    </main>
  );
}

localStorage.setItem('kiki.locale', 'zh');
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider>
      <MemoryRouter>
        <ConnectionScope value={connection}>
          <Mount />
        </ConnectionScope>
      </MemoryRouter>
    </I18nProvider>
  </QueryClientProvider>,
);
