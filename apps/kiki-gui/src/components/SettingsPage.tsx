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
import { useI18n } from '../i18n';
import { errorText, issueText, type I18nKey, type Locale } from '../i18n/locale';
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

const SECTIONS: readonly { id: string; labelKey: I18nKey }[] = [
  { id: 'general', labelKey: 'st.section.general' },
  { id: 'models', labelKey: 'st.section.models' },
  { id: 'connection', labelKey: 'st.section.connection' },
  { id: 'providers', labelKey: 'st.section.providers' },
  { id: 'capabilities', labelKey: 'st.section.capabilities' },
  { id: 'workspaces', labelKey: 'st.section.workspaces' },
  { id: 'about', labelKey: 'st.section.about' },
];

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
        onChange={(event) => { onChange(event.target.checked); }}
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
  const { t, locale, setLocale } = useI18n();
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
      setFeedback({ tone: 'error', text: issueText(locale, validation) });
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
        text: t('st.defaults.savedEcho', {
          permission: echoedMode ?? 'manual',
          plan: echoedPlan ? t('st.defaults.planOn') : t('st.defaults.planOff'),
        }),
      });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
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
      <SectionCard title={t('st.language.title')} badge={t('st.badge.thisDevice')}>
        <div className="space-y-3">
          <div>
            <label htmlFor="language-select" className="mb-1.5 block text-[11px] font-medium text-ink-soft">
              {t('st.language.title')}
            </label>
            <select
              id="language-select"
              className={SMALL_INPUT}
              value={locale}
              onChange={(event) => { setLocale(event.target.value as Locale); }}
            >
              <option value="en">English</option>
              <option value="zh">中文</option>
            </select>
          </div>
          <Hint>{t('st.language.hint')}</Hint>
        </div>
      </SectionCard>

      <SectionCard title={t('st.defaults.title')} badge={t('st.badge.serverLive')}>
        <div className="space-y-4">
          <div>
            <span id="default-permission-mode-label" className="mb-1.5 block text-[11px] font-medium text-ink-soft">{t('st.defaults.permissionMode')}</span>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby="default-permission-mode-label">
              {(['manual', 'auto', 'yolo'] as PermissionMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => { setPermissionMode(mode); }}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                    permissionMode === mode
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-hairline text-ink-soft hover:border-hairline-strong'
                  }`}
                >
                  {t(`composer.mode.${mode}`)}
                </button>
              ))}
            </div>
          </div>
          <Toggle label={t('st.defaults.planMode')} checked={planMode} onChange={setPlanMode} />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void saveServerDefaults()}>
              {saving ? t('common.saving') : t('st.defaults.save')}
            </button>
            <Hint>{t('st.defaults.hint')}</Hint>
          </div>
          <FeedbackLine feedback={feedback} />
          {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard title={t('st.composer.title')} badge={t('st.badge.thisDevice')}>
        <div className="space-y-4">
          <div>
            <label htmlFor="send-shortcut-select" className="mb-1.5 block text-[11px] font-medium text-ink-soft">{t('st.composer.sendShortcut')}</label>
            <select
              id="send-shortcut-select"
              className={SMALL_INPUT}
              value={settings.sendShortcut}
              onChange={(event) => { updateLocal({ sendShortcut: event.target.value as SendShortcut }); }}
            >
              <option value="enter">{t('st.composer.shortcutEnter')}</option>
              <option value="cmd-enter">{t('st.composer.shortcutCmdEnter')}</option>
            </select>
          </div>
          <Toggle
            label={t('st.composer.persistDrafts')}
            checked={settings.draftPersistence}
            onChange={(checked) => { updateLocal({ draftPersistence: checked }); }}
          />
        </div>
      </SectionCard>

      <SectionCard title={t('st.desktop.title')} badge={isDesktop ? t('st.badge.thisDevice') : t('st.badge.desktopApp')}>
        <fieldset disabled={!isDesktop} className="space-y-4">
          <Toggle
            label={t('st.desktop.notifications')}
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
            {([
              { closeToTray: true, titleKey: 'st.desktop.tray', descriptionKey: 'st.desktop.trayDesc' },
              { closeToTray: false, titleKey: 'st.desktop.quit', descriptionKey: 'st.desktop.quitDesc' },
            ] as const).map((option) => (
              <label
                key={option.titleKey}
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
                    <span className="block text-[12.5px] font-semibold text-ink">{t(option.titleKey)}</span>
                    <span className="mt-0.5 block text-[11px] text-ink-faint">{t(option.descriptionKey)}</span>
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {!isDesktop ? <Hint>{t('st.desktop.browserHint')}</Hint> : null}
      </SectionCard>
    </div>
  );
}

function ModelsSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
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
      setFeedback({ tone: 'success', text: t('st.models.savedEcho', { model: echoed.default_model }) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusyModel(null);
    }
  };

  const saveEffort = async () => {
    if (thinkingEnabled && effort.trim() === '') {
      setFeedback({ tone: 'error', text: t('st.thinking.emptyError') });
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
      setFeedback({
        tone: 'success',
        text: echoedEnabled
          ? t('st.thinking.savedAt', { effort: echoedEffort })
          : t('st.thinking.savedOff'),
      });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusyModel(null);
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard title={t('st.models.defaultTitle')} badge={t('st.badge.serverLive')}>
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
          {modelsQuery.isLoading ? <Hint>{t('st.models.loading')}</Hint> : null}
          {modelsQuery.isError ? <InlineError error={modelsQuery.error} /> : null}
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      <SectionCard title={t('st.thinking.title')} badge={t('st.badge.serverLive')}>
        <div className="space-y-3">
          <Toggle label={t('st.thinking.enable')} checked={thinkingEnabled} onChange={setThinkingEnabled} />
          {defaultItem?.support_efforts !== undefined && defaultItem.support_efforts.length > 0 ? (
            <select className={SMALL_INPUT} value={effort} disabled={!thinkingEnabled} onChange={(event) => { setEffort(event.target.value); }}>
              {defaultItem.support_efforts.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          ) : (
            <input className={INPUT} value={effort} disabled={!thinkingEnabled} onChange={(event) => { setEffort(event.target.value); }} placeholder={t('st.thinking.placeholder')} />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={PRIMARY_BUTTON} disabled={busyModel !== null} onClick={() => void saveEffort()}>
              {busyModel === 'effort' ? t('common.saving') : t('st.thinking.save')}
            </button>
            <Hint>{t('st.thinking.hint')}</Hint>
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
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-paper px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-ink">{item.display_name ?? item.model}</p>
        <p className="truncate font-mono text-[10.5px] text-ink-faint">
          {item.model} · {item.max_context_size.toLocaleString()} {t('st.models.context')}
          {item.capabilities?.length ? ` · ${item.capabilities.join(', ')}` : ''}
        </p>
      </div>
      <button type="button" onClick={onSetDefault} disabled={isDefault || busy} className={isDefault ? `${SECONDARY_BUTTON} border-success/30 bg-success/10 text-success` : SECONDARY_BUTTON}>
        {isDefault ? t('st.models.default') : busy ? t('common.saving') : t('st.models.setDefault')}
      </button>
    </div>
  );
}

function ConnectionSection() {
  const { config, meta, wsStatus, socket } = useConnection();
  const { t, locale } = useI18n();
  const isDesktop = isDesktopRuntime();
  const [restarting, setRestarting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const restart = async () => {
    setRestarting(true);
    setFeedback(null);
    try {
      await restartNativeServer();
      clearRestartRequirement();
      setFeedback({ tone: 'success', text: t('st.conn.restarted') });
      window.location.reload();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      setRestarting(false);
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard title={t('st.conn.connectedTitle')} badge={t('st.badge.liveStatus')}>
        <div className="space-y-2 text-[12.5px] text-ink-soft">
          <p>URL: <span className="font-mono text-ink">{config.url}</span></p>
          <p>{t('st.conn.version')}: <span className="font-mono text-ink">{meta.server_version}</span></p>
          <p>{t('st.conn.backend')}: <span className="font-mono text-ink">{meta.backend ?? 'v1'}</span></p>
          <p>WebSocket: <span className={wsStatus === 'open' ? 'font-medium text-success' : 'font-medium text-amber-ink'}>{wsStatus}</span></p>
          <button type="button" onClick={() => { socket?.nudge(); }} className={SECONDARY_BUTTON}>{t('st.conn.reconnect')}</button>
        </div>
      </SectionCard>

      <SectionCard title={t('st.conn.ownedTitle')} badge={isDesktop ? t('st.badge.desktopNative') : t('st.badge.desktopApp')}>
        <div className="space-y-3">
          <p className="text-[12.5px] text-ink-soft">
            {t('st.conn.ownedBody')}
          </p>
          <button type="button" className={PRIMARY_BUTTON} disabled={!isDesktop || restarting} onClick={() => void restart()}>
            {restarting ? t('st.conn.restarting') : t('st.conn.restart')}
          </button>
          {!isDesktop ? <Hint>{t('st.conn.browserHint')}</Hint> : null}
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>
    </div>
  );
}

function ProvidersSection() {
  const { client, config: connection } = useConnection();
  const { t, locale } = useI18n();
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
      setOauthFeedback({ tone: 'error', text: t('st.auth.chooseProvider') });
      return;
    }
    setOauthBusy(true);
    setOauthFeedback(null);
    try {
      const echoed = await client.patchConfig({ default_provider: defaultProvider });
      queryClient.setQueryData(['config'], echoed);
      setDefaultProvider(echoed.default_provider ?? defaultProvider);
      setOauthFeedback({
        tone: 'success',
        text: t('st.auth.savedEcho', { provider: echoed.default_provider ?? defaultProvider }),
      });
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setOauthBusy(false);
    }
  };

  const startOAuth = async () => {
    setOauthBusy(true);
    setOauthFeedback(null);
    try {
      const result = await client.startOAuthLogin();
      setOauthFeedback({
        tone: 'success',
        text: result.status === 'authenticated' ? t('st.auth.already') : t('st.auth.deviceFlow'),
      });
      await refreshProviderData();
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setOauthBusy(false);
    }
  };

  const logout = async () => {
    setOauthBusy(true);
    setOauthFeedback(null);
    try {
      await client.logoutOAuth();
      setOauthFeedback({ tone: 'success', text: t('st.auth.removed') });
      await refreshProviderData();
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setOauthBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard title={t('st.auth.title')} badge={t('st.badge.serverApi')}>
        <div className="space-y-3">
          {authQuery.data !== undefined ? (
            <div className="grid gap-2 text-[12.5px] text-ink-soft sm:grid-cols-2">
              <p>{t('st.auth.ready')}: <span className="text-ink">{authQuery.data.ready ? t('st.auth.yes') : t('st.auth.no')}</span></p>
              <p>{t('st.auth.providers')}: <span className="text-ink">{authQuery.data.providers_count}</span></p>
              <p>{t('st.auth.defaultModel')}: <span className="font-mono text-ink">{authQuery.data.default_model ?? t('st.auth.none')}</span></p>
              <p>{t('st.auth.managedAuth')}: <span className="text-ink">{authQuery.data.managed_provider?.status ?? t('st.auth.none')}</span></p>
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[11px] font-medium text-ink-soft">{t('st.auth.defaultProvider')}
              <select className={`${SMALL_INPUT} ml-2`} value={defaultProvider} onChange={(event) => { setDefaultProvider(event.target.value); }}>
                {(providersQuery.data?.items ?? []).map((provider) => <option key={provider.id} value={provider.id}>{provider.id}</option>)}
              </select>
            </label>
            <button type="button" disabled={oauthBusy || defaultProvider === ''} onClick={() => void saveDefaultProvider()} className={SECONDARY_BUTTON}>{t('st.auth.saveDefault')}</button>
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={oauthBusy} onClick={() => void startOAuth()} className={PRIMARY_BUTTON}>{oauthBusy ? t('st.auth.working') : t('st.auth.signIn')}</button>
            <button type="button" disabled={oauthBusy} onClick={() => void logout()} className={SECONDARY_BUTTON}>{t('st.auth.signOut')}</button>
          </div>
          {oauthQuery.data !== null && oauthQuery.data !== undefined ? <Hint>{oauthQuery.data.provider} · {oauthQuery.data.status}</Hint> : null}
          <FeedbackLine feedback={oauthFeedback} />
          {authQuery.isError ? <InlineError error={authQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard title={t('st.providers.title')} badge={t('st.badge.serverLive')}>
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
          {providersQuery.isLoading ? <Hint>{t('st.providers.loading')}</Hint> : null}
          {providersQuery.data?.items.length === 0 ? <Hint>{t('st.providers.empty')}</Hint> : null}
          {providersQuery.isError ? <InlineError error={providersQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard title={t('st.providers.addTitle')} badge={t('st.badge.serverLive')}>
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
  const { t, locale } = useI18n();
  const initial = useMemo(() => providerDraftFromCatalog(provider, models), [provider, models]);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => { setDraft(initial); }, [initial]);

  if (draft === null) {
    return (
      <div className="rounded-xl border border-hairline bg-paper p-3">
        <p className="text-[13px] font-semibold text-ink">{provider.id}</p>
        <Hint>
          {t('st.providers.cannotRewrite')}
        </Hint>
      </div>
    );
  }

  const save = async () => {
    const validation = validateProviderDraft(draft);
    if (validation !== null) {
      setFeedback({ tone: 'error', text: issueText(locale, validation) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await replaceProvider(connection, provider.id, draft);
      setDraft((current) => current === null ? null : { ...current, apiKey: '', clearApiKey: false });
      await onSaved();
      setFeedback({ tone: 'success', text: t('st.providers.savedEcho', { id: echoed.id }) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t('st.providers.removeConfirm', { id: provider.id }))) return;
    setSaving(true);
    setFeedback(null);
    try {
      await deleteProvider(connection, provider.id);
      await onSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
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
          <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('common.saving') : t('st.providers.save')}</button>
          <button type="button" className={`${SECONDARY_BUTTON} text-danger`} disabled={saving} onClick={() => void remove()}>{t('common.remove')}</button>
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
  const { t, locale } = useI18n();
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
      defaultModel: draft.defaultModel || (draft.models[0]?.model ?? ''),
    };
    const validation = validateProviderDraft(normalized);
    if (validation !== null) {
      setFeedback({ tone: 'error', text: issueText(locale, validation) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await createProvider(connection, normalized);
      setDraft(blank());
      await onSaved();
      setFeedback({ tone: 'success', text: t('st.providers.createdEcho', { id: echoed.id }) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <ProviderFields draft={draft} onChange={setDraft} hasStoredKey={false} />
      <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('st.providers.creating') : t('st.providers.create')}</button>
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
  const { t } = useI18n();
  const updateModel = (index: number, patch: Partial<ProviderModelDraft>) => {
    onChange({
      ...draft,
      models: draft.models.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model),
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-[11px] font-medium text-ink-soft">{t('st.providers.idLabel')}
          <input className={`${INPUT} mt-1`} value={draft.id} onChange={(event) => { onChange({ ...draft, id: event.target.value }); }} />
        </label>
        <label className="text-[11px] font-medium text-ink-soft">{t('st.providers.protocol')}
          <select className={`${INPUT} mt-1`} value={draft.type} onChange={(event) => { onChange({ ...draft, type: event.target.value as ProviderDraft['type'] }); }}>
            {PROVIDER_WIRE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-[11px] font-medium text-ink-soft">{t('st.providers.baseUrl')}
        <input className={`${INPUT} mt-1`} value={draft.baseUrl} onChange={(event) => { onChange({ ...draft, baseUrl: event.target.value }); }} placeholder="https://api.example.com/v1" />
      </label>
      <div>
        <label className="block text-[11px] font-medium text-ink-soft">{t('st.providers.apiKey')}
          <input
            type="password"
            autoComplete="new-password"
            className={`${INPUT} mt-1`}
            value={draft.apiKey}
            disabled={draft.clearApiKey}
            onChange={(event) => { onChange({ ...draft, apiKey: event.target.value }); }}
            placeholder={hasStoredKey ? t('st.providers.keyStored') : t('st.providers.keyNew')}
          />
        </label>
        <div className="mt-2">
          <Toggle label={t('st.providers.clearKey')} checked={draft.clearApiKey} onChange={(checked) => { onChange({ ...draft, clearApiKey: checked, apiKey: '' }); }} />
        </div>
        <Hint>{t('st.providers.keyHint')}</Hint>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium text-ink-soft">{t('st.providers.models')}</p>
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { onChange({ ...draft, models: [...draft.models, { model: '', maxContextSize: 128000, displayName: '', capabilities: [], supportEfforts: [] }] }); }}>{t('st.providers.addModel')}</button>
        </div>
        {draft.models.map((model, index) => (
          <div key={`${index}-${model.model}`} className="rounded-lg border border-hairline bg-panel p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <input className={INPUT} aria-label={t('st.providers.modelIdAria', { n: index + 1 })} value={model.model} onChange={(event) => { updateModel(index, { model: event.target.value }); }} placeholder="model-id" />
              <input className={INPUT} aria-label={t('st.providers.modelContextAria', { n: index + 1 })} type="number" min={1} value={model.maxContextSize} onChange={(event) => { updateModel(index, { maxContextSize: Number(event.target.value) }); }} />
              <input className={INPUT} aria-label={t('st.providers.modelNameAria', { n: index + 1 })} value={model.displayName} onChange={(event) => { updateModel(index, { displayName: event.target.value }); }} placeholder={t('st.providers.displayNamePlaceholder')} />
              <input className={INPUT} aria-label={t('st.providers.modelCapsAria', { n: index + 1 })} value={model.capabilities.join(', ')} onChange={(event) => { updateModel(index, { capabilities: commaList(event.target.value) }); }} placeholder="reasoning, vision" />
              <input className={INPUT} aria-label={t('st.providers.modelEffortsAria', { n: index + 1 })} value={model.supportEfforts.join(', ')} onChange={(event) => { updateModel(index, { supportEfforts: commaList(event.target.value) }); }} placeholder="low, medium, high" />
              <button type="button" className={`${SECONDARY_BUTTON} text-danger`} disabled={draft.models.length === 1} onClick={() => { onChange({ ...draft, models: draft.models.filter((_, modelIndex) => modelIndex !== index) }); }}>{t('st.providers.removeModel')}</button>
            </div>
          </div>
        ))}
      </div>
      <label className="block text-[11px] font-medium text-ink-soft">{t('st.providers.defaultModel')}
        <select className={`${INPUT} mt-1`} value={draft.defaultModel} onChange={(event) => { onChange({ ...draft, defaultModel: event.target.value }); }}>
          <option value="">{t('st.providers.chooseModel')}</option>
          {draft.models.filter((model) => model.model !== '').map((model) => <option key={model.model} value={model.model}>{model.model}</option>)}
        </select>
      </label>
    </div>
  );
}

function CapabilitiesSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
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
      setFeedback({ tone: 'error', text: issueText(locale, pathError) });
      return;
    }
    let flags: Record<string, boolean>;
    try {
      flags = parseExperimentalFlags(experimental);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
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
      setFeedback({ tone: 'success', text: t('st.caps.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const saveAdvanced = async () => {
    let patch;
    try {
      patch = parseAdvancedServerConfig(advanced);
    } catch (error) {
      setAdvancedFeedback({ tone: 'error', text: errorText(locale, error) });
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
      setAdvancedFeedback({ tone: 'success', text: t('st.advanced.saved') });
    } catch (error) {
      setAdvancedFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setAdvancedSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard title={t('st.caps.title')} badge={t('st.badge.serverLive')}>
        <div className="space-y-4">
          <Toggle label={t('st.caps.mergeSkills')} checked={mergeSkills} onChange={setMergeSkills} />
          <Toggle label={t('st.caps.telemetry')} checked={telemetry} onChange={setTelemetry} />
          <label className="block text-[11px] font-medium text-ink-soft">{t('st.caps.extraDirs')}
            <textarea className={`${INPUT} mt-1 min-h-24 font-mono`} value={extraDirs} onChange={(event) => { setExtraDirs(event.target.value); }} placeholder={'C:/skills/shared\nC:/skills/team'} />
          </label>
          <label className="block text-[11px] font-medium text-ink-soft">{t('st.caps.experimental')}
            <textarea className={`${INPUT} mt-1 min-h-32 font-mono`} value={experimental} onChange={(event) => { setExperimental(event.target.value); }} aria-label={t('st.caps.experimentalAria')} />
          </label>
          <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('common.saving') : t('st.caps.save')}</button>
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      <SectionCard title={t('st.advanced.title')} badge={t('st.badge.serverLive')}>
        <div className="space-y-3">
          <Hint>{t('st.advanced.hint')}</Hint>
          <textarea className={`${INPUT} min-h-64 font-mono`} value={advanced} onChange={(event) => { setAdvanced(event.target.value); }} aria-label={t('st.advanced.aria')} />
          <button type="button" className={PRIMARY_BUTTON} disabled={advancedSaving} onClick={() => void saveAdvanced()}>{advancedSaving ? t('common.saving') : t('st.advanced.save')}</button>
          <FeedbackLine feedback={advancedFeedback} />
        </div>
      </SectionCard>

      <DesktopServerFileCard />

      <SectionCard title={t('st.tools.title')} badge={t('st.badge.serverCatalog')}>
        <div className="space-y-2">
          {toolsQuery.data?.tools.map((tool) => <ToolRow key={tool.name} tool={tool} />)}
          {toolsQuery.isLoading ? <Hint>{t('st.tools.loading')}</Hint> : null}
          {toolsQuery.isError ? <InlineError error={toolsQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard title={t('st.mcp.title')} badge={t('st.badge.serverActions')}>
        <div className="space-y-2">
          {mcpQuery.data?.servers.map((server) => <McpRow key={server.id} server={server} />)}
          {mcpQuery.isLoading ? <Hint>{t('st.mcp.loading')}</Hint> : null}
          {mcpQuery.isError ? <InlineError error={mcpQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard title={t('st.skills.title')} badge={t('st.badge.serverCatalog')}>
        <div className="mb-3 flex items-center gap-2">
          <label htmlFor="workspace-skills-select" className="text-[11px] font-medium text-ink-soft">{t('st.skills.workspace')}</label>
          <select id="workspace-skills-select" className={SMALL_INPUT} value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); }}>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </div>
        <div className="space-y-2">
          {skillsQuery.data?.skills.map((skill) => <SkillRow key={skill.name} skill={skill} />)}
          {skillsQuery.isLoading ? <Hint>{t('st.skills.loading')}</Hint> : null}
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
  const { t, locale } = useI18n();
  const [config, setConfig] = useState(EMPTY_DESKTOP_CONFIG);
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
          setFeedback({ tone: 'error', text: errorText(locale, error) });
          setLoading(false);
        }
      },
    );
    return () => { cancelled = true; };
  }, [isDesktop, locale]);

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
      setFeedback({ tone: 'error', text: issueText(locale, validation) });
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
      setFeedback({ tone: 'success', text: t('st.sidecar.savedEcho', { path: echoed.backupPath }) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
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
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      setRestarting(false);
    }
  };

  return (
    <SectionCard title={t('st.sidecar.title')} badge={restart.required ? t('st.badge.restartRequired') : isDesktop ? t('st.badge.desktopFile') : t('st.badge.desktopApp')}>
      <div className="space-y-4">
        {!isDesktop ? (
          <p data-testid="desktop-config-disabled-hint" className="rounded-lg border border-amber-ink/25 bg-amber-ink/5 px-3 py-2 text-[11.5px] text-amber-ink">
            {t('st.sidecar.disabledHint')}
          </p>
        ) : null}
        <fieldset disabled={!isDesktop || loading || saving} data-testid="desktop-config-fields" className="space-y-4 disabled:opacity-60">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] font-medium text-ink-soft">{t('st.sidecar.subagentModel')}
              <input className={`${INPUT} mt-1`} value={config.subagent.defaultModel} onChange={(event) => { setConfig({ ...config, subagent: { ...config.subagent, defaultModel: event.target.value } }); }} placeholder="provider/model" />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">{t('st.sidecar.subagentEffort')}
              <input className={`${INPUT} mt-1`} value={config.subagent.defaultEffort} onChange={(event) => { setConfig({ ...config, subagent: { ...config.subagent, defaultEffort: event.target.value } }); }} placeholder="high" />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">{t('st.sidecar.subagentTimeout')}
              <input className={`${INPUT} mt-1`} type="number" min={0} max={86400000} value={config.subagent.timeoutMs} onChange={(event) => { setConfig({ ...config, subagent: { ...config.subagent, timeoutMs: Number(event.target.value) } }); }} />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">{t('st.sidecar.collabModel')}
              <input className={`${INPUT} mt-1`} value={config.agents.defaultSubagentModel} onChange={(event) => { setConfig({ ...config, agents: { ...config.agents, defaultSubagentModel: event.target.value } }); }} placeholder="provider/model" />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">{t('st.sidecar.collabEffort')}
              <input className={`${INPUT} mt-1`} value={config.agents.defaultSubagentReasoningEffort} onChange={(event) => { setConfig({ ...config, agents: { ...config.agents, defaultSubagentReasoningEffort: event.target.value } }); }} placeholder="medium" />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">{t('st.sidecar.catalogInterval')}
              <input className={`${INPUT} mt-1`} type="number" min={0} value={config.modelCatalog.refreshIntervalMs} onChange={(event) => { setConfig({ ...config, modelCatalog: { ...config.modelCatalog, refreshIntervalMs: Number(event.target.value) } }); }} />
            </label>
          </div>
          <Toggle label={t('st.sidecar.enableCollab')} checked={config.agents.enabled} disabled={!isDesktop} onChange={(checked) => { setConfig({ ...config, agents: { ...config.agents, enabled: checked } }); }} />
          <Toggle label={t('st.sidecar.builtinSkills')} checked={config.builtinProductSkills} disabled={!isDesktop} onChange={(checked) => { setConfig({ ...config, builtinProductSkills: checked }); }} />
          <Toggle label={t('st.sidecar.refreshOnStart')} checked={config.modelCatalog.refreshOnStart} disabled={!isDesktop} onChange={(checked) => { setConfig({ ...config, modelCatalog: { ...config.modelCatalog, refreshOnStart: checked } }); }} />
        </fieldset>
        <Hint>{t('st.sidecar.hint', { path: config.configPath })}</Hint>
        {Object.keys(config.experimentalEnv).length > 0 ? (
          <div className="rounded-lg border border-hairline bg-paper p-3">
            <p className="mb-2 text-[11px] font-semibold text-ink">{t('st.sidecar.envTitle')}</p>
            {Object.entries(config.experimentalEnv).map(([name, value]) => <p key={name} className="font-mono text-[10px] text-ink-faint">{name}={value}</p>)}
            <Hint>{t('st.sidecar.envHint')}</Hint>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={PRIMARY_BUTTON} disabled={!isDesktop || loading || saving} onClick={() => void save()}>{saving ? t('st.sidecar.saving') : t('st.sidecar.save')}</button>
          <button type="button" className={SECONDARY_BUTTON} disabled={!isDesktop || !restart.required || restarting} onClick={() => void applyRestart()}>{restarting ? t('st.sidecar.restarting') : t('st.sidecar.applyRestart')}</button>
          {!isDesktop && restart.required ? <button type="button" className={SECONDARY_BUTTON} onClick={() => { setRestart(clearRestartRequirement()); }}>{t('st.sidecar.acknowledge')}</button> : null}
        </div>
        {restart.required ? <Hint>{t('st.sidecar.pendingFields', { fields: restart.fields.join(', ') })}</Hint> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

function ToolRow({ tool }: { tool: ToolDescriptor }) {
  const { t } = useI18n();
  return <div className="rounded-lg border border-hairline bg-paper px-3 py-2"><p className="text-[13px] font-medium text-ink">{tool.name}</p><p className="text-[11px] text-ink-soft">{tool.description}</p><p className="mt-0.5 font-mono text-[10px] text-ink-faint">{t('st.tools.source', { source: tool.source })}</p></div>;
}

function McpRow({ server }: { server: McpServer }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [restarting, setRestarting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const restart = async () => {
    setRestarting(true);
    setFeedback(null);
    try {
      await client.restartMcpServer(server.id);
      setFeedback({ tone: 'success', text: t('st.mcp.restartRequested') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRestarting(false);
    }
  };
  return (
    <div className="rounded-lg border border-hairline bg-paper px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><p className="truncate text-[13px] font-medium text-ink">{server.name}</p><p className="truncate font-mono text-[10.5px] text-ink-faint">{server.transport} · {server.status} · {t('st.mcp.toolsCount', { count: server.tool_count })}</p></div>
        <button type="button" disabled={restarting} onClick={() => void restart()} className={SECONDARY_BUTTON}>{restarting ? t('st.mcp.restarting') : t('st.mcp.restart')}</button>
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
  const { t } = useI18n();
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  return (
    <SectionCard title={t('st.workspaces.title')} badge={t('st.badge.serverCatalog')}>
      <div className="space-y-2">
        {query.data?.items.map((workspace) => (
          <div key={workspace.id} className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-paper px-3 py-2">
            <div className="min-w-0"><p className="truncate text-[13px] font-medium text-ink">{workspace.name}</p><p className="truncate font-mono text-[10.5px] text-ink-faint">{workspace.root}</p></div>
            <button type="button" onClick={() => void navigate(`/new?workspace=${encodeURIComponent(workspace.id)}`)} className={SECONDARY_BUTTON}>{t('st.workspaces.newSession')}</button>
          </div>
        ))}
        {query.isLoading ? <Hint>{t('st.workspaces.loading')}</Hint> : null}
        {query.isError ? <InlineError error={query.error} /> : null}
        <Hint>{t('st.workspaces.hint')}</Hint>
      </div>
    </SectionCard>
  );
}

function AboutSection() {
  const { meta } = useConnection();
  const { t } = useI18n();
  const guiVersion = import.meta.env['VITE_APP_VERSION'] ?? '0.0.0-dev';
  return (
    <SectionCard title={t('st.about.title')} badge={t('st.badge.buildInfo')}>
      <div className="space-y-2 text-[12.5px] text-ink-soft">
        <p>Kiki GUI: <span className="font-mono text-ink">{guiVersion}</span></p>
        <p>{t('st.about.serverVersion')}: <span className="font-mono text-ink">{meta.server_version}</span></p>
        <p>{t('st.about.serverId')}: <span className="font-mono text-ink">{meta.server_id}</span></p>
        <p>{t('st.about.backend')}: <span className="font-mono text-ink">{meta.backend ?? 'v1'}</span></p>
      </div>
    </SectionCard>
  );
}

function SettingsNav({ active }: { active: SectionId }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <nav className="flex h-full w-full flex-col border-r border-hairline bg-panel p-2 lg:w-[200px]">
      {SECTIONS.map((section) => (
        <button key={section.id} type="button" onClick={() => void navigate(`/settings/${section.id}`)} className={`rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${active === section.id ? 'bg-accent-soft font-medium text-accent' : 'text-ink-soft hover:bg-paper hover:text-ink'}`}>{t(section.labelKey)}</button>
      ))}
    </nav>
  );
}

export function SettingsPage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { section } = useParams<{ section?: string }>();
  const { t } = useI18n();
  const active: SectionId = SECTIONS.find((candidate) => candidate.id === section)?.id ?? 'general';
  const navigate = useNavigate();
  const pane = active === 'general' ? <GeneralSection /> : active === 'models' ? <ModelsSection /> : active === 'connection' ? <ConnectionSection /> : active === 'providers' ? <ProvidersSection /> : active === 'capabilities' ? <CapabilitiesSection /> : active === 'workspaces' ? <WorkspacesSection /> : <AboutSection />;

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
        <button type="button" onClick={onToggleSidebar} aria-label={t('sv.openMenuAria')} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"><span aria-hidden>☰</span></button>
        <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">{t('st.title')}</h1>
      </header>
      <main className="flex min-h-0 flex-1">
        <div className="hidden lg:block"><SettingsNav active={active} /></div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-hairline bg-panel px-4 py-2 lg:hidden">
            <select className="w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent" value={active} onChange={(event) => void navigate(`/settings/${event.target.value}`)}>
              {SECTIONS.map((candidate) => <option key={candidate.id} value={candidate.id}>{t(candidate.labelKey)}</option>)}
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
