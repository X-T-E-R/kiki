import { useEffect, useMemo, useState } from 'react';
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
  readNativeServerConfig,
  restartNativeServer,
  writeNativeDesktopPrefs,
  writeNativeServerConfig,
  type DesktopServerConfig,
} from '../lib/desktop';
import {
  clearRestartRequirement,
  createProvider,
  deleteProvider,
  markRestartRequired,
  parseAdvancedServerConfig,
  parseExperimentalFlags,
  providerDraftFromCatalog,
  PROVIDER_WIRE_TYPES,
  readDesktopPrefs,
  readRestartRequirement,
  readSettings,
  replaceProvider,
  validateDesktopConfigDraft,
  validateExtraSkillDirs,
  validateProviderDraft,
  validateServerDefaults,
  writeDesktopPrefs,
  writeSettings,
  type ProviderDraft,
  type ProviderModelDraft,
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
type Feedback = { tone: 'success' | 'error' | 'info'; text: string } | null;

const INPUT =
  'w-full rounded-lg border border-hairline bg-paper px-2.5 py-2 text-[12px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint';
const SMALL_INPUT =
  'rounded-md border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint';
const PRIMARY_BUTTON =
  'rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY_BUTTON =
  'rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50';

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
      <div className="mb-4 flex flex-wrap items-center gap-2">
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

function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (feedback === null) return null;
  const classes =
    feedback.tone === 'error'
      ? 'border-danger/30 bg-danger/5 text-danger'
      : feedback.tone === 'success'
        ? 'border-success/30 bg-success/5 text-success'
        : 'border-hairline bg-paper text-ink-soft';
  return (
    <p role={feedback.tone === 'error' ? 'alert' : 'status'} className={`rounded-md border px-2.5 py-2 font-mono text-[11px] ${classes}`}>
      {feedback.text}
    </p>
  );
}

function InlineError({ error }: { error: unknown }) {
  return (
    <FeedbackLine
      feedback={{
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      }}
    />
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
      <span
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled}
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
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="text-[12.5px] text-ink-soft">{label}</span>
    </label>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] leading-relaxed text-ink-faint">{children}</p>;
}

