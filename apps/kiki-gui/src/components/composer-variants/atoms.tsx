/**
 * Small state atoms shared by the variants: the run line's words, queue-row
 * actions, and the connection notice. Placement differs per variant; the
 * vocabulary does not, so the comparison is about layout, not wording.
 */

import type { ReactNode } from 'react';

import { useI18n } from '../../i18n';
import { ApprovalCard, QuestionCard } from '../Interactions';
import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { COPY } from './copy';
import { approvalBlock, questionBlock } from './mockBlocks';
import { elapsedLabel, type ComposerMockState, type MockApproval, type MockQuestion, type MockQueued } from './states';

const noop = () => Promise.resolve();

/** "正在工作 · 2:14 · 刚刚有输出" — or compaction / idle-with-queue. */
export function RunWords({ state, withMark = true }: { readonly state: ComposerMockState; readonly withMark?: boolean }) {
  const { locale } = useI18n();
  if (state.run === 'idle') {
    if (state.queue.length === 0) return null;
    return <span className="truncate text-ink-faint">{COPY.idleWaiting}</span>;
  }
  const label = state.run === 'compacting' ? COPY.compacting : COPY.working;
  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
      {withMark ? <LifeMark markId="preview-run" life="working" /> : null}
      <span className="shrink-0 text-ink-soft">{label}</span>
      <span className="text-ink-faint tabular-nums">{elapsedLabel(state.elapsed, locale === 'zh')}</span>
      {state.sinceResponse !== undefined && state.run === 'working' ? (
        <span className="min-w-0 truncate text-ink-faint max-sm:hidden">· {COPY.lastOutput(state.sinceResponse)}</span>
      ) : null}
    </span>
  );
}

export const ROW_ACTION =
  'inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none pointer-coarse:min-h-10';

/** Steer / edit / remove, in that order everywhere. */
export function QueueActions({ compact = false }: { readonly compact?: boolean }) {
  return (
    <span className="flex shrink-0 items-center">
      <button type="button" title={COPY.sendNowTitle} className={ROW_ACTION}>
        <Icon name="arrowUpRight" size={12} />
        {compact ? <span className="sr-only">{COPY.sendNow}</span> : COPY.sendNow}
      </button>
      <button type="button" aria-label={COPY.edit} title={COPY.edit} className={`${ROW_ACTION} w-7 justify-center px-0 pointer-coarse:w-10`}>
        <Icon name="edit" size={12} />
      </button>
      <button type="button" aria-label={COPY.remove} title={COPY.remove} className={`${ROW_ACTION} w-7 justify-center px-0 hover:bg-danger/[0.08] hover:text-danger pointer-coarse:w-10`}>
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

/** When a queued prompt starts, only when it is not the default. */
export function TimingTag({ item }: { readonly item: MockQueued }) {
  if (item.timing === undefined || item.timing === 'agent_idle') return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-ink-faint">
      <Icon name="clock" size={12} />
      {COPY.timing[item.timing]}
    </span>
  );
}

export function AttachmentTag({ item }: { readonly item: MockQueued }) {
  if (item.attachments === undefined) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-ink-faint">
      <Icon name="file" size={12} />
      {COPY.attachmentsN(item.attachments)}
    </span>
  );
}

/** Connection / resync / recovered-queue notice: the only amber in the area. */
export function ConnectionNotice({ state, inline = false, iconOnlyNarrow = false }: {
  readonly state: ComposerMockState;
  readonly inline?: boolean;
  /** Narrow widths keep the mark; the words move to the tooltip. */
  readonly iconOnlyNarrow?: boolean;
}) {
  let body: ReactNode = null;
  if (state.connection === 'reconnecting' || state.connection === 'resyncing') {
    body = (
      <>
        <span className="spinner inline-block h-3 w-3 shrink-0 rounded-full border-[1.5px] border-amber-ink/30 border-t-amber-ink" aria-hidden />
        <span className={`min-w-0 truncate ${iconOnlyNarrow ? 'max-sm:sr-only' : ''}`}>
          {state.connection === 'reconnecting' ? COPY.reconnecting : COPY.resyncing} · {COPY.sendPausedShort}
        </span>
      </>
    );
  } else if (state.connection === 'offline') {
    body = (
      <>
        <Icon name="warning" size={12} />
        <span className="min-w-0 truncate">{COPY.offline} · {COPY.sendPausedShort}</span>
        <button type="button" className="shrink-0 rounded-md px-1.5 font-semibold underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
          {COPY.reconnectNow}
        </button>
      </>
    );
  } else if (state.recoveredQueue !== undefined) {
    body = (
      <>
        <Icon name="hold" size={12} />
        <span className="min-w-0 truncate">{COPY.recovered(state.recoveredQueue)}</span>
        <button type="button" className="shrink-0 rounded-md px-1.5 font-semibold underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
          {COPY.recoveredConfirm}
        </button>
      </>
    );
  }
  if (body === null) return null;
  return (
    <div
      role="status"
      data-connection-notice
      title={iconOnlyNarrow ? COPY.reconnecting : undefined}
      className={`flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-amber-ink ${
        inline ? '' : 'rounded-[10px] bg-amber-card px-3 py-1.5'
      }`}
    >
      {body}
    </div>
  );
}

export function hasConnectionNotice(state: ComposerMockState): boolean {
  return state.connection !== 'ok' || state.recoveredQueue !== undefined;
}

export function RealApproval({ approval }: { readonly approval: MockApproval }) {
  return (
    <ApprovalCard
      block={approvalBlock(approval)}
      originAgentName={approval.origin}
      showShortcutHints
      onResolve={noop}
    />
  );
}

export function RealQuestion({ question }: { readonly question: MockQuestion }) {
  return <QuestionCard block={questionBlock(question)} onAnswer={noop} onDismiss={noop} />;
}

/** One-line summary of a pending item (collapsed rows). */
export function needsYouRows(state: ComposerMockState): { id: string; kind: string; text: string; origin?: string }[] {
  return [
    ...state.approvals.map((a) => ({ id: a.id, kind: COPY.approval, text: `${a.tool} · ${a.command}`, origin: a.origin })),
    ...state.questions.map((q) => ({ id: q.id, kind: COPY.question, text: q.question })),
  ];
}

/** The first pending item, expanded (approvals before questions). */
export function FirstNeedsYou({ state }: { readonly state: ComposerMockState }) {
  const approval = state.approvals[0];
  if (approval !== undefined) return <RealApproval approval={approval} />;
  const question = state.questions[0];
  if (question !== undefined) return <RealQuestion question={question} />;
  return null;
}
