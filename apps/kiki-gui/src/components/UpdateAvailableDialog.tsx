/**
 * The one dialog an update ever gets.
 *
 * This is a reminder, not a changelog to read. The version and the three
 * decisions are the content; the release notes are reference material kept
 * deliberately small, in its own scroll area, so a long changelog never decides
 * how tall the panel is. The primary action is the update; "remind me tomorrow"
 * and "skip this version" are the two ways of not taking it right now, and the
 * close button is the third: not now, and this run says nothing more about this
 * version.
 *
 * Installing runs the host's own install, which asks the desktop side to
 * confirm closing the running sessions. That is the confirmation; a second one
 * stacked on top of it would be the same question asked twice.
 */

import { useEffect, useRef, useState } from 'react';

import { useI18n } from '../i18n';
import { FeedbackLine } from './controls';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from './Dialog';
import { Icon } from './icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';
import type { UpdateOffer } from '../lib/desktopUpdates';
import { UPDATE_DIALOG_OVERLAY } from '../lib/useDesktopUpdateScheduler';

export interface UpdateAvailableDialogProps {
  readonly offer: UpdateOffer | null;
  readonly onUpdate: (offer: UpdateOffer) => void;
  readonly onRemindLater: (offer: UpdateOffer) => void | Promise<void>;
  readonly onSkip: (offer: UpdateOffer) => void | Promise<void>;
  readonly onDismiss: () => void;
  /**
   * The owner's install state. A manual check that is already installing keeps
   * the same message here instead of starting a second one, and a failure comes
   * back as a sentence in the dialog's own language.
   */
  readonly installing?: boolean;
  readonly installError?: string | null;
  /**
   * The update record could not be stored natively, so the choice the user just
   * made is not recorded. Shown in the dialog, and dismissed with it.
   */
  readonly persistError?: string | null;
}

