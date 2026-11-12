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
    <p data-first-run-tour className="mx-auto w-full max-w-[var(--kiki-chat-content-width,760px)] text-left text-[12.5px] leading-relaxed text-ink-faint">
      <span>{t('firstRun.tour.line')}</span>{' '}
      <button
        type="button"
        data-first-run-tour-start
        className="rounded-sm text-ink-soft underline decoration-hairline-strong underline-offset-[3px] hover:text-ink hover:decoration-ink-soft focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
        onClick={() => {
          done();
          void discovery.startRoute('overview');
        }}
      >
        {t('firstRun.tour.start')}
      </button>
      <span aria-hidden className="px-1.5">·</span>
      <button
        type="button"
        data-first-run-tour-dismiss
        className="rounded-sm text-ink-soft underline decoration-hairline-strong underline-offset-[3px] hover:text-ink hover:decoration-ink-soft focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
        onClick={done}
      >
        {t('firstRun.tour.dismiss')}
      </button>
    </p>
  );
}
