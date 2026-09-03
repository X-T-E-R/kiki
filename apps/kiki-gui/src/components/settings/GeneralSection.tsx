import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { PermissionMode } from '@moonshot-ai/protocol';

import { clearStoredDrafts } from '@kiki/session-core/composer';
import { errorText, type Locale } from '@kiki/session-core/i18n';
import {
  markRestartRequired,
  readDesktopPrefs,
  readSettings,
  writeDesktopPrefs,
  writeSettings,
  type CompatibilitySettings,
  type SendShortcut,
  type ThemePreference,
} from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '@kiki/session-core/transport';
import { useHost, type SessionsMigrationPlan } from '../../host';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';
import { useSavedTick } from './useSavedTick';

function isAbsoluteHomePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(path);
}

export function GeneralSection() {
  const host = useHost();
  const { client } = useConnection();
  const { t, locale, setLocale } = useI18n();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState(readSettings);
  const [desktopPrefs, setDesktopPrefs] = useState(readDesktopPrefs);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('manual');
  const [planMode, setPlanMode] = useState(false);
  const [planGate, setPlanGate] = useState<'free' | 'gated'>('free');
  const [planGateTimeoutS, setPlanGateTimeoutS] = useState('60');
  const [compatOpen, setCompatOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [compatibilityFeedback, setCompatibilityFeedback] = useState<Feedback>(null);
  const [compatibilityBusy, setCompatibilityBusy] = useState(false);
  const [kimiHomePaths, setKimiHomePaths] = useState<{
    home: string;
    credentialPath: string;
    sourceConfigPath: string;
    configPath: string;
  } | null>(null);
  const [configImporting, setConfigImporting] = useState(false);
  const [migrating, setMigrating] = useState<'userSkills' | null>(null);
  const [sessionsBusy, setSessionsBusy] = useState<'dryRun' | 'move' | null>(null);
  const [sessionsPlan, setSessionsPlan] = useState<SessionsMigrationPlan | null>(null);
  const [confirmSessionsMove, setConfirmSessionsMove] = useState(false);
  const [homeKindDraft, setHomeKindDraft] = useState(
    desktopPrefs.compatibility.homeKind,
  );
  const [customHome, setCustomHome] = useState(
    desktopPrefs.compatibility.customHome ?? '',
  );
  const [tick, ping] = useSavedTick();
  const isDesktop = host.kind === 'tauri';

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  const syncFromConfig = useCallback((config: KikiConfigResponse | undefined) => {
    if (config === undefined) return;
    const mode = config.default_permission_mode;
    if (mode === 'manual' || mode === 'auto' || mode === 'yolo') setPermissionMode(mode);
    setPlanMode(config.default_plan_mode === true);
    setPlanGate(config.plan?.gate === 'gated' ? 'gated' : 'free');
    setPlanGateTimeoutS(String((config.plan?.enterApprovalTimeoutMs ?? 60_000) / 1000));
  }, []);

  useEffect(() => { syncFromConfig(configQuery.data); }, [configQuery.data, syncFromConfig]);

  useEffect(() => {
    if (host.kind !== 'tauri') return;
    void Promise.all([host.readDesktopPrefs(), host.readKimiHomePaths()]).then(([prefs, paths]) => {
      if (prefs !== null) {
        setDesktopPrefs(prefs);
        setHomeKindDraft(prefs.compatibility.homeKind);
        setCustomHome(prefs.compatibility.customHome ?? '');
        writeDesktopPrefs(prefs);
      }
      setKimiHomePaths(paths);
    });
  }, [host]);

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
      syncFromConfig(echoed);
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

  // Same optimistic discipline as applyDefaults: local echo first, server
  // echo confirms, failure reverts to the last server-known config.
  const applyPlanGate = async (gate: 'free' | 'gated') => {
    setPlanGate(gate);
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ plan: { gate } });
      queryClient.setQueryData(['config'], echoed);
      syncFromConfig(echoed);
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      syncFromConfig(configQuery.data);
    } finally {
      setSaving(false);
    }
  };

  // Seconds in the field, milliseconds on the wire (`enter_approval_timeout_ms`,
  // floor 5000). Commits on blur/Enter; an invalid draft reverts to the config.
  const commitPlanGateTimeout = async () => {
    const ms = Math.round(Number(planGateTimeoutS) * 1000);
    if (!Number.isFinite(ms) || ms < 5000) {
      setFeedback({ tone: 'error', text: t('st.defaults.planGateTimeoutInvalid') });
      syncFromConfig(configQuery.data);
      return;
    }
    if (configQuery.data?.plan?.enterApprovalTimeoutMs === ms) return;
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ plan: { enter_approval_timeout_ms: ms } });
      queryClient.setQueryData(['config'], echoed);
      syncFromConfig(echoed);
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      syncFromConfig(configQuery.data);
    } finally {
      setSaving(false);
    }
  };

  const persistCompatibility = async (next: CompatibilitySettings) => {
    if (next.homeKind === 'custom') {
      const path = next.customHome?.trim() ?? '';
      if (!isAbsoluteHomePath(path)) {
        setCompatibilityFeedback({ tone: 'error', text: t('st.compat.customInvalid') });
        return;
      }
      next = { ...next, customHome: path };
    }
    setCompatibilityBusy(true);
    setCompatibilityFeedback(null);
    try {
      await host.writeCompatibilitySettings?.(next);
      setKimiHomePaths((await host.readKimiHomePaths?.()) ?? null);
      setSessionsPlan(null);
      setConfirmSessionsMove(false);
      const prefs = { ...desktopPrefs, compatibility: next };
      setDesktopPrefs(prefs);
      setHomeKindDraft(next.homeKind);
      writeDesktopPrefs(prefs);
      markRestartRequired(['Kimi Home']);
      setCompatibilityFeedback({ tone: 'success', text: t('st.compat.savedRestart') });
    } catch (error) {
      setCompatibilityFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setCompatibilityBusy(false);
    }
  };

  const importKimiConfig = async () => {
    if (host.kind !== 'tauri') return;
    setConfigImporting(true);
    setCompatibilityFeedback(null);
    try {
      const result = await host.importKimiConfig();
      if (result.status === 'noop') {
        setCompatibilityFeedback({ tone: 'info', text: t('st.compat.configImportNoop') });
      } else if (result.restartError !== null) {
        setCompatibilityFeedback({
          tone: 'info',
          text: t('st.compat.configImportRestartFailed', {
            categories: result.updatedCategories.join(', '),
            error: result.restartError,
          }),
        });
      } else {
        setCompatibilityFeedback({
          tone: 'success',
          text: t('st.compat.configImported', {
            categories: result.updatedCategories.join(', '),
          }),
        });
      }
    } catch (error) {
      setCompatibilityFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setConfigImporting(false);
    }
  };

  const migrateCategory = async () => {
    if (host.kind !== 'tauri') return;
    setMigrating('userSkills');
    setCompatibilityFeedback(null);
    try {
      const result = await host.migrateCompatibilityCategory('userSkills');
      if (result.status === 'copied') {
        setCompatibilityFeedback({
          tone: result.restartError === null ? 'success' : 'info',
          text: result.restartError === null
            ? t('st.compat.migrated', { count: result.files })
            : t('st.compat.migratedRestartFailed', { count: result.files, error: result.restartError }),
        });
      } else if (result.status === 'copiedActivationPending') {
        setCompatibilityFeedback({
          tone: 'info',
          text: result.restartError === null
            ? t('st.compat.migrationActivationPending', {
                count: result.files,
                error: result.activationError ?? t('st.compat.migrationActivationUnknown'),
              })
            : t('st.compat.migrationActivationAndRestartPending', {
                count: result.files,
                error: result.activationError ?? t('st.compat.migrationActivationUnknown'),
                restartError: result.restartError,
              }),
        });
      } else {
        setCompatibilityFeedback({ tone: 'info', text: t('st.compat.migrationNoop') });
      }
    } catch (error) {
      setCompatibilityFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setMigrating(null);
    }
  };

  const reviewSessionsMove = async () => {
    if (host.kind !== 'tauri') return;
    setSessionsBusy('dryRun');
    setCompatibilityFeedback(null);
    try {
      const plan = await host.dryRunSessionsMigration();
      setSessionsPlan(plan);
      if (plan.status === 'blocked') {
        setCompatibilityFeedback({ tone: 'error', text: t('st.compat.sessionsConflict') });
      } else if (plan.status === 'noop') {
        setCompatibilityFeedback({ tone: 'info', text: t('st.compat.sessionsNoop') });
      }
    } catch (error) {
      setCompatibilityFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSessionsBusy(null);
    }
  };

  const moveSessions = async () => {
    if (host.kind !== 'tauri') return;
    setConfirmSessionsMove(false);
    setSessionsBusy('move');
    setCompatibilityFeedback(null);
    try {
      const result = await host.executeSessionsMigration();
      setSessionsPlan(result);
      if (result.status === 'moved') {
        setCompatibilityFeedback({
          tone: 'success',
          text: t('st.compat.sessionsMoved', { count: result.sessionCount }),
        });
      } else if (result.status === 'blocked') {
        setCompatibilityFeedback({ tone: 'error', text: t('st.compat.sessionsConflict') });
      } else {
        setCompatibilityFeedback({ tone: 'info', text: t('st.compat.sessionsNoop') });
      }
    } catch (error) {
      setCompatibilityFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSessionsBusy(null);
    }
  };

  return (
    <div className="space-y-3">
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

      <SectionCard id="st-card-appearance" title={t('st.appearance.title')}>
        <div className="space-y-3">
          <div>
            <span id="theme-label" className="mb-1.5 block text-[11px] font-medium text-ink-soft">
              {t('st.appearance.theme')}
            </span>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="theme-label">
              {(['light', 'dark', 'system'] as ThemePreference[]).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  data-theme-choice={choice}
                  aria-pressed={settings.theme === choice}
                  onClick={() => { updateLocal({ theme: choice }); }}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                    settings.theme === choice
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-hairline text-ink-soft hover:border-hairline-strong'
                  }`}
                >
                  {t(`st.appearance.theme.${choice}`)}
                </button>
              ))}
            </div>
          </div>
          <Hint>{t('st.appearance.themeHint')}</Hint>
        </div>
      </SectionCard>

      <SectionCard id="st-card-defaults" title={t('st.defaults.title')}>
        <div className="space-y-3">
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
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Toggle label={t('st.defaults.planMode')} checked={planMode} disabled={saving} onChange={(checked) => void applyDefaults(permissionMode, checked)} />
            <Toggle
              label={t('st.defaults.planGate')}
              checked={planGate === 'gated'}
              disabled={saving}
              onChange={(checked) => void applyPlanGate(checked ? 'gated' : 'free')}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <label htmlFor="plan-gate-timeout" className="text-[11px] font-medium text-ink-soft">
              {t('st.defaults.planGateTimeout')}
            </label>
            <input
              id="plan-gate-timeout"
              type="number"
              min={5}
              step={1}
              disabled={saving}
              className={`${SMALL_INPUT} py-1`}
              value={planGateTimeoutS}
              onChange={(event) => { setPlanGateTimeoutS(event.target.value); }}
              onBlur={() => void commitPlanGateTimeout()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </div>
          <Hint>{t('st.defaults.planGateHint')} {t('st.defaults.hint')}</Hint>
          <FeedbackLine feedback={feedback} />
          {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard id="st-card-composer" title={t('st.composer.title')}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <label htmlFor="send-shortcut-select" className="text-[11px] font-medium text-ink-soft">{t('st.composer.sendShortcut')}</label>
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

      <SectionCard id="st-card-desktop" title={t('st.desktop.title')} badge="desktop" aside={isDesktop ? undefined : t('st.desktop.browserHint')}>
        {isDesktop ? (
        <fieldset className="space-y-4">
          <Toggle
            label={t('st.desktop.notifications')}
            checked={desktopPrefs.notifications}
            disabled={!isDesktop}
            onChange={(checked) => {
              const next = { ...desktopPrefs, notifications: checked };
              setDesktopPrefs(next);
              writeDesktopPrefs(next);
              void host.writeDesktopPrefs(next);
            }}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            {([
              { closeToTray: true, titleKey: 'st.desktop.tray', descriptionKey: 'st.desktop.trayDesc' },
              { closeToTray: false, titleKey: 'st.desktop.quit', descriptionKey: 'st.desktop.quitDesc' },
            ] as const).map((option) => (
              <label
                key={option.titleKey}
                className={`cursor-pointer rounded-xl border p-3 ${
                  desktopPrefs.closeToTray === option.closeToTray ? 'border-accent bg-accent-soft' : 'border-hairline bg-paper'
                }`}
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
                      void host.writeDesktopPrefs(next);
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
        ) : null}
      </SectionCard>

      <SectionCard id="st-card-compatibility-home" title={t('st.compat.title')} badge="desktop" aside={isDesktop ? undefined : t('st.compat.browserHint')}>
        {isDesktop ? (
        <>
        <button
          type="button"
          aria-expanded={compatOpen}
          onClick={() => { setCompatOpen(!compatOpen); }}
          className="mb-2 text-[11px] font-medium text-accent hover:underline"
        >
          {t(compatOpen ? 'st.compat.collapse' : 'st.compat.expand')}
        </button>
        {compatOpen ? (
        <>
        <fieldset disabled={compatibilityBusy || configImporting || migrating !== null || sessionsBusy !== null} className="space-y-4">
          <div>
            <label htmlFor="compatibility-home-kind" className="mb-1.5 block text-[11px] font-medium text-ink-soft">
              {t('st.compat.home')}
            </label>
            <select
              id="compatibility-home-kind"
              className={SMALL_INPUT}
              value={homeKindDraft}
              onChange={(event) => {
                const homeKind = event.target.value as CompatibilitySettings['homeKind'];
                setSessionsPlan(null);
                setConfirmSessionsMove(false);
                setHomeKindDraft(homeKind);
                if (homeKind === 'custom') {
                  return;
                }
                void persistCompatibility({
                  ...desktopPrefs.compatibility,
                  homeKind,
                  customHome: undefined,
                });
              }}
            >
              <option value="kimi">{t('st.compat.homeKimi')}</option>
              <option value="custom">{t('st.compat.homeCustom')}</option>
            </select>
          </div>
          {homeKindDraft === 'custom' ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                className={INPUT}
                value={customHome}
                placeholder={t('st.compat.customPlaceholder')}
                onChange={(event) => {
                  setCustomHome(event.target.value);
                  setSessionsPlan(null);
                  setConfirmSessionsMove(false);
                }}
              />
              <button
                type="button"
                className={PRIMARY_BUTTON}
                onClick={() => void persistCompatibility({
                  ...desktopPrefs.compatibility,
                  homeKind: 'custom',
                  customHome,
                })}
              >
                {t('st.compat.useHome')}
              </button>
            </div>
          ) : null}
          <div className="space-y-2">
            <label className="block text-[11px] font-medium text-ink-soft">{t('st.compat.credentialPath')}</label>
            <input className={`${INPUT} font-mono`} value={kimiHomePaths?.credentialPath ?? ''} readOnly />
          </div>
          <Hint>{t('st.compat.hint')}</Hint>
          <div className="space-y-3 border-t border-hairline pt-4">
            <div>
              <p className="text-[12.5px] font-medium text-ink">{t('st.compat.configImportTitle')}</p>
              <Hint>{t('st.compat.configImportHint')}</Hint>
            </div>
            <dl className="grid gap-1 text-[11px] text-ink-soft">
              <div><dt className="inline font-medium text-ink">{t('st.compat.configImportSource')}: </dt><dd className="inline break-all font-mono">{kimiHomePaths?.sourceConfigPath ?? ''}</dd></div>
              <div><dt className="inline font-medium text-ink">{t('st.compat.configImportTarget')}: </dt><dd className="inline break-all font-mono">{kimiHomePaths?.configPath ?? ''}</dd></div>
              <div><dt className="inline font-medium text-ink">{t('st.compat.configImportCategories')}: </dt><dd className="inline font-mono">providers, models, default_model, default_provider, thinking</dd></div>
            </dl>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={homeKindDraft !== desktopPrefs.compatibility.homeKind}
              onClick={() => void importKimiConfig()}
            >
              {configImporting ? t('st.compat.configImporting') : t('st.compat.configImport')}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={homeKindDraft !== desktopPrefs.compatibility.homeKind}
              onClick={() => void migrateCategory()}
            >
              {migrating === 'userSkills' ? t('st.compat.migrating') : t('st.compat.migrateUserSkills')}
            </button>
          </div>
          <Hint>{t('st.compat.migrationHint')}</Hint>
          <div className="border-t border-hairline pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[12.5px] font-medium text-ink">{t('st.compat.sessionsTitle')}</p>
                <Hint>{t('st.compat.sessionsHint')}</Hint>
              </div>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={homeKindDraft !== desktopPrefs.compatibility.homeKind}
                onClick={() => void reviewSessionsMove()}
              >
                {sessionsBusy === 'dryRun' ? t('st.compat.sessionsReviewing') : t('st.compat.sessionsReview')}
              </button>
            </div>
            {sessionsPlan !== null ? (
              <div className="mt-3 space-y-2 rounded-lg border border-hairline bg-paper p-3 text-[11.5px] text-ink-soft">
                <p>{t('st.compat.sessionsSummary', {
                  count: sessionsPlan.sessionCount,
                  bytes: sessionsPlan.totalBytes.toLocaleString(),
                })}</p>
                <p>{t('st.compat.sessionsMethod')}</p>
                <dl className="grid gap-1">
                  <div><dt className="inline font-medium text-ink">{t('st.compat.sessionsSource')}: </dt><dd className="inline break-all font-mono">{sessionsPlan.sourceRoot}</dd></div>
                  <div><dt className="inline font-medium text-ink">{t('st.compat.sessionsTarget')}: </dt><dd className="inline break-all font-mono">{sessionsPlan.targetRoot}</dd></div>
                </dl>
                <ul className="space-y-1">
                  {sessionsPlan.plannedMoves.map((move) => (
                    <li key={`${move.source}:${move.target}`} className="break-all font-mono">
                      {move.entry}: {move.source} → {move.target}
                    </li>
                  ))}
                </ul>
                {sessionsPlan.status === 'ready' ? (
                  <button
                    type="button"
                    className={PRIMARY_BUTTON}
                    onClick={() => { setConfirmSessionsMove(true); }}
                  >
                    {sessionsBusy === 'move' ? t('st.compat.sessionsMoving') : t('st.compat.sessionsMove')}
                  </button>
                ) : null}
                {sessionsPlan.status === 'blocked' ? <p className="text-danger">{t('st.compat.sessionsConflict')}</p> : null}
                {sessionsPlan.status === 'noop' ? <p>{t('st.compat.sessionsNoop')}</p> : null}
              </div>
            ) : null}
          </div>
          <FeedbackLine feedback={compatibilityFeedback} />
        </fieldset>
        <ConfirmDialog
          open={confirmSessionsMove && sessionsPlan?.status === 'ready'}
          title={t('st.compat.sessionsConfirmTitle')}
          body={t('st.compat.sessionsConfirmBody')}
          consequences={sessionsPlan === null ? undefined : [
            t('st.compat.sessionsSummary', {
              count: sessionsPlan.sessionCount,
              bytes: sessionsPlan.totalBytes.toLocaleString(),
            }),
            ...sessionsPlan.plannedMoves.map(
              (move) => `${move.entry}: ${move.source} → ${move.target}`,
            ),
            t('st.compat.sessionsMethod'),
          ]}
          confirmLabel={t('st.compat.sessionsMove')}
          busy={sessionsBusy === 'move'}
          onConfirm={() => void moveSessions()}
          onCancel={() => { setConfirmSessionsMove(false); }}
        />
        </>
        ) : null}
        </>
        ) : null}
      </SectionCard>
    </div>
  );
}
