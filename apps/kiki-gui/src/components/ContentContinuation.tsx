/** Reading progress for the displayed field; the controller owns continuation and cancellation. */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { contentOriginalFileId, type ContentRef } from '@kiki/transcript';
import type { HttpRestMediaOptions, HttpRestMediaSink } from '@kiki/klient';
import type { I18nKey } from '@kiki/session-core/i18n';
import { ContentRangeText } from './ContentRangeText';

import { useHost } from '../host';
import { browserSaveSink, bufferedSaveSink } from '../host/saveSink';
import { useI18n } from '../i18n';
import { useOptionalConnection } from '../state/connection';
import { useAutomaticContentRead, useContentContinuation, useTranscriptController, useTranscriptTarget, type ContentBodySource } from './transcriptDetail';

/** Field-path roots each reading area consumes, stable so the hook can memo. */
export const MESSAGE_TEXT_ROOTS: readonly string[] = ['text', 'prompt'];
export const OUTPUT_ROOTS: readonly string[] = ['output', 'error'];
export const INPUT_ROOTS: readonly string[] = ['input'];
export const INPUT_TEXT_ROOTS: readonly string[] = ['inputText'];
export const DISPLAY_ROOTS: readonly string[] = ['display'];
export const TASK_OUTPUT_ROOTS: readonly string[] = ['outputTail'];
export const SHELL_COMMAND_ROOTS: readonly string[] = ['input', 'inputText'];
/** Edit-style bodies render as a diff, built from the display or the args. */
export const EDIT_ROOTS: readonly string[] = ['display', 'input', 'inputText'];
/** Structural refs of a turn: its steps, and one step's own frames. */
export const TURN_STEP_ROOTS: readonly string[] = ['steps'];

/**
 * The frame a tool or shell block was projected from. The projection keeps the
 * frame's turn on every block, its own id and step on frame-derived ones, and
 * the task id only when the displayed output really is that task's tail — so a
 * reading area asks for exactly the entity it renders, and never points a
 * frame's control at a task body (or the reverse).
 */
export interface FrameIdentity {
  readonly frameId?: string;
  readonly stepId?: string;
}

export function frameContentSource(
  block: { readonly turnId?: string } & FrameIdentity,
): ContentBodySource | undefined {
  if (block.frameId === undefined) return undefined;
  return { kind: 'frame', id: block.frameId, turnId: block.turnId, stepId: block.stepId };
}

/** The share of a text field already read, in the contract's own unit. */
export function contentRefProgress(
  ref: ContentRef,
  t: (key: I18nKey, params?: Readonly<Record<string, string | number>>) => string,
): string {
  if (ref.kind === 'text') {
    const percent = ref.total === 0 ? 0 : Math.floor((ref.offset / ref.total) * 100);
    return t('transcript.content.percent', { percent: percent < 1 ? '<1' : String(percent) });
  }
  return t('transcript.content.items', { shown: ref.offset, total: ref.total });
}

/** One continuation line, wherever it sits: a body's tail or the session's own. */
export const CONTINUATION_ROW_CLASS = 'flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-5';

export const CONTINUATION_ACTION_CLASS =
  'inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-md px-2 font-medium text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-80 disabled:hover:no-underline motion-reduce:transition-none';

export type ContinuationState = 'idle' | 'loading' | 'error';

export interface ContinuationRowProps {
  /** What this row reads: a body's field, or the structure/collection it is. */
  readonly kind: string;
  readonly state: ContinuationState;
  /** Already-translated progress, in the contract's own unit. */
  readonly progress: string;
  /** Already-translated failure copy, shown in place while the body stays. */
  readonly error: string;
  /** Names the field for screen readers. */
  readonly label: string;
  readonly onRequest: () => void;
  /**
   * Offered only while the row is in error, and only when the field has an
   * original file behind it: the same session, agent and ref the row reads.
   */
  readonly original?: ReactNode;
  readonly className?: string;
}

export function ContinuationRow({
  kind,
  state,
  progress,
  error,
  label,
  onRequest,
  original,
  className = '',
}: ContinuationRowProps): ReactNode {
  const { t } = useI18n();
  const loading = state === 'loading';
  return (
    <div
      data-content-continuation={state}
      data-continuation-kind={kind}
      className={`${CONTINUATION_ROW_CLASS} ${className}`.trimEnd()}
    >
      <span data-content-continuation-progress className="min-w-0 truncate text-ink-faint">
        {progress}
      </span>
      {state === 'error' ? (
        <span role="alert" className="text-danger">
          {error}
        </span>
      ) : null}
      {state === 'error' && original !== undefined ? original : null}
      <button
        type="button"
        data-content-continuation-action
        onClick={onRequest}
        disabled={loading}
        aria-busy={loading}
        aria-label={t('transcript.content.actionAria', { field: label })}
        className={CONTINUATION_ACTION_CLASS}
      >
        {loading ? (
          <>
            <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" />
            {t('transcript.content.loading')}
          </>
        ) : state === 'error' ? t('transcript.detail.retry') : t('transcript.content.more')}
      </button>
    </div>
  );
}

