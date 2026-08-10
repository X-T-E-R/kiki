/**
 * SettingsPage — /settings/:section? shell and honest section panes.
 *
 * Every section is either backed by a real kap-server endpoint or explicitly
 * labeled "This device". No fake toggles.
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';

import type {
  McpServer,
  ModelCatalogItem,
  PermissionMode,
  ProviderCatalogItem,
  SkillDescriptor,
  ToolDescriptor,
} from '@moonshot-ai/protocol';

import {
  isDesktopRuntime,
  writeNativeDesktopPrefs,
} from '../lib/desktop';
import {
  readDesktopPrefs,
  readSettings,
  writeDesktopPrefs,
  writeSettings,
  type SendShortcut,
} from '../lib/settings';
import { useConnection } from '../state/connection';

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
  { id: 'connection', label: 'Connection' },
  { id: 'providers', label: 'Providers & auth' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'about', label: 'About' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function SectionCard({
  title,
  children,
  badge,
}: {
  title: string;
  children: React.ReactNode;
  badge?: string;
}) {
  return (
    <section className="rounded-2xl border border-hairline bg-panel p-5 shadow-[0_2px_4px_rgba(28,25,23,0.03)]">
      <div className="mb-4 flex items-center gap-2">
        <h2 className="font-display text-[16px] font-semibold text-ink">{title}</h2>
        {badge !== undefined ? (
          <span className="rounded-full border border-hairline bg-paper px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-faint">
            {badge}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function InlineError({ error }: { error: unknown }) {
  return (
    <p className="rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5 font-mono text-[11px] text-danger">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <span
        role="switch"
        aria-checked={checked}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-hairline-strong'
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-[18px]' : 'translate-x-1'
          }`}
        />
      </span>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="text-[12.5px] text-ink-soft">{label}</span>
    </label>
  );
}

function GeneralSection() {
  const { client } = useConnection();
  const [settings, setSettings] = useState(readSettings);
  const [desktopPrefs, setDesktopPrefs] = useState(readDesktopPrefs);
  const isDesktop = isDesktopRuntime();

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  const update = (patch: Partial<typeof settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    writeSettings(patch);
    // Best-effort server mirror for the fields the config endpoint knows.
    void client
      .patchConfig({
        default_permission_mode: next.defaultPermissionMode,
        default_plan_mode: next.defaultPlanMode,
      })
      .catch(() => undefined);
  };

  return (
    <div className="space-y-5">
      <SectionCard title="Prompt defaults" badge="This device">
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-ink-soft">
              Default permission mode
            </label>
            <div className="flex flex-wrap gap-2">
              {(['manual', 'auto', 'yolo'] as PermissionMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => update({ defaultPermissionMode: mode })}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                    settings.defaultPermissionMode === mode
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-hairline text-ink-soft hover:border-hairline-strong'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <Toggle
            label="Plan mode by default"
            checked={settings.defaultPlanMode}
            onChange={(checked) => update({ defaultPlanMode: checked })}
          />

          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-ink-soft">
              Send shortcut
            </label>
            <select
              className="rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
              value={settings.sendShortcut}
              onChange={(event) =>
                update({ sendShortcut: event.target.value as SendShortcut })
              }
            >
              <option value="enter">Enter sends · Shift+Enter newline</option>
              <option value="cmd-enter">⌘/Ctrl+Enter sends · Enter newline</option>
            </select>
          </div>

          <Toggle
            label="Persist composer drafts"
            checked={settings.draftPersistence}
            onChange={(checked) => update({ draftPersistence: checked })}
          />
        </div>
      </SectionCard>

      {configQuery.data !== undefined ? (
        <SectionCard title="Server baseline" badge="Read-only">
          <div className="space-y-2 text-[12.5px] text-ink-soft">
            <p>
              Server default permission mode:{' '}
              <span className="font-mono text-ink">
                {configQuery.data.default_permission_mode ?? 'manual'}
              </span>
            </p>
            <p>
              Server default plan mode:{' '}
              <span className="font-mono text-ink">
                {configQuery.data.default_plan_mode === true ? 'on' : 'off'}
              </span>
            </p>
          </div>
        </SectionCard>
      ) : null}

      {isDesktop ? (
        <SectionCard title="Desktop" badge="This device">
          <div className="space-y-3">
            <Toggle
              label="Show approval notifications"
              checked={desktopPrefs.notifications}
              onChange={(checked) => {
                const next = { ...desktopPrefs, notifications: checked };
                setDesktopPrefs(next);
                writeDesktopPrefs(next);
                void writeNativeDesktopPrefs(next);
              }}
            />
            <fieldset>
              <legend className="mb-2 text-[11px] font-medium text-ink-soft">
                When the window is closed
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {([
                  {
                    closeToTray: true,
                    title: 'Hide to tray',
                    description: 'Keep Kiki and its local backend running.',
                  },
                  {
                    closeToTray: false,
                    title: 'Quit Kiki',
                    description: 'Exit Kiki and stop its local backend.',
                  },
                ] as const).map((option) => (
                  <label
                    key={option.title}
                    className={`cursor-pointer rounded-xl border p-3 transition-colors ${
                      desktopPrefs.closeToTray === option.closeToTray
                        ? 'border-accent bg-accent-soft'
                        : 'border-hairline bg-paper hover:border-hairline-strong'
                    }`}
                  >
                    <span className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="close-behavior"
                        value={option.closeToTray ? 'hide-to-tray' : 'quit'}
                        checked={desktopPrefs.closeToTray === option.closeToTray}
                        onChange={() => {
                          const next = { ...desktopPrefs, closeToTray: option.closeToTray };
                          setDesktopPrefs(next);
                          writeDesktopPrefs(next);
                          void writeNativeDesktopPrefs(next);
                        }}
                        className="mt-0.5 accent-[var(--color-accent)]"
                      />
                      <span>
                        <span className="block text-[12.5px] font-semibold text-ink">
                          {option.title}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-faint">
                          {option.description}
                        </span>
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

function ModelsSection() {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState(readSettings);
  const [saveError, setSaveError] = useState<string | null>(null);

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
  });
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  const defaultModel = settings.defaultModel ?? configQuery.data?.default_model;
  const items = modelsQuery.data?.items ?? [];

  const selectDefault = async (modelId: string | undefined) => {
    setSaveError(null);
    setSettings((prev) => ({ ...prev, defaultModel: modelId }));
    writeSettings({ defaultModel: modelId });
    if (modelId !== undefined) {
      try {
        await client.setDefaultModel(modelId);
        void queryClient.invalidateQueries({ queryKey: ['config'] });
      } catch (error: unknown) {
        setSaveError(error instanceof Error ? error.message : String(error));
      }
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard title="Default model" badge="Server + this device">
        <div className="space-y-3">
          {items.map((item) => (
            <ModelRow
              key={item.model}
              item={item}
              isDefault={item.model === defaultModel}
              onSetDefault={() => selectDefault(item.model)}
            />
          ))}
          {items.length === 0 && modelsQuery.isLoading ? (
            <p className="text-[12px] text-ink-faint">Loading catalog…</p>
          ) : null}
          {modelsQuery.isError ? <InlineError error={modelsQuery.error} /> : null}
          {saveError !== null ? <InlineError error={saveError} /> : null}
        </div>
      </SectionCard>

      {defaultModel !== undefined ? (
        <SectionCard title="Default effort" badge="This device">
          <EffortSelector modelId={defaultModel} />
        </SectionCard>
      ) : null}
    </div>
  );
}

function ModelRow({
  item,
  isDefault,
  onSetDefault,
}: {
  item: ModelCatalogItem;
  isDefault: boolean;
  onSetDefault: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-hairline bg-paper px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-ink">
          {item.display_name ?? item.model}
        </p>
        <p className="truncate font-mono text-[10.5px] text-ink-faint">
          {item.model} · {item.max_context_size.toLocaleString()} context
          {item.capabilities !== undefined && item.capabilities.length > 0
            ? ` · ${item.capabilities.join(', ')}`
            : ''}
        </p>
      </div>
      <button
        type="button"
        onClick={onSetDefault}
        disabled={isDefault}
        className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
          isDefault
            ? 'border-success/30 bg-success/10 text-success'
            : 'border-hairline text-ink-soft hover:border-hairline-strong hover:text-ink'
        }`}
      >
        {isDefault ? 'Default' : 'Set default'}
      </button>
    </div>
  );
}

function EffortSelector({ modelId }: { modelId: string }) {
  const { client } = useConnection();
  const [settings, setSettings] = useState(readSettings);
  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
  });
  const item = (modelsQuery.data?.items ?? []).find((m) => m.model === modelId);
  const efforts = item?.support_efforts ?? [];
  if (efforts.length === 0) {
    return <p className="text-[12px] text-ink-faint">This model does not advertise effort levels.</p>;
  }
  return (
    <select
      className="rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
      value={settings.defaultEffort ?? item?.default_effort ?? efforts[0]}
      onChange={(event) => {
        const next = event.target.value;
        setSettings((prev) => ({ ...prev, defaultEffort: next }));
        writeSettings({ defaultEffort: next });
      }}
    >
      {efforts.map((level) => (
        <option key={level} value={level}>
          {level}
        </option>
      ))}
    </select>
  );
}

function ConnectionSection() {
  const { config, meta, wsStatus, socket } = useConnection();
  const isDesktop = isDesktopRuntime();

  return (
    <div className="space-y-5">
      <SectionCard title="Server" badge="Read-only">
        <div className="space-y-2 text-[12.5px] text-ink-soft">
          <p>
            URL: <span className="font-mono text-ink">{config.url}</span>
          </p>
          <p>
            Version: <span className="font-mono text-ink">{meta.server_version}</span>
          </p>
          <p>
            Backend: <span className="font-mono text-ink">{meta.backend ?? 'v1'}</span>
          </p>
          <p>
            WebSocket:{' '}
            <span
              className={`font-medium ${
                wsStatus === 'open' ? 'text-success' : 'text-amber-ink'
              }`}
            >
              {wsStatus}
            </span>
          </p>
          <button
            type="button"
            onClick={() => socket?.nudge()}
            className="mt-2 rounded-md border border-hairline bg-paper px-3 py-1 text-[11px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
          >
            Reconnect now
          </button>
        </div>
      </SectionCard>

      {isDesktop ? (
        <SectionCard title="Desktop backend" badge="Read-only">
          <p className="text-[12.5px] text-ink-soft">
            The Kiki desktop shell owns the local backend process. Status:{' '}
            <span className="font-medium text-success">attached</span>.
          </p>
        </SectionCard>
      ) : null}
    </div>
  );
}

function ProvidersSection() {
  const { client } = useConnection();
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthMessage, setOauthMessage] = useState<string | null>(null);

  const authQuery = useQuery({
    queryKey: ['auth'],
    queryFn: () => client.getAuth(),
    staleTime: 10_000,
  });
  const providersQuery = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.listProviders(),
    staleTime: 60_000,
  });
  const oauthQuery = useQuery({
    queryKey: ['oauth'],
    queryFn: () => client.getOAuthStatus(),
    staleTime: 5000,
  });

  const startOAuth = async () => {
    setOauthBusy(true);
    setOauthMessage(null);
    try {
      const result = await client.startOAuthLogin();
      if (result.status === 'authenticated') {
        setOauthMessage('Already authenticated.');
      } else {
        setOauthMessage('Device-code flow started — check your browser.');
      }
    } catch (error: unknown) {
      setOauthMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setOauthBusy(false);
    }
  };

  const logout = async () => {
    setOauthBusy(true);
    try {
      await client.logoutOAuth();
      setOauthMessage('Logged out.');
    } catch (error: unknown) {
      setOauthMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setOauthBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard title="Authentication" badge="Read-only">
        {authQuery.isLoading ? (
          <p className="text-[12px] text-ink-faint">Loading…</p>
        ) : authQuery.data !== undefined ? (
          <div className="space-y-2 text-[12.5px] text-ink-soft">
            <p>
              Ready: <span className="text-ink">{authQuery.data.ready ? 'yes' : 'no'}</span>
            </p>
            <p>
              Providers configured: <span className="text-ink">{authQuery.data.providers_count}</span>
            </p>
            <p>
              Default model: <span className="font-mono text-ink">{authQuery.data.default_model ?? 'none'}</span>
            </p>
            {authQuery.data.managed_provider !== null ? (
              <p>
                Managed provider:{' '}
                <span className="font-medium text-ink">{authQuery.data.managed_provider.name}</span>{' '}
                · {authQuery.data.managed_provider.status}
              </p>
            ) : null}
          </div>
        ) : null}
        {authQuery.isError ? <InlineError error={authQuery.error} /> : null}
      </SectionCard>

      <SectionCard title="Configured providers" badge="Read-only">
        <div className="space-y-2">
          {providersQuery.data?.items.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
          {providersQuery.isLoading ? <p className="text-[12px] text-ink-faint">Loading providers…</p> : null}
          {providersQuery.data?.items.length === 0 ? (
            <p className="text-[12px] text-ink-faint">No providers configured.</p>
          ) : null}
          {providersQuery.isError ? <InlineError error={providersQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard title="OAuth" badge="Read-only actions">
        <div className="space-y-3">
          {oauthQuery.data !== undefined && oauthQuery.data !== null ? (
            <p className="text-[12.5px] text-ink-soft">
              Provider: <span className="font-medium text-ink">{oauthQuery.data.provider}</span> ·{' '}
              {oauthQuery.data.status}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={oauthBusy}
              onClick={startOAuth}
              className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-50"
            >
              {oauthBusy ? 'Working…' : 'Sign in'}
            </button>
            <button
              type="button"
              disabled={oauthBusy}
              onClick={logout}
              className="rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-50"
            >
              Sign out
            </button>
          </div>
          {oauthMessage !== null ? (
            <p className="text-[11.5px] text-ink-faint">{oauthMessage}</p>
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}

function ProviderRow({ provider }: { provider: ProviderCatalogItem }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-hairline bg-paper px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-ink">{provider.id}</p>
        <p className="truncate font-mono text-[10.5px] text-ink-faint">
          {provider.type} · {provider.status}
          {provider.default_model !== undefined ? ` · default ${provider.default_model}` : ''}
        </p>
      </div>
    </div>
  );
}

function CapabilitiesSection() {
  const { client } = useConnection();
  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const [workspaceId, setWorkspaceId] = useState<string>('');

  const toolsQuery = useQuery({
    queryKey: ['tools'],
    queryFn: () => client.listTools(),
    staleTime: 60_000,
  });
  const mcpQuery = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: () => client.listMcpServers(),
    staleTime: 60_000,
  });
  const skillsQuery = useQuery({
    queryKey: ['workspace-skills', workspaceId],
    queryFn: () => client.listWorkspaceSkills(workspaceId),
    enabled: workspaceId !== '',
    staleTime: 60_000,
  });

  const workspaces = workspacesQuery.data?.items ?? [];
  const selectedWorkspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];

  useEffect(() => {
    if (workspaceId === '' && workspaces.length > 0) {
      setWorkspaceId(workspaces[0]!.id);
    }
  }, [workspaces, workspaceId]);

  return (
    <div className="space-y-5">
      <SectionCard title="Tools" badge="Read-only">
        <div className="space-y-2">
          {toolsQuery.data?.tools.map((tool) => (
            <ToolRow key={tool.name} tool={tool} />
          ))}
          {toolsQuery.isLoading ? <p className="text-[12px] text-ink-faint">Loading tools…</p> : null}
          {toolsQuery.data?.tools.length === 0 ? (
            <p className="text-[12px] text-ink-faint">No tools advertised.</p>
          ) : null}
          {toolsQuery.isError ? <InlineError error={toolsQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard title="MCP servers" badge="Restart available">
        <div className="space-y-2">
          {mcpQuery.data?.servers.map((server) => (
            <McpRow key={server.id} server={server} />
          ))}
          {mcpQuery.isLoading ? <p className="text-[12px] text-ink-faint">Loading servers…</p> : null}
          {mcpQuery.data?.servers.length === 0 ? (
            <p className="text-[12px] text-ink-faint">No MCP servers configured.</p>
          ) : null}
          {mcpQuery.isError ? <InlineError error={mcpQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard title="Skills" badge="Read-only">
        <div className="mb-3 flex items-center gap-2">
          <label className="text-[11px] font-medium text-ink-soft">Workspace</label>
          <select
            className="rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
            value={selectedWorkspace?.id ?? ''}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          {skillsQuery.data?.skills.map((skill) => (
            <SkillRow key={skill.name} skill={skill} />
          ))}
          {skillsQuery.isLoading ? <p className="text-[12px] text-ink-faint">Loading skills…</p> : null}
          {skillsQuery.data?.skills.length === 0 ? (
            <p className="text-[12px] text-ink-faint">No skills found for this workspace.</p>
          ) : null}
          {skillsQuery.isError ? <InlineError error={skillsQuery.error} /> : null}
        </div>
      </SectionCard>
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolDescriptor }) {
  return (
    <div className="rounded-lg border border-hairline bg-paper px-3 py-2">
      <p className="text-[13px] font-medium text-ink">{tool.name}</p>
      <p className="text-[11px] text-ink-soft">{tool.description}</p>
      <p className="mt-0.5 font-mono text-[10px] text-ink-faint">source: {tool.source}</p>
    </div>
  );
}

function McpRow({ server }: { server: McpServer }) {
  const { client } = useConnection();
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const restart = async () => {
    setRestarting(true);
    setMessage(null);
    try {
      await client.restartMcpServer(server.id);
      setMessage('Restart requested.');
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="flex items-center justify-between rounded-lg border border-hairline bg-paper px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-ink">{server.name}</p>
        <p className="truncate font-mono text-[10.5px] text-ink-faint">
          {server.transport} · {server.status} · {server.tool_count} tools
        </p>
      </div>
      <button
        type="button"
        disabled={restarting}
        onClick={restart}
        className="shrink-0 rounded-md border border-hairline bg-panel px-2 py-1 text-[11px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-50"
      >
        {restarting ? 'Restarting…' : 'Restart'}
      </button>
      {message !== null ? <span className="sr-only">{message}</span> : null}
    </div>
  );
}

function SkillRow({ skill }: { skill: SkillDescriptor }) {
  return (
    <div className="rounded-lg border border-hairline bg-paper px-3 py-2">
      <p className="text-[13px] font-medium text-ink">{skill.name}</p>
      <p className="text-[11px] text-ink-soft">{skill.description}</p>
      <p className="mt-0.5 font-mono text-[10px] text-ink-faint">{skill.path}</p>
    </div>
  );
}

function WorkspacesSection() {
  const { client } = useConnection();
  const navigate = useNavigate();
  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });

  return (
    <SectionCard title="Workspaces" badge="Read-only">
      <div className="space-y-2">
        {workspacesQuery.data?.items.map((workspace) => (
          <div
            key={workspace.id}
            className="flex items-center justify-between rounded-lg border border-hairline bg-paper px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-ink">{workspace.name}</p>
              <p className="truncate font-mono text-[10.5px] text-ink-faint">{workspace.root}</p>
            </div>
            <button
              type="button"
              onClick={() => navigate(`/new?workspace=${encodeURIComponent(workspace.id)}`)}
              className="shrink-0 rounded-md border border-hairline bg-panel px-2 py-1 text-[11px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
            >
              New session
            </button>
          </div>
        ))}
        {workspacesQuery.isLoading ? <p className="text-[12px] text-ink-faint">Loading workspaces…</p> : null}
        {workspacesQuery.isError ? <InlineError error={workspacesQuery.error} /> : null}
      </div>
    </SectionCard>
  );
}

function AboutSection() {
  const { meta } = useConnection();
  const guiVersion = import.meta.env['VITE_APP_VERSION'] ?? '0.0.0-dev';

  return (
    <SectionCard title="About" badge="Read-only">
      <div className="space-y-2 text-[12.5px] text-ink-soft">
        <p>
          Kiki GUI: <span className="font-mono text-ink">{guiVersion}</span>
        </p>
        <p>
          Server version: <span className="font-mono text-ink">{meta.server_version}</span>
        </p>
        <p>
          Server ID: <span className="font-mono text-ink">{meta.server_id}</span>
        </p>
        <p>
          Backend: <span className="font-mono text-ink">{meta.backend ?? 'v1'}</span>
        </p>
      </div>
    </SectionCard>
  );
}

function SettingsNav({ active }: { active: SectionId }) {
  const navigate = useNavigate();
  return (
    <nav className="flex h-full w-full flex-col border-r border-hairline bg-panel p-2 lg:w-[200px]">
      {SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          onClick={() => navigate(`/settings/${section.id}`)}
          className={`rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
            active === section.id
              ? 'bg-accent-soft font-medium text-accent'
              : 'text-ink-soft hover:bg-paper hover:text-ink'
          }`}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}

export function SettingsPage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { section } = useParams<{ section?: string }>();
  const active: SectionId = SECTIONS.find((s) => s.id === section)?.id ?? 'general';
  const navigate = useNavigate();

  const pane = (() => {
    switch (active) {
      case 'general':
        return <GeneralSection />;
      case 'models':
        return <ModelsSection />;
      case 'connection':
        return <ConnectionSection />;
      case 'providers':
        return <ProvidersSection />;
      case 'capabilities':
        return <CapabilitiesSection />;
      case 'workspaces':
        return <WorkspacesSection />;
      case 'about':
        return <AboutSection />;
      default:
        return <GeneralSection />;
    }
  })();

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Open session menu"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"
        >
          <span aria-hidden>☰</span>
        </button>
        <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
          Settings
        </h1>
      </header>

      <main className="flex min-h-0 flex-1">
        <div className="hidden lg:block">
          <SettingsNav active={active} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-hairline bg-panel px-4 py-2 lg:hidden">
            <select
              className="w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
              value={active}
              onChange={(event) => navigate(`/settings/${event.target.value}`)}
            >
              {SECTIONS.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.label}
                </option>
              ))}
            </select>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8">
            <div className="mx-auto max-w-[760px] space-y-5">{pane}</div>
          </div>
        </div>
      </main>
    </>
  );
}
