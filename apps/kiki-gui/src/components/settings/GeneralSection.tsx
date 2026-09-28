import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PermissionMode } from '@kiki/protocol';

import { clearStoredDrafts } from '@kiki/session-core/composer';
import { errorText, type Locale } from '@kiki/session-core/i18n';
import {
  readDesktopPrefs,
  readSettings,
  writeDesktopPrefs,
  writeSettings,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  type SendShortcut,
} from '@kiki/session-core/settings';
import type { KikiConfigPatch, KikiConfigResponse } from '@kiki/session-core/transport';
import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from '../controls';
import { ScopeTag, SectionCard } from './SectionCard';
import { SettingField } from './fields';
import { SettingsSegmented, SettingsSelect } from './SettingsPrimitives';
import { DefaultAppendTimingCard } from './CommunicationSection';
import { ExperimentalSection } from './ExperimentalSection';
import { SessionTitleModelFields } from './SessionTitleModelSettings';
import { mergeConfigEcho } from './configEcho';
import { useSavedTick } from './useSavedTick';

export function GeneralSection({ area = 'app' }: { area?: 'app' | 'models' }) {
  const host = useHost();
  const { client } = useConnection();
  const { t, locale, setLocale } = useI18n();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState(readSettings);
  const [desktopPrefs, setDesktopPrefs] = useState(readDesktopPrefs);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('auto');
  const [questionBehavior, setQuestionBehavior] = useState<'background' | 'blocking'>('background');
  const [questionSaving, setQuestionSaving] = useState(false);
  const [questionFeedback, setQuestionFeedback] = useState<Feedback>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [tick, ping] = useSavedTick();
  const isDesktop = host.kind === 'tauri';
  // The fold-steps toggle instant-applies (the transcript reads the pub/sub
  // snapshot), so it follows the live store instead of the local settings
  // state the save-on-change cards use.
  const foldSteps = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  ).foldSteps;

  const [titleModelDirty, setTitleModelDirty] = useState(false);
  const [titleModelSaver, setTitleModelSaver] = useState<{
    getPatch: () => KikiConfigPatch | null;
    onSaved: (echoed: KikiConfigResponse) => void;
    onDiscard: () => void;
  } | null>(null);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  const syncFromConfig = useCallback((config: KikiConfigResponse | undefined) => {
    if (config === undefined) return;
    const mode = config.default_permission_mode;
    if (mode === 'manual' || mode === 'auto' || mode === 'review' || mode === 'yolo') setPermissionMode(mode);
  }, []);

  useEffect(() => {
    syncFromConfig(configQuery.data);
    if (configQuery.data !== undefined && !questionSaving) {
      setQuestionBehavior(configQuery.data.interaction?.askUserQuestion ?? 'background');
    }
  }, [configQuery.data, syncFromConfig, questionSaving]);

  useEffect(() => {
    if (host.kind !== 'tauri') return;
    void host.readDesktopPrefs().then((prefs) => {
      if (prefs !== null) {
        setDesktopPrefs(prefs);
        writeDesktopPrefs(prefs);
      }
    });
  }, [host]);

  // The permission default saves independently from planning defaults. The
  // narrow patch keeps the plan configuration untouched on this page.
  const applyPermissionMode = async (mode: PermissionMode) => {
    setPermissionMode(mode);
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ default_permission_mode: mode });
      const merged = mergeConfigEcho(
        queryClient.getQueryData<KikiConfigResponse>(['config']) ?? configQuery.data,
        echoed,
      );
      queryClient.setQueryData(['config'], merged);
      syncFromConfig(merged);
      const echoedMode = merged.default_permission_mode;
      if (echoedMode === 'manual' || echoedMode === 'auto' || echoedMode === 'review' || echoedMode === 'yolo') {
        writeSettings({ defaultPermissionMode: echoedMode });
      }
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      syncFromConfig(configQuery.data);
    } finally {
      setSaving(false);
    }
  };

  const applyQuestionBehavior = async (choice: 'background' | 'blocking') => {
    const previous = questionBehavior;
    setQuestionBehavior(choice);
    setQuestionSaving(true);
    setQuestionFeedback(null);
    try {
      const echoed = await client.patchConfig({ interaction: { ask_user_question: choice } });
      const merged = mergeConfigEcho(queryClient.getQueryData<KikiConfigResponse>(['config']) ?? configQuery.data, echoed);
      queryClient.setQueryData(['config'], merged);
      setQuestionBehavior(merged.interaction?.askUserQuestion ?? choice);
    } catch (error) {
      setQuestionBehavior(previous);
      setQuestionFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setQuestionSaving(false); }
  };

  const updateLocal = (patch: Partial<typeof settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    writeSettings(patch);
  };

  return (
    <div className="space-y-3">
      {area === 'app' ? <>
      <SectionCard id="st-card-language" title={t('st.language.title')}>
        <SettingField label={t('st.language.title')} labelId="language-label" help={t('st.language.hint')}>
          <SettingsSegmented<Locale>
            ariaLabelledBy="language-label"
            dataAttr="data-locale-choice"
            value={locale}
            onChange={setLocale}
            choices={[{ value: 'en', label: 'English' }, { value: 'zh', label: '中文' }]}
          />
        </SettingField>
      </SectionCard>

      </> : null}

      {area === 'models' ? <SectionCard id="st-card-permission-defaults" title={t('st.defaults.title')}>
        <div className="space-y-2">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span id="default-permission-mode-label" className="text-[13px] font-medium text-ink">{t('st.defaults.permissionMode')}</span>
              <SavedTick show={tick} />
            </div>
            <SettingsSegmented<PermissionMode>
              ariaLabelledBy="default-permission-mode-label"
              value={permissionMode}
              disabled={saving}
              onChange={(mode) => void applyPermissionMode(mode)}
              choices={(['manual', 'auto', 'review', 'yolo'] as PermissionMode[]).map((mode) => ({
                value: mode, label: t(`st.defaults.permission.${mode}`), caution: mode === 'yolo',
              }))}
            />
          </div>
          <p className={`max-w-[62ch] text-[12px] leading-snug ${permissionMode === 'yolo' ? 'text-amber-ink' : 'text-ink-soft'}`}>
            {t(`st.defaults.permission.${permissionMode}Hint`)}
          </p>
          <Hint>{t('st.defaults.hint')}</Hint>
          <FeedbackLine feedback={feedback} />
          {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        </div>
      </SectionCard> : null}

      {area === 'app' ? <>
      <SectionCard id="st-card-composer" title={t('st.composer.title')}>
        <div className="space-y-1.5">
          <SettingField label={t('st.composer.sendShortcut')} labelId="send-shortcut-label">
            <SettingsSelect<SendShortcut>
              id="send-shortcut-select"
              ariaLabel={t('st.composer.sendShortcut')}
              value={settings.sendShortcut}
              onChange={(value) => { updateLocal({ sendShortcut: value }); }}
              choices={[
                { value: 'enter', label: t('st.composer.shortcutEnter') },
                { value: 'cmd-enter', label: t('st.composer.shortcutCmdEnter') },
              ]}
            />
          </SettingField>
          {/* Each switch keeps its own help line directly under its label. */}
          <div data-settings-field className="space-y-0.5 py-1">
            <Toggle
              layout="row"
              label={t('st.composer.persistDrafts')}
              checked={settings.draftPersistence}
              onChange={(checked) => {
                updateLocal({ draftPersistence: checked });
                if (!checked) clearStoredDrafts();
              }}
            />
            <Hint>{t('st.composer.persistDraftsHint')}</Hint>
          </div>
          <div data-settings-field className="py-1">
            <Toggle
              layout="row"
              label={t('st.transcript.foldSteps')}
              checked={foldSteps}
              onChange={(checked) => { writeSettings({ foldSteps: checked }); }}
            />
          </div>
          <div data-question-behavior>
            <SettingField
              label={t('st.composer.questions')}
              labelId="question-behavior-label"
              help={<ScopeTag scope="server" />}
            >
              <SettingsSegmented<'background' | 'blocking'>
                ariaLabel={t('st.composer.questions')}
                value={questionBehavior}
                disabled={questionSaving}
                onChange={(choice) => void applyQuestionBehavior(choice)}
                choices={[
                  { value: 'background', label: t('st.composer.questionsDontBlock') },
                  { value: 'blocking', label: t('st.composer.questionsBlock') },
                ]}
              />
            </SettingField>
            <FeedbackLine feedback={questionFeedback} />
          </div>
        </div>
      </SectionCard>

      <DefaultAppendTimingCard />

      <ExperimentalSection
        featureIds={['auto_session_title']}
        cardId="st-card-session-title"
        titleKey="st.experimental.sessionTitle"
        extraDirty={titleModelDirty}
        onSaveExtra={titleModelSaver?.getPatch}
        onSavedExtra={titleModelSaver?.onSaved}
        onDiscardExtra={titleModelSaver?.onDiscard}
      >
        {({ saving: sectionSaving }) => (
          <SessionTitleModelFields
            disabled={sectionSaving}
            onDirtyChange={setTitleModelDirty}
            registerExtraSaver={setTitleModelSaver}
          />
        )}
      </ExperimentalSection>

      <SectionCard id="st-card-desktop" title={t('st.desktop.title')} badge="desktop" aside={isDesktop ? undefined : t('st.desktop.browserHint')}>
        {isDesktop ? (
        <fieldset className="space-y-4">
          <Toggle
            layout="row"
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
                className={`cursor-pointer rounded-[10px] border p-3 transition-colors ${
                  desktopPrefs.closeToTray === option.closeToTray ? 'border-hairline-strong bg-panel' : 'border-hairline hover:border-hairline-strong'
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
      </> : null}
    </div>
  );
}
