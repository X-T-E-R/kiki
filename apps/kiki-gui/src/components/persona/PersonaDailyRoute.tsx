/**
 * PersonaDailyRoute: the stable address of one persona's daily conversation.
 *
 * `/p/:personaId/daily` is the address every persona name points at (sidebar
 * row, switcher, header, persona page). It resolves to the persisted home when
 * there is one, and otherwise to a fresh daily draft.
 *
 * The directory read decides which: while it is loading or failed this page
 * must NOT render the draft, because "no homeSessionId in a list we do not
 * have yet" is not the same as "this persona has no daily conversation".
 */

import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useI18n } from '../../i18n';
import { errorText } from '@kiki/session-core/i18n';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { NewSessionPage } from '../NewSessionPage';
import { resolvePersonaDailyRoute } from './personaNavigation';
import { usePersonaDirectory } from './usePersonaDirectory';

export function PersonaDailyRoute({ onToggleSidebar }: { readonly onToggleSidebar?: () => void }) {
  const { personaId } = useParams<{ personaId: string }>();
  const navigate = useNavigate();
  const { t, locale } = useI18n();
  const directory = usePersonaDirectory();

  const resolution = resolvePersonaDailyRoute({
    personaId,
    directory: directory.directory,
    isLoading: directory.isLoading,
    isError: directory.isError,
  });

  useEffect(() => {
    if (resolution.kind === 'home') void navigate(resolution.href, { replace: true });
  }, [resolution, navigate]);

  if (resolution.kind === 'draft') {
    return <NewSessionPage dailyPersonaId={resolution.personaId} onToggleSidebar={onToggleSidebar ?? noop} />;
  }

  // One quiet note in the sheet: opening, unreadable, or gone. Never a draft.
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-16">
      {resolution.kind === 'loading' ? (
        <p role="status" className="text-[13px] text-ink-faint">
          {t('persona.dailyLoading')}
        </p>
      ) : null}
      {resolution.kind === 'error' ? (
        <div className="max-w-sm text-center">
          <p role="alert" className="text-[13px] text-ink-soft">
            {t('persona.dailyLoadFailed', { detail: errorText(locale, directory.error) })}
          </p>
          <button
            type="button"
            onClick={() => { void directory.refetch(); }}
            className={`${PRIMARY_BUTTON} mt-3`}
          >
            {t('common.retry')}
          </button>
        </div>
      ) : null}
      {resolution.kind === 'missing' ? (
        <div className="max-w-sm text-center">
          <p className="text-[13px] text-ink-soft">{t('persona.dailyMissing')}</p>
          <button
            type="button"
            onClick={() => { void navigate('/personas'); }}
            className={`${SECONDARY_BUTTON} mt-3`}
          >
            {t('persona.back')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function noop(): void {}
