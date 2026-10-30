/**
 * Local sessions — browse the Claude Code / Codex history already on this
 * machine and continue one of them in Kiki.
 *
 *   list     one engine at a time, newest first; each row names the session
 *            (title, else the last prompt), its folder and when it was last
 *            used. A row that cannot be continued says why, translated from
 *            the server's reason code, and stays previewable.
 *   preview  the bounded transcript the server returns. It is a sample, not
 *            a copy: `partial` and every warning are stated above it, so an
 *            excerpt never reads as the whole history. The preview is the
 *            in-page detail (`?localSession=`): the list stays mounted behind
 *            it, Back returns to it, and a deep link opens the same session.
 *   continue the one primary action. It attaches the vendor session to a
 *            Kiki session (sending nothing) and opens it; a session that was
 *            already attached opens the existing one (`created: false`).
 *
 * Nothing here copies history into Kiki; the first prompt in the opened
 * session resumes the vendor session through its engine.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { LocalSessionDetail, LocalSessionSummary } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import {
  folderName,
  localSessionName,
  localSessionSources,
  previewWarningKey,
  resumeReasonKey,
  type LocalSessionSource,
} from '../../lib/localSessions';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { DetailBack, DetailRailItem, DetailSplit } from '../overlays/DetailSplit';
import { useDetailParam } from '../overlays/useDetailParam';
import { RelativeTime } from '../RelativeTime';
import { useExecutorCatalogQuery } from '../settings/profileEditor/engines';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { segmentClass } from '../WorkspaceScopeControl';

const LIST_LIMIT = 100;

/** Codes the resume route documents; each gets wording that says what to do. */
const RESUME_ERROR_KEYS: Readonly<Record<number, 'localSessions.error.disabled' | 'localSessions.error.locked' | 'localSessions.error.missing' | 'localSessions.error.workspace'>> = {
  40925: 'localSessions.error.disabled',
  40933: 'localSessions.error.locked',
  40401: 'localSessions.error.missing',
  40404: 'localSessions.error.workspace',
};

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

function SourceTabs({
  sources,
  value,
  onChange,
}: {
  readonly sources: readonly LocalSessionSource[];
  readonly value: string;
  readonly onChange: (executorId: string) => void;
}) {
  const { t } = useI18n();
  if (sources.length < 2) return null;
  return (
    <div role="group" aria-label={t('localSessions.sourceAria')} data-local-sources
      className="flex w-fit items-center gap-0.5 rounded-[9px] border border-hairline bg-paper p-0.5">
      {sources.map((source) => (
        <button key={source.executorId} type="button" aria-pressed={source.executorId === value}
          data-local-source={source.executorId}
          onClick={() => { onChange(source.executorId); }}
          className={segmentClass(source.executorId === value, 'h-7 px-3 text-[13px]')}>
          {source.label}
        </button>
      ))}
    </div>
  );
}

