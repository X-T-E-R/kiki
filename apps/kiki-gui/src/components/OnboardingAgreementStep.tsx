/**
 * The agreement page of the first run — "how should Kiki work with you" —
 * three short rows, each backed by a real setting.
 *
 * 1. How much it may do on its own: the default permission mode. First-run
 *    offers manual / auto / yolo with auto recommended; `review` is only worth
 *    choosing once a reviewer is configured, so it waits behind a small "more"
 *    disclosure. Both lists come from PERMISSION_MODES, which is already
 *    filtered against the wire enum — a mode the connected server does not
 *    know is never offered, and the three ids are never hard-coded as the
 *    whole catalog. The wizard owns the chosen value and saves it on Next
 *    through the existing config-patch path, so the save semantics (a fresh
 *    run upgrades manual to auto, a replay shows the server's explicit value,
 *    a failed save keeps the step) live there.
 * 2. When it should reach you: one real switch, the `completed` kind of the
 *    away notifications, written the moment it flips. Failures, questions and
 *    approval requests always notify; the copy says so instead of offering a
 *    switch that does not exist.
 * 3. How it should talk to you: there is no setting for this, so the choice is
 *    kept as a `user` memory in the global scope — the honest mechanism,
 *    visible and editable later under Settings › Memory, and the copy says so
 *    in one line. A second choice updates the same entry rather than adding
 *    another. A failed write shows a line and never blocks the step.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import type { PermissionMode } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import {
  readSettings,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  writeSettings,
} from '@kiki/session-core/settings';

import { useI18n } from '../i18n';
import { PERMISSION_MODES, RECOMMENDED_PERMISSION_MODE } from '../lib/permissionModes';
import { onboardingVoiceFromMemory, readOnboardingVoiceMemory, saveOnboardingVoiceMemory, type OnboardingVoice } from '../lib/onboardingVoiceMemory';
import { useConnection } from '../state/connection';
import { FeedbackLine, Toggle, type Feedback } from './controls';
import { DisclosureChevron, Icon } from './icons';
import { OnboardingRow } from './OnboardingAppearanceStep';

/** The modes offered on the first screen; anything else PERMISSION_MODES carries waits behind "more". */
const FIRST_RUN_MODES: readonly PermissionMode[] = ['manual', 'auto', 'yolo'];

/**
 * Selection mark shared by the radio cards: an empty ring at rest, an
 * ink-blue check once chosen — "this is the current choice", never the accent.
 */