export function UpdateAvailableDialog({
  offer,
  onUpdate,
  onRemindLater,
  onSkip,
  onDismiss,
  installing = false,
  installError = null,
  persistError = null,
}: UpdateAvailableDialogProps) {
  const { t } = useI18n();
  // The dialog's own guard against a double install, and what the buttons
  // disable on. It clears as soon as the owner's install state settles, so a
  // failed attempt leaves the same button ready to try again instead of
  // stranding the dialog with everything disabled.
  const [attempted, setAttempted] = useState(false);
  const version = offer?.update.version;

  const actionRunning = useRef(false);
  const channel = offer?.channel;
  useEffect(() => { actionRunning.current = false; setAttempted(false); }, [version, channel]);
  useEffect(() => {
    if (!installing && installError !== null) actionRunning.current = false;
  }, [installing, installError]);

  // Saving a skip or a snooze is a write the owner has not finished yet; the
  // two are not the same wait, and the buttons read as busy for the one that
  // is actually in flight.
  const [saving, setSaving] = useState(false);

  if (offer === null) return null;
  const { update } = offer;
  const notes = update.notes?.trim() ?? '';
  const working = installing || saving || (attempted && installError === null);
  const title = t('st.about.updateDialog.title', { version: update.version });

  const startInstall = () => {
    if (working || actionRunning.current) return;
    actionRunning.current = true;
    setAttempted(true);
    onUpdate(offer);
  };

  /**
   * A choice that has to be stored before the dialog may close. The owner
   * resolves with the outcome, so a refused write leaves the dialog on screen
   * with the reason and the same button ready to press again.
   */
  const leave = (act: (offer: UpdateOffer) => void | Promise<void>) => {
    if (working || actionRunning.current) return;
    actionRunning.current = true;
    setSaving(true);
    const finished = () => { actionRunning.current = false; setSaving(false); };
    void Promise.resolve().then(() => act(offer)).then(finished, finished);
  };

  return (
    <Dialog
      onClose={() => { if (!working) onDismiss(); }}
      ariaLabel={title}
      overlayId={UPDATE_DIALOG_OVERLAY}
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.sm} flex max-h-[calc(100dvh-2rem)] flex-col`}
    >
      <header className="flex shrink-0 items-start gap-3">
        <span
          aria-hidden
          className="mt-[3px] flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-selected/15 text-selected-ink"
        >
          <Icon name="arrowUp" size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[18px] font-semibold tracking-tight text-ink">{title}</h2>
          {update.currentVersion !== '' ? (
            <p className="mt-0.5 font-mono text-[12px] text-ink-faint">
              {t('st.about.updateDialog.fromTo', { from: update.currentVersion, to: update.version })}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => { if (!working) onDismiss(); }}
          disabled={working}
          aria-label={t('common.close')}
          className="-mr-2 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:w-11"
        >
          <Icon name="close" size={16} />
        </button>
      </header>

      {/*
        The notes are the one part of this dialog that a person may or may not
        read, so they get their own small, bounded scroller rather than the
        panel's leftover height. Four lines is what a glance absorbs; anything
        past that is a decision to scroll, and the choice below stays a choice
        rather than a page turn. A short changelog simply leaves the box short
        instead of padding it out.
      */}
      <div
        data-update-notes
        className="mt-3 max-h-[104px] min-h-0 shrink overflow-y-auto overscroll-contain rounded-lg bg-ink/[0.03] px-3 py-2"
      >
        <p className="text-[11px] font-medium text-ink-faint">{t('st.about.updateDialog.notes')}</p>
        {notes === '' ? (
          <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
            {t('st.about.updateDialog.noNotes')}
          </p>
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-[12px] leading-[18px] text-ink-soft">{notes}</p>
        )}
      </div>

      <p className="mt-3 shrink-0 text-[12px] leading-relaxed text-ink-faint">
        {t('st.about.updateDialog.restart')}
      </p>
      {/* Both failures go through the same line: each is the outcome of the
          button just pressed, not standing boilerplate, and a reader who cannot
          see the colour still gets the announcement. */}
      <FeedbackLine feedback={installError === null ? null : { tone: 'error', text: installError }} />
      <FeedbackLine feedback={persistError === null ? null : { tone: 'error', text: persistError }} />

      {/* Skip is the smallest decision and sits apart on the left; the two
          buttons that answer "now" keep their order at every width, so the
          primary never ends up above the choice it outranks. */}
      <div className="mt-4 flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
        <button
          type="button"
          onClick={() => { leave(onSkip); }}
          disabled={working}
          className={`${SECONDARY_BUTTON} self-start px-0 text-ink-faint hover:bg-transparent hover:text-ink-soft`}
        >
          {t('st.about.updateDialog.skip')}
        </button>
        {/* Secondary first, primary last, in the DOM and in both layouts, so
            the highlighted action is the one nearest the thumb and the one the
            eye lands on last. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            data-autofocus
            onClick={() => { leave(onRemindLater); }}
            disabled={working}
            className={SECONDARY_BUTTON}
          >
            {t('st.about.updateDialog.remindLater')}
          </button>
          <button
            type="button"
            data-confirm-action="confirm"
            onClick={startInstall}
            disabled={working}
            // The button stays disabled, but it does not drain: while the
            // install is in flight it keeps the accent and breathes on the
            // codebase's own `working` rhythm, so the one thing the user is
            // waiting for is the thing still on screen. The shared button class
            // greys a disabled button out, so the busy state re-asserts the
            // accent after it. Reduced-motion users get the steady accent and
            // the label change instead.
            className={`${PRIMARY_BUTTON} data-[busy=true]:animate-[kiki-breath_var(--kiki-motion-loop-breath)_var(--kiki-ease-loop)_infinite] data-[busy=true]:disabled:bg-accent data-[busy=true]:disabled:text-on-accent motion-reduce:data-[busy=true]:animate-none`}
            data-busy={installing ? 'true' : undefined}
          >
            {installing
              ? t('st.about.installing')
              : attempted && installError !== null
                // The first attempt failed, so the same button says what
                // pressing it does now rather than pretending this is a first
                // time offer.
                ? t('st.about.updateDialog.installRetry')
                : t('st.about.updateDialog.install')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
