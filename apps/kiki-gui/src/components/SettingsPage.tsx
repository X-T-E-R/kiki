import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';

import type {
  McpServer,
  ModelCatalogItem,
  PermissionMode,
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
import { clearStoredDrafts } from '../lib/drafts';
import {
  buildSettingsSearchIndex,
  clearRestartRequirement,
  markRestartRequired,
  parseAdvancedServerConfig,
  parseExperimentalFlags,
  readDesktopPrefs,
  readSettings,
  searchSettings,
  validateDesktopConfigDraft,
  validateExtraSkillDirs,
  writeDesktopPrefs,
  writeSettings,
  acknowledgeRestartRequirement,
  isRestartRequirementAcknowledged,
  type SendShortcut,
  type SettingsSearchEntry,
} from '../lib/settings';
import { formatTokens } from '../lib/time';
import { useConnection } from '../state/connection';
import { ConfirmDialog } from './ConfirmDialog';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from './controls';
import { DirtyGuardContext } from './dirtyGuard';
import { OAuthDeviceCard } from './OAuthDeviceCard';
import { MsUnitInput, NewProviderWizard, ProviderEditor } from './ProviderFields';
import { useRestartRequirement } from './RestartBanner';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from './ui';

const SECTIONS: readonly { id: string; labelKey: I18nKey }[] = [
  { id: 'general', labelKey: 'st.section.general' },
  { id: 'models', labelKey: 'st.section.models' },
  { id: 'connection', labelKey: 'st.section.connection' },
  { id: 'providers', labelKey: 'st.section.providers' },
  { id: 'agents', labelKey: 'st.section.agents' },
  { id: 'capabilities', labelKey: 'st.section.capabilities' },
  { id: 'workspaces', labelKey: 'st.section.workspaces' },
  { id: 'about', labelKey: 'st.section.about' },
];

type SectionId = (typeof SECTIONS)[number]['id'];

/** Card id a settings-search hit asked to flash; null when idle. */
const SettingsFlashContext = createContext<string | null>(null);

type CardBadge = 'restart' | 'desktop';

function SectionCard({
  id,
  title,
  children,
  badge,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
  badge?: CardBadge;
}) {
  const { t } = useI18n();
  const flashId = useContext(SettingsFlashContext);
  const badgeClass = badge === 'restart'
    ? 'border-amber-rule/60 bg-amber-card text-amber-ink'
    : 'border-hairline bg-paper text-ink-faint';
  return (
    <section
      id={id}
      className={`rounded-2xl border border-hairline bg-panel p-5 shadow-[0_2px_4px_rgba(28,25,23,0.03)] ${flashId !== null && flashId === id ? 'settings-card-flash' : ''}`}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="font-display text-[16px] font-semibold text-ink">{title}</h2>
        {badge !== undefined ? (
          <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${badgeClass}`}>
            {badge === 'restart' ? t('st.badge.restartRequired') : t('st.badge.desktopOnly')}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** Transient ✓-saved affirmation with auto-clear, for instant-apply controls. */
function useSavedTick(): [boolean, () => void] {
  const [nonce, setNonce] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  const ping = useCallback(() => {
    setNonce((value) => value + 1);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setNonce(0); }, 2500);
  }, []);
  return [nonce > 0, ping];
}

/**
 * Busy-session count for restart confirm dialogs. A dedicated first-page
 * query (short stale window) — restart kills the server process, so the
 * confirm names exactly how many running turns it would terminate.
 */
function useBusySessionCount(): number | undefined {
  const { client } = useConnection();
  const query = useQuery({
    queryKey: ['sessions', 'restart-confirm'],
    queryFn: () => client.listSessions({ page_size: 100 }),
    staleTime: 10_000,
    select: (page) => page.items.filter((session) => session.busy).length,
  });
  return query.data;
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
  const [tick, ping] = useSavedTick();
  const isDesktop = isDesktopRuntime();

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  const syncFromConfig = useCallback((config: Record<string, unknown> | undefined) => {
    if (config === undefined) return;
    const mode = config['default_permission_mode'];
    if (mode === 'manual' || mode === 'auto' || mode === 'yolo') setPermissionMode(mode);
    setPlanMode(config['default_plan_mode'] === true);
  }, []);

  useEffect(() => { syncFromConfig(configQuery.data); }, [configQuery.data, syncFromConfig]);

  // Server defaults apply on change: optimistic local state, echo confirms,
  // failure reverts to the last server-known config.
  const applyDefaults = async (mode: PermissionMode, plan: boolean) => {
    setPermissionMode(mode);
    setPlanMode(plan);
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({
        default_permission_mode: mode,
        default_plan_mode: plan,
      });
      queryClient.setQueryData(['config'], echoed);
      syncFromConfig(echoed as Record<string, unknown>);
      const echoedMode = echoed.default_permission_mode;
      if (echoedMode === 'manual' || echoedMode === 'auto' || echoedMode === 'yolo') {
        writeSettings({ defaultPermissionMode: echoedMode });
      }
      writeSettings({ defaultPlanMode: echoed.default_plan_mode === true });
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      syncFromConfig(configQuery.data);
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
      <SectionCard id="st-card-language" title={t('st.language.title')}>
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

      <SectionCard id="st-card-defaults" title={t('st.defaults.title')}>
        <div className="space-y-4">
          <div>
            <span id="default-permission-mode-label" className="mb-1.5 block text-[11px] font-medium text-ink-soft">{t('st.defaults.permissionMode')}</span>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="default-permission-mode-label">
              {(['manual', 'auto', 'yolo'] as PermissionMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={saving}
                  onClick={() => void applyDefaults(mode, planMode)}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                    permissionMode === mode
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-hairline text-ink-soft hover:border-hairline-strong'
                  }`}
                >
                  {t(`composer.mode.${mode}`)}
                </button>
              ))}
              <SavedTick show={tick} />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Toggle label={t('st.defaults.planMode')} checked={planMode} disabled={saving} onChange={(checked) => void applyDefaults(permissionMode, checked)} />
          </div>
          <Hint>{t('st.defaults.hint')}</Hint>
          <FeedbackLine feedback={feedback} />
          {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard id="st-card-composer" title={t('st.composer.title')}>
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
            onChange={(checked) => {
              updateLocal({ draftPersistence: checked });
              if (!checked) clearStoredDrafts();
            }}
          />
          <Hint>{t('st.composer.persistDraftsHint')}</Hint>
        </div>
      </SectionCard>

      <SectionCard id="st-card-desktop" title={t('st.desktop.title')} badge="desktop">
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
  const [busy, setBusy] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [effort, setEffort] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [tick, ping] = useSavedTick();
  const [modelQuery, setModelQuery] = useState('');

  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const items = modelsQuery.data?.items ?? [];
  const defaultModel = configQuery.data?.default_model;
  const defaultProvider = configQuery.data?.default_provider ?? '';
  const defaultItem = items.find((item) => item.model === defaultModel);
  const thinking = asRecord(configQuery.data?.thinking);

  const syncThinking = useCallback(() => {
    const configured = thinking?.['effort'];
    setThinkingEnabled(thinking?.['enabled'] !== false);
    setEffort(typeof configured === 'string' ? configured : (defaultItem?.default_effort ?? ''));
  }, [defaultItem?.default_effort, thinking]);

  useEffect(() => { syncThinking(); }, [syncThinking]);

  // Provider grouping: default provider's group first, default model first
  // inside its group; the search box filters by id, name, provider, or chip.
  const groups = useMemo(() => {
    const needle = modelQuery.trim().toLowerCase();
    const matched = needle === ''
      ? items
      : items.filter((item) =>
          item.model.toLowerCase().includes(needle)
          || (item.display_name ?? '').toLowerCase().includes(needle)
          || item.provider.toLowerCase().includes(needle)
          || (item.capabilities ?? []).some((capability) => capability.toLowerCase().includes(needle)));
    const byProvider = new Map<string, ModelCatalogItem[]>();
    for (const item of matched) {
      const list = byProvider.get(item.provider) ?? [];
      list.push(item);
      byProvider.set(item.provider, list);
    }
    return [...byProvider.entries()]
      .map(([provider, models]) => ({
        provider,
        models: models.toSorted((a, b) =>
          Number(b.model === defaultModel) - Number(a.model === defaultModel)
          || (a.display_name ?? a.model).localeCompare(b.display_name ?? b.model)),
      }))
      .toSorted((a, b) =>
        Number(b.provider === defaultProvider) - Number(a.provider === defaultProvider)
        || a.provider.localeCompare(b.provider));
  }, [items, modelQuery, defaultModel, defaultProvider]);

  const selectDefaultProvider = async (providerId: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ default_provider: providerId });
      queryClient.setQueryData(['config'], echoed);
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(false);
    }
  };

  // Starring a model carries its provider along as the default provider.
  const selectDefaultModel = async (item: ModelCatalogItem) => {
    setBusy(true);
    setFeedback(null);
    try {
      const echoed = await client.setDefaultModel(item.model);
      queryClient.setQueryData(['config'], (current: Record<string, unknown> | undefined) => ({
        ...current,
        default_model: echoed.default_model,
      }));
      writeSettings({ defaultModel: echoed.default_model });
      if (item.provider !== defaultProvider) {
        const echoedConfig = await client.patchConfig({ default_provider: item.provider });
        queryClient.setQueryData(['config'], echoedConfig);
      }
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(false);
    }
  };

  const saveThinking = async (enabled: boolean, nextEffort: string) => {
    setThinkingEnabled(enabled);
    setEffort(nextEffort);
    if (enabled && nextEffort.trim() === '') {
      setFeedback({ tone: 'error', text: t('st.thinking.emptyError') });
      syncThinking();
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ thinking: { enabled, effort: nextEffort.trim() || undefined } });
      queryClient.setQueryData(['config'], echoed);
      const echoedThinking = asRecord(echoed.thinking);
      const echoedEnabled = echoedThinking?.['enabled'] !== false;
      const echoedEffort = typeof echoedThinking?.['effort'] === 'string' ? echoedThinking['effort'] : nextEffort.trim();
      setThinkingEnabled(echoedEnabled);
      setEffort(echoedEffort);
      writeSettings({ defaultEffort: echoedEffort || undefined });
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      syncThinking();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard id="st-card-models" title={t('st.models.defaultTitle')}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[11px] font-medium text-ink-soft">{t('st.models.providerLabel')}
              <select
                className={`${SMALL_INPUT} ml-2`}
                value={defaultProvider}
                disabled={busy}
                onChange={(event) => void selectDefaultProvider(event.target.value)}
              >
                {(providersQuery.data?.items ?? []).map((provider) => <option key={provider.id} value={provider.id}>{provider.id}</option>)}
              </select>
            </label>
            <SavedTick show={tick} />
          </div>
          <input
            type="search"
            aria-label={t('st.models.searchAria')}
            placeholder={t('st.models.searchPlaceholder')}
            className={INPUT}
            value={modelQuery}
            onChange={(event) => { setModelQuery(event.target.value); }}
          />
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group.provider}>
                <div className="mb-1.5 flex items-center gap-2">
                  <p className="font-mono text-[11px] font-semibold text-ink-soft">{group.provider}</p>
                  {group.provider === defaultProvider ? (
                    <span className="rounded-full border border-success/30 bg-success/10 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-success">{t('st.models.default')}</span>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  {group.models.map((item) => (
                    <ModelRow
                      key={item.model}
                      item={item}
                      isDefault={item.model === defaultModel}
                      busy={busy}
                      onSetDefault={() => void selectDefaultModel(item)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {modelQuery.trim() !== '' && groups.length === 0 ? (
            <Hint>{t('st.models.searchEmpty', { query: modelQuery.trim() })}</Hint>
          ) : null}
          {modelsQuery.isLoading ? <Hint>{t('st.models.loading')}</Hint> : null}
          {modelsQuery.isError ? <InlineError error={modelsQuery.error} /> : null}
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      <SectionCard id="st-card-thinking" title={t('st.thinking.title')}>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Toggle label={t('st.thinking.enable')} checked={thinkingEnabled} disabled={busy} onChange={(checked) => void saveThinking(checked, effort)} />
            <SavedTick show={tick} />
          </div>
          {defaultItem?.support_efforts !== undefined && defaultItem.support_efforts.length > 0 ? (
            <select
              className={SMALL_INPUT}
              value={effort}
              disabled={!thinkingEnabled || busy}
              onChange={(event) => void saveThinking(thinkingEnabled, event.target.value)}
            >
              {defaultItem.support_efforts.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          ) : (
            <input
              className={INPUT}
              value={effort}
              disabled={!thinkingEnabled || busy}
              onChange={(event) => { setEffort(event.target.value); }}
              onBlur={() => void saveThinking(thinkingEnabled, effort)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveThinking(thinkingEnabled, effort);
              }}
              placeholder={t('st.thinking.placeholder')}
            />
          )}
          <Hint>{t('st.thinking.hint')}</Hint>
          <FeedbackLine feedback={feedback} />
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
    <div className="flex items-center gap-3 rounded-lg border border-hairline bg-paper px-3 py-2">
      <button
        type="button"
        onClick={onSetDefault}
        disabled={busy || isDefault}
        aria-label={t('st.models.starAria', { model: item.model })}
        title={isDefault ? t('st.models.starredTitle') : t('st.models.unstarredTitle')}
        className={`shrink-0 text-[15px] leading-none transition-colors disabled:cursor-default ${
          isDefault ? 'text-accent' : 'text-hairline-strong hover:text-accent'
        }`}
      >
        {isDefault ? '★' : '☆'}
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink">
          {item.display_name ?? item.model}
          {isDefault ? (
            <span className="ml-2 rounded-full border border-success/30 bg-success/10 px-1.5 py-px align-middle text-[9px] font-medium uppercase tracking-wide text-success">{t('st.models.default')}</span>
          ) : null}
        </p>
        <p className="truncate font-mono text-[10.5px] text-ink-faint">
          {item.model} · {formatTokens(item.max_context_size)} {t('st.models.context')}
        </p>
      </div>
      {item.capabilities !== undefined && item.capabilities.length > 0 ? (
        <div className="hidden shrink-0 flex-wrap justify-end gap-1 sm:flex">
          {item.capabilities.map((capability) => (
            <span key={capability} className="rounded-full border border-hairline bg-panel px-1.5 py-px text-[9.5px] text-ink-faint">{capability}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ConnectionSection() {
  const { config, meta, wsStatus, socket } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const isDesktop = isDesktopRuntime();
  const [restarting, setRestarting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const busySessions = useBusySessionCount();

  const restart = async () => {
    setRestarting(true);
    setFeedback(null);
    try {
      await restartNativeServer();
      clearRestartRequirement();
      // Fresh sidecar on the same endpoint: reattach the WS and refetch
      // instead of reloading the page.
      socket?.nudge();
      await queryClient.invalidateQueries();
      setFeedback({ tone: 'success', text: t('st.conn.restarted') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard id="st-card-conn-server" title={t('st.conn.connectedTitle')}>
        <div className="space-y-2 text-[12.5px] text-ink-soft">
          <p>{t('st.conn.urlLabel')}: <span className="font-mono text-ink">{config.url}</span></p>
          <p>{t('st.conn.version')}: <span className="font-mono text-ink">{meta.server_version}</span></p>
          <p>{t('st.conn.backend')}: <span className="font-mono text-ink">{meta.backend ?? 'v1'}</span></p>
          <p>{t('st.conn.wsLabel')}: <span className={wsStatus === 'open' ? 'font-medium text-success' : 'font-medium text-amber-ink'}>{t(`st.conn.ws.${wsStatus}`)}</span></p>
          <button type="button" onClick={() => { socket?.nudge(); }} className={SECONDARY_BUTTON}>{t('st.conn.reconnect')}</button>
        </div>
      </SectionCard>

      <SectionCard id="st-card-conn-owned" title={t('st.conn.ownedTitle')} badge="desktop">
        <div className="space-y-3">
          <p className="text-[12.5px] text-ink-soft">
            {t('st.conn.ownedBody')}
          </p>
          <button type="button" className={PRIMARY_BUTTON} disabled={!isDesktop || restarting} onClick={() => { setConfirmRestart(true); }}>
            {restarting ? t('st.conn.restarting') : t('st.conn.restart')}
          </button>
          {!isDesktop ? <Hint>{t('st.conn.browserHint')}</Hint> : null}
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      <ConfirmDialog
        open={confirmRestart}
        overlayId="confirm-conn-restart"
        title={t('st.restart.confirmTitle')}
        body={
          busySessions !== undefined && busySessions > 0
            ? t('st.restart.confirmBodyActive', { count: busySessions })
            : t('st.restart.confirmBodyIdle')
        }
        confirmLabel={t('st.conn.restart')}
        tone="danger"
        onConfirm={() => { setConfirmRestart(false); void restart(); }}
        onCancel={() => { setConfirmRestart(false); }}
      />
    </div>
  );
}

function ProvidersSection() {
  const { client, config: connection } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthCancelling, setOauthCancelling] = useState(false);
  const [oauthFeedback, setOauthFeedback] = useState<Feedback>(null);
  const [dismissedFlows, setDismissedFlows] = useState<readonly string[]>([]);
  const prevFlowStatus = useRef<string | null>(null);

  const authQuery = useQuery({ queryKey: ['auth'], queryFn: () => client.getAuth(), staleTime: 10_000 });
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  // The device flow polls at the server-suggested interval while pending and
  // stops on any terminal state.
  const oauthQuery = useQuery({
    queryKey: ['oauth'],
    queryFn: () => client.getOAuthStatus(),
    staleTime: 0,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data !== null && data !== undefined && data.status === 'pending'
        ? Math.max(2000, data.interval * 1000)
        : false;
    },
  });

  const snapshot = oauthQuery.data ?? null;

  const refreshProviderData = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['providers'] }),
      queryClient.invalidateQueries({ queryKey: ['models'] }),
      queryClient.invalidateQueries({ queryKey: ['auth'] }),
      queryClient.invalidateQueries({ queryKey: ['config'] }),
    ]);
  }, [queryClient]);

  // authenticated → auto-collapse the card and refresh provider data.
  useEffect(() => {
    if (snapshot === null) {
      prevFlowStatus.current = null;
      return;
    }
    if (snapshot.status === 'authenticated' && !dismissedFlows.includes(snapshot.flow_id)) {
      if (prevFlowStatus.current === 'pending') {
        setOauthFeedback({ tone: 'success', text: t('st.oauth.authenticated') });
      }
      setDismissedFlows((flows) => [...flows, snapshot.flow_id]);
      void refreshProviderData();
    }
    prevFlowStatus.current = snapshot.status;
  }, [snapshot, dismissedFlows, t, refreshProviderData]);

  const startOAuth = async () => {
    setOauthBusy(true);
    setOauthFeedback(null);
    try {
      const result = await client.startOAuthLogin();
      if (result.status === 'authenticated') {
        setOauthFeedback({ tone: 'success', text: t('st.auth.already') });
        await refreshProviderData();
      } else {
        // Surface the fresh pending flow immediately; the interval poller
        // takes over from here.
        setDismissedFlows([]);
        queryClient.setQueryData(['oauth'], result);
      }
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setOauthBusy(false);
    }
  };

  const cancelOAuth = async () => {
    setOauthCancelling(true);
    try {
      await client.cancelOAuthLogin();
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setOauthCancelling(false);
      await queryClient.invalidateQueries({ queryKey: ['oauth'] });
    }
  };

  const logout = async () => {
    setOauthBusy(true);
    setOauthFeedback(null);
    try {
      await client.logoutOAuth();
      setDismissedFlows([]);
      setOauthFeedback({ tone: 'success', text: t('st.auth.removed') });
      await Promise.all([refreshProviderData(), queryClient.invalidateQueries({ queryKey: ['oauth'] })]);
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setOauthBusy(false);
    }
  };

  const visibleSnapshot = snapshot !== null
    && snapshot.status !== 'authenticated'
    && !dismissedFlows.includes(snapshot.flow_id)
    ? snapshot
    : null;

  return (
    <div className="space-y-5">
      <SectionCard id="st-card-auth" title={t('st.auth.title')}>
        <div className="space-y-3">
          {authQuery.data !== undefined ? (
            <div className="flex items-start gap-2.5">
              <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${authQuery.data.ready ? 'bg-success' : 'bg-amber-rule'}`} />
              <div className="min-w-0 text-[12.5px]">
                <p className="font-medium text-ink">{authQuery.data.ready ? t('st.auth.statusReady') : t('st.auth.statusNotReady')}</p>
                <p className="text-ink-soft">{t('st.auth.summary', { count: authQuery.data.providers_count, model: authQuery.data.default_model ?? t('st.auth.none') })}</p>
                {authQuery.data.managed_provider ? (
                  <p className="text-ink-soft">{t('st.auth.managed', { status: authQuery.data.managed_provider.status })}</p>
                ) : null}
              </div>
            </div>
          ) : null}
          {visibleSnapshot !== null ? (
            <OAuthDeviceCard
              snapshot={visibleSnapshot}
              cancelling={oauthCancelling}
              onCancel={() => void cancelOAuth()}
              onRetry={() => void startOAuth()}
              onDismiss={() => { setDismissedFlows((flows) => [...flows, visibleSnapshot.flow_id]); }}
            />
          ) : null}
          <div className="flex gap-2">
            <button type="button" disabled={oauthBusy} onClick={() => void startOAuth()} className={PRIMARY_BUTTON}>{oauthBusy ? t('st.auth.working') : t('st.auth.signIn')}</button>
            <button type="button" disabled={oauthBusy} onClick={() => void logout()} className={SECONDARY_BUTTON}>{t('st.auth.signOut')}</button>
          </div>
          <FeedbackLine feedback={oauthFeedback} />
          {authQuery.isError ? <InlineError error={authQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard id="st-card-providers" title={t('st.providers.title')}>
        <div className="space-y-3">
          {(providersQuery.data?.items ?? []).map((provider) => (
            <ProviderEditor
              key={provider.id}
              provider={provider}
              models={modelsQuery.data?.items ?? []}
              connection={connection}
              managed={provider.id === authQuery.data?.managed_provider?.name}
              onSaved={refreshProviderData}
            />
          ))}
          {providersQuery.isLoading ? <Hint>{t('st.providers.loading')}</Hint> : null}
          {providersQuery.data?.items.length === 0 ? <Hint>{t('st.providers.empty')}</Hint> : null}
          {providersQuery.isError ? <InlineError error={providersQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard id="st-card-providers-add" title={t('st.providers.addTitle')}>
        <NewProviderWizard connection={connection} onSaved={refreshProviderData} />
      </SectionCard>
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
  const restart = useRestartRequirement();

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
      const previousTelemetry = configQuery.data?.telemetry !== false;
      if (telemetry !== previousTelemetry) {
        markRestartRequired(['telemetry']);
        setFeedback({ tone: 'success', text: t('st.caps.savedRestart') });
      } else {
        setFeedback({ tone: 'success', text: t('st.caps.saved') });
      }
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
      <SectionCard
        id="st-card-caps"
        title={t('st.caps.title')}
        badge={restart.fields.includes('telemetry') ? 'restart' : undefined}
      >
        <div className="space-y-4">
          <Toggle label={t('st.caps.mergeSkills')} checked={mergeSkills} onChange={setMergeSkills} />
          <div className="space-y-1.5">
            <Toggle label={t('st.caps.telemetry')} checked={telemetry} onChange={setTelemetry} />
            <Hint>{t('st.caps.telemetryHint')}</Hint>
          </div>
          <label className="block text-[11px] font-medium text-ink-soft">{t('st.caps.extraDirs')}
            <textarea className={`${INPUT} mt-1 min-h-24 font-mono`} value={extraDirs} onChange={(event) => { setExtraDirs(event.target.value); }} placeholder={t('st.caps.extraDirsPlaceholder')} />
          </label>
          <label className="block text-[11px] font-medium text-ink-soft">{t('st.caps.experimental')}
            <textarea className={`${INPUT} mt-1 min-h-32 font-mono`} value={experimental} onChange={(event) => { setExperimental(event.target.value); }} aria-label={t('st.caps.experimentalAria')} />
          </label>
          <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('common.saving') : t('st.caps.save')}</button>
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      <SectionCard id="st-card-advanced" title={t('st.advanced.title')}>
        <div className="space-y-3">
          <Hint>{t('st.advanced.hint')}</Hint>
          <textarea className={`${INPUT} min-h-64 font-mono`} value={advanced} onChange={(event) => { setAdvanced(event.target.value); }} aria-label={t('st.advanced.aria')} />
          <button type="button" className={PRIMARY_BUTTON} disabled={advancedSaving} onClick={() => void saveAdvanced()}>{advancedSaving ? t('common.saving') : t('st.advanced.save')}</button>
          <FeedbackLine feedback={advancedFeedback} />
        </div>
      </SectionCard>

      <SectionCard id="st-card-tools" title={t('st.tools.title')}>
        <div className="space-y-2">
          {toolsQuery.data?.tools.map((tool) => <ToolRow key={tool.name} tool={tool} />)}
          {toolsQuery.isLoading ? <Hint>{t('st.tools.loading')}</Hint> : null}
          {toolsQuery.isError ? <InlineError error={toolsQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard id="st-card-mcp" title={t('st.mcp.title')}>
        <div className="space-y-2">
          {mcpQuery.data?.servers.map((server) => <McpRow key={server.id} server={server} />)}
          {mcpQuery.isLoading ? <Hint>{t('st.mcp.loading')}</Hint> : null}
          {mcpQuery.isError ? <InlineError error={mcpQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard id="st-card-skills" title={t('st.skills.title')}>
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

function AgentsSection() {
  const { t } = useI18n();
  return (
    <div className="space-y-5">
      <Hint>{t('st.agents.webHint')}</Hint>
      <DesktopServerFileCard />
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
  const { socket } = useConnection();
  const queryClient = useQueryClient();
  const [config, setConfig] = useState(EMPTY_DESKTOP_CONFIG);
  const restart = useRestartRequirement();
  const [loading, setLoading] = useState(isDesktop);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const busySessions = useBusySessionCount();

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
      markRestartRequired(['subagent', 'agents', 'builtin_product_skills', 'model_catalog']);
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
      clearRestartRequirement();
      socket?.nudge();
      await queryClient.invalidateQueries();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      setRestarting(false);
    }
  };

  return (
    <SectionCard id="st-card-sidecar" title={t('st.sidecar.title')} badge={restart.required ? 'restart' : 'desktop'}>
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
              <MsUnitInput
                value={config.subagent.timeoutMs}
                onChange={(timeoutMs) => { setConfig({ ...config, subagent: { ...config.subagent, timeoutMs } }); }}
                ariaLabel={t('st.sidecar.subagentTimeout')}
              />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">{t('st.sidecar.collabModel')}
              <input className={`${INPUT} mt-1`} value={config.agents.defaultSubagentModel} onChange={(event) => { setConfig({ ...config, agents: { ...config.agents, defaultSubagentModel: event.target.value } }); }} placeholder="provider/model" />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">{t('st.sidecar.collabEffort')}
              <input className={`${INPUT} mt-1`} value={config.agents.defaultSubagentReasoningEffort} onChange={(event) => { setConfig({ ...config, agents: { ...config.agents, defaultSubagentReasoningEffort: event.target.value } }); }} placeholder="medium" />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">{t('st.sidecar.catalogInterval')}
              <MsUnitInput
                value={config.modelCatalog.refreshIntervalMs}
                onChange={(refreshIntervalMs) => { setConfig({ ...config, modelCatalog: { ...config.modelCatalog, refreshIntervalMs } }); }}
                ariaLabel={t('st.sidecar.catalogInterval')}
              />
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
          <button type="button" className={SECONDARY_BUTTON} disabled={!isDesktop || !restart.required || restarting} onClick={() => { setConfirmRestart(true); }}>{restarting ? t('st.sidecar.restarting') : t('st.sidecar.applyRestart')}</button>
          {!isDesktop && restart.required && !isRestartRequirementAcknowledged(restart) ? (
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { acknowledgeRestartRequirement(); }}>{t('st.sidecar.acknowledge')}</button>
          ) : null}
        </div>
        {restart.required ? <Hint>{t('st.sidecar.pendingFields', { fields: restart.fields.join(', ') })}</Hint> : null}
        <FeedbackLine feedback={feedback} />
      </div>
      <ConfirmDialog
        open={confirmRestart}
        overlayId="confirm-sidecar-restart"
        title={t('st.restart.confirmTitle')}
        body={
          busySessions !== undefined && busySessions > 0
            ? t('st.restart.confirmBodyActive', { count: busySessions })
            : t('st.restart.confirmBodyIdle')
        }
        confirmLabel={t('st.sidecar.applyRestart')}
        tone="danger"
        onConfirm={() => { setConfirmRestart(false); void applyRestart(); }}
        onCancel={() => { setConfirmRestart(false); }}
      />
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
    <SectionCard id="st-card-workspaces" title={t('st.workspaces.title')}>
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
    <SectionCard id="st-card-about" title={t('st.about.title')}>
      <div className="space-y-2 text-[12.5px] text-ink-soft">
        <p>Kiki GUI: <span className="font-mono text-ink">{guiVersion}</span></p>
        <p>{t('st.about.serverVersion')}: <span className="font-mono text-ink">{meta.server_version}</span></p>
        <p>{t('st.about.serverId')}: <span className="font-mono text-ink">{meta.server_id}</span></p>
        <p>{t('st.about.backend')}: <span className="font-mono text-ink">{meta.backend ?? 'v1'}</span></p>
      </div>
    </SectionCard>
  );
}

function SettingsNav({
  active,
  onNavigate,
  onSearchHit,
}: {
  active: SectionId;
  onNavigate: (section: SectionId) => void;
  onSearchHit: (entry: SettingsSearchEntry) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const sectionLabels = useMemo(
    () => Object.fromEntries(SECTIONS.map((section) => [section.id, t(section.labelKey)])),
    [t],
  );
  const index = useMemo(() => buildSettingsSearchIndex(sectionLabels, t), [sectionLabels, t]);
  const results = useMemo(() => searchSettings(index, query), [index, query]);
  const searching = query.trim() !== '';

  return (
    <nav className="flex h-full w-full flex-col border-r border-hairline bg-panel p-2 lg:w-[200px]">
      <div className="mb-2 px-1">
        <input
          type="search"
          aria-label={t('st.search.aria')}
          placeholder={t('st.search.placeholder')}
          value={query}
          onChange={(event) => { setQuery(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setQuery('');
              event.currentTarget.blur();
            }
          }}
          className="w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
        />
      </div>
      {searching ? (
        <div className="space-y-0.5" role="listbox" aria-label={t('st.search.aria')}>
          {results.map((entry) => (
            <button
              key={entry.cardId}
              type="button"
              role="option"
              aria-selected="false"
              onClick={() => { onSearchHit(entry); setQuery(''); }}
              className="w-full truncate rounded-lg px-3 py-2 text-left text-[12px] text-ink-soft transition-colors hover:bg-paper hover:text-ink"
            >
              <span className="text-ink-faint">{entry.sectionLabel}</span>
              <span className="mx-1 text-ink-faint">›</span>
              <span className="text-ink">{entry.title}</span>
            </button>
          ))}
          {results.length === 0 ? (
            <p className="px-3 py-2 text-[11.5px] text-ink-faint">{t('st.search.empty', { query: query.trim() })}</p>
          ) : null}
        </div>
      ) : (
        SECTIONS.map((section) => (
          <button key={section.id} type="button" onClick={() => { onNavigate(section.id); }} className={`rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${active === section.id ? 'bg-accent-soft font-medium text-accent' : 'text-ink-soft hover:bg-paper hover:text-ink'}`}>{t(section.labelKey)}</button>
        ))
      )}
    </nav>
  );
}

export function SettingsPage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { section } = useParams<{ section?: string }>();
  const { t } = useI18n();
  const active: SectionId = SECTIONS.find((candidate) => candidate.id === section)?.id ?? 'general';
  const navigate = useNavigate();
  const [dirtyIds, setDirtyIds] = useState<readonly string[]>([]);
  const [pendingLeave, setPendingLeave] = useState<string | null>(null);
  const [focusCard, setFocusCard] = useState<{ cardId: string; nonce: number } | null>(null);

  const reportDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyIds((current) => {
      const has = current.includes(id);
      if (dirty === has) return current;
      return dirty ? [...current, id] : current.filter((entry) => entry !== id);
    });
  }, []);
  const guardValue = useMemo(() => ({ reportDirty }), [reportDirty]);

  // Leaving a dirty providers section asks first; everything else navigates.
  const guardedNavigate = useCallback((target: string) => {
    if (active === 'providers' && target !== 'providers' && dirtyIds.length > 0) {
      setPendingLeave(target);
      return;
    }
    void navigate(`/settings/${target}`);
  }, [active, dirtyIds.length, navigate]);

  const confirmLeave = () => {
    const target = pendingLeave;
    setPendingLeave(null);
    setDirtyIds([]);
    if (target !== null) void navigate(`/settings/${target}`);
  };

  // Scroll + flash the card a search hit pointed at, then disarm.
  useEffect(() => {
    if (focusCard === null) return;
    const frame = requestAnimationFrame(() => {
      document.querySelector(`#${CSS.escape(focusCard.cardId)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const timer = setTimeout(() => { setFocusCard(null); }, 2000);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [focusCard]);

  // A dirty providers editor also guards closing the app itself.
  useEffect(() => {
    if (dirtyIds.length === 0) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => { window.removeEventListener('beforeunload', handler); };
  }, [dirtyIds.length]);

  const onSearchHit = (entry: SettingsSearchEntry) => {
    setFocusCard({ cardId: entry.cardId, nonce: Date.now() });
    if (entry.section !== active) guardedNavigate(entry.section);
  };

  const pane = active === 'general' ? <GeneralSection /> : active === 'models' ? <ModelsSection /> : active === 'connection' ? <ConnectionSection /> : active === 'providers' ? <ProvidersSection /> : active === 'agents' ? <AgentsSection /> : active === 'capabilities' ? <CapabilitiesSection /> : active === 'workspaces' ? <WorkspacesSection /> : <AboutSection />;

  return (
    <DirtyGuardContext.Provider value={guardValue}>
      <SettingsFlashContext.Provider value={focusCard?.cardId ?? null}>
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
          <button type="button" onClick={onToggleSidebar} aria-label={t('sv.openMenuAria')} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"><span aria-hidden>☰</span></button>
          <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">{t('st.title')}</h1>
        </header>
        <main className="flex min-h-0 flex-1">
          <div className="hidden lg:block"><SettingsNav active={active} onNavigate={guardedNavigate} onSearchHit={onSearchHit} /></div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="border-b border-hairline bg-panel px-4 py-2 lg:hidden">
              <select className="w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent" value={active} onChange={(event) => { guardedNavigate(event.target.value); }}>
                {SECTIONS.map((candidate) => <option key={candidate.id} value={candidate.id}>{t(candidate.labelKey)}</option>)}
              </select>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8"><div className="mx-auto max-w-[760px] space-y-5">{pane}</div></div>
          </div>
        </main>
        <ConfirmDialog
          open={pendingLeave !== null}
          title={t('st.dirty.leaveTitle')}
          body={t('st.dirty.leaveBody')}
          confirmLabel={t('st.dirty.leaveConfirm')}
          cancelLabel={t('st.dirty.stay')}
          onConfirm={confirmLeave}
          onCancel={() => { setPendingLeave(null); }}
        />
      </SettingsFlashContext.Provider>
    </DirtyGuardContext.Provider>
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
