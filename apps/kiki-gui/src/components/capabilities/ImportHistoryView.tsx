/**
 * Import history — bring a Claude Code / Codex conversation into Kiki, as a
 * Kiki session you can keep talking in, or as a read-only archive.
 *
 * The destination is chosen first, because it is the reader's actual goal and
 * it decides everything after it: a Kiki session and an archive are different
 * reads of the same file. It is one short choice, not a second form — picking
 * a session reveals exactly one more field, the working directory that session
 * will run in, offered as the workspaces this Kiki already knows plus a typed
 * path and a folder button.
 *
 * The flow is one column and one thing at a time, because the reader's
 * questions arrive in this order: what will it become, which source, which
 * file, what will be kept and lost, has it landed, where is it. So the column
 * holds, top to bottom:
 *
 *   destination what the imported conversation becomes: a Kiki session you can
 *             continue, or a read-only archive. Chosen first, stated once.
 *   source    the enabled importers this server offers (contract data — never a
 *             list of formats written in the GUI), the source home to read, and
 *             the file in it. The home is the *source* machine's home, and the
 *             target is named separately below; the two are never blurred into
 *             one "folder" field.
 *   target    the home this window is connected to. It is a fact, not a field:
 *             an import lands here, and the reader cannot aim it elsewhere
 *             from this surface.
 *   preview   a bounded sample with the server's own completeness word
 *             (`preserved` / `partial` / `unsupported`) and its loss list. A
 *             sample is labelled a sample; it is never drawn as the whole
 *             history.
 *   job       a real bounded job: read-then-commit with progress the host
 *             reports, a cancel while it runs, and a resume after a stop. A
 *             finished session import says Open session, which is the whole
 *             point of the native destination.
 *   archive   the result of the read-only destination, opened as a read-only
 *             history. It is not a live session and does not pretend to be
 *             one — there is no composer there, and the copy says so once.
 *
 * Layout follows the capability grammar: T5 section labels over rows, hairline
 * rules, quiet buttons, no stacked cards. Numbers stay folded: the page shows
 * what is kept and what is lost, and the byte/page counts live in the job row
 * where they mean something.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import {
  archiveStateKey,
  destinationKey,
  destinationReady,
  homeName,
  importKeys,
  importCountsText,
  importProgress,
  importsApi,
  isJobActive,
  isNativeDestination,
  jobStateKey,
  lossCount,
  nativeSessionId,
  nativeWorkDir,
  probeStateKey,
  recordRoleKey,
  anySourceKey,
  isSameSource,
  shortDigest,
  sourceKey,
  shortPath,
  shortSourceId,
  useImportHistoryEnabled,
  UNFINISHED_JOB_STATES,
  type ImportArchive,
  type ImportDestination,
  type ImportJob,
  type ImportPreview,
} from '../../lib/importHistory';
import { useConnection } from '../../state/connection';
import { FeedbackLine, InlineError } from '../controls';
import { Icon, Spinner } from '../icons';
import { CapabilitySection, EmptyNote, QUIET_BUTTON, Segmented, Tag } from './primitives';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { PluginSettingsForm } from './PluginSettingsForm';
import { useInstalledPlugins } from './usePlugins';
import { PluginImportArchive } from './PluginImportArchive';

/** Poll cadence while a job is live; a finished job stops the loop by itself. */
const ACTIVE_POLL_MS = 900;
/** One page of jobs or archives, the same bound the archive reader uses. */
const PAGE_LIMIT = 50;

