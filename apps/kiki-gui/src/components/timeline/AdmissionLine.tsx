/**
 * Durable admission, told on the message it belongs to.
 *
 * Every saved-session send passes through server admission, and most leave it
 * within a moment. That pass is the ordinary "sending" state of the bubble and
 * nothing more. Only a restore still running after `RESTORE_NOTICE_MS` earns a
 * quiet line under the bubble (loading the session, or its queue place), with
 * cancel offered on hover or focus. A message the server holds or could not
 * admit keeps its decision on the same line: retry (or send a duplicate
 * separately) and cancel.
 *
 * Progress is read only while that slow line is on screen. A fast admission
 * needs no read at all: the canonical transcript row arriving over the live
 * stream replaces the bubble's pending state.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { MessageContent, PromptItem } from '@kiki/protocol';
import { appendLocalUserMessage, createViewState, projectMessageContent, type Block, type SessionController } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { pushToast } from '../../lib/toasts';
import { Icon, Spinner } from '../icons';

/** A restore shorter than this reads as an ordinary send. */
export const RESTORE_NOTICE_MS = 4000;
/** Progress read cadence while a slow restore is shown. */
export const RESTORE_POLL_MS = 3000;

export type AdmissionKind = 'loading' | 'queued' | 'switching' | 'held' | 'failed' | 'duplicate';

export interface AdmissionView {
  readonly promptId: string;
  readonly kind: AdmissionKind;
  readonly position?: number;
}

interface AdmissionScopeValue {
  readonly views: ReadonlyMap<string, AdmissionView>;
  readonly busyId?: string;
  readonly onRetry?: (promptId: string) => void;
  readonly onCancel?: (promptId: string) => void;
}

const EMPTY_VIEWS: ReadonlyMap<string, AdmissionView> = new Map();
const NO_RECORDS: readonly PromptItem[] = [];
const AdmissionContext = createContext<AdmissionScopeValue>({ views: EMPTY_VIEWS });

/** Prompt ids the canonical transcript already owns (no pending echo). */
function settledPromptIds(blocks: readonly Block[]): Set<string> {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.kind === 'user' && block.promptId !== undefined && block.optimisticStatus === undefined) ids.add(block.promptId);
  }
  return ids;
}

/**
 * Which messages carry an admission line. A restore shows only once slow and
 * only until the transcript owns the prompt; held and failed always show.
 */
export function admissionViews(
  ingress: readonly PromptItem[],
  settled: ReadonlySet<string>,
  slow: ReadonlySet<string>,
): ReadonlyMap<string, AdmissionView> {
  const views = new Map<string, AdmissionView>();
  for (const item of ingress) {
    const promptId = item.prompt_id;
    if (item.admission === 'restoring') {
      if (settled.has(promptId) || !slow.has(promptId)) continue;
      const position = item.restore_progress?.queue_position;
      views.set(promptId, position === undefined ? { promptId, kind: 'loading' } : { promptId, kind: 'queued', position });
    } else if (item.admission === 'waiting_switch') {
      if (settled.has(promptId)) continue;
      views.set(promptId, { promptId, kind: 'switching' });
    } else if (item.admission === 'held') {
      views.set(promptId, { promptId, kind: item.admission_duplicate_of === undefined ? 'held' : 'duplicate' });
    } else if (item.admission === 'failed') {
      views.set(promptId, { promptId, kind: 'failed' });
    }
  }
  return views.size === 0 ? EMPTY_VIEWS : views;
}

/**
 * Saved messages the timeline has no row for yet (a restore or a held copy
 * seen after reopening the session) become the user's bubble, so the state
 * and its actions still sit on a message rather than in a banner.
 */
export function withAdmissionUserBlocks(blocks: readonly Block[], ingress: readonly PromptItem[] | undefined): readonly Block[] {
  if (ingress === undefined || ingress.length === 0) return blocks;
  const present = new Set<string>();
  for (const block of blocks) if (block.kind === 'user' && block.promptId !== undefined) present.add(block.promptId);
  const extra: Block[] = [];
  for (const item of ingress) {
    if (item.admission !== 'restoring' && item.admission !== 'waiting_switch' && item.admission !== 'held' && item.admission !== 'failed') continue;
    if (present.has(item.prompt_id)) continue;
    const projection = projectMessageContent(item.content);
    extra.push({
      kind: 'user',
      id: `admission-${item.prompt_id}`,
      promptId: item.prompt_id,
      text: projection.text,
      media: projection.media.length > 0 ? projection.media : undefined,
      createdAt: item.created_at,
      optimisticStatus: item.admission === 'restoring' || item.admission === 'waiting_switch' ? 'sending' : undefined,
    });
  }
  return extra.length === 0 ? blocks : [...blocks, ...extra];
}

