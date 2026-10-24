import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import type { SshHost, SshHostStatus, SshSessionHostsResponse } from '@kiki/protocol';
import { I18nProvider } from '../src/i18n';
import type { KikiClient } from '../src/lib/client';
import { ConnectionScope, type ConnectionValue } from '../src/state/connection';
import { useComposerSsh } from '../src/components/ssh/ComposerSsh';
import '../src/index.css';

const ALL_HOSTS: SshHost[] = [
  { id: 'gpu-box', name: 'gpu-box', hostname: 'gpu.lab.example.com', user: 'ubuntu', port: 2222, source: 'kiki' },
  { id: 'staging-db', name: 'staging-db', hostname: 'staging.example.com', user: 'deploy', source: 'kiki' },
  { id: 'build-runner', name: 'build-runner', hostname: 'build.example.com', source: 'ssh-config' },
  { id: 'dev-box', name: 'dev-box', hostname: 'dev.local', source: 'kiki' },
  { id: 'pi-lab', name: 'pi-lab', hostname: 'pi-lab.local', source: 'kiki' },
];

const sessionStore = new Map<string, string[]>([
  ['sess-3', ['gpu-box', 'staging-db', 'build-runner']],
  ['sess-5', ['gpu-box', 'staging-db', 'build-runner', 'dev-box', 'pi-lab']],
]);

function getSessionHosts(sessionId: string): SshSessionHostsResponse['hosts'] {
  const ids = sessionStore.get(sessionId) ?? [];
  return ids.map((id) => {
    const host = ALL_HOSTS.find((h) => h.id === id) ?? { id, name: id, source: 'session' as const };
    const state: SshHostStatus['state'] = id === 'gpu-box' ? 'ready' : 'idle';
    return {
      host,
      status: { hostId: id, state, generation: 1 },
    };
  });
}

const mockSsh = {
  list: async () => ({ hosts: ALL_HOSTS }),
  sessionHosts: async (sessionId: string) => ({ hosts: getSessionHosts(sessionId) }),
  addSessionHost: async (sessionId: string, hostId: string) => {
    const list = sessionStore.get(sessionId) ?? [];
    if (!list.includes(hostId)) sessionStore.set(sessionId, [...list, hostId]);
    return { ok: true };
  },
  removeSessionHost: async (sessionId: string, hostId: string) => {
    const list = sessionStore.get(sessionId) ?? [];
    sessionStore.set(sessionId, list.filter((id) => id !== hostId));
    return { ok: true };
  },
  status: async (hostId: string): Promise<SshHostStatus> => ({
    hostId,
    state: hostId === 'gpu-box' ? 'ready' : 'idle',
    generation: 1,
  }),
};

const mockClient = {
  meta: async () => ({ experimental_flags: { native_ssh: true } }),
  klient: {
    rest: {
      ssh: mockSsh,
    },
  },
} as unknown as KikiClient;

const mockConnection: ConnectionValue = {
  connectionId: 'mount-conn',
  scopeId: 'mount-scope',
  spaceKey: 'local',
  client: mockClient,
  klient: mockClient.klient as any,
  socket: {} as any,
  meta: { experimental_flags: { native_ssh: true } } as any,
  wsStatus: 'connected' as any,
  localClient: null,
  disconnect: () => {},
  applyConnection: () => {},
};

function SshComposerBlock({ title, sessionId, desc }: { title: string; sessionId?: string; desc: string }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const hook = useComposerSsh(sessionId, true);

  return (
    <section className="rounded-xl border border-hairline bg-surface p-4 shadow-sm" data-mount-section={sessionId ?? 'draft'}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        <span className="text-[11px] font-medium text-ink-faint">{desc}</span>
      </div>

      <div className="rounded-lg border border-hairline/80 bg-ink/[0.02] p-1.5">
        <div data-composer-surface className="flex flex-col">
          <div className="flex items-center justify-between">
            <div className="flex-1">{hook.resident}</div>
            <button
              type="button"
              className="ml-2 inline-flex h-6 items-center rounded px-2 text-[11px] font-medium text-ink-soft hover:bg-ink/[0.05]"
              onClick={() => setPanelOpen((open) => !open)}
              data-toggle-panel-button
            >
              {panelOpen ? '关闭面板' : '点开 SSH 面板'}
            </button>
          </div>
          {panelOpen ? (
            <div className="mt-2 rounded-lg border border-hairline bg-surface p-1 shadow-md" data-manual-panel-container>
              {hook.renderPanel(() => setPanelOpen(false))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 h-12 w-full rounded border border-hairline/60 bg-paper p-2 text-[12px] text-ink-faint select-none">
        输入提示词...
      </div>
      {hook.dialog}
    </section>
  );
}

function ProofApp() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } }));

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionScope value={mockConnection}>
        <I18nProvider>
          <MemoryRouter>
            <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
              <header className="border-b border-hairline pb-3">
                <h1 className="text-[16px] font-semibold text-ink">Composer SSH 真实组件渲染与视觉闭环</h1>
                <p className="mt-1 text-[12px] text-ink-faint">
                  真实挂载 ComposerSsh.tsx、Toggle、SshBits 及 Design Tokens，检验 1–3 台直显、超过 3 台折叠展开、面板 Switch 独立状态。
                </p>
              </header>

              <SshComposerBlock
                title="场景 1：3 台主机（1–3 台不折叠）"
                sessionId="sess-3"
                desc="1–3 台直接平铺显示，无折叠/展开按钮"
              />

              <SshComposerBlock
                title="场景 2：5 台主机（超过 3 台默认折叠 + 手动展开）"
                sessionId="sess-5"
                desc="默认仅占一行，右侧带展开按钮，保护输入留白"
              />
            </main>
          </MemoryRouter>
        </I18nProvider>
      </ConnectionScope>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById('root')!).render(<ProofApp />);