export function ImportHistoryView({
  initialSourceId,
  initialSourcePluginId,
  onOpenPlugin,
  onOpenSession,
  onBack,
}: {
  /** Deep-link a plugin's own importer straight into this view. */
  readonly initialSourceId?: string;
  /** The plugin that contributes the linked source, when the link carries it. */
  readonly initialSourcePluginId?: string;
  readonly onOpenPlugin?: (pluginId: string) => void;
  /**
   * Open a finished native import as a live session. This is the same route the
   * session list and the memory page use, so an imported conversation is
   * continued in the same place a session started here would be — not in a
   * reader bolted onto this page.
   */
  readonly onOpenSession?: (sessionId: string) => void;
  readonly onBack?: () => void;
}) {
  const { t, locale } = useI18n();
  const { client, scopeId, meta, sshLabel, connectionId } = useConnection();
  const queryClient = useQueryClient();
  const host = useHost();
  // A remote peer's grant covers reading sources, jobs and archives. The four
  // writes stay with the peer that owns its home, so they are shown as read-only
  // facts here rather than disabled-and-pretending.
  const remote = connectionId !== null;
  const api = importsApi(client);
  const { enabled, loading: flagLoading } = useImportHistoryEnabled(client, scopeId);

  // A Kiki session is the point of this page, so it is what the reader gets
  // without choosing. The archive stays one segment away because it is still
  // the right answer for a history you want to read rather than continue.
  const [destinationKind, setDestinationKind] = useState<'native' | 'archive'>('native');
  const [workDir, setWorkDir] = useState('');
  // The destination as the wire wants it: absent for the archive path, which is
  // what the first phase of this feature has always sent. A native read with no
  // working directory is not sent at all — see `destinationReady`.
  const destination: ImportDestination | undefined = destinationKind === 'native'
    ? { kind: 'native-session', workDir: workDir.trim() }
    : { kind: 'archive' };
  // A remote peer's sessions would be created in this machine's directory from
  // the peer's conversation, so the native aim is withdrawn there rather than
  // sent and refused. The archive aim is always this server's own to write.
  const nativeAllowed = destinationKind === 'archive' || !remote;
  const destinationReadyForSource = nativeAllowed && destinationReady(destination);

  // The picked key names one source by plugin and id. A deep link carrying
  // only a source id still resolves, through the wildcard key.
  const [picked, setPicked] = useState<string | undefined>(() => (
    initialSourceId === undefined ? undefined
      : initialSourcePluginId === undefined ? anySourceKey(initialSourceId)
        : sourceKey(initialSourcePluginId, initialSourceId)));
  const [home, setHome] = useState('');
  const [externalId, setExternalId] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The id, not a record: a job that just finished names an archive that this
  // page's first archive page may not contain yet.
  const [openArchiveId, setOpenArchiveId] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // The effect above settles the state on the frame *after* the change, so the
  // panel is also gated on the aim it was read for. Otherwise one render would
  // still offer the previous aim's consequences next to the new aim's field —
  // and the reader could start an import from a preview that no longer describes
  // what they are about to get. The panel a reader can act on is one that was
  // read for the destination currently on screen.
  const shownPreview = preview !== null && destinationKey(preview.destination) === destinationKey(destination)
    ? preview
    : null;

  // The consequence lands under a long list. Bring it to the reader rather
  // than leaving the action below the fold they are still scrolling.
  useEffect(() => {
    if (shownPreview === null) return;
    previewRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [shownPreview?.id]);

  const live = enabled === true;
  const sourcesQuery = useQuery({
    queryKey: importKeys.sources(scopeId),
    queryFn: async () => api.sources(),
    enabled: live,
    staleTime: 60_000,
    retry: false,
  });
  const sources = useMemo(() => sourcesQuery.data ?? [], [sourcesQuery.data]);
  const source = (picked === undefined
    ? undefined
    : sources.find((item) => isSameSource(picked, item.pluginId, item.id)))
    ?? sources.at(0);
  // Whether the plugin behind the chosen source is one the reader installed.
  // A host-shipped importer answers from the server's own descriptor, so it has
  // no plugin page with settings to manage and nothing to remove; offering one
  // would send the reader to a page that cannot act on it. The wire names no
  // such flag, so this reads the installed list rather than inventing a field.
  const installedPlugins = useInstalledPlugins().data?.plugins;
  const sourceIsInstalled = source !== undefined
    && (installedPlugins === undefined || installedPlugins.some((plugin) => plugin.id === source.pluginId));

  // The lists page by the server's own cursor and *accumulate*: asking for the
  // next page must not make the previous one disappear, and a job that starts or
  // finishes belongs where a reader will see it. One infinite query per list
  // keeps every page it has read — first page included — and the server's
  // `null` cursor simply ends the list instead of dropping the middle of it.
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  // Only a live job keeps a timer, and a live job on a remote peer is read here,
  // not commanded — the peer's own window owns cancel and resume.
  const pollWhileActive = (items: readonly ImportJob[]) => (items.some(isJobActive) ? ACTIVE_POLL_MS : false);
  const jobsQuery = useInfiniteQuery({
    queryKey: importKeys.jobs(scopeId),
    queryFn: async ({ pageParam }) => api.jobs({ limit: PAGE_LIMIT, ...(pageParam === undefined ? {} : { cursor: pageParam }) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.cursor ?? undefined,
    enabled: live,
    staleTime: 5_000,
    retry: false,
    refetchInterval: (query) => pollWhileActive(importJobPages(query.state.data)),
  });
  // The job this window just started is read by id. Its id is a digest of the
  // preview, not a time, so the list's first page does not have to contain it —
  // this read is what puts a new job's progress and cancel in front of the
  // reader who asked for it.
  const startedJobQuery = useQuery({
    queryKey: [...importKeys.job(scopeId, startedJobId ?? '')],
    queryFn: () => api.job(startedJobId!),
    enabled: live && startedJobId !== null,
    staleTime: ACTIVE_POLL_MS,
    retry: false,
    refetchInterval: (query) => pollWhileActive([query.state.data].filter((job): job is ImportJob => job !== undefined)),
  });
  const archivesQuery = useInfiniteQuery({
    queryKey: importKeys.archives(scopeId, ''),
    queryFn: async ({ pageParam }) => api.archives({ limit: PAGE_LIMIT, ...(pageParam === undefined ? {} : { cursor: pageParam }) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.cursor ?? undefined,
    enabled: live,
    staleTime: 10_000,
    retry: false,
  });
  // The newest page first, then every page the reader asked for behind it, then
  // the job this window started: de-duplicated, because a job that finished
  // between two reads — or that the list already carries — appears once.
  const jobs = useMemo(
    () => uniqueBy([...importJobPages(jobsQuery.data), ...(startedJobQuery.data === undefined ? [] : [startedJobQuery.data])], (job) => job.id),
    [jobsQuery.data, startedJobQuery.data],
  );
  const archives = useMemo(
    () => uniqueBy(importArchivePages(archivesQuery.data), (archive) => archive.id),
    [archivesQuery.data],
  );

  // A source switch invalidates the home, the file choice and any preview of
  // it: the other parser's folder is not this one's, and a preview names the
  // exact source it was probed from.
  const sourceIdentity = source === undefined ? undefined : sourceKey(source.pluginId, source.id);
  useEffect(() => {
    setHome('');
    setExternalId(undefined);
    setPreview(null);
    setError(null);
  }, [sourceIdentity]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: importKeys.all });

  // Which jobs have left `queued`/`running`. A change here means one settled —
  // and a settled job has just written an archive, or stopped, or failed, so it
  // is also when the archive list is re-read. The job list needs no help of its
  // own: it is a separate query and re-reads itself.
  const settled = useMemo(
    () => jobs.filter((job) => !isJobActive(job)).map((job) => job.id).join(','),
    [jobs],
  );
  useEffect(() => {
    if (settled === '') return;
    void queryClient.invalidateQueries({ queryKey: importKeys.archives(scopeId, '') });
  }, [settled, queryClient, scopeId]);
  // The job this window started is read by id, so it is not part of any list
  // page. When it settles it carries the archive id the reader needs, which
  // only a fresh read of that job can supply.
  const startedJobSettled = startedJobQuery.data === undefined || isJobActive(startedJobQuery.data);
  useEffect(() => {
    if (startedJobId === null || startedJobSettled) return;
    void queryClient.invalidateQueries({ queryKey: importKeys.job(scopeId, startedJobId) });
  }, [startedJobId, startedJobSettled, queryClient, scopeId]);
  // The target home is whatever the server's own `targetHome` field says —
  // an absolute home path. `meta.server_home_id` is a *different* fact (a home
  // uuid), and this window may not have read a preview or a job yet, so the
  // block reports "not read yet" rather than a value the GUI invented.
  const targetHome = preview?.targetHome ?? jobs.find((job) => job.targetHome !== '')?.targetHome
    ?? archives.find((archive) => archive.targetHome !== '')?.targetHome;
  const targetLabel = sshLabel ?? meta.server_id;
  const trimmedHome = home.trim();

  // A new home is a new source to probe: the chosen file, its preview and any
  // error belong to the folder that was there a moment ago.
  useEffect(() => {
    setExternalId(undefined);
    setPreview(null);
    setError(null);
  }, [trimmedHome]);

  // A different destination is a different read, and the preview under the
  // reader described the old one — its losses, its reuse receipt and its
  // sample all belong to that aim. The chosen file survives, because changing
  // where a conversation lands is not changing which conversation it is.
  useEffect(() => {
    setPreview(null);
    setError(null);
  }, [destinationKind, workDir]);


  const start = async () => {
    if (preview === null || starting) return;
    setStarting(true);
    setError(null);
    try {
      const job = await api.start({ previewId: preview.id, acknowledge: true });
      setPreview(null);
      setExternalId(undefined);
      // The receipt names the job this window just started. Keep it: its id is
      // a preview digest, so a list ordered by another key may not have it on
      // any page the reader has asked for, and the read-back below is what
      // shows its progress and lets it be cancelled.
      setStartedJobId(job.id);
      await invalidate();
    } catch (error) {
      setError(errorText(locale, error));
    } finally {
      setStarting(false);
    }
  };

  const pickHome = async () => {
    const selected = await host.pickDirectory?.().catch(() => null);
    if (typeof selected === 'string') setHome(selected);
  };

  /**
   * Browsing a working directory is not registering one. The folder lands in
   * the field and the host creates the session in it; nothing is written to the
   * workspace list until an import actually lands there, so abandoning the
   * import leaves no workspace behind.
   */
  const pickWorkDir = async () => {
    const selected = await host.pickDirectory?.().catch(() => null);
    if (typeof selected === 'string') setWorkDir(selected);
  };

  if (flagLoading) {
    return <p className="py-3 text-[13px] text-ink-faint" role="status"><Spinner label={t('cap.loading')} /> {t('cap.import.loading')}</p>;
  }
  if (enabled !== true) {
    return (
      <div data-cap-import-disabled className="space-y-3">
        <EmptyNote title={t('cap.import.unavailableTitle')} body={t('cap.import.unavailableBody')} />
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-8" data-plugin-import-view={source?.id ?? 'none'}>
      {onBack !== undefined ? (
        <button type="button" className={`${QUIET_BUTTON} -ml-3`} onClick={onBack} data-plugin-import-back>
          <Icon name="arrowLeft" size={14} />{t('cap.detail.back')}
        </button>
      ) : null}

      <header className="space-y-1">
        <h1 className="font-display text-[20px] leading-7 text-ink">{t('cap.import.title')}</h1>
        <p className="max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t('cap.import.intro')}</p>
      </header>

      {/*
        The destination is the reader's goal, and it is the one decision that
        changes what the other fields mean. It sits above the source picker, in
        the same two-segment geometry the source picker uses, because it is the
        same kind of question: one of a small closed set the host already named.
      */}
      <CapabilitySection id="plugin-import-destination" title={t('cap.import.destinationTitle')}>
        {remote ? (
          // A remote peer has its own home and its own workspaces. A session
          // would have to be created in *this* machine's directory while the
          // conversation came from the peer's, so the native destination is not
          // offered here at all rather than offered and refused later.
          <div className="min-w-0" data-plugin-import-destination-readonly>
            <Segmented
              value="archive"
              ariaLabel={t('cap.import.destinationAria')}
              dataAttribute="data-plugin-import-destination"
              options={[{ value: 'archive', label: t('cap.import.destinationArchive') }]}
              onChange={() => undefined}
            />
            <p className="mt-2 max-w-[62ch] text-[12px] leading-4 text-ink-soft">{t('cap.import.destinationRemoteBody')}</p>
          </div>
        ) : (
          <div className="min-w-0 space-y-3 pt-1">
            <Segmented
              value={destinationKind}
              ariaLabel={t('cap.import.destinationAria')}
              dataAttribute="data-plugin-import-destination"
              options={[
                { value: 'native', label: t('cap.import.destinationSession') },
                { value: 'archive', label: t('cap.import.destinationArchive') },
              ]}
              onChange={(next) => { setDestinationKind(next); }}
            />
            <p className="max-w-[62ch] text-[12px] leading-4 text-ink-soft">
              {destinationKind === 'native' ? t('cap.import.destinationSessionHint') : t('cap.import.destinationArchiveHint')}
            </p>
            {destinationKind === 'native' ? (
              <WorkDirField
                value={workDir}
                onChange={setWorkDir}
                onPick={host.pickDirectory === undefined ? undefined : () => { void pickWorkDir(); }}
                pickLabel={t('cap.import.pickWorkDir')}
              />
            ) : null}
          </div>
        )}
      </CapabilitySection>

      <CapabilitySection id="plugin-import-source" title={t('cap.import.sourceTitle')} count={sources.length} aside={
        // A source the host ships itself has no plugin page a reader could
        // act on — there is nothing to install, trust or remove — so the link
        // is only offered when the contributing plugin is a real installed one.
        source !== undefined && sourceIsInstalled ? (
          <button type="button" className={QUIET_BUTTON} onClick={() => { onOpenPlugin?.(source.pluginId); }} data-plugin-import-open-plugin={source.pluginId}>
            {t('cap.import.manageSource')}
          </button>
        ) : undefined
      }>
        {sourcesQuery.isPending ? (
          <p className="py-2 text-[13px] text-ink-faint" role="status">{t('cap.import.loadingSources')}</p>
        ) : sourcesQuery.isError ? (
          <div className="space-y-2 py-2">
            <InlineError error={sourcesQuery.error} />
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { void sourcesQuery.refetch(); }}>{t('common.retry')}</button>
          </div>
        ) : sources.length === 0 ? (
          <div className="py-2" data-plugin-import-no-sources>
            <EmptyNote title={t('cap.import.noSourcesTitle')} body={t('cap.import.noSourcesBody')} />
          </div>
        ) : (
          <>
            {/* Six chips out-widen a phone, so the row wraps instead of hiding
                the overflow behind a scrollbar-free scroll nobody can see. */}
            <div className="min-w-0">
              <div className="flex w-fit min-w-0 max-w-full flex-wrap items-center gap-0.5 rounded-[9px] bg-ink/[0.04] p-0.5" role="tablist" aria-label={t('cap.import.sourceAria')}>
                {sources.map((item) => (
                  <button
                    key={sourceKey(item.pluginId, item.id)}
                    type="button"
                    role="tab"
                    aria-selected={isSameSource(sourceIdentity, item.pluginId, item.id)}
                    data-plugin-import-source={`${item.pluginId}:${item.id}`}
                    onClick={() => { setPicked(sourceKey(item.pluginId, item.id)); }}
                    className={`inline-flex min-h-7 items-center rounded-[7px] px-3 text-[13px] whitespace-nowrap transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink pointer-coarse:min-h-10 ${
                      isSameSource(sourceIdentity, item.pluginId, item.id) ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'text-ink-soft hover:text-ink'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            {source !== undefined ? (
              <p className="mt-2 text-[12px] leading-4 text-ink-faint">
                {t('cap.import.sourceFormat', { format: source.formatVersion })}
              </p>
            ) : null}
            {/*
              The custom source reads records through a script the reader
              wrote, so its rule lives in settings. The entry stays here, beside
              the format it configures, because this source ships with Kiki and
              is not an installed plugin — there is no plugin page to reach it
              from, and a second management page would be a new surface for one
              field.
            */}
            {source !== undefined && source.id === 'custom' ? (
              <div className="mt-3" data-plugin-import-custom-settings>
                <PluginSettingsForm pluginId={source.pluginId} />
              </div>
            ) : null}
          </>
        )}
      </CapabilitySection>

      {source !== undefined ? (
        <CapabilitySection id="plugin-import-pick" title={t('cap.import.pickTitle')}>
          <div className="min-w-0 space-y-4 pt-1">
            {remote ? (
              // A remote peer's grant reads its sources, jobs and archives. The
              // four writes belong to the peer that owns the home, so this
              // surface states that once instead of offering dead controls.
              <div className="min-w-0" data-plugin-import-readonly>
                <TargetHomeField targetHome={targetHome} targetLabel={targetLabel} remote />
                <p className="mt-2 max-w-[62ch] text-[12px] leading-4 text-ink-soft">{t('cap.import.readonlyBody')}</p>
              </div>
            ) : (
              <>
                <div className="grid gap-4 min-[720px]:grid-cols-2">
                  <PathField
                    id="plugin-import-home"
                    label={t('cap.import.homeLabel')}
                    hint={t('cap.import.homeHint')}
                    value={trimmedHome}
                    onChange={setHome}
                    onPick={host.pickDirectory === undefined ? undefined : () => { void pickHome(); }}
                    pickLabel={t('cap.import.pickHome')}
                    placeholder="C:\Users\you\.claude"
                    dataAttr="data-plugin-import-home"
                  />
                  <TargetHomeField targetHome={targetHome} targetLabel={targetLabel} remote={false} />
                </div>
            {trimmedHome === '' ? (
              <p className="text-[12px] leading-4 text-ink-faint">{t('cap.import.homeRequired')}</p>
            ) : (
              <DiscoveryList
                pluginId={source.pluginId}
                sourceId={source.id}
                home={trimmedHome}
                destination={destinationReadyForSource ? destination : undefined}
                selected={externalId}
                previewOpen={shownPreview !== null}
                onSelect={(entry) => {
                  setExternalId(entry?.externalId);
                  setPreview(null);
                  setError(null);
                }}
                onPreview={setPreview}
              />
            )}
                <FeedbackLine feedback={error === null ? null : { tone: 'error', text: error }} />
              </>
            )}
          </div>
        </CapabilitySection>
      ) : null}

      {shownPreview !== null && source !== undefined ? (
        <div ref={previewRef} className="scroll-mt-4">
          <ImportPreviewPanel
            preview={shownPreview}
            targetLabel={targetLabel}
            starting={starting}
            onCancel={() => { setPreview(null); }}
            onStart={() => { void start(); }}
          />
        </div>
      ) : null}

      <CapabilitySection id="plugin-import-jobs" title={t('cap.import.jobsTitle')} count={jobs.length}>
        <div className="pt-1" data-plugin-import-jobs-section>
          {jobsQuery.isPending ? (
            <p className="py-2 text-[13px] text-ink-faint" role="status">{t('cap.import.loadingJobs')}</p>
          ) : jobsQuery.isError ? (
            <div className="space-y-2 py-2">
              <InlineError error={jobsQuery.error} />
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { void jobsQuery.refetch(); }}>{t('common.retry')}</button>
            </div>
          ) : jobs.length === 0 ? (
            <div className="py-2" data-plugin-import-no-jobs>
              <EmptyNote title={t('cap.import.noJobsTitle')} body={t('cap.import.noJobsBody')} />
            </div>
          ) : (
            <ul className="divide-y divide-hairline" data-plugin-import-jobs>
              {jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  remote={remote}
                  onOpenArchive={setOpenArchiveId}
                  onOpenSession={onOpenSession}
                  onChanged={() => { void invalidate(); }}
                />
              ))}            </ul>
          )}
          <PagingControls
            cursor={jobsQuery.hasNextPage ? 'more' : null}
            moreLabel={t('cap.import.moreJobs', { count: jobs.length })}
            onMore={() => { void jobsQuery.fetchNextPage(); }}
          />
        </div>
      </CapabilitySection>

      <CapabilitySection id="plugin-import-archives" title={t('cap.import.archivesTitle')} count={archives.length}>
        <div className="pt-1" data-plugin-import-archives-section>
          {archivesQuery.isPending ? (
            <p className="py-2 text-[13px] text-ink-faint" role="status">{t('cap.import.loadingArchives')}</p>
          ) : archivesQuery.isError ? (
            <div className="space-y-2 py-2">
              <InlineError error={archivesQuery.error} />
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { void archivesQuery.refetch(); }}>{t('common.retry')}</button>
            </div>
          ) : archives.length === 0 ? (
            <div className="py-2" data-plugin-import-no-archives>
              <EmptyNote title={t('cap.import.noArchivesTitle')} body={t('cap.import.noArchivesBody')} />
            </div>
          ) : (
            <ul className="divide-y divide-hairline" data-plugin-import-archives>
              {archives.map((archive) => (
                <ArchiveRow key={archive.id} archive={archive} onOpen={() => { setOpenArchiveId(archive.id); }} />
              ))}
            </ul>
          )}
          <PagingControls
            cursor={archivesQuery.hasNextPage ? 'more' : null}
            moreLabel={t('cap.import.moreArchives', { count: archives.length })}
            onMore={() => { void archivesQuery.fetchNextPage(); }}
          />
        </div>
      </CapabilitySection>

      {openArchiveId !== null ? (
        <PluginImportArchive archiveId={openArchiveId} onClose={() => { setOpenArchiveId(null); }} />
      ) : null}
    </div>
  );
}

/**
 * Paging for a list that accumulates. `show more` appears only when the server
 * returned a cursor, and it carries the count already read, because a bare
 * "more" would not say what is behind it. There is no page to go back to: the
 * pages stay on screen, so the only choice a reader has left is to read more.
 */
function PagingControls({ cursor, moreLabel, onMore }: {
  readonly cursor: string | null | undefined;
  readonly moreLabel: string;
  readonly onMore: () => void;
}) {
  const { t } = useI18n();
  if (cursor === null || cursor === undefined) return null;
  return (
    <button type="button" className={`${QUIET_BUTTON} -ml-3 mt-1`} data-plugin-import-more onClick={onMore}>
      {moreLabel}
      <Icon name="chevron" size={12} className="rotate-90" />
      <span className="sr-only">{t('cap.import.loadMore')}</span>
    </button>
  );
}

/** First occurrence wins, so a record read on two pages is drawn once. */
function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

/** Every job read so far, page order preserved; a missing list is empty. */
function importJobPages(data: InfiniteData<{ items: readonly ImportJob[] }> | undefined): readonly ImportJob[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

/** Every archive read so far, page order preserved. */
function importArchivePages(data: InfiniteData<{ items: readonly ImportArchive[] }> | undefined): readonly ImportArchive[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

function PathField({
  id, label, hint, value, onChange, onPick, pickLabel, placeholder, dataAttr,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onPick?: () => void;
  readonly pickLabel: string;
  readonly placeholder: string;
  readonly dataAttr: `data-${string}`;
}) {
  const { t } = useI18n();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-[12px] font-medium text-ink-soft">{label}</label>
      <div className="mt-1.5 flex gap-2">
        <input
          id={id}
          {...{ [dataAttr]: '' }}
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(event) => { onChange(event.target.value); }}
          className="min-w-0 flex-1 rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
        />
        {onPick !== undefined ? (
          <button type="button" className={`${SECONDARY_BUTTON} shrink-0`} onClick={onPick} data-plugin-import-pick-home>{pickLabel}</button>
        ) : null}
      </div>
      <p className="mt-1 text-[12px] leading-4 text-ink-faint">{hint}</p>
      <p className="sr-only">{t('cap.import.homeAria')}</p>
    </div>
  );
}

/**
 * The working directory the imported session will run in. It is the one field
 * the native destination adds, so it is drawn as one field: the workspaces
 * this Kiki already knows are offered as chips, and the same value is
 * typeable and browsable for a folder that is not registered yet.
 */
function WorkDirField({
  value, onChange, onPick, pickLabel,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onPick?: () => void;
  readonly pickLabel: string;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  // The same query the new-session page reads, so a workspace the reader already
  // uses is one click away and never has to be retyped.
  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
    retry: false,
  });
  const workspaces = workspacesQuery.data?.items ?? [];
  const trimmed = value.trim();
  return (
    <div className="min-w-0" data-plugin-import-workdir={trimmed === '' ? 'unset' : trimmed}>
      <label htmlFor="plugin-import-workdir" className="block text-[12px] font-medium text-ink-soft">
        {t('cap.import.workDirLabel')}
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="plugin-import-workdir"
          data-plugin-import-workdir-input
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={workspaces[0]?.root ?? 'C:\\code\\my-project'}
          onChange={(event) => { onChange(event.target.value); }}
          className="min-w-0 flex-1 rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
        />
        {onPick !== undefined ? (
          <button type="button" className={`${SECONDARY_BUTTON} shrink-0`} onClick={onPick} data-plugin-import-pick-workdir>
            {pickLabel}
          </button>
        ) : null}
      </div>
      {workspaces.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] text-ink-faint">{t('cap.import.workDirKnown')}</span>
          {workspaces.map((workspace) => {
            const active = workspace.root === trimmed;
            return (
              <button
                key={workspace.id}
                type="button"
                aria-pressed={active}
                data-plugin-import-workdir-option={workspace.root}
                onClick={() => { onChange(workspace.root); }}
                className={`inline-flex min-h-7 max-w-[46ch] items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink ${
                  active
                    ? 'border-accent bg-paper text-ink'
                    : 'border-hairline text-ink-soft hover:bg-ink/[0.05] hover:text-ink'
                }`}
              >
                <Icon name="folder" size={12} className="shrink-0 text-ink-faint" />
                <span className="min-w-0 truncate">{workspace.name || shortPath(workspace.root)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {/*
        The prompt replaces the explanatory line rather than sitting under it.
        Two grey sentences about one field read as two separate warnings, and a
        reader who has not chosen yet does not need the explanation as well.
      */}
      {trimmed === '' ? (
        <p className="mt-1.5 text-[12px] leading-4 text-ink-faint" data-plugin-import-workdir-required>
          {t('cap.import.workDirRequired')}
        </p>
      ) : (
        <p className="mt-1.5 text-[12px] leading-4 text-ink-faint">{t('cap.import.workDirHint')}</p>
      )}
    </div>
  );
}

/**
 * The target is a fact about this connection, so it is drawn as one: the home
 * the connected server writes to, and whether that server is this machine. A
 * remote connection says so, because a device's local path is not a remote
 * service's path and the reader must not have to guess which one they typed.
 */
function TargetHomeField({
  targetHome, targetLabel, remote,
}: {
  /** Undefined until the server has named it on a preview, job or archive. */
  readonly targetHome: string | undefined;
  readonly targetLabel: string;
  readonly remote: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="min-w-0" data-plugin-import-target={targetHome ?? 'unknown'}>
      <p className="text-[12px] font-medium text-ink-soft">{t('cap.import.targetLabel')}</p>
      <div className="mt-1.5 flex min-h-[34px] items-center gap-2 rounded-lg border border-hairline bg-ink/[0.03] px-3 py-1.5">
        <Icon name="folder" size={14} className="shrink-0 text-ink-faint" />
        {targetHome === undefined ? (
          // Nothing on the wire has named a target yet. Saying so is the honest
          // state; a guessed home would be a path the server never chose.
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint">{t('cap.import.targetUnknown')}</span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={`${targetLabel} · ${targetHome}`}>
            <span className="block truncate font-mono">{targetHome}</span>
          </span>
        )}
        <Tag tone={remote ? 'accent' : 'faint'}>{remote ? t('cap.import.targetRemote') : t('cap.import.targetLocal')}</Tag>
      </div>
      <p className="mt-1 text-[12px] leading-4 text-ink-faint">{t('cap.import.targetHint')}</p>
    </div>
  );
}

/**
 * The source file, one bounded page at a time. Each row is a title or the
 * external id, and the selection is what the preview reads — nothing is parsed
 * on this list, so it stays cheap on a large home.
 */
function DiscoveryList({
  pluginId, sourceId, home, destination, selected, previewOpen, onSelect, onPreview,
}: {
  readonly pluginId: string;
  readonly sourceId: string;
  readonly home: string;
  /** The aim of this read, or undefined when it is not ready to be sent yet. */
  readonly destination: ImportDestination | undefined;
  readonly selected: string | undefined;
  /** A preview is on screen, so the rows fold away beside it. */
  readonly previewOpen: boolean;
  readonly onSelect: (entry: { externalId: string; title: string } | undefined) => void;
  readonly onPreview: (preview: ImportPreview | null) => void;
}) {
  const { t } = useI18n();
  const { client, scopeId } = useConnection();
  const api = importsApi(client);
  // Paging is a stack of cursors, not a jump: the reader has already seen the
  // page before it, so "next" is a step and "back to the newest" resets the
  // stack. The server owns the order, so nothing here sorts or filters.
  const [depth, setDepth] = useState(0);
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const [issue, setIssue] = useState<string | null>(null);
  useEffect(() => { setDepth(0); setCursors([]); setIssue(null); }, [home, sourceId]);

  const page = useQuery({
    queryKey: importKeys.discovery(scopeId, pluginId, sourceId, `${home}#${cursors.join('>')}`),
    queryFn: async () => api.discover({
      pluginId, sourceId, home, ...(depth === 0 ? {} : { cursor: cursors.at(-1) as string }),
    }),
    enabled: home !== '',
    staleTime: 30_000,
    retry: false,
  });
  const entries = page.data?.entries ?? [];
  const next = page.data?.cursor;
  const more = next !== null && next !== undefined;
  return (
    <div className="min-w-0" data-plugin-import-discovery={sourceKey(pluginId, sourceId)}>
      <div className="flex min-h-8 items-center gap-2">
        <h3 className="text-[12px] font-medium text-ink-soft">{t('cap.import.filesTitle')}</h3>
        {entries.length > 0 ? <span className="text-[12px] tabular-nums text-ink-faint">{entries.length}</span> : null}
        <span className="ms-auto flex items-center gap-1">
          {depth > 0 ? (
            <button type="button" className={QUIET_BUTTON} data-plugin-import-first-page
              onClick={() => { setDepth(0); setCursors([]); setIssue(null); }}>
              {t('cap.import.firstPage')}
            </button>
          ) : null}
          {more ? (
            <button type="button" className={QUIET_BUTTON} data-plugin-import-next-page
              onClick={() => { setCursors((current) => [...current, next]); setDepth((current) => current + 1); setIssue(null); }}>
              {t('cap.import.nextPage')}
            </button>
          ) : null}
          {page.isFetching ? <Spinner label={t('cap.import.loadingFiles')} size={12} /> : null}
        </span>
      </div>
      {issue !== null ? <p role="alert" className="mt-1 text-[12px] text-danger">{issue}</p> : null}
      {page.isPending ? (
        <p className="py-2 text-[13px] text-ink-faint" role="status">{t('cap.import.loadingFiles')}</p>
      ) : page.isError ? (
        <div className="space-y-2 py-2">
          <InlineError error={page.error} />
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { void page.refetch(); }}>{t('common.retry')}</button>
        </div>
      ) : previewOpen ? (
        // The chosen row stays as the anchor for the preview below it.
        <ul className="mt-1 divide-y divide-hairline border-y border-hairline">
          {entries.filter((entry) => entry.externalId === selected).map((entry) => (
            <li key={entry.externalId} data-plugin-import-file={entry.externalId} aria-current="true"
              className="flex min-h-11 min-w-0 items-center gap-3 rounded-md bg-paper px-2 py-1.5 shadow-[var(--kiki-sheet-shadow)]">
              <Icon name="file" size={14} className="shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{entry.title || shortSourceId(entry.externalId)}</span>
            </li>
          ))}
        </ul>
      ) : entries.length === 0 ? (
        <div className="py-2" data-plugin-import-no-files>
          <EmptyNote title={t('cap.import.noFilesTitle')} body={t('cap.import.noFilesBody', { home: homeName(home) })} />
        </div>
      ) : (
        <ul className="mt-1 divide-y divide-hairline border-y border-hairline">
          {entries.map((entry) => (
            <li key={entry.externalId}>
              <button
                type="button"
                data-plugin-import-file={entry.externalId}
                aria-current={selected === entry.externalId ? 'true' : undefined}
                onClick={() => { onSelect(entry); }}
                className={`flex w-full min-h-11 min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink ${
                  selected === entry.externalId ? 'bg-paper shadow-[var(--kiki-sheet-shadow)]' : 'hover:bg-ink/[0.04]'
                }`}
              >
                <Icon name="file" size={14} className="shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{entry.title || shortSourceId(entry.externalId)}</span>
                {entry.title !== '' ? (
                  <span className="hidden min-w-0 max-w-[45%] truncate font-mono text-[11px] text-ink-faint min-[560px]:block" title={entry.externalId}>
                    {shortSourceId(entry.externalId)}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected !== undefined ? <PreviewLoader pluginId={pluginId} sourceId={sourceId} home={home} destination={destination} externalId={selected} onPreview={onPreview} /> : null}
      {selected !== undefined && previewOpen ? (
        // The rows step aside once a choice has a consequence below, so the two
        // are read together instead of on opposite ends of a long page.
        <button type="button" className={`${QUIET_BUTTON} -ml-3 mt-1`} data-plugin-import-change-file
          onClick={() => { onSelect(undefined); onPreview(null); }}>
          <Icon name="arrowLeft" size={14} className="text-ink-faint" />
          {t('cap.import.changeFile')}
        </button>
      ) : null}
    </div>
  );
}

/** Loads the bounded preview for the chosen file. The sample never fills the page. */
function PreviewLoader({
  pluginId, sourceId, home, destination, externalId, onPreview,
}: {
  readonly pluginId: string;
  readonly sourceId: string;
  readonly home: string;
  /** Undefined until the reader has finished aiming the import. */
  readonly destination: ImportDestination | undefined;
  readonly externalId: string;
  readonly onPreview: (preview: ImportPreview) => void;
}) {
  const { t } = useI18n();
  const { client, scopeId } = useConnection();
  const api = importsApi(client);
  const query = useQuery({
    // The destination is part of this key: the same file aimed at a Kiki
    // session and at an archive is two different reads, and switching the aim
    // must re-probe rather than redraw the previous one's losses.
    queryKey: importKeys.preview(scopeId, `${sourceKey(pluginId, sourceId)}:${home}:${externalId}`, destinationKey(destination)),
    queryFn: async () => api.preview({
      pluginId, sourceId, home, externalId,
      ...(destination === undefined ? {} : { destination }),
    }),
    enabled: destination !== undefined,
    staleTime: 0,
    retry: false,
  });
  useEffect(() => { if (query.data !== undefined) onPreview(query.data); }, [query.data, onPreview]);
  if (query.isError) {
    return <div className="mt-2 space-y-2"><InlineError error={query.error} />
      <button type="button" className={SECONDARY_BUTTON} onClick={() => { void query.refetch(); }}>{t('common.retry')}</button>
    </div>;
  }
  if (query.isPending) {
    return (
      <p className="mt-2 flex items-center gap-2 text-[12px] text-ink-faint" role="status" data-plugin-import-preview-loading>
        <Spinner label={t('cap.import.previewLoading')} size={12} />{t('cap.import.previewLoading')}
      </p>
    );
  }
  return null;
}

/**
 * The consequence, before the action: what the parser preserved, what it will
 * not carry, and a bounded sample of what the archive will read like. The
 * primary action is one click — the consent is this panel, not a second modal.
 */
function ImportPreviewPanel({
  preview, targetLabel, starting, onCancel, onStart,
}: {
  readonly preview: ImportPreview;
  readonly targetLabel: string;
  readonly starting: boolean;
  readonly onCancel: () => void;
  readonly onStart: () => void;
}) {
  const { t } = useI18n();
  const losses = preview.losses.length > 0 ? preview.losses : preview.probe.losses;
  const total = lossCount(losses);
  const native = isNativeDestination(preview.destination);
  const workDir = nativeWorkDir(preview.destination);
  return (
    <section
      id="plugin-import-preview"
      data-plugin-import-preview={preview.id}
      data-plugin-import-coverage={preview.coverage}
      data-plugin-import-probe={preview.probe.status}
      data-plugin-import-preview-kind={native ? 'native-session' : 'archive'}
      className="anim-enter min-w-0 space-y-3 rounded-xl border border-hairline bg-panel p-4"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        {/* The title wraps rather than truncates: it is the one thing the
            reader has to recognise, and at 390 the two tags take the row. */}
        <h2 className="w-full min-w-0 text-[14px] font-medium leading-5 text-ink min-[560px]:w-auto min-[560px]:flex-1">{preview.probe.title || t('cap.import.untitled')}</h2>
        <Tag tone={preview.probe.status === 'preserved' ? 'success' : preview.probe.status === 'partial' ? 'warn' : 'danger'}>
          {t(probeStateKey(preview.probe.status))}
        </Tag>
        <Tag>{preview.coverage === 'sample' ? t('cap.import.coverageSample') : t('cap.import.coverageComplete')}</Tag>
      </div>
      {/* Where it lands is the reader's own choice for a session and the
          server's fact for an archive; the sentence says which. */}
      <p className="text-[12px] leading-4 text-ink-faint" data-plugin-import-preview-where>
        {native
          ? t('cap.import.previewSessionTarget', { dir: workDir ?? '' })
          : t('cap.import.previewTarget', { home: preview.targetHome, server: targetLabel })}
      </p>
      {/*
        The host's own reuse receipt. For a session it names the conversation
        that already exists for this source and revision in this directory, so
        the reader knows the import will extend that one rather than fork a
        second copy of the same history.
      */}
      {/*
        Each receipt belongs to the aim it is about. Under a session read the
        archive's existence is a different fact and would send the reader
        looking for a record they did not ask for, so only the one that changes
        what starting this import will do is shown.
      */}
      {native ? (
        preview.existingSessionId !== null && preview.existingSessionId !== undefined ? (
          <p className="text-[12px] leading-4 text-amber-ink" data-plugin-import-existing-session>
            {t('cap.import.alreadyImportedSession', { dir: workDir ?? '' })}
          </p>
        ) : null
      ) : preview.existingArchiveId !== null ? (
        <p className="text-[12px] leading-4 text-amber-ink" data-plugin-import-existing>
          {t('cap.import.alreadyImported', { revision: shortDigest(preview.existingRevision) })}
        </p>
      ) : null}
      {total > 0 ? (
        <div data-plugin-import-losses className="space-y-1">
          <p className="text-[12px] font-medium text-ink-soft">{t('cap.import.lossesTitle', { count: total })}</p>
          <ul className="space-y-0.5">
            {losses.map((loss) => (
              <li key={loss.code} data-plugin-import-loss={loss.code} className="flex min-w-0 items-baseline gap-2 text-[12px] leading-4 text-ink-soft">
                <span className="shrink-0 tabular-nums text-ink-faint">{loss.count}</span>
                <span className="min-w-0 flex-1">{loss.detail || loss.code}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[12px] leading-4 text-ink-soft" data-plugin-import-no-losses>{t('cap.import.noLosses')}</p>
      )}
      <PreviewSample preview={preview} />
      <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
        {/* One short line, not a paragraph. For an archive it is the reason the
            result cannot be continued; for a session it is the one honest
            limit — the conversation's old tool calls and system text arrive as
            history, not as this Kiki's permissions. */}
        <p className="min-w-0 flex-1 text-[12px] leading-4 text-ink-faint" data-plugin-import-preview-note>
          {native ? t('cap.import.previewSessionNote') : t('cap.import.previewNote')}
        </p>
        <button type="button" className={SECONDARY_BUTTON} disabled={starting} onClick={onCancel}>{t('common.cancel')}</button>
        <button type="button" className={PRIMARY_BUTTON} disabled={starting} data-plugin-import-start onClick={onStart} aria-busy={starting}>
          {starting ? <Spinner label={t('cap.import.starting')} size={12} /> : null}
          {starting ? t('cap.import.starting') : native ? t('cap.import.startSession') : t('cap.import.start')}
        </button>
      </div>
    </section>
  );
}

/** A bounded sample, drawn as flat rows, with the coverage word already above it. */
function PreviewSample({ preview }: { readonly preview: ImportPreview }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const sample = preview.records;
  return (
    <div className="min-w-0" data-plugin-import-sample>
      <button
        type="button"
        className="flex min-h-8 items-center gap-1.5 rounded-md px-1 text-[12px] font-medium text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        aria-expanded={open}
        data-plugin-import-sample-toggle
        onClick={() => { setOpen((value) => !value); }}
      >
        <span aria-hidden className={`flex text-ink-faint transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>
          <Icon name="chevron" size={12} />
        </span>
        {t('cap.import.sampleTitle', { count: sample.length })}
      </button>
      {open ? (
        <ol className="mt-1 space-y-2 border-l border-hairline pl-3">
          {/* `id` + `part` is not unique: one record's body can arrive in
              several segments. The position in the sample disambiguates. */}
          {sample.map((record, index) => (
            <li key={`${record.id}-${record.part}-${index}`} className="min-w-0 space-y-0.5">
              <p className="text-[11.5px] font-medium text-ink-faint">
                {t(recordRoleKey(record.role))}
                {record.toolName !== undefined ? <span className="font-mono"> · {record.toolName}</span> : null}
              </p>
              {record.text !== undefined && record.text !== '' ? (
                <p className="line-clamp-3 break-words whitespace-pre-wrap text-[12.5px] leading-[1.5] text-ink-soft">{record.text}</p>
              ) : null}
            </li>
          ))}
          {sample.length === 0 ? <li className="text-[12px] text-ink-faint">{t('cap.import.sampleEmpty')}</li> : null}
        </ol>
      ) : null}
    </div>
  );
}

/**
 * One job row: the host's own state, real progress, and the two actions that
 * state allows. `interrupted` is a resumable stop, not a failure to explain —
 * it gets the same resume action a cancelled job gets, because re-running a
 * read-only parse is exactly what the host allows.
 */
function JobRow({
  job, remote, onOpenArchive, onOpenSession, onChanged,
}: {
  readonly job: ImportJob;
  /** A remote peer's jobs are read here; the peer's own window commands them. */
  readonly remote: boolean;
  readonly onOpenArchive: (archiveId: string) => void;
  /** Absent when this host has no session route; the row then shows its result. */
  readonly onOpenSession?: (sessionId: string) => void;
  readonly onChanged: () => void;
}) {
  const { t, tp, locale } = useI18n();
  const { client } = useConnection();
  const api = importsApi(client);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const progress = importProgress(job);
  const active = isJobActive(job);
  const resumable = UNFINISHED_JOB_STATES.has(job.status);
  // The host writes `sessionId` only when the session was committed, so this is
  // the fact that the conversation is really there to be continued.
  const sessionId = nativeSessionId(job);
  const workDir = nativeWorkDir(job.destination);

  const act = async (call: 'cancel' | 'resume') => {
    setBusy(true);
    setFailure(null);
    try {
      if (call === 'cancel') await api.cancel(job.id);
      else await api.resume(job.id);
      onChanged();
    } catch (error) {
      setFailure(errorText(locale, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="min-w-0 py-2.5" data-plugin-import-job={job.id} data-plugin-import-job-state={job.status}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{job.title || t('cap.import.untitled')}</span>
        <Tag tone={job.status === 'completed' ? 'success' : job.status === 'failed' ? 'danger' : resumable ? 'warn' : active ? 'accent' : 'faint'}>
          {t(jobStateKey(job.status))}
        </Tag>
      </div>
      <p className="mt-0.5 min-w-0 truncate font-mono text-[11px] text-ink-faint"
        title={`${job.selection.externalId}
${job.sourceHome} → ${workDir ?? job.targetHome}`}>
        {/* The external id is the discriminator: two imports of the same title
            from different files are different jobs, and the row has to say so.
            A session import ends at the directory it runs in, not at a home. */}
        <span className="min-[720px]:hidden">{shortSourceId(job.selection.externalId)} · </span>
        {homeName(job.sourceHome)} → {workDir ?? job.targetHome}
      </p>
      {active ? (
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <div
            role="progressbar"
            aria-label={t('cap.import.progress', { title: job.title })}
            aria-valuemin={0}
            aria-valuemax={progress?.total ?? 0}
            aria-valuenow={progress?.value ?? 0}
            data-plugin-import-progress
            data-indeterminate={progress?.ratio === undefined ? 'true' : undefined}
            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-hairline"
          >
            <div
              className={`h-full rounded-full bg-ink-soft transition-[width] duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${progress?.ratio === undefined ? 'w-1/3 animate-pulse' : ''}`}
              style={progress?.ratio === undefined ? undefined : { width: `${Math.round(progress.ratio * 100)}%` }}
            />
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
            {progress?.ratio === undefined
              ? t('cap.import.readingBytes', { count: progress?.value ?? job.bytesRead })
              : t('cap.import.readingPercent', { percent: Math.round(progress.ratio * 100) })}
          </span>
        </div>
      ) : null}
      {job.status === 'failed' && job.error !== null ? (
        <p role="alert" className="mt-1 text-[12px] leading-4 text-danger" data-plugin-import-job-error>{job.error}</p>
      ) : null}
      {failure !== null ? <p role="alert" className="mt-1 text-[12px] text-danger">{failure}</p> : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {active && !remote ? (
          <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={() => { void act('cancel'); }} data-plugin-import-cancel={job.id}>
            {t('cap.import.cancel')}
          </button>
        ) : null}
        {resumable && !remote ? (
          <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={() => { void act('resume'); }} data-plugin-import-resume={job.id}>
            {t('cap.import.resume')}
          </button>
        ) : null}
        {/*
          A session import's result is a conversation, not a record, so the
          action that matters is the one that continues it. It is the primary
          weight here because it is the whole reason to choose this destination;
          the archive's own action stays a quiet link, as it always was.
        */}
        {sessionId !== undefined && onOpenSession !== undefined ? (
          <button type="button" className={PRIMARY_BUTTON} data-plugin-import-open-session={sessionId} onClick={() => { onOpenSession(sessionId); }}>
            {t('cap.import.openSession')}
          </button>
        ) : null}
        {job.archiveId !== null ? (
          <button type="button" className={QUIET_BUTTON} data-plugin-import-open={job.archiveId} onClick={() => { onOpenArchive(job.archiveId!); }}>
            {t('cap.import.openArchive')}
          </button>
        ) : null}
        {lossCount(job.losses) > 0 ? (
          <span className="text-[11px] text-ink-faint">{t('cap.import.jobLosses', { count: lossCount(job.losses) })}</span>
        ) : null}
        <span className="ms-auto text-[11px] tabular-nums text-ink-faint">{importCountsText(tp, job.records, job.pages)}</span>
      </div>
    </li>
  );
}

function ArchiveRow({ archive, onOpen }: { readonly archive: ImportArchive; readonly onOpen: () => void }) {
  const { t, tp } = useI18n();
  return (
    <li className="min-w-0 py-2.5" data-plugin-import-archive={archive.id} data-plugin-import-archive-state={archive.status}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <button
          type="button"
          className="min-w-0 flex-1 truncate rounded-sm py-0.5 text-left text-[13px] font-medium text-ink transition-colors hover:text-selected-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
          data-plugin-import-archive-open={archive.id}
          onClick={onOpen}
        >
          {archive.title || t('cap.import.untitled')}
        </button>
        <Tag tone={archive.status === 'preserved' ? 'success' : 'warn'}>{t(archiveStateKey(archive.status))}</Tag>
      </div>
      <p className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 text-[11px] text-ink-faint">
        <span className="min-w-0 truncate font-mono" title={`${archive.sourceId} · ${archive.externalId}`}>
          {archive.sourceId} · {shortSourceId(archive.externalId)}
        </span>
        <span className="shrink-0 tabular-nums">{importCountsText(tp, archive.records, archive.pages)}</span>
        {lossCount(archive.losses) > 0 ? (
          <span className="shrink-0">{t('cap.import.jobLosses', { count: lossCount(archive.losses) })}</span>
        ) : null}
      </p>
    </li>
  );
}
