/**
 * The desktop update scheduler — mounted once, at the app shell.
 *
 * Everything the updater needs a rhythm for lives here: a first check that does
 * not stand in front of the first screen, a daily cadence for a window left
 * open for days, and a catch-up only when the window comes back after the day
 * has actually run out. One hook, one timer, one in-flight check, so no two
 * components can each decide it is time to look.
 *
 * Three things it deliberately does not do. It never installs without asking,
 * except for the one preference that says to. It never steals the stage: an
 * offer waits while a dialog, a menu, or a pending approval owns the screen.
 * And it never acts on a stale answer: a check that comes back after the user
 * turned checking off, or moved to the other channel, is dropped rather than
 * shown or installed under preferences that no longer hold.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useI18n } from '../i18n';
import { isDesktopUpdateSelectionChanged } from '../host/host';
import {
  checkDesktopUpdateOnce,
  hydrateUpdatePrefs,
  lastUpdateCheckAt,
  markUpdateChecked,
  mayOfferUpdate,
  readUpdatePrefs,
  resetUpdateCheckCache,
  skipUpdateVersion,
  snoozeUpdateUntil,
  updateCheckDue,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STARTUP_DELAY_MS,
  type DesktopUpdateHost,
  type UpdateOffer,
  type UpdatePrefsHost,
} from './desktopUpdates';
import { pushToast } from './toasts';
import { anyOverlayOpen } from './uiBusy';

/** How often the offer waits to see whether the app has gone quiet. */
const OVERLAY_RETRY_MS = 400;

/** The overlay id the update dialog registers; it never blocks itself. */
export const UPDATE_DIALOG_OVERLAY = 'update-available';

export interface DesktopUpdateScheduler {
  /** The update waiting to be shown, or `null` when there is nothing to say. */
  readonly offer: UpdateOffer | null;
  readonly onUpdate: (offer: UpdateOffer) => void;
  /**
   * Both of these resolve once the choice has been stored, or left the dialog
   * alone with the reason when it could not be. The dialog awaits them, so the
   * closing animation never starts on a promise the next launch will break.
   */
  readonly onRemindLater: (offer: UpdateOffer) => void | Promise<void>;
  readonly onSkip: (offer: UpdateOffer) => void | Promise<void>;
  readonly onDismiss: () => void;
  /** The scheduler's own install, so the dialog can show its progress. */
  readonly installing: boolean;
  readonly installError: string | null;
  /**
   * The update record could not be stored on the native side, so this answer
   * will not survive a restart. A reason the user can act on, or `null`.
   */
  readonly persistError: string | null;
}

export interface DesktopUpdateSchedulerOptions {
  readonly host: DesktopUpdateHost & UpdatePrefsHost;
  readonly isDesktop: boolean;
  /**
   * A session is blocked on the user right now. An approval is a modal moment
   * in its own right, and an update dialog on top of it is how an approval gets
   * answered by accident.
   */
  readonly hasPendingApproval?: boolean;
  readonly now?: () => number;
}