export function ChoiceMark({ selected }: { readonly selected: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors ${
        selected ? 'bg-selected-ink text-paper' : 'ring-1 ring-inset ring-hairline-strong'
      }`}
    >
      {selected ? <Icon name="check" size={12} /> : null}
    </span>
  );
}

export const CHOICE_CARD =
  'flex w-full items-start gap-2 rounded-[10px] px-3 py-2 text-left transition-[background-color,box-shadow] duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';
export const CHOICE_CARD_SELECTED = 'bg-paper shadow-[var(--kiki-sheet-shadow)]';
export const CHOICE_CARD_IDLE = 'hover:bg-ink/[0.04]';

/** One permission-mode radio row: the mode label plus its one-line meaning. */
function PermissionOption({
  mode,
  selected,
  recommended,
  disabled,
  onSelect,
}: {
  readonly mode: PermissionMode;
  readonly selected: boolean;
  readonly recommended: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      data-permission-choice={mode}
      className={`${CHOICE_CARD} ${selected ? CHOICE_CARD_SELECTED : CHOICE_CARD_IDLE}`}
    >
      <ChoiceMark selected={selected} />
      <span className="min-w-0">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className={`text-[13px] text-ink ${selected ? 'font-medium' : ''}`}>
            {t(`composer.perm.${mode}`)}
          </span>
          {recommended ? (
            <span className="rounded-[4px] bg-ink/[0.06] px-1.5 py-px text-[11px] font-medium text-ink-soft">
              {t('onboarding.permissions.recommended')}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-soft">
          {t(`onboarding.permissions.${mode}.line`)}
        </span>
      </span>
    </button>
  );
}

export type { OnboardingVoice } from '../lib/onboardingVoiceMemory';
const VOICES: readonly OnboardingVoice[] = ['concise', 'detailed'];

export function OnboardingAgreementStep({
  permissionMode,
  onPermissionModeChange,
  permissionBusy,
  permissionFeedback,
}: {
  readonly permissionMode: PermissionMode;
  readonly onPermissionModeChange: (mode: PermissionMode) => void;
  readonly permissionBusy: boolean;
  readonly permissionFeedback: Feedback;
}) {
  const { t, locale } = useI18n();
  const { client, config } = useConnection();
  const connectionUrl = config.url || window.location.origin;
  const settings = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsServerSnapshot);

  const firstRunModes = PERMISSION_MODES.filter((mode) => FIRST_RUN_MODES.includes(mode.id));
  const moreModes = PERMISSION_MODES.filter((mode) => !FIRST_RUN_MODES.includes(mode.id));
  const [moreOpen, setMoreOpen] = useState(() => moreModes.some((mode) => mode.id === permissionMode));
  const [voice, setVoice] = useState<OnboardingVoice | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceFeedback, setVoiceFeedback] = useState<Feedback>(null);

  useEffect(() => {
    let cancelled = false;
    void readOnboardingVoiceMemory(client, connectionUrl).then((entry) => {
      if (!cancelled) setVoice((chosen) => chosen ?? onboardingVoiceFromMemory(entry));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [client, connectionUrl]);

  const chooseVoice = async (choice: OnboardingVoice) => {
    setVoice(choice);
    setVoiceBusy(true);
    setVoiceFeedback(null);
    try {
      await saveOnboardingVoiceMemory(client, connectionUrl, locale, choice);
      setVoiceFeedback({ tone: 'success', text: t('onboarding.agreement.voice.saved') });
    } catch (error) {
      setVoiceFeedback({ tone: 'error', text: t('onboarding.agreement.voice.failed', { detail: errorText(locale, error) }) });
    } finally {
      setVoiceBusy(false);
    }
  };

  return (
    <div className="mt-3" data-onboarding-agreement>
      <OnboardingRow label={t('onboarding.agreement.autonomy')} labelId="onboarding-autonomy-label">
        <div role="radiogroup" aria-labelledby="onboarding-autonomy-label" className="space-y-1">
          {firstRunModes.map(({ id: mode }) => (
            <PermissionOption
              key={mode}
              mode={mode}
              selected={permissionMode === mode}
              recommended={mode === RECOMMENDED_PERMISSION_MODE}
              disabled={permissionBusy}
              onSelect={() => { onPermissionModeChange(mode); }}
            />
          ))}
          {moreOpen ? moreModes.map(({ id: mode }) => (
            <PermissionOption
              key={mode}
              mode={mode}
              selected={permissionMode === mode}
              recommended={mode === RECOMMENDED_PERMISSION_MODE}
              disabled={permissionBusy}
              onSelect={() => { onPermissionModeChange(mode); }}
            />
          )) : null}
        </div>
        {moreModes.length > 0 ? (
          <button
            type="button"
            data-onboarding-permission-more
            aria-expanded={moreOpen}
            onClick={() => { setMoreOpen((open) => !open); }}
            className="mt-1 inline-flex min-h-7 items-center gap-1 rounded-md px-1 text-[12px] text-ink-faint transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
          >
            <DisclosureChevron open={moreOpen} />
            {moreOpen ? t('onboarding.agreement.less') : t('onboarding.agreement.more')}
          </button>
        ) : null}
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-faint">{t('onboarding.permissions.body')}</p>
        <FeedbackLine feedback={permissionFeedback} />
      </OnboardingRow>

      <OnboardingRow label={t('onboarding.agreement.reach')} labelId="onboarding-reach-label">
        <div data-onboarding-notify>
          <Toggle
            id="onboarding-notify-completed"
            layout="row"
            label={t('onboarding.agreement.reach.completed')}
            checked={settings.awayNotifications.completed}
            onChange={(completed) => {
              writeSettings({ awayNotifications: { ...readSettings().awayNotifications, completed } });
            }}
          />
          <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">{t('onboarding.agreement.reach.always')}</p>
        </div>
      </OnboardingRow>

      <OnboardingRow label={t('onboarding.agreement.voice')} labelId="onboarding-voice-label">
        <div role="radiogroup" aria-labelledby="onboarding-voice-label" className="space-y-1">
          {VOICES.map((choice) => {
            const selected = voice === choice;
            return (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={voiceBusy}
                data-onboarding-voice={choice}
                onClick={() => { void chooseVoice(choice); }}
                className={`${CHOICE_CARD} ${selected ? CHOICE_CARD_SELECTED : CHOICE_CARD_IDLE}`}
              >
                <ChoiceMark selected={selected} />
                <span className="min-w-0">
                  <span className={`block text-[13px] text-ink ${selected ? 'font-medium' : ''}`}>
                    {t(`onboarding.agreement.voice.${choice}`)}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-soft">
                    {t(`onboarding.agreement.voice.${choice}.line`)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-faint">{t('onboarding.agreement.voice.note')}</p>
        <FeedbackLine feedback={voiceFeedback} />
      </OnboardingRow>
    </div>
  );
}
