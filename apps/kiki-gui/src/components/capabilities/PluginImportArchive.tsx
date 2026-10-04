/**
 * The archive — a read-only record of one imported conversation.
 *
 * This is the honest shape of the result: an archive is not a session. There
 * is no composer here and no way to continue it in this surface, because the
 * imported record is a record — its old tool calls and system text are history,
 * not instructions this engine will act on. The header says that once, in one
 * line, and the body is the transcript.
 *
 * Records are read in bounded pages through the same reader the local-session
 * preview uses, so a long archive never loads its whole body at once. A `cursor`
 * at the end is a "load more", not a spinner that never resolves.
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { importCountsText, importsApi, recordRoleKey, type ImportReadPage } from '../../lib/importHistory';
import { useConnection } from '../../state/connection';
import { InlineError } from '../controls';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { Icon, Spinner } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { Disclosure, FactList } from './primitives';

const PAGE_LIMIT = 50;

export function PluginImportArchive({
  archiveId,
  onClose,
}: {
  /**
   * The archive to open, by id. A job that just finished names an archive the
   * caller's first page may not list, so the reader resolves the id itself
   * rather than being handed a record that might not exist yet.
   */
  readonly archiveId: string;
  readonly onClose: () => void;
}) {
  const { t, tp, locale } = useI18n();
  const { client, scopeId } = useConnection();
  const api = importsApi(client);
  // Only the pages past the first are local state. The first page belongs to
  // the query, so a close-and-reopen meets a warm cache and draws it again
  // instead of clearing the body and waiting for a fetch that will not come.
  const [more, setMore] = useState<readonly ImportReadPage[]>([]);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [details, setDetails] = useState(false);

  const first = useQuery({
    queryKey: ['plugin-import', 'read', scopeId, archiveId, 'first'],
    queryFn: async () => api.read({ archiveId, limit: PAGE_LIMIT }),
    staleTime: 60_000,
    retry: false,
  });
  // The archive comes back with the first page, so the header reads the server's
  // own record rather than a guess assembled from a job.
  const archive = first.data?.archive;

  // Identity is the scope *and* the archive: the same id read through another
  // connection is another archive, and a page asked for under the old pair is
  // not this reader's page.
  const opened = `${scopeId}::${archiveId}`;
  const openedRef = useRef(opened);
  openedRef.current = opened;
  // Dropping the carried pages on every change of identity is what keeps a late
  // page from landing in a body that has moved on, and what makes switching
  // back to an archive start from its own first page.
  useEffect(() => { setMore([]); setFailure(null); setLoading(false); }, [opened]);

  const loadMore = async () => {
    if (cursor === null || cursor === undefined || loading) return;
    const askedFor = opened;
    const at = cursor;
    setLoading(true);
    setFailure(null);
    try {
      const page = await api.read({ archiveId, cursor: at, limit: PAGE_LIMIT });
      if (openedRef.current !== askedFor) return;
      setMore((current) => [...current, page]);
    } catch (error) {
      if (openedRef.current !== askedFor) return;
      setFailure(errorText(locale, error));
    } finally {
      // Only this reader's own request may stop this reader's spinner; the
      // identity effect already cleared it for whoever moved on.
      if (openedRef.current === askedFor) setLoading(false);
    }
  };

  const records = first.data === undefined ? [] : [...first.data.records, ...more.flatMap((page) => page.records)];
  // The cursor is the server's, and it is always the last page actually read —
  // not a fallback to the first page's, which would resurrect a cursor the
  // server already closed. `undefined` means nothing has been read yet.
  const cursor = first.data === undefined
    ? undefined
    : more.length > 0 ? more.at(-1)!.cursor : first.data.cursor;
  // Only a finished read is a finished read. While the first page is in flight
  // the footer must not report the record as complete or offer a next page.
  const exhausted = first.isSuccess && cursor === null;

  // The archive is only named by the first read, so the panel opens on a
  // loading state rather than on a title the GUI made up.
  const title = archive === undefined
    ? t('cap.import.archiveLoading')
    : (archive.title !== '' ? archive.title : t('cap.import.untitled'));
  return (
    <Dialog
      onClose={onClose}
      ariaLabel={title}
      overlayId="plugin-import-archive"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.lg} flex h-[min(86dvh,720px)] flex-col !p-0`}
      overlayData={{ 'data-plugin-import-archive-dialog': archiveId }}
    >
      <header className="flex shrink-0 items-start gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="truncate font-display text-[18px] font-semibold tracking-tight text-ink" title={title}>{title}</h2>
          <p className="text-[12.5px] leading-5 text-ink-soft">{t('cap.import.archiveIntro')}</p>
        </div>
        <button type="button" onClick={onClose} aria-label={t('common.close')}
          className="-mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11">
          <Icon name="close" size={16} />
        </button>
      </header>
      {archive !== undefined ? (
      <div className="shrink-0 border-b border-hairline bg-ink/[0.02] px-5 py-3">
        <FactList
          items={[
            { label: t('cap.import.archiveSource'), value: `${archive.sourceId} · ${archive.externalId}`, mono: true },
            { label: t('cap.import.archiveHome'), value: `${archive.sourceHome} → ${archive.targetHome}`, mono: true },
            { label: t('cap.import.archiveStatus'), value: t(archive.status === 'preserved' ? 'cap.import.probe.preserved' : 'cap.import.probe.partial') },
            ...(archive.losses.length > 0 ? [{
              label: t('cap.import.archiveLosses'),
              value: (
                <ul className="space-y-0.5">
                  {archive.losses.map((loss) => (
                    <li key={loss.code} className="flex min-w-0 items-baseline gap-1.5">
                      <span className="shrink-0 tabular-nums text-ink-faint">{loss.count}</span>
                      <span className="min-w-0">{loss.detail || loss.code}</span>
                    </li>
                  ))}
                </ul>
              ),
            }] : []),
          ]}
        />
        {/* The digest, the parser's format version and the page arithmetic are
            how the host identifies this archive, not what it contains. They are
            one disclosure away rather than four rows above the conversation. */}
        <div className="mt-1">
        <Disclosure
          label={t('cap.import.archiveDetails')}
          open={details}
          onToggle={() => { setDetails((value) => !value); }}
          dataAttrs={{ 'data-plugin-import-archive-details': '' }}
        >
          <FactList
            items={[
              { label: t('cap.import.archiveRevision'), value: archive.revision, mono: true },
              { label: t('cap.import.archiveFormat'), value: archive.formatVersion, mono: true },
              { label: t('cap.import.archiveSize'), value: importCountsText(tp, archive.records, archive.pages) },
            ]}
          />
        </Disclosure>
        </div>
      </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3" data-plugin-import-archive-body>
        {first.isPending ? (
          <p className="flex items-center gap-2 text-[13px] text-ink-faint" role="status"><Spinner label={t('cap.import.archiveLoading')} />{t('cap.import.archiveLoading')}</p>
        ) : null}
        {first.isError ? (
          <div className="space-y-2">
            <InlineError error={first.error} />
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { void first.refetch(); }}>{t('common.retry')}</button>
          </div>
        ) : null}
        {first.isSuccess && records.length === 0 ? (
          <p className="text-[13px] text-ink-soft">{t('cap.import.archiveEmpty')}</p>
        ) : null}
        <ol className="space-y-3">
          {/* The key is the record's position in everything read so far, not its
              position on this page. A parser may return one record's body in
              several segments, so `id` + `part` alone is not unique — and each
              page restarts its own numbering, which would collide. */}
          {records.map((record, index) => (
            <li key={`${record.id}-${record.part}-${index}`} data-plugin-import-archive-record={record.role} className="min-w-0 space-y-0.5">
              <p className="text-[11.5px] font-medium text-ink-faint">
                {t(recordRoleKey(record.role))}
                {record.toolName !== undefined ? <span className="font-mono"> · {record.toolName}</span> : null}
              </p>
              {record.text !== undefined && record.text !== '' ? (
                <p className={`break-words whitespace-pre-wrap text-[13px] leading-[1.55] ${record.role === 'user' ? 'text-ink' : 'text-ink-soft'}`}>{record.text}</p>
              ) : null}
            </li>
          ))}
        </ol>
        {failure !== null ? <p role="alert" className="mt-2 text-[12px] text-danger">{failure}</p> : null}
      </div>
      <footer data-plugin-import-archive-footer className="flex shrink-0 items-center gap-2 border-t border-hairline px-5 py-3">
        <p className="min-w-0 flex-1 text-[12px] leading-4 text-ink-faint">
          {exhausted ? t('cap.import.archiveComplete') : t('cap.import.archiveMoreHint')}
        </p>
        {cursor !== null && cursor !== undefined ? (
          <button type="button" className={SECONDARY_BUTTON} disabled={loading} onClick={() => { void loadMore(); }} data-plugin-import-archive-more>
            {loading ? <Spinner label={t('cap.import.archiveLoading')} size={12} /> : null}
            {t('cap.import.loadMore')}
          </button>
        ) : null}
        <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>{t('common.close')}</button>
      </footer>
    </Dialog>
  );
}