function GeneralSection() {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState(readSettings);
  const [desktopPrefs, setDesktopPrefs] = useState(readDesktopPrefs);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('manual');
  const [planMode, setPlanMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const isDesktop = isDesktopRuntime();

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  useEffect(() => {
    const config = configQuery.data;
    if (config === undefined) return;
    const mode = config.default_permission_mode;
    if (mode === 'manual' || mode === 'auto' || mode === 'yolo') setPermissionMode(mode);
    setPlanMode(config.default_plan_mode === true);
  }, [configQuery.data]);

  const saveServerDefaults = async () => {
    const validation = validateServerDefaults(permissionMode);
    if (validation !== null) {
      setFeedback({ tone: 'error', text: validation });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({
        default_permission_mode: permissionMode,
        default_plan_mode: planMode,
      });
      queryClient.setQueryData(['config'], echoed);
      const echoedMode = echoed.default_permission_mode;
      if (echoedMode === 'manual' || echoedMode === 'auto' || echoedMode === 'yolo') {
        setPermissionMode(echoedMode);
        writeSettings({ defaultPermissionMode: echoedMode });
      }
      const echoedPlan = echoed.default_plan_mode === true;
      setPlanMode(echoedPlan);
      writeSettings({ defaultPlanMode: echoedPlan });
      setFeedback({
        tone: 'success',
        text: `Server saved and echoed permission=${echoedMode ?? 'manual'}, plan=${echoedPlan ? 'on' : 'off'}.`,
      });
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const updateLocal = (patch: Partial<typeof settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    writeSettings(patch);
  };

  return (
    <div className="space-y-5">
      <SectionCard title="New-session defaults" badge="Server API · live">
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-ink-soft">Default permission mode</label>
            <div className="flex flex-wrap gap-2">
              {(['manual', 'auto', 'yolo'] as PermissionMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPermissionMode(mode)}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                    permissionMode === mode
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-hairline text-ink-soft hover:border-hairline-strong'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <Toggle label="Start new sessions in plan mode" checked={planMode} onChange={setPlanMode} />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={saveServerDefaults}>
              {saving ? 'Saving…' : 'Save server defaults'}
            </button>
            <Hint>Applies to sessions created after the server confirms the write.</Hint>
          </div>
          <FeedbackLine feedback={feedback} />
          {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard title="Composer" badge="This device">
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-ink-soft">Send shortcut</label>
            <select
              className={SMALL_INPUT}
              value={settings.sendShortcut}
              onChange={(event) => updateLocal({ sendShortcut: event.target.value as SendShortcut })}
            >
              <option value="enter">Enter sends · Shift+Enter newline</option>
              <option value="cmd-enter">⌘/Ctrl+Enter sends · Enter newline</option>
            </select>
          </div>
          <Toggle
            label="Persist composer drafts"
            checked={settings.draftPersistence}
            onChange={(checked) => updateLocal({ draftPersistence: checked })}
          />
        </div>
      </SectionCard>

      <SectionCard title="Desktop behaviour" badge={isDesktop ? 'This device' : 'Desktop app'}>
        <fieldset disabled={!isDesktop} className="space-y-4">
          <Toggle
            label="Show approval notifications"
            checked={desktopPrefs.notifications}
            disabled={!isDesktop}
            onChange={(checked) => {
              const next = { ...desktopPrefs, notifications: checked };
              setDesktopPrefs(next);
              writeDesktopPrefs(next);
              void writeNativeDesktopPrefs(next);
            }}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { closeToTray: true, title: 'Hide to tray', description: 'Keep Kiki and its local backend running.' },
              { closeToTray: false, title: 'Quit Kiki', description: 'Exit Kiki and stop its local backend.' },
            ].map((option) => (
              <label
                key={option.title}
                className={`rounded-xl border p-3 ${
                  desktopPrefs.closeToTray === option.closeToTray ? 'border-accent bg-accent-soft' : 'border-hairline bg-paper'
                } ${isDesktop ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
              >
                <span className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="close-behavior"
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
                    <span className="block text-[12.5px] font-semibold text-ink">{option.title}</span>
                    <span className="mt-0.5 block text-[11px] text-ink-faint">{option.description}</span>
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {!isDesktop ? <Hint>Install and open the Kiki desktop app to change native window and notification behaviour.</Hint> : null}
      </SectionCard>
    </div>
  );
}

function ModelsSection() {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [effort, setEffort] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);

  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const items = modelsQuery.data?.items ?? [];
  const defaultModel = configQuery.data?.default_model;
  const defaultItem = items.find((item) => item.model === defaultModel);
  const thinking = asRecord(configQuery.data?.thinking);

  useEffect(() => {
    const configured = thinking?.['effort'];
    setThinkingEnabled(thinking?.['enabled'] !== false);
    setEffort(typeof configured === 'string' ? configured : (defaultItem?.default_effort ?? ''));
  }, [defaultItem?.default_effort, thinking]);

  const selectDefault = async (modelId: string) => {
    setBusyModel(modelId);
    setFeedback(null);
    try {
      const echoed = await client.setDefaultModel(modelId);
      queryClient.setQueryData(['config'], (current: Record<string, unknown> | undefined) => ({
        ...current,
        default_model: echoed.default_model,
      }));
      writeSettings({ defaultModel: echoed.default_model });
      setFeedback({ tone: 'success', text: `Server confirmed ${echoed.default_model} as the default model.` });
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyModel(null);
    }
  };

  const saveEffort = async () => {
    if (thinkingEnabled && effort.trim() === '') {
      setFeedback({ tone: 'error', text: 'Choose or enter a non-empty effort value.' });
      return;
    }
    setBusyModel('effort');
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ thinking: { enabled: thinkingEnabled, effort: effort.trim() || undefined } });
      queryClient.setQueryData(['config'], echoed);
      const echoedThinking = asRecord(echoed.thinking);
      const echoedEnabled = echoedThinking?.['enabled'] !== false;
      const echoedEffort = typeof echoedThinking?.['effort'] === 'string' ? echoedThinking['effort'] : effort.trim();
      setThinkingEnabled(echoedEnabled);
      setEffort(echoedEffort);
      writeSettings({ defaultEffort: echoedEffort || undefined });
      setFeedback({ tone: 'success', text: `Server saved thinking ${echoedEnabled ? `at ${echoedEffort}` : 'off'}.` });
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyModel(null);
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard title="Default model" badge="Server API · live">
        <div className="space-y-3">
          {items.map((item) => (
            <ModelRow
              key={item.model}
              item={item}
              isDefault={item.model === defaultModel}
              busy={busyModel === item.model}
              onSetDefault={() => void selectDefault(item.model)}
            />
          ))}
          {modelsQuery.isLoading ? <Hint>Loading model catalog…</Hint> : null}
          {modelsQuery.isError ? <InlineError error={modelsQuery.error} /> : null}
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      <SectionCard title="Default thinking" badge="Server API · live">
        <div className="space-y-3">
          <Toggle label="Enable thinking by default" checked={thinkingEnabled} onChange={setThinkingEnabled} />
          {defaultItem?.support_efforts !== undefined && defaultItem.support_efforts.length > 0 ? (
            <select className={SMALL_INPUT} value={effort} disabled={!thinkingEnabled} onChange={(event) => setEffort(event.target.value)}>
              {defaultItem.support_efforts.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          ) : (
            <input className={INPUT} value={effort} disabled={!thinkingEnabled} onChange={(event) => setEffort(event.target.value)} placeholder="for example: high" />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={PRIMARY_BUTTON} disabled={busyModel !== null} onClick={() => void saveEffort()}>
              {busyModel === 'effort' ? 'Saving…' : 'Save thinking default'}
            </button>
            <Hint>The server validates the selected model and returns the effective config.</Hint>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

function ModelRow({
  item,
  isDefault,
  busy,
  onSetDefault,
}: {
  item: ModelCatalogItem;
  isDefault: boolean;
  busy: boolean;
  onSetDefault: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-paper px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-ink">{item.display_name ?? item.model}</p>
        <p className="truncate font-mono text-[10.5px] text-ink-faint">
          {item.model} · {item.max_context_size.toLocaleString()} context
          {item.capabilities?.length ? ` · ${item.capabilities.join(', ')}` : ''}
        </p>
      </div>
      <button type="button" onClick={onSetDefault} disabled={isDefault || busy} className={isDefault ? `${SECONDARY_BUTTON} border-success/30 bg-success/10 text-success` : SECONDARY_BUTTON}>
        {isDefault ? 'Default' : busy ? 'Saving…' : 'Set default'}
      </button>
    </div>
  );
}

function ConnectionSection() {
  const { config, meta, wsStatus, socket } = useConnection();
  const isDesktop = isDesktopRuntime();
  const [restarting, setRestarting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const restart = async () => {
    setRestarting(true);
    setFeedback(null);
    try {
      await restartNativeServer();
      clearRestartRequirement();
      setFeedback({ tone: 'success', text: 'The desktop server restarted and passed its authenticated health check.' });
      window.location.reload();
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      setRestarting(false);
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard title="Connected server" badge="Live status">
        <div className="space-y-2 text-[12.5px] text-ink-soft">
          <p>URL: <span className="font-mono text-ink">{config.url}</span></p>
          <p>Version: <span className="font-mono text-ink">{meta.server_version}</span></p>
          <p>Backend: <span className="font-mono text-ink">{meta.backend ?? 'v1'}</span></p>
          <p>WebSocket: <span className={wsStatus === 'open' ? 'font-medium text-success' : 'font-medium text-amber-ink'}>{wsStatus}</span></p>
          <button type="button" onClick={() => socket?.nudge()} className={SECONDARY_BUTTON}>Reconnect now</button>
        </div>
      </SectionCard>

      <SectionCard title="Owned desktop server" badge={isDesktop ? 'Desktop native' : 'Desktop app'}>
        <div className="space-y-3">
          <p className="text-[12.5px] text-ink-soft">
            Kiki desktop owns the sidecar lifecycle. Restart waits for shutdown, launches a new sidecar, and verifies its authenticated endpoint before returning.
          </p>
          <button type="button" className={PRIMARY_BUTTON} disabled={!isDesktop || restarting} onClick={() => void restart()}>
            {restarting ? 'Restarting server…' : 'Restart server'}
          </button>
          {!isDesktop ? <Hint>This action is disabled in the browser build. Open the same settings page in Kiki desktop.</Hint> : null}
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>
    </div>
  );
}

function ProvidersSection() {
  const { client, config: connection } = useConnection();
  const queryClient = useQueryClient();
  const [oauthBusy, setOauthBusy] = useState(false);
  const [defaultProvider, setDefaultProvider] = useState('');
  const [oauthFeedback, setOauthFeedback] = useState<Feedback>(null);

  const authQuery = useQuery({ queryKey: ['auth'], queryFn: () => client.getAuth(), staleTime: 10_000 });
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const oauthQuery = useQuery({ queryKey: ['oauth'], queryFn: () => client.getOAuthStatus(), staleTime: 5000 });

  useEffect(() => {
    const configured = configQuery.data?.default_provider;
    const first = providersQuery.data?.items[0]?.id;
    setDefaultProvider(configured ?? first ?? '');
  }, [configQuery.data?.default_provider, providersQuery.data?.items]);

  const refreshProviderData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['providers'] }),
      queryClient.invalidateQueries({ queryKey: ['models'] }),
      queryClient.invalidateQueries({ queryKey: ['auth'] }),
      queryClient.invalidateQueries({ queryKey: ['config'] }),
    ]);
  };

  const saveDefaultProvider = async () => {
    if (defaultProvider === '') {
      setOauthFeedback({ tone: 'error', text: 'Choose a configured provider.' });
      return;
    }
    setOauthBusy(true);
    setOauthFeedback(null);
    try {
      const echoed = await client.patchConfig({ default_provider: defaultProvider });
      queryClient.setQueryData(['config'], echoed);
      setDefaultProvider(echoed.default_provider ?? defaultProvider);
      setOauthFeedback({ tone: 'success', text: `Server saved default provider ${echoed.default_provider ?? defaultProvider}.` });
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setOauthBusy(false);
    }
  };

  const startOAuth = async () => {
    setOauthBusy(true);
    setOauthFeedback(null);
    try {
      const result = await client.startOAuthLogin();
      setOauthFeedback({ tone: 'success', text: result.status === 'authenticated' ? 'Already authenticated.' : 'Device-code flow started — check your browser.' });
      await refreshProviderData();
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setOauthBusy(false);
    }
  };

  const logout = async () => {
    setOauthBusy(true);
    setOauthFeedback(null);
    try {
      await client.logoutOAuth();
      setOauthFeedback({ tone: 'success', text: 'OAuth credentials removed.' });
      await refreshProviderData();
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setOauthBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard title="Authentication" badge="Server API">
        <div className="space-y-3">
          {authQuery.data !== undefined ? (
            <div className="grid gap-2 text-[12.5px] text-ink-soft sm:grid-cols-2">
              <p>Ready: <span className="text-ink">{authQuery.data.ready ? 'yes' : 'no'}</span></p>
              <p>Providers: <span className="text-ink">{authQuery.data.providers_count}</span></p>
              <p>Default model: <span className="font-mono text-ink">{authQuery.data.default_model ?? 'none'}</span></p>
              <p>Managed auth: <span className="text-ink">{authQuery.data.managed_provider?.status ?? 'none'}</span></p>
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[11px] font-medium text-ink-soft">Default provider
              <select className={`${SMALL_INPUT} ml-2`} value={defaultProvider} onChange={(event) => setDefaultProvider(event.target.value)}>
                {(providersQuery.data?.items ?? []).map((provider) => <option key={provider.id} value={provider.id}>{provider.id}</option>)}
              </select>
            </label>
            <button type="button" disabled={oauthBusy || defaultProvider === ''} onClick={() => void saveDefaultProvider()} className={SECONDARY_BUTTON}>Save default provider</button>
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={oauthBusy} onClick={() => void startOAuth()} className={PRIMARY_BUTTON}>{oauthBusy ? 'Working…' : 'Sign in'}</button>
            <button type="button" disabled={oauthBusy} onClick={() => void logout()} className={SECONDARY_BUTTON}>Sign out</button>
          </div>
          {oauthQuery.data !== null && oauthQuery.data !== undefined ? <Hint>{oauthQuery.data.provider} · {oauthQuery.data.status}</Hint> : null}
          <FeedbackLine feedback={oauthFeedback} />
          {authQuery.isError ? <InlineError error={authQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard title="Configured providers" badge="Server API · live">
        <div className="space-y-4">
          {(providersQuery.data?.items ?? []).map((provider) => (
            <ProviderEditor
              key={provider.id}
              provider={provider}
              models={modelsQuery.data?.items ?? []}
              connection={connection}
              onSaved={refreshProviderData}
            />
          ))}
          {providersQuery.isLoading ? <Hint>Loading providers…</Hint> : null}
          {providersQuery.data?.items.length === 0 ? <Hint>No providers configured yet.</Hint> : null}
          {providersQuery.isError ? <InlineError error={providersQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard title="Add provider" badge="Server API · live">
        <NewProviderForm connection={connection} onSaved={refreshProviderData} />
      </SectionCard>
    </div>
  );
}

function ProviderEditor({
  provider,
  models,
  connection,
  onSaved,
}: {
  provider: ProviderCatalogItem;
  models: readonly ModelCatalogItem[];
  connection: { url: string; token: string };
  onSaved: () => Promise<void>;
}) {
  const initial = useMemo(() => providerDraftFromCatalog(provider, models), [provider, models]);
  const [draft, setDraft] = useState<ProviderDraft | null>(initial);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => setDraft(initial), [initial]);

  if (draft === null) {
    return (
      <div className="rounded-xl border border-hairline bg-paper p-3">
        <p className="text-[13px] font-semibold text-ink">{provider.id}</p>
        <Hint>
          This provider cannot be rewritten safely: PUT /providers/:id only accepts the six built-in wire types and requires complete model metadata, which this catalog entry does not expose.
        </Hint>
      </div>
    );
  }

  const save = async () => {
    const validation = validateProviderDraft(draft);
    if (validation !== null) {
      setFeedback({ tone: 'error', text: validation });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await replaceProvider(connection, provider.id, draft);
      setDraft((current) => current === null ? null : { ...current, apiKey: '', clearApiKey: false });
      await onSaved();
      setFeedback({ tone: 'success', text: `Server saved provider ${echoed.id}. The secret field was cleared locally.` });
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove provider ${provider.id} and its model aliases?`)) return;
    setSaving(true);
    setFeedback(null);
    try {
      await deleteProvider(connection, provider.id);
      await onSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      setSaving(false);
    }
  };

  return (
    <details className="rounded-xl border border-hairline bg-paper p-3" open>
      <summary className="cursor-pointer text-[13px] font-semibold text-ink">
        {provider.id} <span className="font-mono text-[10px] font-normal text-ink-faint">{provider.status}</span>
      </summary>
      <div className="mt-4 space-y-4">
        <ProviderFields draft={draft} onChange={setDraft} hasStoredKey={provider.has_api_key} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save provider'}</button>
          <button type="button" className={`${SECONDARY_BUTTON} text-danger`} disabled={saving} onClick={() => void remove()}>Remove</button>
        </div>
        <FeedbackLine feedback={feedback} />
      </div>
    </details>
  );
}

function NewProviderForm({
  connection,
  onSaved,
}: {
  connection: { url: string; token: string };
  onSaved: () => Promise<void>;
}) {
  const blank = (): ProviderDraft => ({
    id: '',
    type: 'openai',
    baseUrl: '',
    defaultModel: '',
    apiKey: '',
    clearApiKey: false,
    models: [{ model: '', maxContextSize: 128000, displayName: '', capabilities: [], supportEfforts: [] }],
  });
  const [draft, setDraft] = useState<ProviderDraft>(blank);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const save = async () => {
    const normalized = {
      ...draft,
      defaultModel: draft.defaultModel || draft.models[0]?.model || '',
    };
    const validation = validateProviderDraft(normalized);
    if (validation !== null) {
      setFeedback({ tone: 'error', text: validation });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await createProvider(connection, normalized);
      setDraft(blank());
      await onSaved();
      setFeedback({ tone: 'success', text: `Server created provider ${echoed.id}. The secret field was cleared locally.` });
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <ProviderFields draft={draft} onChange={setDraft} hasStoredKey={false} />
      <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? 'Creating…' : 'Create provider'}</button>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

function ProviderFields({
  draft,
  onChange,
  hasStoredKey,
}: {
  draft: ProviderDraft;
  onChange: (draft: ProviderDraft) => void;
  hasStoredKey: boolean;
}) {
  const updateModel = (index: number, patch: Partial<ProviderModelDraft>) => {
    onChange({
      ...draft,
      models: draft.models.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model),
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-[11px] font-medium text-ink-soft">Provider ID
          <input className={`${INPUT} mt-1`} value={draft.id} onChange={(event) => onChange({ ...draft, id: event.target.value })} />
        </label>
        <label className="text-[11px] font-medium text-ink-soft">Protocol
          <select className={`${INPUT} mt-1`} value={draft.type} onChange={(event) => onChange({ ...draft, type: event.target.value as ProviderDraft['type'] })}>
            {PROVIDER_WIRE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-[11px] font-medium text-ink-soft">Base URL
        <input className={`${INPUT} mt-1`} value={draft.baseUrl} onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
      </label>
      <div>
        <label className="block text-[11px] font-medium text-ink-soft">API key
          <input
            type="password"
            autoComplete="new-password"
            className={`${INPUT} mt-1`}
            value={draft.apiKey}
            disabled={draft.clearApiKey}
            onChange={(event) => onChange({ ...draft, apiKey: event.target.value })}
            placeholder={hasStoredKey ? 'Stored key present — leave blank to keep it' : 'Paste a new key'}
          />
        </label>
        <div className="mt-2">
          <Toggle label="Clear stored API key on save" checked={draft.clearApiKey} onChange={(checked) => onChange({ ...draft, clearApiKey: checked, apiKey: '' })} />
        </div>
        <Hint>Existing credentials are never requested or echoed. A newly entered key is cleared from this form after save.</Hint>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium text-ink-soft">Models</p>
          <button type="button" className={SECONDARY_BUTTON} onClick={() => onChange({ ...draft, models: [...draft.models, { model: '', maxContextSize: 128000, displayName: '', capabilities: [], supportEfforts: [] }] })}>Add model</button>
        </div>
        {draft.models.map((model, index) => (
          <div key={`${index}-${model.model}`} className="rounded-lg border border-hairline bg-panel p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <input className={INPUT} aria-label={`Model ${index + 1} ID`} value={model.model} onChange={(event) => updateModel(index, { model: event.target.value })} placeholder="model-id" />
              <input className={INPUT} aria-label={`Model ${index + 1} context size`} type="number" min={1} value={model.maxContextSize} onChange={(event) => updateModel(index, { maxContextSize: Number(event.target.value) })} />
              <input className={INPUT} aria-label={`Model ${index + 1} display name`} value={model.displayName} onChange={(event) => updateModel(index, { displayName: event.target.value })} placeholder="Display name (optional)" />
              <input className={INPUT} aria-label={`Model ${index + 1} capabilities`} value={model.capabilities.join(', ')} onChange={(event) => updateModel(index, { capabilities: commaList(event.target.value) })} placeholder="reasoning, vision" />
              <input className={INPUT} aria-label={`Model ${index + 1} efforts`} value={model.supportEfforts.join(', ')} onChange={(event) => updateModel(index, { supportEfforts: commaList(event.target.value) })} placeholder="low, medium, high" />
              <button type="button" className={`${SECONDARY_BUTTON} text-danger`} disabled={draft.models.length === 1} onClick={() => onChange({ ...draft, models: draft.models.filter((_, modelIndex) => modelIndex !== index) })}>Remove model</button>
            </div>
          </div>
        ))}
      </div>
      <label className="block text-[11px] font-medium text-ink-soft">Provider default model
        <select className={`${INPUT} mt-1`} value={draft.defaultModel} onChange={(event) => onChange({ ...draft, defaultModel: event.target.value })}>
          <option value="">Choose a model</option>
          {draft.models.filter((model) => model.model !== '').map((model) => <option key={model.model} value={model.model}>{model.model}</option>)}
        </select>
      </label>
    </div>
  );
}

function CapabilitiesSection() {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [workspaceId, setWorkspaceId] = useState('');
  const [mergeSkills, setMergeSkills] = useState(true);
  const [extraDirs, setExtraDirs] = useState('');
  const [experimental, setExperimental] = useState('{}');
  const [advanced, setAdvanced] = useState('{}');
  const [telemetry, setTelemetry] = useState(true);
  const [saving, setSaving] = useState(false);
  const [advancedSaving, setAdvancedSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [advancedFeedback, setAdvancedFeedback] = useState<Feedback>(null);

  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  const toolsQuery = useQuery({ queryKey: ['tools'], queryFn: () => client.listTools(), staleTime: 60_000 });
  const mcpQuery = useQuery({ queryKey: ['mcp-servers'], queryFn: () => client.listMcpServers(), staleTime: 60_000 });
  const skillsQuery = useQuery({
    queryKey: ['workspace-skills', workspaceId],
    queryFn: () => client.listWorkspaceSkills(workspaceId),
    enabled: workspaceId !== '',
    staleTime: 60_000,
  });

  const workspaces = workspacesQuery.data?.items ?? [];
  useEffect(() => {
    if (workspaceId === '' && workspaces[0] !== undefined) setWorkspaceId(workspaces[0].id);
  }, [workspaceId, workspaces]);
  useEffect(() => {
    const config = configQuery.data;
    if (config === undefined) return;
    setMergeSkills(config.merge_all_available_skills !== false);
    setExtraDirs((config.extra_skill_dirs ?? []).join('\n'));
    setExperimental(JSON.stringify(config.experimental ?? {}, null, 2));
    setAdvanced(JSON.stringify({
      permission: config.permission ?? {},
      hooks: config.hooks ?? [],
      services: config.services ?? {},
      loop_control: config.loop_control ?? {},
      background: config.background ?? {},
    }, null, 2));
    setTelemetry(config.telemetry !== false);
  }, [configQuery.data]);

  const save = async () => {
    const pathError = validateExtraSkillDirs(extraDirs);
    if (pathError !== null) {
      setFeedback({ tone: 'error', text: pathError });
      return;
    }
    let flags: Record<string, boolean>;
    try {
      flags = parseExperimentalFlags(experimental);
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({
        merge_all_available_skills: mergeSkills,
        extra_skill_dirs: extraDirs.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean),
        experimental: flags,
        telemetry,
      });
      queryClient.setQueryData(['config'], echoed);
      setMergeSkills(echoed.merge_all_available_skills !== false);
      setExtraDirs((echoed.extra_skill_dirs ?? []).join('\n'));
      setExperimental(JSON.stringify(echoed.experimental ?? {}, null, 2));
      setTelemetry(echoed.telemetry !== false);
      setFeedback({ tone: 'success', text: 'Server saved and echoed capability defaults.' });
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const saveAdvanced = async () => {
    let patch;
    try {
      patch = parseAdvancedServerConfig(advanced);
    } catch (error) {
      setAdvancedFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      return;
    }
    setAdvancedSaving(true);
    setAdvancedFeedback(null);
    try {
      const echoed = await client.patchConfig(patch);
      queryClient.setQueryData(['config'], echoed);
      setAdvanced(JSON.stringify({
        permission: echoed.permission ?? {},
        hooks: echoed.hooks ?? [],
        services: echoed.services ?? {},
        loop_control: echoed.loop_control ?? {},
        background: echoed.background ?? {},
      }, null, 2));
      setAdvancedFeedback({ tone: 'success', text: 'Server validated, saved, and echoed the advanced engine domains.' });
    } catch (error) {
      setAdvancedFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setAdvancedSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard title="Skill and experiment defaults" badge="Server API · live">
        <div className="space-y-4">
          <Toggle label="Merge all available skills" checked={mergeSkills} onChange={setMergeSkills} />
          <Toggle label="Enable telemetry" checked={telemetry} onChange={setTelemetry} />
          <label className="block text-[11px] font-medium text-ink-soft">Extra skill directories
            <textarea className={`${INPUT} mt-1 min-h-24 font-mono`} value={extraDirs} onChange={(event) => setExtraDirs(event.target.value)} placeholder={'C:/skills/shared\nC:/skills/team'} />
          </label>
          <label className="block text-[11px] font-medium text-ink-soft">Experimental flag overrides (JSON)
            <textarea className={`${INPUT} mt-1 min-h-32 font-mono`} value={experimental} onChange={(event) => setExperimental(event.target.value)} aria-label="Experimental flag overrides" />
          </label>
          <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save capability defaults'}</button>
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      <SectionCard title="Advanced engine domains" badge="Server API · live">
        <div className="space-y-3">
          <Hint>Edit the protocol-backed permission, hooks, services, loop_control, and background domains. Unknown fields and malformed hook lists are rejected before the request; domain schemas are then validated by kap-server.</Hint>
          <textarea className={`${INPUT} min-h-64 font-mono`} value={advanced} onChange={(event) => setAdvanced(event.target.value)} aria-label="Advanced engine domains" />
          <button type="button" className={PRIMARY_BUTTON} disabled={advancedSaving} onClick={() => void saveAdvanced()}>{advancedSaving ? 'Saving…' : 'Save advanced domains'}</button>
          <FeedbackLine feedback={advancedFeedback} />
        </div>
      </SectionCard>

      <DesktopServerFileCard />

      <SectionCard title="Tools" badge="Server catalog">
        <div className="space-y-2">
          {toolsQuery.data?.tools.map((tool) => <ToolRow key={tool.name} tool={tool} />)}
          {toolsQuery.isLoading ? <Hint>Loading tools…</Hint> : null}
          {toolsQuery.isError ? <InlineError error={toolsQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard title="MCP servers" badge="Server actions">
        <div className="space-y-2">
          {mcpQuery.data?.servers.map((server) => <McpRow key={server.id} server={server} />)}
          {mcpQuery.isLoading ? <Hint>Loading MCP servers…</Hint> : null}
          {mcpQuery.isError ? <InlineError error={mcpQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard title="Workspace skills" badge="Server catalog">
        <div className="mb-3 flex items-center gap-2">
          <label className="text-[11px] font-medium text-ink-soft">Workspace</label>
          <select className={SMALL_INPUT} value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </div>
        <div className="space-y-2">
          {skillsQuery.data?.skills.map((skill) => <SkillRow key={skill.name} skill={skill} />)}
          {skillsQuery.isLoading ? <Hint>Loading skills…</Hint> : null}
          {skillsQuery.isError ? <InlineError error={skillsQuery.error} /> : null}
        </div>
      </SectionCard>
    </div>
  );
}

const EMPTY_DESKTOP_CONFIG: DesktopServerConfig = {
  configPath: '~/.kimi-code/config.toml',
  backupPath: '~/.kimi-code/config.toml.kiki-backup',
  subagent: { defaultModel: '', defaultEffort: '', timeoutMs: 7_200_000 },
  agents: { enabled: true, defaultSubagentModel: '', defaultSubagentReasoningEffort: '' },
  builtinProductSkills: true,
  modelCatalog: { refreshIntervalMs: 0, refreshOnStart: false },
  experimentalEnv: {},
};

function DesktopServerFileCard() {
  const isDesktop = isDesktopRuntime();
  const [config, setConfig] = useState<DesktopServerConfig>(EMPTY_DESKTOP_CONFIG);
  const [restart, setRestart] = useState(readRestartRequirement);
  const [loading, setLoading] = useState(isDesktop);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    void readNativeServerConfig().then(
      (value) => {
        if (!cancelled) {
          setConfig(value);
          setLoading(false);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
          setLoading(false);
        }
      },
    );
    return () => { cancelled = true; };
  }, [isDesktop]);

  const save = async () => {
    const validation = validateDesktopConfigDraft({
      subagentDefaultModel: config.subagent.defaultModel,
      subagentDefaultEffort: config.subagent.defaultEffort,
      subagentTimeoutMs: config.subagent.timeoutMs,
      defaultSubagentModel: config.agents.defaultSubagentModel,
      defaultSubagentReasoningEffort: config.agents.defaultSubagentReasoningEffort,
      modelCatalogRefreshIntervalMs: config.modelCatalog.refreshIntervalMs,
    });
    if (validation !== null) {
      setFeedback({ tone: 'error', text: validation });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await writeNativeServerConfig({
        subagentDefaultModel: config.subagent.defaultModel,
        subagentDefaultEffort: config.subagent.defaultEffort,
        subagentTimeoutMs: config.subagent.timeoutMs,
        agentsEnabled: config.agents.enabled,
        defaultSubagentModel: config.agents.defaultSubagentModel,
        defaultSubagentReasoningEffort: config.agents.defaultSubagentReasoningEffort,
        builtinProductSkills: config.builtinProductSkills,
        modelCatalogRefreshIntervalMs: config.modelCatalog.refreshIntervalMs,
        modelCatalogRefreshOnStart: config.modelCatalog.refreshOnStart,
      });
      setConfig(echoed);
      setRestart(markRestartRequired(['subagent', 'agents', 'builtin_product_skills', 'model_catalog']));
      setFeedback({ tone: 'success', text: `Saved atomically. Backup: ${echoed.backupPath}` });
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const applyRestart = async () => {
    setRestarting(true);
    setFeedback(null);
    try {
      await restartNativeServer();
      setRestart(clearRestartRequirement());
      window.location.reload();
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      setRestarting(false);
    }
  };

  return (
    <SectionCard title="Sidecar-only defaults" badge={restart.required ? 'Restart required' : isDesktop ? 'Desktop file' : 'Desktop app'}>
      <div className="space-y-4">
        {!isDesktop ? (
          <p data-testid="desktop-config-disabled-hint" className="rounded-lg border border-amber-ink/25 bg-amber-ink/5 px-3 py-2 text-[11.5px] text-amber-ink">
            These controls edit ~/.kimi-code/config.toml and are disabled in the browser build. Open Kiki desktop to change them.
          </p>
        ) : null}
        <fieldset disabled={!isDesktop || loading || saving} data-testid="desktop-config-fields" className="space-y-4 disabled:opacity-60">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] font-medium text-ink-soft">Subagent default model
              <input className={`${INPUT} mt-1`} value={config.subagent.defaultModel} onChange={(event) => setConfig({ ...config, subagent: { ...config.subagent, defaultModel: event.target.value } })} placeholder="provider/model" />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">Subagent default effort
              <input className={`${INPUT} mt-1`} value={config.subagent.defaultEffort} onChange={(event) => setConfig({ ...config, subagent: { ...config.subagent, defaultEffort: event.target.value } })} placeholder="high" />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">Subagent timeout (ms)
              <input className={`${INPUT} mt-1`} type="number" min={0} max={86400000} value={config.subagent.timeoutMs} onChange={(event) => setConfig({ ...config, subagent: { ...config.subagent, timeoutMs: Number(event.target.value) } })} />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">Collaboration default model
              <input className={`${INPUT} mt-1`} value={config.agents.defaultSubagentModel} onChange={(event) => setConfig({ ...config, agents: { ...config.agents, defaultSubagentModel: event.target.value } })} placeholder="provider/model" />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">Collaboration default effort
              <input className={`${INPUT} mt-1`} value={config.agents.defaultSubagentReasoningEffort} onChange={(event) => setConfig({ ...config, agents: { ...config.agents, defaultSubagentReasoningEffort: event.target.value } })} placeholder="medium" />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">Catalog refresh interval (ms)
              <input className={`${INPUT} mt-1`} type="number" min={0} value={config.modelCatalog.refreshIntervalMs} onChange={(event) => setConfig({ ...config, modelCatalog: { ...config.modelCatalog, refreshIntervalMs: Number(event.target.value) } })} />
            </label>
          </div>
          <Toggle label="Enable agent collaboration" checked={config.agents.enabled} disabled={!isDesktop} onChange={(checked) => setConfig({ ...config, agents: { ...config.agents, enabled: checked } })} />
          <Toggle label="Include built-in product skills" checked={config.builtinProductSkills} disabled={!isDesktop} onChange={(checked) => setConfig({ ...config, builtinProductSkills: checked })} />
          <Toggle label="Refresh model catalog when the server starts" checked={config.modelCatalog.refreshOnStart} disabled={!isDesktop} onChange={(checked) => setConfig({ ...config, modelCatalog: { ...config.modelCatalog, refreshOnStart: checked } })} />
        </fieldset>
        <Hint>Writes are validated against the documented config sections, backed up first, and atomically replace {config.configPath}. Applies after server restart.</Hint>
        {Object.keys(config.experimentalEnv).length > 0 ? (
          <div className="rounded-lg border border-hairline bg-paper p-3">
            <p className="mb-2 text-[11px] font-semibold text-ink">Environment overrides in effect</p>
            {Object.entries(config.experimentalEnv).map(([name, value]) => <p key={name} className="font-mono text-[10px] text-ink-faint">{name}={value}</p>)}
            <Hint>Environment gates override the matching [experimental] value until the sidecar environment changes.</Hint>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={PRIMARY_BUTTON} disabled={!isDesktop || loading || saving} onClick={() => void save()}>{saving ? 'Saving file…' : 'Save sidecar defaults'}</button>
          <button type="button" className={SECONDARY_BUTTON} disabled={!isDesktop || !restart.required || restarting} onClick={() => void applyRestart()}>{restarting ? 'Restarting…' : 'Apply & restart server'}</button>
          {!isDesktop && restart.required ? <button type="button" className={SECONDARY_BUTTON} onClick={() => setRestart(clearRestartRequirement())}>Acknowledge restart notice</button> : null}
        </div>
        {restart.required ? <Hint>Pending fields: {restart.fields.join(', ')}. This badge remains until a verified desktop restart or explicit browser acknowledgement.</Hint> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

function ToolRow({ tool }: { tool: ToolDescriptor }) {
  return <div className="rounded-lg border border-hairline bg-paper px-3 py-2"><p className="text-[13px] font-medium text-ink">{tool.name}</p><p className="text-[11px] text-ink-soft">{tool.description}</p><p className="mt-0.5 font-mono text-[10px] text-ink-faint">source: {tool.source}</p></div>;
}

function McpRow({ server }: { server: McpServer }) {
  const { client } = useConnection();
  const [restarting, setRestarting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const restart = async () => {
    setRestarting(true);
    setFeedback(null);
    try {
      await client.restartMcpServer(server.id);
      setFeedback({ tone: 'success', text: 'Restart requested.' });
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setRestarting(false);
    }
  };
  return (
    <div className="rounded-lg border border-hairline bg-paper px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><p className="truncate text-[13px] font-medium text-ink">{server.name}</p><p className="truncate font-mono text-[10.5px] text-ink-faint">{server.transport} · {server.status} · {server.tool_count} tools</p></div>
        <button type="button" disabled={restarting} onClick={() => void restart()} className={SECONDARY_BUTTON}>{restarting ? 'Restarting…' : 'Restart'}</button>
      </div>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

function SkillRow({ skill }: { skill: SkillDescriptor }) {
  return <div className="rounded-lg border border-hairline bg-paper px-3 py-2"><p className="text-[13px] font-medium text-ink">{skill.name}</p><p className="text-[11px] text-ink-soft">{skill.description}</p><p className="mt-0.5 font-mono text-[10px] text-ink-faint">{skill.path}</p></div>;
}

function WorkspacesSection() {
  const { client } = useConnection();
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  return (
    <SectionCard title="Workspaces" badge="Server catalog">
      <div className="space-y-2">
        {query.data?.items.map((workspace) => (
          <div key={workspace.id} className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-paper px-3 py-2">
            <div className="min-w-0"><p className="truncate text-[13px] font-medium text-ink">{workspace.name}</p><p className="truncate font-mono text-[10.5px] text-ink-faint">{workspace.root}</p></div>
            <button type="button" onClick={() => navigate(`/new?workspace=${encodeURIComponent(workspace.id)}`)} className={SECONDARY_BUTTON}>New session</button>
          </div>
        ))}
        {query.isLoading ? <Hint>Loading workspaces…</Hint> : null}
        {query.isError ? <InlineError error={query.error} /> : null}
        <Hint>Workspace roots are discovered and managed by the server. This page exposes the real action available for each entry instead of a fake edit form.</Hint>
      </div>
    </SectionCard>
  );
}

function AboutSection() {
  const { meta } = useConnection();
  const guiVersion = import.meta.env['VITE_APP_VERSION'] ?? '0.0.0-dev';
  return (
    <SectionCard title="About" badge="Build info">
      <div className="space-y-2 text-[12.5px] text-ink-soft">
        <p>Kiki GUI: <span className="font-mono text-ink">{guiVersion}</span></p>
        <p>Server version: <span className="font-mono text-ink">{meta.server_version}</span></p>
        <p>Server ID: <span className="font-mono text-ink">{meta.server_id}</span></p>
        <p>Backend: <span className="font-mono text-ink">{meta.backend ?? 'v1'}</span></p>
      </div>
    </SectionCard>
  );
}

function SettingsNav({ active }: { active: SectionId }) {
  const navigate = useNavigate();
  return (
    <nav className="flex h-full w-full flex-col border-r border-hairline bg-panel p-2 lg:w-[200px]">
      {SECTIONS.map((section) => (
        <button key={section.id} type="button" onClick={() => navigate(`/settings/${section.id}`)} className={`rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${active === section.id ? 'bg-accent-soft font-medium text-accent' : 'text-ink-soft hover:bg-paper hover:text-ink'}`}>{section.label}</button>
      ))}
    </nav>
  );
}

export function SettingsPage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { section } = useParams<{ section?: string }>();
  const active: SectionId = SECTIONS.find((candidate) => candidate.id === section)?.id ?? 'general';
  const navigate = useNavigate();
  const pane = active === 'general' ? <GeneralSection /> : active === 'models' ? <ModelsSection /> : active === 'connection' ? <ConnectionSection /> : active === 'providers' ? <ProvidersSection /> : active === 'capabilities' ? <CapabilitiesSection /> : active === 'workspaces' ? <WorkspacesSection /> : <AboutSection />;

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
        <button type="button" onClick={onToggleSidebar} aria-label="Open session menu" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"><span aria-hidden>☰</span></button>
        <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">Settings</h1>
      </header>
      <main className="flex min-h-0 flex-1">
        <div className="hidden lg:block"><SettingsNav active={active} /></div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-hairline bg-panel px-4 py-2 lg:hidden">
            <select className="w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent" value={active} onChange={(event) => navigate(`/settings/${event.target.value}`)}>
              {SECTIONS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            </select>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8"><div className="mx-auto max-w-[760px] space-y-5">{pane}</div></div>
        </div>
      </main>
    </>
  );
}

function commaList(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
