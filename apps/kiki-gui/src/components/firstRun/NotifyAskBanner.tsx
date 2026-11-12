/**
 * The one question about system notifications, asked when it can be
 * understood: something happened while the person was away (a task finished,
 * an approval or a question waited, a turn failed), the system has never been
 * asked, and nothing was shown. The strip sits where the connection banner
 * sits and stays until it is answered; the answer is remembered for the device
 * (`lib/awayNotify`).
 *
 * "Notify me" asks the system from inside this click — browsers only show
 * their prompt for a user gesture, and a prompt the person did not start is
 * one they cannot place. "No thanks" is this device's answer; it switches no
 * notification off, and Settings can ask again later.
 */

import { useSyncExternalStore } from 'react';

import { useI18n } from '../../i18n';
import { answerNotificationAsk, notificationAskSnapshot, subscribeNotificationAsk } from '../../lib/awayNotify';
import { SECONDARY_BUTTON } from '../ui';

export function NotifyAskBanner() {
  const { t } = useI18n();
  const ask = useSyncExternalStore(subscribeNotificationAsk, notificationAskSnapshot, notificationAskSnapshot);
  if (ask === null) return null;

  return (
    <div
      role="status"
      data-notify-ask
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-b border-hairline bg-panel px-4 py-1.5 text-center text-[12px] text-ink"
    >
      <span className="min-w-0">
        {ask.title === undefined ? t('firstRun.notify.askGeneric') : t('firstRun.notify.ask', { title: ask.title })}
      </span>
      <span className="flex items-center gap-2">
        <button
          type="button"
          data-notify-ask-yes
          className={`${SECONDARY_BUTTON} py-1 text-ink pointer-coarse:min-h-11`}
          onClick={() => { void answerNotificationAsk(true)?.catch(() => false); }}
        >
          {t('firstRun.notify.yes')}
        </button>
        <button
          type="button"
          data-notify-ask-no
          className="rounded-md px-2 py-1 text-[12px] text-ink-soft underline-offset-2 hover:text-ink hover:underline pointer-coarse:min-h-11"
          onClick={() => { void answerNotificationAsk(false); }}
        >
          {t('firstRun.notify.no')}
        </button>
      </span>
    </div>
  );
}