/** A message the composer sent that no projection owns yet. */
export interface OptimisticSubmission {
  readonly id: string;
  readonly text: string;
  readonly content?: MessageContent[];
  readonly createdAt: string;
  readonly slow: boolean;
  readonly preserved: boolean;
  readonly retryable: boolean;
  readonly status: 'sending' | 'offline' | 'server';
}

/**
 * Show the composer's in-flight message as the user's bubble until the
 * timeline has a row for the same prompt id.
 */
export function withOptimisticUserBlock(
  blocks: readonly Block[],
  pending: OptimisticSubmission | undefined,
): readonly Block[] {
  if (pending === undefined || blocks.some(block => block.kind === 'user' && block.promptId === pending.id)) return blocks;
  const projected = appendLocalUserMessage(createViewState(pending.id), {
    userMessageId: pending.id, promptId: pending.id, text: pending.text, content: pending.content,
    createdAt: pending.createdAt, status: 'running',
  }).blocks;
  return [...blocks, ...projected.map((block): Block => block.kind !== 'user' ? block : {
    ...block, userMessageId: undefined, promptStatus: undefined,
    optimisticStatus: pending.status, optimisticSlow: pending.slow,
    optimisticPreserved: pending.preserved, optimisticRetryable: pending.retryable,
  })];
}

/**
 * Tracks how long each restore has run (the server's elapsed time when known,
 * else since this view first saw it) and flips it to "slow" at the threshold.
 */
function useSlowRestores(ingress: readonly PromptItem[]): ReadonlySet<string> {
  const firstSeen = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => Date.now());
  const restoring = ingress.filter((item) => item.admission === 'restoring');
  const seen = firstSeen.current;
  const live = new Set(restoring.map((item) => item.prompt_id));
  for (const id of seen.keys()) if (!live.has(id)) seen.delete(id);
  const startOf = (item: PromptItem) => {
    let start = seen.get(item.prompt_id);
    if (start === undefined) {
      start = Date.now() - (item.restore_progress?.elapsed_ms ?? 0);
      seen.set(item.prompt_id, start);
    }
    return start;
  };
  const slow = new Set<string>();
  let nextCrossing = Infinity;
  for (const item of restoring) {
    const due = startOf(item) + RESTORE_NOTICE_MS;
    if (due <= now) slow.add(item.prompt_id);
    else nextCrossing = Math.min(nextCrossing, due);
  }
  useEffect(() => {
    if (nextCrossing === Infinity) return;
    const timer = setTimeout(() => { setNow(Date.now()); }, Math.max(0, nextCrossing - Date.now()));
    return () => { clearTimeout(timer); };
  }, [nextCrossing]);
  return slow;
}

/**
 * Admission lines for one timeline, plus the reads and actions behind them.
 * `retryPending` lets the composer's own in-flight retry handle a message it
 * still owns; anything else resumes the saved request by id.
 */
export function useAdmissionScope({ ingress, blocks, controller, retryPending }: {
  readonly ingress: readonly PromptItem[] | undefined;
  readonly blocks: readonly Block[];
  readonly controller: SessionController | null;
  readonly retryPending?: (promptId: string) => boolean;
}): AdmissionScopeValue {
  const { t } = useI18n();
  const records = ingress ?? NO_RECORDS;
  const slow = useSlowRestores(records);
  const settled = useMemo(() => settledPromptIds(blocks), [blocks]);
  const computed = admissionViews(records, settled, slow);
  // Blocks change on every streamed delta; keep one map per distinct set of
  // lines so the bubbles reading it do not re-render with each token.
  const signature = JSON.stringify([...computed.values()]);
  const views = useMemo(() => computed, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busyId, setBusyId] = useState<string>();
  const polled = JSON.stringify([...views.values()].filter((view) => view.kind === 'loading' || view.kind === 'queued' || view.kind === 'switching').map((view) => view.promptId));
  useEffect(() => {
    const ids = JSON.parse(polled) as string[];
    if (ids.length === 0 || controller === null) return;
    let next = 0;
    let reading = false;
    const read = () => {
      if (reading) return;
      reading = true;
      void controller.refreshDurablePrompt(ids[next++ % ids.length]!).catch(() => {}).finally(() => { reading = false; });
    };
    // The first read lands with the line itself: a restore that already
    // finished or failed corrects the bubble at once.
    read();
    const timer = setInterval(read, RESTORE_POLL_MS);
    return () => { clearInterval(timer); };
  }, [polled, controller]);
  const run = useCallback((promptId: string, action: () => Promise<unknown>) => {
    setBusyId(promptId);
    void action()
      .then(() => controller?.refreshDurableIngress())
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: t('transcript.admission.actionFailed', { reason: error instanceof Error ? error.message : String(error) }) });
      })
      .finally(() => { setBusyId((current) => current === promptId ? undefined : current); });
  }, [controller, t]);
  const onRetry = useCallback((promptId: string) => {
    if (controller === null) return;
    if (retryPending?.(promptId) === true) return;
    const item = [...(controller.getDurableIngress?.() ?? []), ...records].find((entry) => entry.prompt_id === promptId);
    if (item === undefined) return;
    run(promptId, () => controller.resumeDurableIngress(promptId, { content: item.content }));
  }, [controller, records, retryPending, run]);
  const onCancel = useCallback((promptId: string) => {
    if (controller === null) return;
    run(promptId, () => controller.abortPrompt(promptId));
  }, [controller, run]);
  return useMemo(() => ({ views, busyId, onRetry: controller === null ? undefined : onRetry, onCancel: controller === null ? undefined : onCancel }),
    [views, busyId, controller, onRetry, onCancel]);
}