/**
 * The whole field, as a file, for the few fields the server keeps an original
 * for. Offered only next to a failed read — a successful row is completed by
 * reading, not by downloading — and only when this ref names a field that has
 * one, so a body with no original renders nothing here.
 *
 * A download is bound to the row that asked for it, and to the server home it
 * was started from: another session, agent, ref, client or space under the same
 * row cancels it, so a late save can never land in whatever the reader has
 * moved to. Cancellation and failure both end in a state the reader can retry
 * from; a download that had already begun closing its sink is left alone,
 * because the host decides what closing commits.
 */
function ContentOriginalDownload({ ref, label, callerAgentId }: { readonly ref: ContentRef; readonly label: string; readonly callerAgentId?: string }): ReactNode {
  const { t } = useI18n();
  const host = useHost();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const workspaceTarget = useTranscriptTarget();
  const target = useMemo(() => workspaceTarget === undefined || callerAgentId === undefined ? workspaceTarget : { ...workspaceTarget, agentId: callerAgentId }, [workspaceTarget, callerAgentId]);
  const [transfer, setTransfer] = useState<'idle' | 'downloading' | 'saving' | 'saved' | 'failed'>('idle');
  const controllerRef = useRef<AbortController | null>(null);
  // What the in-flight download belongs to, so a cancellation can name it and a
  // late result can tell that its row is gone.
  const owned = useRef(false);
  // The server names the original after the field it holds (output.txt /
  // output.json, input.txt / input.json); a text ref is a string, an object or
  // array ref is JSON. The receipt carries the same name when the read lands.
  const field = ref.path[0] === 'outputTail' ? 'output' : String(ref.path[0] ?? 'content');
  const name = `${field}.${ref.kind === 'text' ? 'txt' : 'json'}`;
  // What the in-flight download belongs to: the session and agent of the ref,
  // the field itself, and the server home it is read from. The home is named by
  // the connection's own scope fields, so a space or connection switch ends the
  // download; `client` is a separate dependency below because a new home can
  // carry the same scope names, and the row must still tell the two apart.
  const identity = JSON.stringify([
    target?.sessionId ?? '', target?.agentId ?? '', ref.source.kind, ref.source.id,
    ref.source.turnId ?? '', ref.source.stepId ?? '', ref.path, ref.revision,
  ]) + ` ${connection?.connectionId ?? ''} ${connection?.spaceKey ?? ''} ${connection?.scopeId ?? ''}`;
  useEffect(() => () => {
    // Leaving the row — another session, agent, ref or server home under it, or
    // the row itself going away — ends the download and hands the button back
    // ready. A result that arrives afterwards cannot land here: `owned` is
    // false, so `stillMine()` is. (On unmount React ignores the state update;
    // the abort is the part that matters there.)
    owned.current = false;
    const controller = controllerRef.current;
    controllerRef.current = null;
    controller?.abort();
    setTransfer((value) => (value === 'downloading' || value === 'saving' ? 'idle' : value));
  }, [identity, client]);

  if (client === undefined || target === undefined || contentOriginalFileId(target.agentId, ref) === undefined) return null;
  const download = async (): Promise<void> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    owned.current = true;
    let sink: import('../host/host').HostSaveSink | null = null;
    let closed = false;
    setTransfer('downloading');
    // A result only reaches the row that is still on screen and still waiting
    // for this download; a cancelled or replaced one reports nothing.
    const stillMine = (): boolean => owned.current && controllerRef.current === controller && !controller.signal.aborted;
    try {
      sink = host.openSaveSink !== undefined ? await host.openSaveSink(name)
        : host.saveBlob !== undefined ? bufferedSaveSink((blob) => host.saveBlob!(blob, name)) : await browserSaveSink(name);
      if (sink === null) { if (stillMine()) setTransfer('idle'); return; }
      controller.signal.throwIfAborted();
      const writer = sink;
      const consume: HttpRestMediaSink = async (chunk) => { await writer.write(chunk); };
      const options: HttpRestMediaOptions = { signal: controller.signal, timeoutMs: 0 };
      // The client is the one this press was rendered against, not whatever the
      // connection holds by the time the save picker returns: picking a
      // destination can outlast a home switch, and a download the reader
      // started on one home must not be sent to another. The effect above ends
      // the request when that client does change, so the old one is already
      // aborted by the time this line runs.
      await client.downloadTranscriptContent(target.sessionId, target.agentId, ref, consume, options);
      controller.signal.throwIfAborted();
      if (stillMine()) setTransfer('saving');
      // Closing is the point of no return: once the host has committed the
      // bytes there is nothing left to cancel, and a failure below that point
      // must not abandon a sink the host may have already written.
      closed = true;
      const saved = await sink.close();
      if (stillMine()) setTransfer(saved ? 'saved' : 'idle');
    } catch {
      if (!closed) await sink?.abort().catch(() => {});
      // A cancelled download is not a failure: the row goes back to ready, and
      // a genuine refusal is a state the reader can press again.
      if (stillMine()) setTransfer('failed');
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        if (owned.current) setTransfer((value) => (value === 'downloading' || value === 'saving' ? 'idle' : value));
      }
    }
  };
  const busy = transfer === 'downloading' || transfer === 'saving';
  const cancel = (): void => {
    // Cancelling is not a failure and not a save: the row goes back to ready
    // now, and the abandoned stream settles on its own afterwards.
    const controller = controllerRef.current;
    controllerRef.current = null;
    controller?.abort();
    setTransfer((value) => (value === 'downloading' || value === 'saving' ? 'idle' : value));
  };
  return (
    <span data-content-original={transfer} className="flex items-center gap-1.5">
      <button
        type="button"
        data-content-original-action
        onClick={() => { void download(); }}
        disabled={busy}
        aria-busy={busy}
        aria-label={t('transcript.content.originalAria', { field: label })}
        className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 font-medium text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-80 disabled:hover:no-underline motion-reduce:transition-none"
      >
        {busy ? <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" /> : null}
        {transfer === 'failed' ? t('transcript.content.originalRetry')
          : transfer === 'saved' ? t('transcript.content.originalSaved')
            : busy ? t('transcript.content.originalSaving') : t('transcript.content.original')}
      </button>
      {busy ? (
        <button
          type="button"
          data-content-original-cancel
          onClick={cancel}
          className="inline-flex min-h-7 items-center rounded-md px-2 font-medium text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink motion-reduce:transition-none"
        >
          {t('transcript.content.originalCancel')}
        </button>
      ) : null}
    </span>
  );
}

