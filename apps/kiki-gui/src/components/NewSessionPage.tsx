/**
 * NewSessionPage — /new is the full-page draft conversation and the landing
 * route when no session exists. The workspace picker + Composer core is
 * shared with the Ctrl+N NewSessionDialog via `useNewSessionDraft`; the page
 * adds the wordmark header and the recent-sessions chips.
 */

import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { NewSessionDraftPanel, useNewSessionDraft } from './NewSessionDraft';
import { Wordmark } from './Wordmark';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';

export function NewSessionPage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { client } = useConnection();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const workspaceParam = searchParams.get('workspace') ?? undefined;

  const state = useNewSessionDraft({ initialWorkspaceId: workspaceParam });

  const recentQuery = useQuery({
    queryKey: ['sessions', 'recent'],
    queryFn: () => client.listSessions({ page_size: 5 }),
    staleTime: 5000,
  });
  const recentSessions = recentQuery.data?.items ?? [];

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('sv.openMenuAria')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"
        >
          <span aria-hidden>☰</span>
        </button>
        <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
          {t('new.title')}
        </h1>
      </header>

      <main className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-10">
        <div className="w-full max-w-[760px]">
          <div className="mb-8 text-center">
            <Wordmark size="lg" />
            <p className="mt-3 text-[13px] text-ink-soft">
              {t('new.tagline')}
            </p>
          </div>

          <NewSessionDraftPanel state={state} />

          {recentSessions.length > 0 ? (
            <div className="mt-6">
              <p className="mb-2 text-[11px] font-medium text-ink-soft">{t('new.recent')}</p>
              <div className="flex flex-wrap gap-2">
                {recentSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => void navigate(`/s/${session.id}`)}
                    className="max-w-[200px] truncate rounded-full border border-hairline bg-panel px-3 py-1 text-[11.5px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
                  >
                    {session.title !== '' ? session.title : session.last_prompt ?? session.id}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </main>
    </>
  );
}