function SessionRow({
  summary,
  selected,
  onSelect,
}: {
  readonly summary: LocalSessionSummary;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { t } = useI18n();
  const folder = folderName(summary.cwd);
  return (
    <li>
      <button
        type="button"
        data-local-session={summary.id}
        data-local-resumable={summary.resume.supported}
        data-detail-trigger={summary.id}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        className={`relative flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
          selected ? 'bg-paper shadow-[var(--kiki-sheet-shadow)]' : 'hover:bg-ink/[0.04]'}`}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-[13px] ${selected ? 'font-medium text-ink' : 'text-ink'}`}>
            {localSessionName(summary)}
          </span>
          <RelativeTime at={summary.updated_at} className="shrink-0 text-[11.5px] text-ink-faint tabular-nums" />
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-[12px] leading-4 text-ink-faint">
          {folder !== undefined ? <span className="min-w-0 truncate font-mono text-[11px]" title={summary.cwd}>{folder}</span> : null}
          {summary.parent_id !== undefined ? <span className="shrink-0">· {t('localSessions.branch')}</span> : null}
        </span>
        {!summary.resume.supported ? (
          <span data-local-unsupported={summary.resume.reason ?? 'unknown'} className="flex min-w-0 items-start gap-1 text-[12px] leading-4 text-amber-ink">
            <Icon name="hold" size={12} className="mt-[2px]" />
            <span className="min-w-0">{t(resumeReasonKey(summary.resume.reason))}</span>
          </span>
        ) : null}
      </button>
    </li>
  );
}

const ROLE_KEYS = {
  user: 'localSessions.role.user',
  assistant: 'localSessions.role.assistant',
  system: 'localSessions.role.system',
} as const;

/** Text worth showing for one message: text blocks verbatim, tools and images as a short tag. */
function messageLines(message: LocalSessionDetail['messages'][number], t: ReturnType<typeof useI18n>['t']): { text: string; tags: string[] } {
  const text: string[] = [];
  const tags: string[] = [];
  for (const block of message.blocks) {
    if (block.kind === 'text' && block.text !== undefined && block.text.trim() !== '') text.push(block.text);
    else if (block.kind === 'tool_call') tags.push(block.name ?? t('localSessions.block.tool'));
    else if (block.kind === 'image') tags.push(t('localSessions.block.image'));
  }
  return { text: text.join('\n\n'), tags: [...new Set(tags)] };
}

function Preview({
  executorId,
  summary,
}: {
  readonly executorId: string;
  readonly summary: LocalSessionSummary;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const detail = useQuery({
    queryKey: ['local-session', executorId, summary.id],
    queryFn: () => client.getLocalSession(executorId, summary.id),
    staleTime: 30_000,
    retry: false,
  });
  const warnings = detail.data?.warnings ?? [];
  const partial = detail.data?.summary.partial ?? summary.partial;
  const messages = detail.data?.messages ?? [];
  return (
    <div data-local-preview={summary.id} className="flex flex-col">
      <div className="shrink-0 space-y-1 border-b border-hairline px-1 pt-1 pb-3">
        <h3 data-detail-heading tabIndex={-1} className="truncate text-[14px] font-medium text-ink outline-none" title={localSessionName(summary)}>{localSessionName(summary)}</h3>
        {summary.cwd !== undefined ? <p className="truncate font-mono text-[11px] text-ink-faint" title={summary.cwd}>{summary.cwd}</p> : null}
        {partial || warnings.length > 0 ? (
          <div data-local-partial role="note" className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-4 text-amber-ink">
            <Icon name="partial" size={12} className="mt-[2px]" />
            <div className="min-w-0">
              <p>{t('localSessions.partial')}</p>
              {warnings.length > 0 ? (
                <ul className="mt-0.5 space-y-0.5 text-ink-soft">
                  {warnings.map((warning) => {
                    const key = previewWarningKey(warning);
                    return <li key={warning} data-local-warning={warning}>{key !== undefined ? t(key) : <span className="font-mono text-[11px]">{warning}</span>}</li>;
                  })}
                </ul>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      <div data-local-preview-body className="px-1 py-3">
        {detail.isPending ? <p className="text-[13px] text-ink-faint">{t('localSessions.previewLoading')}</p> : null}
        {detail.isError ? <p role="alert" className="text-[13px] text-danger">{t('localSessions.previewFailed', { detail: errorText(locale, detail.error) })}</p> : null}
        {detail.isSuccess && messages.length === 0 ? <p className="text-[13px] text-ink-soft">{t('localSessions.previewEmpty')}</p> : null}
        <ol className="space-y-3">
          {messages.map((message) => {
            const { text, tags } = messageLines(message, t);
            if (text === '' && tags.length === 0) return null;
            return (
              <li key={message.id} data-local-message={message.role} className="space-y-0.5">
                <p className="text-[11.5px] font-medium text-ink-faint">{t(ROLE_KEYS[message.role])}</p>
                {text !== '' ? (
                  <p className={`line-clamp-6 text-[13px] leading-[1.55] break-words whitespace-pre-wrap ${message.role === 'user' ? 'text-ink' : 'text-ink-soft'}`}>{text}</p>
                ) : null}
                {tags.length > 0 ? (
                  <p className="truncate font-mono text-[11px] text-ink-faint">{tags.join(' · ')}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

export function LocalSessionsDialog({
  initialExecutorId,
  onClose,
}: {
  /** Open on this engine's history when it has one. */
  readonly initialExecutorId?: string;
  readonly onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const navigate = useGuardedNavigate();
  const catalog = useExecutorCatalogQuery();
  const sources = useMemo(() => localSessionSources(catalog.data?.items ?? []), [catalog.data]);
  const [picked, setPicked] = useState<string | undefined>(initialExecutorId);
  const executorId = sources.some((source) => source.executorId === picked) ? picked! : sources[0]?.executorId;
  const directory = useQuery({
    queryKey: ['local-sessions', executorId],
    queryFn: () => client.listLocalSessions(executorId!, LIST_LIMIT),
    enabled: executorId !== undefined,
    staleTime: 30_000,
    retry: false,
  });
  const items = directory.data?.items ?? [];
  const detail = useDetailParam('localSession');
  const selected = items.find((item) => item.id === detail.selected);
  // A param naming nothing (stale link, another engine's id) falls back to
  // the list once the directory has answered.
  useEffect(() => {
    if (detail.selected !== null && directory.isSuccess && selected === undefined) detail.close();
  }, [detail, directory.isSuccess, selected]);
  useEffect(() => { detail.close(); }, [executorId]); // eslint-disable-line react-hooks/exhaustive-deps -- engine switch returns to the list
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resumeEnabled = directory.data?.resume_enabled !== false;
  const canContinue = selected !== undefined && selected.resume.supported && resumeEnabled && !resuming;

  const resume = async () => {
    if (!canContinue || executorId === undefined || selected === undefined) return;
    setResuming(true);
    setError(null);
    try {
      const result = await client.resumeLocalSession(executorId, selected.id, { source_home: selected.source_home });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      pushToast({ tone: 'success', text: t(result.created ? 'localSessions.attached' : 'localSessions.alreadyAttached') });
      onClose();
      void navigate(`/s/${encodeURIComponent(result.session_id)}`);
    } catch (cause) {
      const code = errorCode(cause);
      const key = code !== undefined ? RESUME_ERROR_KEYS[code] : undefined;
      setError(key !== undefined ? t(key) : t('localSessions.error.generic', { detail: errorText(locale, cause) }));
      setResuming(false);
    }
  };

  const title = t('localSessions.title');
  const listPane = (
    <>
      <header className="space-y-1 px-1 pt-1 pb-3">
        <h2 className="font-display text-[18px] font-semibold tracking-tight text-ink">{title}</h2>
        <p className="text-[12.5px] leading-5 text-ink-soft">{t('localSessions.intro')}</p>
      </header>
      {executorId !== undefined ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1 pb-3">
          <SourceTabs sources={sources} value={executorId} onChange={setPicked} />
          {directory.data !== undefined ? (
            <p data-local-root className="min-w-0 truncate font-mono text-[11px] text-ink-faint" title={directory.data.root}>{directory.data.root}</p>
          ) : null}
        </div>
      ) : null}
      <div data-local-list className="px-1 py-1">
        {catalog.isPending || (executorId !== undefined && directory.isPending) ? (
          <p className="px-3 py-2 text-[12.5px] text-ink-faint">{t('localSessions.loading')}</p>
        ) : null}
        {catalog.isSuccess && executorId === undefined ? (
          <div data-local-no-engine className="px-3 py-3">
            <p className="text-[13px] text-ink">{t('localSessions.noEngineTitle')}</p>
            <p className="mt-1 text-[12px] leading-4 text-ink-soft">{t('localSessions.noEngineBody')}</p>
          </div>
        ) : null}
        {directory.isError ? (
          <p role="alert" className="px-3 py-2 text-[12.5px] text-danger">{t('localSessions.listFailed', { detail: errorText(locale, directory.error) })}</p>
        ) : null}
        {directory.isSuccess && items.length === 0 ? (
          <div data-local-empty className="px-3 py-3">
            <p className="text-[13px] text-ink">{t(directory.data.exists ? 'localSessions.emptyTitle' : 'localSessions.missingTitle')}</p>
            <p className="mt-1 text-[12px] leading-4 text-ink-soft">{t('localSessions.emptyBody')}</p>
          </div>
        ) : null}
        <ul className="space-y-0.5">
          {items.map((item) => (
            <SessionRow key={item.id} summary={item} selected={item.id === selected?.id}
              onSelect={() => { detail.open(item.id); setError(null); }} />
          ))}
        </ul>
      </div>
      {directory.data !== undefined && (directory.data.truncated || directory.data.unreadable_files > 0) ? (
        <p data-local-truncated className="border-t border-hairline px-1 pt-2 text-[11.5px] leading-4 text-ink-faint">
          {directory.data.truncated ? t('localSessions.truncated', { count: items.length }) : null}
          {directory.data.truncated && directory.data.unreadable_files > 0 ? ' · ' : null}
          {directory.data.unreadable_files > 0 ? t('localSessions.unreadable', { count: directory.data.unreadable_files }) : null}
        </p>
      ) : null}
      <div className="flex justify-end pt-3">
        <button type="button" className={SECONDARY_BUTTON} disabled={resuming} onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </>
  );

  return (
    <div data-local-sessions className="w-full max-w-3xl rounded-2xl border border-hairline bg-panel p-4 shadow-[var(--kiki-sheet-shadow)]">
      <DetailSplit
        selected={selected?.id ?? null}
        label={title}
        list={listPane}
        rail={
          <ul className="space-y-px">
            {items.map((item) => (
              <DetailRailItem key={item.id} itemKey={item.id} current={item.id === selected?.id}
                label={localSessionName(item)} hint={folderName(item.cwd)}
                onSelect={() => { detail.open(item.id); setError(null); }} />
            ))}
          </ul>
        }
        detail={selected !== undefined && executorId !== undefined ? (
          <div className="flex flex-col gap-3">
            <DetailBack label={title} onClick={() => { detail.close(); }} data={{ 'data-local-back': '' }} />
            <Preview key={`${executorId}:${selected.id}`} executorId={executorId} summary={selected} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-hairline pt-3">
              <div className="min-w-0 flex-1 text-[12px] leading-4">
                {error !== null ? <p role="alert" data-local-error className="text-danger">{error}</p>
                  : !resumeEnabled ? <p data-local-disabled className="text-ink-soft">{t('localSessions.resumeDisabled')}</p>
                    : !selected.resume.supported ? <p className="text-ink-faint">{t('localSessions.cannotContinue')}</p>
                      : <p className="text-ink-faint">{t('localSessions.continueHint')}</p>}
              </div>
              <button type="button" data-local-continue className={`${PRIMARY_BUTTON} inline-flex items-center gap-1.5`}
                disabled={!canContinue} aria-busy={resuming} onClick={() => void resume()}>
                {resuming ? <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none" /> : null}
                {resuming ? t('localSessions.continuing') : t('localSessions.continue')}
              </button>
            </div>
          </div>
        ) : null}
      />
    </div>
  );
}
