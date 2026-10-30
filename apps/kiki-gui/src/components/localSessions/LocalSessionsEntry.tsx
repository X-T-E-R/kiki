/**
 * The quiet way into the local-sessions dialog. Renders nothing unless a
 * registered executor can read local Claude / Codex history, so a machine
 * without either engine never sees a dead entry.
 */

import { useMemo, useState } from 'react';

import { useI18n } from '../../i18n';
import { localSessionEngine, localSessionSources } from '../../lib/localSessions';
import { Icon } from '../icons';
import { useExecutorCatalogQuery } from '../settings/profileEditor/engines';
import { SECONDARY_BUTTON } from '../ui';
import { LocalSessionsDialog } from './LocalSessionsDialog';

const QUIET =
  'motion-press inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-11';

export function LocalSessionsEntry({
  executorId,
  variant = 'quiet',
}: {
  /** Settings engine rows scope the entry to their own engine. */
  readonly executorId?: string;
  /** `quiet`: a text control (the /new target row); `button`: a secondary button (settings). */
  readonly variant?: 'quiet' | 'button';
}) {
  const { t } = useI18n();
  const catalog = useExecutorCatalogQuery();
  const available = useMemo(() => {
    if (executorId !== undefined) return localSessionEngine(executorId) !== undefined;
    return localSessionSources(catalog.data?.items ?? []).length > 0;
  }, [catalog.data, executorId]);
  const [open, setOpen] = useState(false);
  if (!available) return null;
  return (
    <>
      <button
        type="button"
        data-local-sessions-entry={executorId ?? 'new'}
        aria-haspopup="dialog"
        onClick={() => { setOpen(true); }}
        className={variant === 'button' ? `${SECONDARY_BUTTON} inline-flex items-center gap-1.5` : `${QUIET} -ml-2 mt-2`}
      >
        <Icon name="branch" size={12} className="text-ink-faint" />
        {t(variant === 'button' ? 'localSessions.browse' : 'localSessions.entry')}
      </button>
      {open ? (
        // The surface replaces the entry's row; a quiet scrim gives the
        // dismiss a target without stacking a second dialog layer.
        <>
          <button type="button" aria-label={t('common.close')} tabIndex={-1}
            onClick={() => { setOpen(false); }}
            className="fixed inset-0 z-40 cursor-default bg-shell/20" />
          <div className="fixed inset-x-0 top-10 z-40 flex justify-center px-4">
            <LocalSessionsDialog initialExecutorId={executorId} onClose={() => { setOpen(false); }} />
          </div>
        </>
      ) : null}
    </>
  );
}
