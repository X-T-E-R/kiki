/**
 * The one-line tour invitation under the starters (or under the connect card)
 * on an empty new-conversation page.
 *
 * It is offered only while the server has no conversations at all, so a phone
 * or a browser that attaches to a Kiki already in use never sees it, and only
 * on a device that has not had it: "No thanks", starting the tour from here,
 * any tour run from Discover, or the first message sent puts it away for good
 * (`kiki.firstRun`). Someone who finished the old first-run wizard counts as
 * having dismissed it. It is the weakest thing on the page: plain text, no
 * accent, no box.
 */

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import { markFirstRunHintDone } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { useOptionalDiscovery } from '../discovery';
import { Icon } from '../icons';

export function TourLine({ onDone }: {
  /** Called after the line put itself away, so the page stops rendering it. */
  readonly onDone: () => void;
}) {
  const { client } = useConnection();
  const { t } = useI18n();
  const discovery = useOptionalDiscovery();
  // Under ['sessions'] so a created conversation refreshes it; archived ones
  // count, since the server is then in use all the same.
  const anySession = useQuery({
    queryKey: ['sessions', 'first-run-any'],
    queryFn: () => client.listSessions({ page_size: 1, include_archive: true }),
    staleTime: 60_000,
  });
  // A tour already run from anywhere (Discover, the sidebar) has had its
  // introduction, on this device for good; an unknown session count is not "none".
  const toured = discovery !== null && discovery.state.lifecycle !== 'new';
  useEffect(() => {
    if (toured) markFirstRunHintDone('tourLine');
  }, [toured]);
  if (discovery === null || toured) return null;
  if (anySession.data === undefined || anySession.data.items.length > 0) return null;

  const done = () => {
    markFirstRunHintDone('tourLine');
    onDone();
  };

  return (
    <div
      data-first-run-tour
      className="mx-auto flex w-full max-w-[var(--kiki-chat-content-width,760px)] flex-col items-start gap-1.5 text-left text-[12.5px] leading-5 text-ink-faint sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-1"
    >
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Icon name="compass" size={12} className="shrink-0 text-ink-faint" />
        <span className="min-w-0">{t('firstRun.tour.line')}</span>
      </span>
      <span className="-ml-1.5 inline-flex flex-wrap items-center gap-x-1 gap-y-1 pointer-coarse:-ml-2 sm:ml-0">
        <button
          type="button"
          data-first-run-tour-start
          className="motion-press inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] font-normal text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:min-h-11 pointer-coarse:px-2"
          onClick={() => {
            done();
            void discovery.startRoute('overview');
          }}
        >
          <span>{t('firstRun.tour.start')}</span>
          <Icon name="arrowRight" size={12} className="shrink-0" />
        </button>
        <span aria-hidden className="px-0.5 text-hairline-strong">·</span>
        <button
          type="button"
          data-first-run-tour-dismiss
          className="motion-press inline-flex min-h-7 items-center rounded-md px-1.5 text-[12.5px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:min-h-11 pointer-coarse:px-2"
          onClick={done}
        >
          {t('firstRun.tour.dismiss')}
        </button>
      </span>
    </div>
  );
}