export function AdmissionScope({ value, children }: { readonly value: AdmissionScopeValue; readonly children: ReactNode }) {
  return <AdmissionContext.Provider value={value}>{children}</AdmissionContext.Provider>;
}

export function useAdmissionView(promptId: string | undefined): AdmissionView | undefined {
  const { views } = useContext(AdmissionContext);
  return promptId === undefined ? undefined : views.get(promptId);
}

const LINK = 'min-h-6 rounded-sm px-1 font-medium text-ink-soft underline-offset-2 transition-colors duration-[var(--kiki-motion-quick)] hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink disabled:cursor-default disabled:no-underline disabled:opacity-60';
/** Shown with the bubble's hover/focus, always on touch screens. */
const ON_HOVER = 'opacity-0 transition-opacity duration-[var(--kiki-motion-quick)] group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 [@media(hover:none)]:opacity-100';

/** The admission line under a user bubble; nothing when the message has none. */
export function AdmissionLine({ view }: { readonly view: AdmissionView }) {
  const { t } = useI18n();
  const { busyId, onRetry, onCancel } = useContext(AdmissionContext);
  const busy = busyId !== undefined;
  const waiting = view.kind === 'loading' || view.kind === 'queued' || view.kind === 'switching';
  const label = view.kind === 'loading' ? t('transcript.admission.loading')
    : view.kind === 'queued' ? t('transcript.admission.queued', { position: view.position ?? 1 })
    : view.kind === 'switching' ? t('transcript.admission.switching')
    : view.kind === 'duplicate' ? t('transcript.admission.duplicate')
    : view.kind === 'held' ? t('transcript.admission.held')
    : t('transcript.admission.failed');
  const title = view.kind === 'duplicate' ? t('transcript.admission.duplicateTitle')
    : view.kind === 'held' ? t('transcript.admission.heldTitle')
    : undefined;
  return (
    <span
      role="status"
      data-admission={view.kind}
      title={title}
      className="mt-1 mr-1 flex flex-wrap items-center justify-end gap-x-1 text-[11px] text-ink-faint"
    >
      {waiting
        ? <Spinner label={label} size={12} />
        : <Icon name="hold" size={12} className="text-ink-faint" />}
      <span className={waiting ? undefined : 'text-ink-soft'}>{label}</span>
      {!waiting && onRetry !== undefined ? (
        <>
          <span aria-hidden>·</span>
          <button type="button" data-admission-retry className={LINK} disabled={busy}
            onClick={(event) => { event.stopPropagation(); onRetry(view.promptId); }}>
            {t(view.kind === 'duplicate' ? 'transcript.admission.sendSeparately' : 'transcript.admission.retry')}
          </button>
        </>
      ) : null}
      {onCancel !== undefined ? (
        <span className={`inline-flex items-center gap-x-1 ${waiting ? ON_HOVER : ''}`}>
          <span aria-hidden>·</span>
          <button type="button" data-admission-cancel className={LINK} disabled={busy}
            onClick={(event) => { event.stopPropagation(); onCancel(view.promptId); }}>
            {t('transcript.admission.cancel')}
          </button>
        </span>
      ) : null}
    </span>
  );
}
