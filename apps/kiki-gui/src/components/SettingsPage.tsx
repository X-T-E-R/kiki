import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import type {
  McpServer,
  ModelCatalogItem,
  PermissionMode,
  SkillDescriptor,
} from '@moonshot-ai/protocol';
import type {
  ListWorkspacesResponse,
  Workspace,
} from '@moonshot-ai/protocol';

import {
  checkNativeDesktopUpdate,
  dryRunNativeSessionsMigration,
  executeNativeSessionsMigration,
  importNativeKimiConfig,
  isDesktopRuntime,
  migrateNativeCompatibilityCategory,
  readNativeDesktopPrefs,
  readNativeKimiHomePaths,
  restartNativeServer,
  selectDirectoriesNative,
  writeNativeDesktopPrefs,
  writeNativeCompatibilitySettings,
  type SessionsMigrationPlan,
} from '../lib/desktop';
import { useI18n } from '../i18n';
import { errorText, issueText, type I18nKey, type Locale } from '../i18n/locale';
import { clearStoredDrafts } from '../lib/drafts';
import {
  disabledProfilePatch,
  experimentalFlagRows,
  mergeNamedAgentProfiles,
  namedAgentNewSessionBlocked,
  namedAgentOverrideRelations,
  namedAgentSessionHref,
  partitionNamedAgentProfiles,
  subagentGovernanceFromConfig,
  subagentGovernancePatch,
  summarizeNamedAgentLease,
  summarizeNamedAgentModelProfile,
  validateSubagentGovernance,
  workspaceChipDisplay,
  type NamedAgentLeaseDetailLabel,
  type NamedAgentOverrideRelation,
  type SubagentGovernanceDraft,
  type SubagentGovernanceIssue,
} from '../lib/agentSettings';
import type {
  KikiConfigResponse,
  ListNamedAgentProfilesResponse,
  McpJsonServerConfig,
  McpJsonServerEntry,
  McpJsonWriteScope,
  NamedAgentProfile,
} from '../lib/client';
import {
  appendExtraSkillDirs,
  buildSettingsSearchIndex,
  CAPABILITY_GROUPS,
  capabilityGroupForCard,
  clearRestartRequirement,
  markRestartRequired,
  parseAdvancedServerConfig,
  readDesktopPrefs,
  readSettings,
  searchSettings,
  serverFileSettingsFromConfig,
  serverFileSettingsPatch,
  validateDesktopConfigDraft,
  validateExtraSkillDirs,
  writeDesktopPrefs,
  writeSettings,
  acknowledgeRestartRequirement,
  isRestartRequirementAcknowledged,
  type SendShortcut,
  type SettingsSearchEntry,
  type CompatibilitySettings,
} from '../lib/settings';
import { formatTokens } from '../lib/time';
import { filterWorkspaces, sortWorkspacesByRecency } from '../lib/sorting';
import { useConnection } from '../state/connection';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from './controls';
import { useDirtyGuard, useGuardedNavigate } from './dirtyGuard';
import { OAuthDeviceCard } from './OAuthDeviceCard';
import { MsUnitInput, NewProviderWizard, ProviderEditor } from './ProviderFields';
import { useRestartRequirement } from './RestartBanner';
import { RuntimeConfigEditor } from './RuntimeConfigEditor';
import { SearchableSelect, type SearchableSelectOption } from './SearchableSelect';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from './ui';