export function ContentContinuation({
  source,
  roots,
  label,
  callerAgentId,
  headingPresent = false,
  className = '',
}: {
  headingPresent?: boolean;
  callerAgentId?: string;
  /** The canonical entity this body was rendered from; undefined = no reader. */
  source: ContentBodySource | undefined;
  roots: readonly string[];
  /** The reading area's own name, e.g. Output / Arguments / Command. */
  label: string;
  className?: string;
}): ReactNode {
  const { t, tp } = useI18n();
  const { pending, statusOf, request } = useContentContinuation(source, roots, callerAgentId);
  const controller = useTranscriptController();
  const target = useTranscriptTarget();
  const agentId = callerAgentId ?? target?.agentId;
  const automatic = controller !== undefined;
  const retry = useAutomaticContentRead(source, roots, callerAgentId);
  const ranges = controller !== undefined && agentId !== undefined ? pending.filter((ref) => controller.isContentRange(agentId, ref)) : [];
  const ref = pending.find((candidate) => !ranges.includes(candidate));
  if (ref === undefined && ranges.length === 0) return null;
  const progress = ref === undefined ? '' : contentRefProgress(ref, t);
  return <>
    {ranges.map((range) => <div key={JSON.stringify([range.source, range.path, range.revision])} className={className}><ContentRangeText contentRef={range} callerAgentId={callerAgentId} headingPresent={headingPresent && range.path.length === 1} label={range.path.length === 1 ? label : `${label} · ${range.path.slice(1).join('.')}`} /><ContentOriginalDownload ref={range} label={label} callerAgentId={callerAgentId} /></div>)}
    {ref === undefined ? null : <ContinuationRow
      kind="content"
      state={statusOf(ref)?.status ?? (automatic ? 'loading' : 'idle')}
      progress={pending.length > 1
        ? `${label} · ${progress} · ${tp('transcript.content.morePending', pending.length - 1)}`
        : `${label} · ${progress}`}
      error={t('transcript.content.failed')}
      label={label}
      onRequest={() => { if (automatic) retry(); else request(ref); }}
      original={<ContentOriginalDownload ref={ref} label={label} callerAgentId={callerAgentId} />}
      className={className}
    />}
  </>;
}