export function useDesktopUpdateScheduler({
  host,
  isDesktop,
  hasPendingApproval = false,
  now = Date.now,
}: DesktopUpdateSchedulerOptions): DesktopUpdateScheduler {
  const { t } = useI18n();
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  const [stage, setStage] = useState<'idle' | 'installing' | 'failed'>('idle');
  const [busy, setBusy] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  // The check reads the switches at the moment it runs, not the render that
  // scheduled it, so turning automatic checking off stops the next check
  // without waiting for the current one to land. The same goes for the host and
  // the locale: a language switch must not restart the cadence or re-check.
  const prefsRef = useRef(readUpdatePrefs);
  const hostRef = useRef(host);
  hostRef.current = host;
  const nowRef = useRef(now);
  nowRef.current = now;
  const translateRef = useRef(t);
  translateRef.current = t;

  /**
   * Bumped every time the scheduler starts a check. An answer that comes back
   * for an older generation is dropped: it describes the feed as it was under
   * preferences the user may since have changed, and showing it would put a
   * beta offer in front of someone now on stable, or auto-install under a
   * switch they have turned off.
   */
  const generationRef = useRef(0);

  /**
   * The offers already put off in this run. Closing the dialog is not a skip
   * and not a snooze: it silences this version until the window restarts, and
   * only in memory, so a restart may ask again. Keeping it here rather than in
   * the stored record is what stops "not now" from silently becoming "never".
   */
  const dismissedRef = useRef(new Set<string>());

  const installingRef = useRef(false);
  const runInstall = useCallback((pending: UpdateOffer) => {
    if (installingRef.current) return;
    installingRef.current = true;
    setStage('installing');
    void Promise.resolve().then(() => pending.update.install()).then(
      () => {
        installingRef.current = false;
        if (!aliveRef.current) return;
        setStage('idle');
        setOffer(null);
        pushToast({ tone: 'success', text: translateRef.current('st.about.installedRestart') });
      },
      async (error: unknown) => {
        if (!aliveRef.current) { installingRef.current = false; return; }
        if (isDesktopUpdateSelectionChanged(error)) {
          resetUpdateCheckCache();
          await hydrateUpdatePrefs(hostRef.current);
          const current = prefsRef.current();
          if (current.autoUpdate !== 'off') {
            const result = await checkDesktopUpdateOnce(hostRef.current, nowRef.current(), current.updateChannel);
            if (aliveRef.current && result.kind === 'update'
              && prefsRef.current().autoUpdate !== 'off'
              && prefsRef.current().updateChannel === current.updateChannel
              && mayOfferUpdate(result.update.version, current.updateChannel, nowRef.current())) {
              // Refresh the selection, never auto-install a replacement the user did not click.
              setOffer({ update: result.update, channel: current.updateChannel });
            } else if (aliveRef.current) setOffer(null);
          } else setOffer(null);
        }
        installingRef.current = false;
        if (aliveRef.current) setStage('failed');
      },
    );
  }, []);

  // The cadence. One timer, and the visibility listener re-arms it rather than
  // adding a second one, so returning to a window a hundred times does not
  // leave a hundred clocks running.
  useEffect(() => {
    if (!isDesktop) return undefined;
    let active = true;
    let timer: number | undefined;
    let running: Promise<void> | undefined;
    // A failed persistence call still must not turn a failed feed into a tight retry loop.
    let attemptedAt: number | undefined;
    const clear = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const delayUntilDue = () => {
      if (prefsRef.current().autoUpdate === 'off') return UPDATE_CHECK_INTERVAL_MS;
      const stored = lastUpdateCheckAt();
      const last = attemptedAt === undefined ? stored
        : stored === undefined ? attemptedAt : Math.max(stored, attemptedAt);
      return last === undefined ? UPDATE_STARTUP_DELAY_MS
        : Math.max(0, UPDATE_CHECK_INTERVAL_MS - (nowRef.current() - last));
    };
    const arm = (delay: number) => {
      if (!active) return;
      clear();
      timer = window.setTimeout(() => { timer = undefined; void check(); }, delay);
    };
    const run = async () => {
      await hydrateUpdatePrefs(hostRef.current);
      if (!active) return;
      const started = prefsRef.current();
      setOffer((pending) => pending !== null && (started.autoUpdate === 'off' || pending.channel !== started.updateChannel) ? null : pending);
      if (started.autoUpdate === 'off' || !updateCheckDue(nowRef.current())) return;
      if (attemptedAt !== undefined && nowRef.current() - attemptedAt < UPDATE_CHECK_INTERVAL_MS) return;
      const generation = ++generationRef.current;
      const result = await checkDesktopUpdateOnce(hostRef.current, nowRef.current(), started.updateChannel);
      if (!active || generation !== generationRef.current) return;
      attemptedAt = nowRef.current();
      await markUpdateChecked(attemptedAt, hostRef.current);
      // Another window may have changed mode, channel, skip or snooze during the feed request.
      await hydrateUpdatePrefs(hostRef.current);
      if (!active || generation !== generationRef.current || result.kind !== 'update') return;
      const current = prefsRef.current();
      if (current.autoUpdate === 'off' || current.updateChannel !== started.updateChannel) return;
      const { update } = result;
      if (dismissedRef.current.has(`${current.updateChannel}:${update.version}`)) return;
      if (!mayOfferUpdate(update.version, current.updateChannel, nowRef.current())) return;
      const pending: UpdateOffer = { update, channel: current.updateChannel };
      if (current.autoUpdate === 'install') runInstall(pending);
      else setOffer(pending);
    };
    const check = () => {
      if (running !== undefined) return running;
      running = run().finally(() => { running = undefined; arm(delayUntilDue()); });
      return running;
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      clear();
      void check();
    };
    // Paint first, then hydrate and decide whether today's check is actually due.
    arm(UPDATE_STARTUP_DELAY_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      clear();
      generationRef.current += 1;
    };
  }, [isDesktop, runInstall]);

  // The wait. An overlay that is up, or an approval waiting on the user, means
  // the app is busy with something; the offer keeps its place and is shown when
  // that clears. The retry is one interval rather than a second overlay
  // mechanism: `anyOverlayOpen` is a read, not a subscription.
  //
  // The update dialog's own overlay is excluded, or it would count as the thing
  // it is waiting for and the offer could never be shown at all.
  const somethingElseOpen = () => anyOverlayOpen([UPDATE_DIALOG_OVERLAY]);
  useEffect(() => {
    if (offer === null || (!somethingElseOpen() && !hasPendingApproval)) {
      setBusy(false);
      return undefined;
    }
    setBusy(true);
    const timer = window.setInterval(() => {
      if (somethingElseOpen() || hasPendingApproval) return;
      window.clearInterval(timer);
      setBusy(false);
    }, OVERLAY_RETRY_MS);
    return () => { window.clearInterval(timer); };
  }, [offer, hasPendingApproval]);

  return {
    offer: busy ? null : offer,
    onUpdate: runInstall,
    /**
     * The two ways of not taking the update now.
     *
     * The write is awaited before the offer closes, because a "Kiki will not
     * ask about 0.3.2 again" toast is a promise about the next launch. If the
     * native side refuses the write that promise is false, and the only honest
     * thing to do is leave the dialog on screen with the reason and let the
     * choice be made again.
     */
    onRemindLater: async () => {
      const stored = await snoozeUpdateUntil(nowRef.current(), hostRef.current);
      if (!stored) {
        setPersistError(translateRef.current('st.about.updateDialog.persistFailed'));
        return;
      }
      setPersistError(null);
      setOffer(null);
      pushToast({ tone: 'info', text: translateRef.current('st.about.updateDialog.remindLaterDone') });
    },
    onSkip: async (pending) => {
      const stored = await skipUpdateVersion(pending.update.version, pending.channel, hostRef.current);
      if (!stored) {
        setPersistError(translateRef.current('st.about.updateDialog.persistFailed'));
        return;
      }
      setPersistError(null);
      setOffer(null);
      pushToast({
        tone: 'info',
        text: translateRef.current('st.about.updateDialog.skipDone', { version: pending.update.version }),
      });
    },
    onDismiss: () => {
      if (offer !== null) dismissedRef.current.add(`${offer.channel}:${offer.update.version}`);
      setOffer(null);
    },
    installing: stage === 'installing',
    installError: stage === 'failed' ? translateRef.current('st.about.updateDialog.installFailed') : null,
    persistError,
  };
}