const SECTIONS: readonly { id: string; labelKey: I18nKey }[] = [
  { id: 'general', labelKey: 'st.section.general' },
  { id: 'models', labelKey: 'st.section.models' },
  { id: 'providers', labelKey: 'st.section.providers' },
  { id: 'agents', labelKey: 'st.section.agents' },
  { id: 'capabilities', labelKey: 'st.section.capabilities' },
  { id: 'workspaces', labelKey: 'st.section.workspaces' },
  { id: 'connection', labelKey: 'st.section.connection' },
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

/**
 * Collapsible group header for the capabilities section — a labeled layer
 * (title + card count + chevron + hairline rule) whose body folds with the
 * shared `.expand-collapse` grid-rows transition, mirroring the
 * /capabilities page's CapabilityGroup without nesting card chrome.
 */
function SettingsGroup({
  id,
  title,
  count,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div data-settings-group={id} className="space-y-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`st-group-body-${id}`}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        <span
          aria-hidden
          className={`shrink-0 text-[11px] text-ink-faint transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        >
          ▾
        </span>
        <span className="shrink-0 text-[12px] font-semibold uppercase tracking-wide text-ink-soft">
          {title}
        </span>
        <span className="shrink-0 rounded-full border border-hairline bg-paper px-1.5 py-px font-mono text-[10px] text-ink-faint tabular-nums">
          {count}
        </span>
        <span aria-hidden className="h-px min-w-4 flex-1 bg-hairline" />
      </button>
      <div
        id={`st-group-body-${id}`}
        className="expand-collapse grid"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="space-y-5 pb-1">{children}</div>
        </div>
      </div>
    </div>
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

function isAbsoluteHomePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(path);
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
  const isDesktop = isDesktopRuntime();

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
  }, []);

  useEffect(() => { syncFromConfig(configQuery.data); }, [configQuery.data, syncFromConfig]);

  useEffect(() => {
    if (!isDesktop) return;
    void Promise.all([readNativeDesktopPrefs(), readNativeKimiHomePaths()]).then(([prefs, paths]) => {
      if (prefs !== null) {
        setDesktopPrefs(prefs);
        setHomeKindDraft(prefs.compatibility.homeKind);
        setCustomHome(prefs.compatibility.customHome ?? '');
        writeDesktopPrefs(prefs);
      }
      setKimiHomePaths(paths);
    });
  }, [isDesktop]);

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
      await writeNativeCompatibilitySettings(next);
      setKimiHomePaths(await readNativeKimiHomePaths());
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
    setConfigImporting(true);
    setCompatibilityFeedback(null);
    try {
      const result = await importNativeKimiConfig();
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
    setMigrating('userSkills');
    setCompatibilityFeedback(null);
    try {
      const result = await migrateNativeCompatibilityCategory('userSkills');
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
    setSessionsBusy('dryRun');
    setCompatibilityFeedback(null);
    try {
      const plan = await dryRunNativeSessionsMigration();
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
    setConfirmSessionsMove(false);
    setSessionsBusy('move');
    setCompatibilityFeedback(null);
    try {
      const result = await executeNativeSessionsMigration();
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

      <SectionCard id="st-card-compatibility-home" title={t('st.compat.title')} badge="desktop">
        <fieldset disabled={!isDesktop || compatibilityBusy || configImporting || migrating !== null || sessionsBusy !== null} className="space-y-4">
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
              <div><dt className="inline font-medium text-ink">{t('st.compat.configImportCategories')}: </dt><dd className="inline font-mono">providers, models, services, default_model, default_provider, thinking, secondary_model</dd></div>
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
          <Hint>{t('st.auth.sharedHomeHint')}</Hint>
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

function ExperimentalFlagsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const metaQuery = useQuery({ queryKey: ['meta'], queryFn: () => client.meta(), staleTime: 15_000 });

  useEffect(() => {
    if (configQuery.data !== undefined) setOverrides({ ...(configQuery.data.experimental ?? {}) });
  }, [configQuery.data]);

  const rows = experimentalFlagRows(metaQuery.data ?? {}, { experimental: overrides });
  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({
        experimental: overrides,
        replace_domains: ['experimental'],
      });
      queryClient.setQueryData(['config'], echoed);
      setOverrides({ ...(echoed.experimental ?? {}) });
      await queryClient.invalidateQueries({ queryKey: ['meta'] });
      setFeedback({ tone: 'success', text: t('st.experimental.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-experimental" title={t('st.experimental.title')}>
      <div className="space-y-3">
        <Hint>{t('st.experimental.hint')}</Hint>
        <fieldset disabled={saving} className="space-y-2 disabled:opacity-60">
          {rows.map((row) => (
            <div key={row.id} className="rounded-lg border border-hairline bg-paper px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-all font-mono text-[12px] font-medium text-ink">{row.id}</p>
                  <p className="text-[10.5px] text-ink-faint">
                    {t(row.effective ? 'st.experimental.effectiveOn' : 'st.experimental.effectiveOff')}
                    {' · '}
                    {t(row.override === undefined ? 'st.experimental.inherited' : 'st.experimental.overridden')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Toggle
                    label={t('st.experimental.overrideLabel', { id: row.id })}
                    checked={row.override ?? row.effective}
                    onChange={(checked) => { setOverrides((current) => ({ ...current, [row.id]: checked })); }}
                  />
                  {row.override !== undefined ? (
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      onClick={() => {
                        setOverrides((current) => {
                          const next = { ...current };
                          delete next[row.id];
                          return next;
                        });
                      }}
                    >
                      {t('st.experimental.useInherited')}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
          {rows.length === 0 && !metaQuery.isLoading && !configQuery.isLoading ? <Hint>{t('st.experimental.empty')}</Hint> : null}
        </fieldset>
        <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('common.saving') : t('common.save')}</button>
        {metaQuery.isError ? <InlineError error={metaQuery.error} /> : null}
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

function CapabilitiesSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [workspaceId, setWorkspaceId] = useState('');
  const [mergeSkills, setMergeSkills] = useState(true);
  const [extraDirs, setExtraDirs] = useState('');
  const [advanced, setAdvanced] = useState('{}');
  const [telemetry, setTelemetry] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectingDirs, setSelectingDirs] = useState(false);
  const [advancedSaving, setAdvancedSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [advancedFeedback, setAdvancedFeedback] = useState<Feedback>(null);
  const restart = useRestartRequirement();
  const isDesktop = isDesktopRuntime();
  // Group fold state: user toggles override CAPABILITY_GROUPS defaults; a
  // settings-search flash forces the target card's group open so the
  // scroll + flash lands on a visible card.
  const [openOverrides, setOpenOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const flashId = useContext(SettingsFlashContext);
  const flashGroupId = flashId !== null ? capabilityGroupForCard(flashId)?.id : undefined;

  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  const mcpQuery = useQuery({ queryKey: ['mcp-servers'], queryFn: () => client.listMcpServers(), staleTime: 60_000 });
  const mcpConfigQuery = useQuery({
    queryKey: ['mcp-config-servers', workspaceId],
    queryFn: () => client.listMcpJsonServers(workspaceId),
    enabled: workspaceId !== '',
    staleTime: 60_000,
  });
  const skillsQuery = useQuery({
    queryKey: ['workspace-skills', workspaceId],
    queryFn: () => client.listWorkspaceSkills(workspaceId),
    enabled: workspaceId !== '',
    staleTime: 60_000,
  });

  const workspaces = workspacesQuery.data?.items ?? [];
  const sortedWorkspaces = useMemo(() => sortWorkspacesByRecency(workspaces), [workspaces]);
  const workspaceOptions: readonly SearchableSelectOption[] = useMemo(
    () =>
      sortedWorkspaces.map((workspace) => ({
        value: workspace.id,
        label: workspace.name,
        hint: workspace.root,
        title: workspace.name,
      })),
    [sortedWorkspaces],
  );
  useEffect(() => {
    if (workspaceId === '' && sortedWorkspaces[0] !== undefined) setWorkspaceId(sortedWorkspaces[0].id);
  }, [workspaceId, sortedWorkspaces]);
  useEffect(() => {
    const config = configQuery.data;
    if (config === undefined) return;
    setMergeSkills(config.merge_all_available_skills !== false);
    setExtraDirs((config.extra_skill_dirs ?? []).join('\n'));
    setAdvanced(JSON.stringify({
      permission: config.permission ?? {},
      hooks: config.hooks ?? [],
      services: config.services ?? {},
      loop_control: config.loop_control ?? {},
      background: config.background ?? {},
    }, null, 2));
    setTelemetry(config.telemetry !== false);
  }, [configQuery.data]);

  const selectExtraDirs = async () => {
    setSelectingDirs(true);
    setFeedback(null);
    try {
      const selected = await selectDirectoriesNative();
      if (selected !== null) setExtraDirs((current) => appendExtraSkillDirs(current, selected));
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSelectingDirs(false);
    }
  };

  const save = async () => {
    const pathError = validateExtraSkillDirs(extraDirs);
    if (pathError !== null) {
      setFeedback({ tone: 'error', text: issueText(locale, pathError) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({
        merge_all_available_skills: mergeSkills,
        extra_skill_dirs: extraDirs.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean),
        telemetry,
      });
      queryClient.setQueryData(['config'], echoed);
      setMergeSkills(echoed.merge_all_available_skills !== false);
      setExtraDirs((echoed.extra_skill_dirs ?? []).join('\n'));
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

  const groupContent: Record<string, React.ReactNode> = {
    skills: (
      <>
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
            <div>
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="settings-extra-skill-dirs" className="text-[11px] font-medium text-ink-soft">{t('st.caps.extraDirs')}</label>
                {isDesktop ? (
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    disabled={selectingDirs}
                    onClick={() => void selectExtraDirs()}
                  >
                    {t('st.caps.selectDirs')}
                  </button>
                ) : null}
              </div>
              <textarea id="settings-extra-skill-dirs" className={`${INPUT} mt-1 min-h-24 font-mono`} value={extraDirs} onChange={(event) => { setExtraDirs(event.target.value); }} placeholder={t('st.caps.extraDirsPlaceholder')} />
            </div>
            <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('common.saving') : t('st.caps.save')}</button>
            <FeedbackLine feedback={feedback} />
          </div>
        </SectionCard>

        <SectionCard id="st-card-skills" title={t('st.skills.title')}>
          <div className="mb-3 flex items-center gap-2">
            <span className="text-[11px] font-medium text-ink-soft">{t('st.skills.workspace')}</span>
            <SearchableSelect
              id="workspace-skills-select"
              options={workspaceOptions}
              value={workspaceId}
              onChange={setWorkspaceId}
              ariaLabel={t('st.skills.workspace')}
            />
          </div>
          <div className="space-y-2">
            {skillsQuery.data?.skills.map((skill) => <SkillRow key={skill.name} skill={skill} />)}
            {skillsQuery.isLoading ? <Hint>{t('st.skills.loading')}</Hint> : null}
            {skillsQuery.isError ? <InlineError error={skillsQuery.error} /> : null}
          </div>
        </SectionCard>
      </>
    ),
    mcp: (
      <SectionCard id="st-card-mcp" title={t('st.mcp.title')}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-ink-soft">{t('st.mcp.workspace')}</span>
            <SearchableSelect
              id="workspace-mcp-select"
              options={workspaceOptions}
              value={workspaceId}
              onChange={setWorkspaceId}
              ariaLabel={t('st.mcp.workspace')}
            />
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{t('st.mcp.statusTitle')}</p>
            {mcpQuery.data?.servers.map((server) => <McpRow key={server.id} server={server} />)}
            {mcpQuery.isLoading ? <Hint>{t('st.mcp.loading')}</Hint> : null}
            {mcpQuery.isError ? <InlineError error={mcpQuery.error} /> : null}
          </div>
          <McpConfigManager
            workspaceId={workspaceId}
            entries={mcpConfigQuery.data?.entries ?? []}
            loading={mcpConfigQuery.isLoading}
            error={mcpConfigQuery.error}
            onEcho={(echo) => {
              queryClient.setQueryData(['mcp-config-servers', workspaceId], echo);
            }}
          />
        </div>
      </SectionCard>
    ),
    runtime: <RuntimeConfigEditor />,
    experimental: <ExperimentalFlagsCard />,
    advanced: (
      <SectionCard id="st-card-advanced" title={t('st.advanced.title')}>
        <div className="space-y-3">
          <Hint>{t('st.advanced.hint')}</Hint>
          <textarea className={`${INPUT} min-h-64 font-mono`} value={advanced} onChange={(event) => { setAdvanced(event.target.value); }} aria-label={t('st.advanced.aria')} />
          <button type="button" className={PRIMARY_BUTTON} disabled={advancedSaving} onClick={() => void saveAdvanced()}>{advancedSaving ? t('common.saving') : t('st.advanced.save')}</button>
          <FeedbackLine feedback={advancedFeedback} />
        </div>
      </SectionCard>
    ),
  };

  return (
    <div className="space-y-6">
      <p className="px-1 text-[11.5px] text-ink-faint">
        {t('st.caps.browseHint')}{' '}
        <Link to="/capabilities" className="font-medium text-accent hover:underline">{t('st.caps.browseLink')}</Link>
      </p>
      {CAPABILITY_GROUPS.map((group) => {
        const open = group.id === flashGroupId ? true : (openOverrides[group.id] ?? group.defaultOpen);
        return (
          <SettingsGroup
            key={group.id}
            id={group.id}
            title={t(group.titleKey)}
            count={group.cardIds.length}
            open={open}
            onToggle={() => { setOpenOverrides((current) => ({ ...current, [group.id]: !open })); }}
          >
            {groupContent[group.id]}
          </SettingsGroup>
        );
      })}
    </div>
  );
}

const LEASE_DETAIL_LABEL_KEYS: Record<NamedAgentLeaseDetailLabel, I18nKey> = {
  description: 'st.namedAgents.description',
  whenToUse: 'st.namedAgents.whenToUse',
  modelPreference: 'st.namedAgents.modelPreference',
  serviceTier: 'st.namedAgents.serviceTier',
  delegationNotice: 'st.namedAgents.delegationNotice',
  promptMode: 'st.namedAgents.promptMode',
  allowedModels: 'st.namedAgents.allowedModels',
  deniedModels: 'st.namedAgents.deniedModels',
  allowedEfforts: 'st.namedAgents.allowedEfforts',
  tools: 'st.namedAgents.tools',
  disallowedTools: 'st.namedAgents.disallowedTools',
  subagents: 'st.namedAgents.subagentLease',
  prompt: 'st.namedAgents.prompt',
  requestParams: 'st.namedAgents.requestParams',
  modelProfile: 'st.namedAgents.modelProfile',
  leaseSource: 'st.namedAgents.leaseSource',
};

const SUBAGENT_ISSUE_KEYS: Record<SubagentGovernanceIssue, I18nKey> = {
  duplicate_model: 'st.subagents.issueDuplicate',
  reserved_primary: 'st.subagents.issueReserved',
  default_required: 'st.subagents.issueDefaultRequired',
  default_not_in_pool: 'st.subagents.issueDefaultNotInPool',
  force_pool_conflict: 'st.subagents.issueForcePool',
  enforce_requires_pool: 'st.subagents.issueEnforceNeedsPool',
  enforce_force_conflict: 'st.subagents.issueEnforceForce',
};

const EMPTY_SUBAGENT_GOVERNANCE: SubagentGovernanceDraft = {
  models: [],
  defaultModel: '',
  force: false,
  enforcePool: false,
  denyModels: '',
};

function SubagentGovernanceCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SubagentGovernanceDraft>(EMPTY_SUBAGENT_GOVERNANCE);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined) setDraft(subagentGovernanceFromConfig(configQuery.data));
  }, [configQuery.data]);

  const save = async () => {
    const issue = validateSubagentGovernance(draft);
    if (issue !== null) {
      setFeedback({ tone: 'error', text: t(SUBAGENT_ISSUE_KEYS[issue]) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(subagentGovernancePatch(draft));
      queryClient.setQueryData(['config'], echoed);
      setDraft(subagentGovernanceFromConfig(echoed));
      setFeedback({ tone: 'success', text: t('st.subagents.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-subagents" title={t('st.subagents.title')}>
      <div className="space-y-4">
        <Hint>{t('st.subagents.hint')}</Hint>
        <fieldset disabled={configQuery.isLoading || saving} className="space-y-4 disabled:opacity-60">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-medium text-ink-soft">{t('st.subagents.pool')}</span>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => { setDraft((current) => ({ ...current, models: [...current.models, { id: '', description: '' }] })); }}
              >
                {t('st.subagents.addModel')}
              </button>
            </div>
            {draft.models.map((model, index) => (
              <div key={`${index}:${model.id}`} className="grid gap-2 rounded-lg border border-hairline bg-paper p-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto]">
                <button
                  type="button"
                  className={`h-8 w-8 rounded-md border text-sm ${draft.defaultModel === model.id && model.id !== '' ? 'border-accent bg-accent-soft text-accent' : 'border-hairline text-ink-faint'}`}
                  aria-label={t('st.subagents.setDefault', { model: model.id || String(index + 1) })}
                  title={t('st.subagents.default')}
                  onClick={() => { if (model.id.trim() !== '') setDraft((current) => ({ ...current, defaultModel: model.id.trim() })); }}
                >
                  ★
                </button>
                <input
                  className={INPUT}
                  value={model.id}
                  aria-label={t('st.subagents.modelId', { n: index + 1 })}
                  placeholder="provider/model"
                  onChange={(event) => {
                    const id = event.target.value;
                    setDraft((current) => ({
                      ...current,
                      models: current.models.map((entry, candidate) => candidate === index ? { ...entry, id } : entry),
                    }));
                  }}
                />
                <input
                  className={INPUT}
                  value={model.description}
                  aria-label={t('st.subagents.modelDescription', { n: index + 1 })}
                  placeholder={t('st.subagents.descriptionPlaceholder')}
                  onChange={(event) => {
                    const description = event.target.value;
                    setDraft((current) => ({
                      ...current,
                      models: current.models.map((entry, candidate) => candidate === index ? { ...entry, description } : entry),
                    }));
                  }}
                />
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  aria-label={t('st.subagents.removeModel', { model: model.id || String(index + 1) })}
                  onClick={() => {
                    setDraft((current) => ({
                      ...current,
                      defaultModel: current.defaultModel === model.id ? '' : current.defaultModel,
                      models: current.models.filter((_, candidate) => candidate !== index),
                    }));
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            {draft.models.length === 0 ? <Hint>{t('st.subagents.poolEmpty')}</Hint> : null}
          </div>
          <label className="block text-[11px] font-medium text-ink-soft">{t('st.subagents.default')}
            <input
              className={`${INPUT} mt-1`}
              value={draft.defaultModel}
              placeholder="provider/model"
              onChange={(event) => { setDraft((current) => ({ ...current, defaultModel: event.target.value })); }}
            />
          </label>
          <div className="space-y-2">
            <Toggle label={t('st.subagents.force')} checked={draft.force} onChange={(force) => { setDraft((current) => ({ ...current, force })); }} />
            <Hint>{t('st.subagents.forceHint')}</Hint>
            <Toggle label={t('st.subagents.enforcePool')} checked={draft.enforcePool} onChange={(enforcePool) => { setDraft((current) => ({ ...current, enforcePool })); }} />
            <Hint>{t('st.subagents.enforcePoolHint')}</Hint>
          </div>
          <label className="block text-[11px] font-medium text-ink-soft">{t('st.subagents.denyModels')}
            <textarea
              className={`${INPUT} mt-1 min-h-24 font-mono`}
              value={draft.denyModels}
              placeholder={t('st.subagents.denyPlaceholder')}
              onChange={(event) => { setDraft((current) => ({ ...current, denyModels: event.target.value })); }}
            />
          </label>
        </fieldset>
        <button type="button" className={PRIMARY_BUTTON} disabled={configQuery.isLoading || saving} onClick={() => void save()}>{saving ? t('common.saving') : t('st.subagents.save')}</button>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

export function parseNamedAgentTools(value: string): readonly string[] | null {
  const tools = value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return tools.length === 0 ? null : tools;
}

function NamedAgentProfileRow({
  profile,
  workspaceFallbackId,
  overrideRelation,
  onUpdated,
  onToggleEnabled,
  toggleSaving,
}: {
  profile: NamedAgentProfile;
  workspaceFallbackId?: string;
  overrideRelation?: NamedAgentOverrideRelation;
  onUpdated: (profile: NamedAgentProfile) => void;
  onToggleEnabled: (profile: NamedAgentProfile, enabled: boolean) => Promise<void>;
  toggleSaving: boolean;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const writable =
    profile.workspace_id !== undefined &&
    profile.source_file !== undefined &&
    (profile.source === 'user' || profile.source === 'workspace' || profile.source === 'extra');
  // Built-ins and named profiles toggle through different config lists, but
  // the switch reads the same either way. For a main profile, "off" only
  // stops subagent calls — main sessions keep working.
  const toggleTitle = profile.source === 'builtin'
    ? profile.main === true
      ? t('st.namedAgents.defaultToggleHint')
      : t('st.namedAgents.builtinToggleHint')
    : t('st.namedAgents.namedToggleHint');
  const workspaceIds = profile.workspace_ids ?? (profile.workspace_id === undefined ? [] : [profile.workspace_id]);
  const workspaceChips = workspaceChipDisplay(workspaceIds);
  const sessionHref = namedAgentSessionHref(profile, workspaceFallbackId);
  // A disabled main profile keeps its new-session button (main sessions
  // still run it); a disabled subagent profile loses it. A shadowed file
  // profile loses it too: a session under its name would silently run the
  // same-named built-in instead.
  const shadowed = overrideRelation?.kind === 'shadowed';
  const newSessionBlocked = namedAgentNewSessionBlocked(profile, overrideRelation);
  const newSessionTitle = shadowed
    ? t('st.namedAgents.newSessionShadowed')
    : newSessionBlocked
      ? t('st.namedAgents.newSessionDisabled')
      : profile.disabled
        ? t('st.namedAgents.newSessionDisabledMain')
        : t('st.namedAgents.newSession');
  // Read-only projections the structured editor cannot write (the PATCH
  // schema does not open them): surface them in the summary and point at the
  // raw file instead of silently hiding them.
  const constraints = profile.spawn_constraints;
  const spawnSummary = constraints === undefined ? '' : [
    constraints.allowed_models === undefined ? null : `${t('st.namedAgents.allowedModels')} ${constraints.allowed_models.join(', ')}`,
    constraints.deny_models === undefined ? null : `${t('st.namedAgents.deniedModels')} ${constraints.deny_models.join(', ')}`,
    constraints.allowed_efforts === undefined ? null : `${t('st.namedAgents.allowedEfforts')} ${constraints.allowed_efforts.join(', ')}`,
    constraints.disallowed_tools === undefined ? null : `${t('st.namedAgents.disallowedTools')} ${constraints.disallowed_tools.join(', ')}`,
  ].filter((segment) => segment !== null).join(' · ');
  const hasProjection =
    (profile.model_profiles?.length ?? 0) > 0
    || spawnSummary !== ''
    || (profile.subagents?.length ?? 0) > 0;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [description, setDescription] = useState(profile.description ?? '');
  const [whenToUse, setWhenToUse] = useState(profile.when_to_use ?? '');
  const [modelAlias, setModelAlias] = useState(profile.pinned_model_alias ?? '');
  const [thinkingEffort, setThinkingEffort] = useState(profile.thinking_effort ?? '');
  const [serviceTier, setServiceTier] = useState<NamedAgentProfile['service_tier'] | ''>(profile.service_tier ?? '');
  const [tools, setTools] = useState((profile.tools ?? []).join(', '));
  const [disallowedTools, setDisallowedTools] = useState((profile.disallowed_tools ?? []).join(', '));
  const [routeAliases, setRouteAliases] = useState<Record<string, string>>(() =>
    Object.fromEntries(profile.routes.map((route) => [route.id, route.model_alias ?? ''])),
  );
  const [rawOpen, setRawOpen] = useState(false);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawSaving, setRawSaving] = useState(false);
  const [rawText, setRawText] = useState('');

  const resetDraft = () => {
    setDescription(profile.description ?? '');
    setWhenToUse(profile.when_to_use ?? '');
    setModelAlias(profile.pinned_model_alias ?? '');
    setThinkingEffort(profile.thinking_effort ?? '');
    setServiceTier(profile.service_tier ?? '');
    setTools((profile.tools ?? []).join(', '));
    setDisallowedTools((profile.disallowed_tools ?? []).join(', '));
    setRouteAliases(Object.fromEntries(profile.routes.map((route) => [route.id, route.model_alias ?? ''])));
    setFeedback(null);
  };
  const save = async () => {
    if (!writable || profile.workspace_id === undefined) return;
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.updateNamedAgentProfile(profile.name, {
        scope: profile.source === 'workspace' ? 'project' : profile.source,
        workspace_id: profile.workspace_id,
        description: description.trim(),
        when_to_use: whenToUse.trim() === '' ? null : whenToUse.trim(),
        pinned_model_alias: modelAlias.trim() === '' ? null : modelAlias.trim(),
        thinking_effort: thinkingEffort === '' ? null : thinkingEffort,
        service_tier: serviceTier === '' ? null : serviceTier,
        tools: parseNamedAgentTools(tools),
        disallowed_tools: parseNamedAgentTools(disallowedTools),
        routes: profile.routes.map((route) => ({
          id: route.id,
          model_alias: routeAliases[route.id]?.trim() === ''
            ? null
            : routeAliases[route.id]?.trim(),
        })),
      });
      onUpdated(echoed);
      setEditing(false);
      setFeedback({ tone: 'success', text: t('st.namedAgents.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };
  const toggleRaw = async () => {
    if (rawOpen) {
      setRawOpen(false);
      return;
    }
    if (profile.source_file === undefined) return;
    setRawOpen(true);
    setRawLoading(true);
    setFeedback(null);
    try {
      setRawText(await client.readHostFile(profile.source_file));
    } catch (error) {
      setRawOpen(false);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRawLoading(false);
    }
  };
  const saveRaw = async () => {
    if (!writable || profile.workspace_id === undefined) return;
    setRawSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.updateNamedAgentProfile(profile.name, {
        scope: profile.source === 'workspace' ? 'project' : profile.source,
        workspace_id: profile.workspace_id,
        raw_text: rawText,
      });
      onUpdated(echoed);
      setFeedback({ tone: 'success', text: t('st.namedAgents.rawSaved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRawSaving(false);
    }
  };

  const overriddenBy = overrideRelation?.kind === 'overridden' ? overrideRelation : undefined;
  const overrideState =
    overrideRelation?.kind === 'overrides_builtin'
      ? 'overrides'
      : overrideRelation?.kind === 'shadowed'
        ? 'shadowed'
        : undefined;

  // A built-in shadowed by an overriding same-name file profile collapses to
  // a single muted line — rendering it as a normal enabled row would suggest
  // two live profiles where only the file actually runs.
  if (overriddenBy !== undefined) {
    return (
      <div
        data-agent-profile={profile.name}
        data-agent-source={profile.source}
        data-override-state="overridden"
        className="rounded-lg border border-hairline bg-panel px-3 py-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono text-[12.5px] text-ink-faint">{profile.name}</p>
          <span className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[9.5px] text-ink-faint">
            {profile.source}
          </span>
          <span className="min-w-0 truncate text-[10.5px] text-ink-faint" title={overriddenBy.file}>
            {t('st.namedAgents.overriddenByFile', { file: overriddenBy.file })}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-agent-profile={profile.name}
      data-agent-source={profile.source}
      data-override-state={overrideState}
      className={`rounded-lg border border-hairline bg-paper px-3 py-2 transition-opacity ${profile.disabled ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[12.5px] font-medium text-ink">
            {profile.name}
            {profile.disabled ? (
              <span className="ml-2 rounded-full border border-hairline bg-panel px-1.5 py-px align-middle text-[9px] font-medium uppercase tracking-wide text-ink-faint">
                {t('st.namedAgents.disabledBadge')}
              </span>
            ) : null}
          </p>
          {profile.disabled && profile.main === true ? (
            <p className="mt-0.5 text-[10.5px] text-ink-faint">{t('st.namedAgents.disabledMainHint')}</p>
          ) : null}
          {!editing && profile.description !== undefined ? <p className="text-[11.5px] text-ink-soft">{profile.description}</p> : null}
          {overrideRelation?.kind === 'overrides_builtin' ? (
            <p className="mt-0.5 text-[10.5px] text-ink-faint">{t('st.namedAgents.overridesBuiltin')}</p>
          ) : null}
          {overrideRelation?.kind === 'shadowed' ? (
            <p className="mt-0.5 text-[10.5px] text-danger">{t('st.namedAgents.shadowedByBuiltin')}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div title={toggleTitle}>
            <Toggle
              label={t('st.namedAgents.enabled')}
              checked={!profile.disabled}
              disabled={toggleSaving}
              onChange={(enabled) => {
                setFeedback(null);
                void onToggleEnabled(profile, enabled).catch((error: unknown) => {
                  setFeedback({ tone: 'error', text: errorText(locale, error) });
                });
              }}
            />
          </div>
          <span className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[9.5px] text-ink-faint">
            {profile.source}{writable ? '' : ` · ${t('st.namedAgents.readOnly')}`}
          </span>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={newSessionBlocked}
            title={newSessionTitle}
            data-new-session-href={sessionHref}
            onClick={() => void navigate(sessionHref)}
          >
            {t('st.namedAgents.newSession')}
          </button>
          {writable && !editing ? (
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { resetDraft(); setEditing(true); }}>
              {t('st.namedAgents.edit')}
            </button>
          ) : null}
        </div>
      </div>
      {editing ? (
        <fieldset disabled={saving} className="mt-3 space-y-3 disabled:opacity-60">
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.description')}
            <textarea className={`${INPUT} mt-1 min-h-20`} value={description} onChange={(event) => { setDescription(event.target.value); }} />
          </label>
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.whenToUse')}
            <textarea className={`${INPUT} mt-1 min-h-16`} value={whenToUse} onChange={(event) => { setWhenToUse(event.target.value); }} />
          </label>
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.modelPin')}
            <input className={`${INPUT} mt-1 font-mono`} value={modelAlias} placeholder="provider/model" onChange={(event) => { setModelAlias(event.target.value); }} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-[11px] font-medium text-ink-soft">
              {t('st.namedAgents.thinkingEffort')}
              <select className={`${INPUT} mt-1`} value={thinkingEffort} onChange={(event) => { setThinkingEffort(event.target.value); }}>
                <option value="">{t('st.namedAgents.inherit')}</option>
                {['low', 'medium', 'high', 'xhigh', 'max'].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="block text-[11px] font-medium text-ink-soft">
              {t('st.namedAgents.serviceTier')}
              <select className={`${INPUT} mt-1`} value={serviceTier} onChange={(event) => { setServiceTier(event.target.value as typeof serviceTier); }}>
                <option value="">{t('st.namedAgents.inherit')}</option>
                {['auto', 'default', 'flex', 'priority'].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          </div>
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.tools')}
            <textarea className={`${INPUT} mt-1 min-h-16 font-mono`} value={tools} placeholder={t('st.namedAgents.toolsPlaceholder')} onChange={(event) => { setTools(event.target.value); }} />
          </label>
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.disallowedTools')}
            <textarea className={`${INPUT} mt-1 min-h-16 font-mono`} value={disallowedTools} placeholder={t('st.namedAgents.toolsPlaceholder')} onChange={(event) => { setDisallowedTools(event.target.value); }} />
          </label>
          {profile.routes.map((route) => (
            <label key={route.id} className="block text-[11px] font-medium text-ink-soft">
              {t('st.namedAgents.routeModel', { route: route.id })}
              <input
                className={`${INPUT} mt-1 font-mono`}
                value={routeAliases[route.id] ?? ''}
                placeholder="provider/model"
                onChange={(event) => { setRouteAliases((current) => ({ ...current, [route.id]: event.target.value })); }}
              />
            </label>
          ))}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={PRIMARY_BUTTON} disabled={description.trim() === '' || saving} onClick={() => void save()}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
            <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={() => { resetDraft(); setEditing(false); }}>
              {t('common.cancel')}
            </button>
          </div>
        </fieldset>
      ) : (
        <>
          <details className="mt-2 rounded-lg border border-hairline bg-panel px-2.5 py-1.5" data-technical-details>
            <summary className="cursor-pointer select-none text-[10.5px] font-medium text-ink-faint hover:text-ink-soft">
              {t('st.namedAgents.technicalDetails')}
            </summary>
            <div className="mt-2 space-y-1 break-all font-mono text-[10px] text-ink-faint">
            <p>{t('st.namedAgents.sourceFile')}: {profile.source_file ?? t('st.namedAgents.builtin')}</p>
            {workspaceChips.shown.length > 0 ? (
              <p className="flex flex-wrap items-center gap-1">
                {workspaceChips.shown.map((id) => (
                  <span key={id} title={id} className="max-w-40 truncate rounded-full border border-hairline bg-paper px-1.5 py-px font-mono text-[9.5px] text-ink-faint">
                    {id}
                  </span>
                ))}
                {workspaceChips.extra > 0 ? (
                  <span
                    title={workspaceIds.join(', ')}
                    className="rounded-full border border-hairline bg-paper px-1.5 py-px font-mono text-[9.5px] text-ink-faint"
                  >
                    +{workspaceChips.extra} {t('st.namedAgents.workspaces')}
                  </span>
                ) : null}
              </p>
            ) : null}
            {profile.when_to_use !== undefined ? <p>{t('st.namedAgents.whenToUse')}: {profile.when_to_use}</p> : null}
            {profile.pinned_model_alias !== undefined ? <p>{t('st.namedAgents.modelPin')}: {profile.pinned_model_alias}</p> : null}
            {profile.thinking_effort !== undefined ? <p>{t('st.namedAgents.thinkingEffort')}: {profile.thinking_effort}</p> : null}
            {profile.service_tier !== undefined ? <p>{t('st.namedAgents.serviceTier')}: {profile.service_tier}</p> : null}
            {profile.routes.map((route) => (
              <p key={route.id}>
                {t('st.namedAgents.route')}: {route.id}
                {route.model_alias === undefined ? '' : ` → ${route.model_alias}`}
                {' · '}{route.source_file}
              </p>
            ))}
            {profile.model_profiles?.map((entry) => {
              const modelProfile = summarizeNamedAgentModelProfile(entry);
              return (
                <div key={entry.alias} className="space-y-1">
                  <p>{t('st.namedAgents.modelProfile')}: {modelProfile.headline}</p>
                  {modelProfile.details.map((detail, detailIndex) => (
                    <p key={`${detail.label}:${detailIndex}`} className="pl-3">
                      {t(LEASE_DETAIL_LABEL_KEYS[detail.label])}: {detail.value}
                    </p>
                  ))}
                </div>
              );
            })}
            {spawnSummary !== '' ? <p>{t('st.namedAgents.spawnConstraints')}: {spawnSummary}</p> : null}
            {profile.subagents?.map((lease, index) => {
              if (typeof lease === 'string') {
                return <p key={lease}>{t('st.namedAgents.subagentLease')}: {lease}</p>;
              }
              const leaseSummary = summarizeNamedAgentLease(lease);
              return (
                <div key={`${lease.name}:${index}`} className="space-y-1">
                  <p>
                    {t('st.namedAgents.subagentLease')}:
                    {leaseSummary.scoped ? (
                      <span className="mx-1 rounded-full border border-accent/40 bg-accent-soft px-1.5 py-px align-middle text-[9px] font-medium uppercase tracking-wide text-accent">
                        {t('st.namedAgents.scopedBadge')}
                      </span>
                    ) : null}
                    {' '}{leaseSummary.headline}
                  </p>
                  {leaseSummary.status !== undefined ? (
                    <p className={`pl-3${leaseSummary.status === 'unavailable' ? ' text-danger' : ''}`}>
                      {t('st.namedAgents.leaseStatus')}: {t(leaseSummary.status === 'unavailable' ? 'st.namedAgents.leaseUnavailable' : 'st.namedAgents.leaseReady')}
                    </p>
                  ) : null}
                  {leaseSummary.diagnostic !== undefined ? (
                    <p className="pl-3 text-danger">{leaseSummary.diagnostic}</p>
                  ) : null}
                  {leaseSummary.details.map((detail, detailIndex) => (
                    <p key={`${detail.label}:${detailIndex}`} className="pl-3">
                      {t(LEASE_DETAIL_LABEL_KEYS[detail.label])}: {detail.value}
                    </p>
                  ))}
                </div>
              );
            })}
            </div>
            {hasProjection ? <Hint>{t('st.namedAgents.projectionHint')}</Hint> : null}
          </details>
        </>
      )}
      {profile.source_file !== undefined ? (
        <div className="mt-3 border-t border-hairline pt-3">
          <button type="button" className={SECONDARY_BUTTON} onClick={() => void toggleRaw()}>
            {rawOpen ? t('st.namedAgents.hideRaw') : writable ? t('st.namedAgents.editRaw') : t('st.namedAgents.viewRaw')}
          </button>
          {rawOpen ? (
            <div className="mt-2 space-y-2">
              {rawLoading ? <Hint>{t('st.namedAgents.rawLoading')}</Hint> : (
                <textarea
                  className={`${INPUT} min-h-64 font-mono text-[11px]`}
                  value={rawText}
                  readOnly={!writable}
                  onChange={(event) => { setRawText(event.target.value); }}
                />
              )}
              {writable && !rawLoading ? (
                <button type="button" className={PRIMARY_BUTTON} disabled={rawSaving} onClick={() => void saveRaw()}>
                  {rawSaving ? t('common.saving') : t('st.namedAgents.saveRaw')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

function NamedAgentProfilesCard() {
  const { client } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [toggleSaving, setToggleSaving] = useState<string | null>(null);
  const profilesQuery = useQuery({
    queryKey: ['named-agent-profiles'],
    queryFn: () => client.listNamedAgentProfiles(),
    staleTime: 15_000,
  });
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });
  // Workspace-less (builtin) profiles still need a workspace for the
  // new-session deep link: fall back to the most recent one.
  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const updateEcho = (updated: NamedAgentProfile) => {
    queryClient.setQueryData<ListNamedAgentProfilesResponse>(
      ['named-agent-profiles'],
      (current) => current === undefined
        ? { items: [updated] }
        : {
            items: current.items.map((profile) =>
              profile.name === updated.name &&
              profile.source === updated.source &&
              profile.source_file === updated.source_file
                ? updated
                : profile,
            ),
          },
    );
  };
  const toggleEnabled = async (profile: NamedAgentProfile, enabled: boolean) => {
    setToggleSaving(profile.name);
    try {
      const echoed = await client.patchConfig(disabledProfilePatch(configQuery.data ?? {}, profile, enabled));
      queryClient.setQueryData(['config'], echoed);
      // Named profiles disable globally by name; built-ins only by name+source.
      queryClient.setQueryData<ListNamedAgentProfilesResponse>(
        ['named-agent-profiles'],
        (current) => current === undefined
          ? current
          : {
              items: current.items.map((item) =>
                item.name === profile.name && (profile.source !== 'builtin' || item.source === 'builtin')
                  ? { ...item, disabled: !enabled }
                  : item,
              ),
            },
      );
    } finally {
      setToggleSaving(null);
    }
  };
  // Merged view: one row per name+source+file across workspaces. Idempotent
  // over servers that already return the merged /agents payload.
  const profiles = useMemo(
    () => mergeNamedAgentProfiles(profilesQuery.data?.items ?? []),
    [profilesQuery.data],
  );
  const fallbackWorkspaceId = useMemo(
    () => sortWorkspacesByRecency(workspacesQuery.data?.items ?? [])[0]?.id,
    [workspacesQuery.data],
  );
  // `main === true` lands in the main-agent card; everything else is a
  // subagent profile. Enabled toggle and edit affordances are identical.
  const buckets = useMemo(() => partitionNamedAgentProfiles(profiles), [profiles]);
  // Same-name built-in/file override relations: an overriding file profile is
  // the effective row, its built-in collapses to a shadow note, and a
  // non-override same-name file row carries a not-in-effect warning.
  const overrideRelations = useMemo(() => namedAgentOverrideRelations(profiles), [profiles]);

  const renderRow = (profile: NamedAgentProfile, index: number) => (
    <NamedAgentProfileRow
      key={`${profile.name}:${profile.source}:${profile.source_file ?? profile.workspace_id ?? ''}:${index}`}
      profile={profile}
      workspaceFallbackId={fallbackWorkspaceId}
      overrideRelation={overrideRelations.get(profile)}
      onUpdated={updateEcho}
      onToggleEnabled={toggleEnabled}
      toggleSaving={toggleSaving !== null || configQuery.isLoading}
    />
  );

  return (
    <>
      <SectionCard id="st-card-main-agents" title={t('st.mainAgents.title')}>
        <div className="space-y-3">
          <Hint>{t('st.namedAgents.editHint')}</Hint>
          <div className="space-y-2">
            {buckets.main.map(renderRow)}
            {profilesQuery.data !== undefined && buckets.main.length === 0 ? <Hint>{t('st.mainAgents.empty')}</Hint> : null}
            {profilesQuery.isLoading ? <Hint>{t('st.namedAgents.loading')}</Hint> : null}
            {profilesQuery.isError ? <InlineError error={profilesQuery.error} /> : null}
            {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
          </div>
        </div>
      </SectionCard>
      <SectionCard id="st-card-subagent-profiles" title={t('st.subagentProfiles.title')}>
        <div className="space-y-3">
          <div className="space-y-2">
            {buckets.sub.map(renderRow)}
            {profilesQuery.data !== undefined && buckets.sub.length === 0 ? <Hint>{t('st.subagentProfiles.empty')}</Hint> : null}
          </div>
        </div>
      </SectionCard>
    </>
  );
}

function AgentsSection() {
  const { t } = useI18n();
  return (
    <div className="space-y-5">
      <Hint>{t('st.agents.webHint')}</Hint>
      <NamedAgentProfilesCard />
      <SubagentGovernanceCard />
      <DesktopServerFileCard />
    </div>
  );
}

function DesktopServerFileCard() {
  const isDesktop = isDesktopRuntime();
  const { t, locale } = useI18n();
  const { client, socket } = useConnection();
  const queryClient = useQueryClient();
  const [config, setConfig] = useState(() => serverFileSettingsFromConfig({ providers: {} }));
  const [savedConfig, setSavedConfig] = useState(config);
  const restart = useRestartRequirement();
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const busySessions = useBusySessionCount();
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (configQuery.data !== undefined) {
      const next = serverFileSettingsFromConfig(configQuery.data);
      setConfig(next);
      setSavedConfig(next);
    }
  }, [configQuery.data]);

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
      const echoed = await client.patchConfig(serverFileSettingsPatch(config, savedConfig));
      queryClient.setQueryData(['config'], echoed);
      const next = serverFileSettingsFromConfig(echoed);
      setConfig(next);
      setSavedConfig(next);
      markRestartRequired(['subagent', 'agents', 'builtin_product_skills', 'model_catalog']);
      setFeedback({ tone: 'success', text: t('st.sidecar.savedEcho') });
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
    } finally {
      setRestarting(false);
    }
  };

  return (
    <SectionCard id="st-card-sidecar" title={t('st.sidecar.title')} badge={restart.required ? 'restart' : undefined}>
      <div className="space-y-4">
        <fieldset disabled={configQuery.isLoading || saving} data-testid="desktop-config-fields" className="space-y-4 disabled:opacity-60">
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
          <Toggle label={t('st.sidecar.enableCollab')} checked={config.agents.enabled} onChange={(checked) => { setConfig({ ...config, agents: { ...config.agents, enabled: checked } }); }} />
          <Toggle label={t('st.sidecar.builtinSkills')} checked={config.builtinProductSkills} onChange={(checked) => { setConfig({ ...config, builtinProductSkills: checked }); }} />
          <Toggle label={t('st.sidecar.refreshOnStart')} checked={config.modelCatalog.refreshOnStart} onChange={(checked) => { setConfig({ ...config, modelCatalog: { ...config.modelCatalog, refreshOnStart: checked } }); }} />
        </fieldset>
        <Hint>{t('st.sidecar.hint')}</Hint>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={PRIMARY_BUTTON} disabled={configQuery.isLoading || saving} onClick={() => void save()}>{saving ? t('st.sidecar.saving') : t('st.sidecar.save')}</button>
          <button type="button" className={SECONDARY_BUTTON} disabled={!isDesktop || !restart.required || restarting} onClick={() => { setConfirmRestart(true); }}>{restarting ? t('st.sidecar.restarting') : t('st.sidecar.applyRestart')}</button>
          {!isDesktop && restart.required && !isRestartRequirementAcknowledged(restart) ? (
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { acknowledgeRestartRequirement(); }}>{t('st.sidecar.acknowledge')}</button>
          ) : null}
        </div>
        {restart.required ? <Hint>{t('st.sidecar.pendingFields', { fields: restart.fields.join(', ') })}</Hint> : null}
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
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

interface McpEditorDraft {
  readonly original?: McpJsonServerEntry;
  readonly name: string;
  readonly scope: McpJsonWriteScope;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command: string;
  readonly args: string;
  readonly env: string;
  readonly url: string;
}

function mcpDraft(entry?: McpJsonServerEntry): McpEditorDraft {
  if (entry === undefined) {
    return { name: '', scope: 'project', transport: 'stdio', command: '', args: '', env: '', url: '' };
  }
  const config = entry.config;
  return {
    original: entry,
    name: entry.name,
    scope: entry.scope,
    transport: config.transport,
    command: config.transport === 'stdio' ? config.command : '',
    args: config.transport === 'stdio' ? (config.args ?? []).join('\n') : '',
    env: config.transport === 'stdio'
      ? Object.entries(config.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n')
      : '',
    url: config.transport === 'stdio' ? '' : config.url,
  };
}

function mcpCommonConfig(config: McpJsonServerConfig | undefined) {
  return {
    enabled: config?.enabled,
    startupTimeoutMs: config?.startupTimeoutMs,
    toolTimeoutMs: config?.toolTimeoutMs,
    enabledTools: config?.enabledTools,
    disabledTools: config?.disabledTools,
  };
}

function parseMcpEnv(text: string): Record<string, string> | undefined {
  const entries: Array<[string, string]> = [];
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.trim() === '') continue;
    const separator = raw.indexOf('=');
    if (separator <= 0) throw new Error('st.mcp.envInvalid');
    const key = raw.slice(0, separator).trim();
    if (key === '') throw new Error('st.mcp.envInvalid');
    entries.push([key, raw.slice(separator + 1)]);
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export function mcpConfigFromDraft(draft: McpEditorDraft): McpJsonServerConfig {
  const original = draft.original?.config;
  if (draft.transport === 'stdio') {
    const command = draft.command.trim();
    if (command === '') throw new Error('st.mcp.commandRequired');
    const sameTransport = original?.transport === 'stdio' ? original : undefined;
    const args = draft.args.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    return {
      ...mcpCommonConfig(original),
      ...sameTransport,
      transport: 'stdio',
      command,
      args: args.length === 0 ? undefined : args,
      env: parseMcpEnv(draft.env),
    };
  }
  const url = draft.url.trim();
  try {
    new URL(url);
  } catch {
    throw new Error('st.mcp.urlInvalid');
  }
  const sameTransport = original?.transport === draft.transport ? original : undefined;
  return {
    ...mcpCommonConfig(original),
    ...sameTransport,
    transport: draft.transport,
    url,
  };
}

function McpConfigManager({
  workspaceId,
  entries,
  loading,
  error,
  onEcho,
}: {
  workspaceId: string;
  entries: readonly McpJsonServerEntry[];
  loading: boolean;
  error: unknown;
  onEcho: (echo: { readonly entries: readonly McpJsonServerEntry[] }) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<McpEditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pendingDelete, setPendingDelete] = useState<McpJsonServerEntry | null>(null);

  const save = async () => {
    if (draft === null || workspaceId === '') return;
    const name = draft.name.trim();
    if (name === '') {
      setFeedback({ tone: 'error', text: t('st.mcp.nameRequired') });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      let config: McpJsonServerConfig;
      try {
        config = mcpConfigFromDraft(draft);
      } catch (error) {
        const key = error instanceof Error ? error.message as I18nKey : 'st.mcp.urlInvalid';
        setFeedback({ tone: 'error', text: t(key) });
        return;
      }
      let echoed = await client.upsertMcpJsonServer(name, {
        workspace_id: workspaceId,
        scope: draft.scope,
        config,
      });
      onEcho(echoed);
      const original = draft.original;
      if (original !== undefined && (original.name !== name || original.scope !== draft.scope)) {
        echoed = await client.removeMcpJsonServer(original.name, workspaceId, original.scope);
        onEcho(echoed);
      }
      setDraft(null);
      setFeedback({ tone: 'success', text: t('st.mcp.saved') });
      await queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const entry = pendingDelete;
    if (entry === null || workspaceId === '') return;
    setSaving(true);
    setFeedback(null);
    setPendingDelete(null);
    try {
      const echoed = await client.removeMcpJsonServer(entry.name, workspaceId, entry.scope);
      onEcho(echoed);
      if (draft?.original?.name === entry.name && draft.original.scope === entry.scope) setDraft(null);
      setFeedback({ tone: 'success', text: t('st.mcp.deleted') });
      await queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-hairline pt-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{t('st.mcp.configTitle')}</p>
          <Hint>{t('st.mcp.configHint')}</Hint>
        </div>
        <button type="button" className={SECONDARY_BUTTON} disabled={workspaceId === '' || saving} onClick={() => { setDraft(mcpDraft()); setFeedback(null); }}>{t('st.mcp.add')}</button>
      </div>
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={`${entry.scope}:${entry.name}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-paper px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-ink">{entry.name}</p>
              <p className="truncate font-mono text-[10.5px] text-ink-faint">{entry.scope} · {entry.config.transport}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={() => { setDraft(mcpDraft(entry)); setFeedback(null); }}>{t('st.mcp.edit')}</button>
              <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={() => { setPendingDelete(entry); }}>{t('st.mcp.delete')}</button>
            </div>
          </div>
        ))}
        {loading ? <Hint>{t('st.mcp.configLoading')}</Hint> : null}
        {!loading && entries.length === 0 ? <Hint>{t('st.mcp.empty')}</Hint> : null}
        {error !== null ? <InlineError error={error} /> : null}
      </div>
      {draft !== null ? (
        <fieldset className="space-y-3 rounded-xl border border-hairline bg-paper p-3" disabled={saving}>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-[11px] font-medium text-ink-soft">
              {t('st.mcp.name')}
              <input className={INPUT} value={draft.name} onChange={(event) => { setDraft({ ...draft, name: event.target.value }); }} />
            </label>
            <label className="space-y-1 text-[11px] font-medium text-ink-soft">
              {t('st.mcp.scope')}
              <select className={INPUT} value={draft.scope} onChange={(event) => { setDraft({ ...draft, scope: event.target.value as McpJsonWriteScope }); }}>
                <option value="user">{t('st.mcp.scopeUser')}</option>
                <option value="project">{t('st.mcp.scopeProject')}</option>
              </select>
            </label>
            <label className="space-y-1 text-[11px] font-medium text-ink-soft">
              {t('st.mcp.transport')}
              <select className={INPUT} value={draft.transport} onChange={(event) => { setDraft({ ...draft, transport: event.target.value as McpEditorDraft['transport'] }); }}>
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
            </label>
          </div>
          {draft.transport === 'stdio' ? (
            <div className="space-y-3">
              <label className="block space-y-1 text-[11px] font-medium text-ink-soft">
                {t('st.mcp.command')}
                <input className={`${INPUT} font-mono`} value={draft.command} onChange={(event) => { setDraft({ ...draft, command: event.target.value }); }} />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-[11px] font-medium text-ink-soft">
                  {t('st.mcp.args')}
                  <textarea className={`${INPUT} min-h-24 font-mono`} value={draft.args} onChange={(event) => { setDraft({ ...draft, args: event.target.value }); }} placeholder={t('st.mcp.argsPlaceholder')} />
                </label>
                <label className="space-y-1 text-[11px] font-medium text-ink-soft">
                  {t('st.mcp.env')}
                  <textarea className={`${INPUT} min-h-24 font-mono`} value={draft.env} onChange={(event) => { setDraft({ ...draft, env: event.target.value }); }} placeholder={t('st.mcp.envPlaceholder')} />
                </label>
              </div>
            </div>
          ) : (
            <label className="block space-y-1 text-[11px] font-medium text-ink-soft">
              {t('st.mcp.url')}
              <input className={`${INPUT} font-mono`} value={draft.url} onChange={(event) => { setDraft({ ...draft, url: event.target.value }); }} placeholder="https://mcp.example.com" />
            </label>
          )}
          <div className="flex gap-2">
            <button type="button" className={PRIMARY_BUTTON} onClick={() => void save()}>{saving ? t('common.saving') : t('common.save')}</button>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { setDraft(null); }}>{t('common.cancel')}</button>
          </div>
        </fieldset>
      ) : null}
      <FeedbackLine feedback={feedback} />
      <ConfirmDialog
        open={pendingDelete !== null}
        overlayId="confirm-mcp-delete"
        title={t('st.mcp.deleteTitle')}
        body={t('st.mcp.deleteBody', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('st.mcp.delete')}
        tone="danger"
        onConfirm={() => { void remove(); }}
        onCancel={() => { setPendingDelete(null); }}
      />
    </div>
  );
}

function SkillRow({ skill }: { skill: SkillDescriptor }) {
  return <div className="rounded-lg border border-hairline bg-paper px-3 py-2"><p className="text-[13px] font-medium text-ink">{skill.name}</p><p className="text-[11px] text-ink-soft">{skill.description}</p><p className="mt-0.5 font-mono text-[10px] text-ink-faint">{skill.path}</p></div>;
}

function WorkspacesSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [removing, setRemoving] = useState<Workspace | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const visible = useMemo(
    () => filterWorkspaces(sortWorkspacesByRecency(items), filter),
    [items, filter],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  };

  return (
    <SectionCard id="st-card-workspaces" title={t('st.workspaces.title')}>
      <div className="space-y-2">
        {items.length > 0 ? (
          <input
            type="text"
            value={filter}
            onChange={(event) => { setFilter(event.target.value); }}
            placeholder={t('st.workspaces.search')}
            aria-label={t('st.workspaces.search')}
            className={SMALL_INPUT}
          />
        ) : null}
        {visible.map((workspace) => (
          <div key={workspace.id} className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-paper px-3 py-2">
            <div className="min-w-0"><p className="truncate text-[13px] font-medium text-ink" title={workspace.name}>{workspace.name}</p><p className="truncate font-mono text-[10.5px] text-ink-faint" title={workspace.root}>{workspace.root}</p></div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="button" onClick={() => void navigate(`/new?workspace=${encodeURIComponent(workspace.id)}`)} className={SECONDARY_BUTTON}>{t('st.workspaces.newSession')}</button>
              <button
                type="button"
                onClick={() => setRenaming(workspace)}
                aria-label={t('st.workspaces.renameAria', { name: workspace.name })}
                title={t('st.workspaces.rename')}
                className="rounded-md border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
              >
                ✎
              </button>
              <button
                type="button"
                onClick={() => setRemoving(workspace)}
                aria-label={t('st.workspaces.removeAria', { name: workspace.name })}
                title={t('st.workspaces.remove')}
                className="rounded-md border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-danger hover:text-danger"
              >
                ×
              </button>
            </div>
          </div>
        ))}
        {visible.length === 0 && filter.trim() !== '' ? <Hint>{t('st.workspaces.noMatches', { query: filter.trim() })}</Hint> : null}
        {query.isLoading ? <Hint>{t('st.workspaces.loading')}</Hint> : null}
        {query.isError ? <InlineError error={query.error} /> : null}
        {feedback !== null ? <FeedbackLine feedback={feedback} /> : null}
        <Hint>{t('st.workspaces.hint')}</Hint>
      </div>

      {renaming !== null ? (
        <WorkspaceRenameDialog
          workspace={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={(echoed) => {
            queryClient.setQueryData(['workspaces'], (current: ListWorkspacesResponse | undefined) =>
              current === undefined ? current : { items: current.items.map((ws) => ws.id === echoed.id ? echoed : ws) },
            );
            setRenaming(null);
            invalidate();
          }}
        />
      ) : null}
      {removing !== null ? (
        <ConfirmDialog
          open
          overlayId="confirm-workspace-remove"
          title={t('st.workspaces.removeTitle', { name: removing.name })}
          body={t('st.workspaces.removeBody')}
          confirmLabel={t('st.workspaces.remove')}
          tone="danger"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            setFeedback(null);
            void client
              .removeWorkspace(target.id)
              .then(invalidate)
              .catch((error: unknown) => {
                setFeedback({ tone: 'error', text: errorText(locale, error) });
              });
          }}
        />
      ) : null}
    </SectionCard>
  );
}

function WorkspaceRenameDialog({
  workspace,
  onClose,
  onRenamed,
}: {
  workspace: Workspace;
  onClose: () => void;
  onRenamed: (workspace: Workspace) => void;
}) {
  const { client } = useConnection();
  const { t } = useI18n();
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > 100 || busy) return;
    setBusy(true);
    setError(null);
    void client
      .renameWorkspace(workspace.id, trimmed)
      .then(onRenamed)
      .catch((cause: unknown) => {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <Dialog onClose={onClose} ariaLabel={t('st.workspaces.renameTitle')} overlayId="workspace-rename-dialog">
      <h2 className="font-display text-[16px] font-semibold text-ink">{t('st.workspaces.renameTitle')}</h2>
      <input
        data-autofocus
        className="mt-3 w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
        value={name}
        maxLength={100}
        onChange={(event) => { setName(event.target.value); }}
        onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
      />
      {error !== null ? <p className="mt-2 font-mono text-[11px] text-danger">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>{t('common.cancel')}</button>
        <button
          type="button"
          disabled={busy || name.trim() === '' || name.trim() === workspace.name}
          onClick={submit}
          className={PRIMARY_BUTTON}
        >
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </Dialog>
  );
}

function AboutSection() {
  const { meta } = useConnection();
  const { t } = useI18n();
  const guiVersion = import.meta.env['VITE_APP_VERSION'] ?? '0.0.0-dev';
  const buildSha = import.meta.env['VITE_BUILD_SHA'] as string | undefined;
  const isDesktop = isDesktopRuntime();
  const [channel, setChannel] = useState<'stable' | 'beta'>(() => readDesktopPrefs().updateChannel);
  const [update, setUpdate] = useState<Awaited<ReturnType<typeof checkNativeDesktopUpdate>>>(null);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'installing'>('idle');
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);

  const checkForUpdate = () => {
    setUpdateStatus('checking');
    setUpdateMessage(null);
    void checkNativeDesktopUpdate()
      .then((next) => {
        setUpdate(next);
        setUpdateMessage(next === null ? t('st.about.upToDate') : null);
      })
      .catch((error: unknown) => {
        setUpdate(null);
        setUpdateMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { setUpdateStatus('idle'); });
  };

  const installUpdate = () => {
    if (update === null || !window.confirm(t('st.about.installConfirm', { version: update.version }))) return;
    setUpdateStatus('installing');
    setUpdateMessage(null);
    void update.install().catch((error: unknown) => {
      setUpdateStatus('idle');
      setUpdateMessage(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <SectionCard id="st-card-about" title={t('st.about.title')}>
      <div className="space-y-2 text-[12.5px] text-ink-soft">
        <p>{t('st.about.desktopVersion')}: <span className="font-mono text-ink">{guiVersion}</span></p>
        <p>{t('st.about.serverVersion')}: <span className="font-mono text-ink">{meta.server_version}</span></p>
        {buildSha !== undefined && buildSha !== '' ? <p>{t('st.about.build')}: <span className="font-mono text-ink">{buildSha.slice(0, 12)}</span></p> : null}
        <p>{t('st.about.serverId')}: <span className="font-mono text-ink">{meta.server_id}</span></p>
        <p>{t('st.about.backend')}: <span className="font-mono text-ink">{meta.backend ?? 'v1'}</span></p>
      </div>

      {isDesktop ? (
        <div className="mt-4 space-y-3 border-t border-hairline pt-4">
          <label className="flex items-center justify-between gap-4 text-[12.5px] text-ink-soft">
            <span>{t('st.about.channel')}</span>
            <select
              value={channel}
              onChange={(event) => {
                const next = event.target.value === 'beta' ? 'beta' : 'stable';
                setChannel(next);
                setUpdate(null);
                setUpdateMessage(null);
                writeDesktopPrefs({ updateChannel: next });
                void writeNativeDesktopPrefs({ updateChannel: next });
              }}
              className="rounded-lg border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
            >
              <option value="stable">{t('st.about.stable')}</option>
              <option value="beta">{t('st.about.beta')}</option>
            </select>
          </label>
          {channel === 'beta' ? <p className="text-[11.5px] text-amber-ink">{t('st.about.betaHint')}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={checkForUpdate} disabled={updateStatus !== 'idle'} className={SECONDARY_BUTTON}>
              {updateStatus === 'checking' ? t('st.about.checking') : t('st.about.checkUpdate')}
            </button>
            {update !== null ? (
              <button type="button" onClick={installUpdate} disabled={updateStatus !== 'idle'} className={PRIMARY_BUTTON}>
                {updateStatus === 'installing' ? t('st.about.installing') : t('st.about.install', { version: update.version })}
              </button>
            ) : null}
          </div>
          {update?.notes !== undefined && update.notes !== '' ? <p className="whitespace-pre-wrap text-[11.5px] text-ink-soft">{update.notes}</p> : null}
          {updateMessage !== null ? <p className="font-mono text-[11px] text-ink-soft">{updateMessage}</p> : null}
        </div>
      ) : null}
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
  const navigate = useGuardedNavigate();
  const dirty = useDirtyGuard()?.dirty === true;
  const [focusCard, setFocusCard] = useState<{ cardId: string; nonce: number } | null>(null);

  const guardedNavigate = useCallback((target: string) => {
    navigate(`/settings/${target}`);
  }, [navigate]);

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
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => { window.removeEventListener('beforeunload', handler); };
  }, [dirty]);

  const onSearchHit = (entry: SettingsSearchEntry) => {
    setFocusCard({ cardId: entry.cardId, nonce: Date.now() });
    if (entry.section !== active) guardedNavigate(entry.section);
  };

  const pane = active === 'general' ? <GeneralSection /> : active === 'models' ? <ModelsSection /> : active === 'connection' ? <ConnectionSection /> : active === 'providers' ? <ProvidersSection /> : active === 'agents' ? <AgentsSection /> : active === 'capabilities' ? <CapabilitiesSection /> : active === 'workspaces' ? <WorkspacesSection /> : <AboutSection />;

  return (
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
    </SettingsFlashContext.Provider>
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
