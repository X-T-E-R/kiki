/**
 * Approval card — the amber attention element. Hardened after aionui's
 * PermissionRequestPanel (https://github.com/AionUi/AionUi —
 * `packages/desktop/src/renderer/pages/conversation/Messages/components/
 * MessagePermission/PermissionRequestPanel.tsx` + `permissionOptions.ts`,
 * Apache-2.0), adapted to kiki's wire (decision + optional 'session' scope):
 *
 *   - options classify into intents: allow-once (accent solid), allow-always
 *     (the "remember for this session" scope), reject-once (outline). The
 *     wire has no reject-always; cancelled exists but is not user-facing here.
 *   - single-click submit with an in-flight double-click guard
 *     (respondingRef) and a stale-response epoch guard (a late-settling
 *     promise from a previous request instance never writes state);
 *   - after answering, the button row is replaced inline by the outcome
 *     status (and by the compact resolution line once the stream confirms);
 *   - when the request carries no displayable command, the detail block falls
 *     back to labeled raw JSON instead of a misleading pseudo-title.
 */

import { useEffect, useRef, useState } from 'react';

import type { ApprovalDecision, QuestionAnswer, QuestionItem } from '@moonshot-ai/protocol';

import { timeUntil } from '../lib/time';
import type { ApprovalBlock, QuestionBlock } from '../state/transcript';
import { Markdown } from './Markdown';

type ApprovalIntent = 'allow-once' | 'allow-always' | 'reject-once';

function intentFor(decision: ApprovalDecision, scope: 'session' | undefined): ApprovalIntent {
  if (decision === 'approved') return scope === 'session' ? 'allow-always' : 'allow-once';
  return 'reject-once';
}

/**
 * The displayable detail for a request. Returns `{ label, text }`; when the
 * display payload has no recognizable command/path/summary, falls back to a
 * labeled raw-JSON dump (aionui's honest-degradation rule) rather than
 * inventing a title. Undefined when there is genuinely nothing to show.
 */
function approvalDetail(block: ApprovalBlock): { label: string; text: string } | undefined {
  const display = block.request.tool_input_display;
  if (typeof display !== 'object' || display === null) return undefined;
  const kind = (display as { kind?: unknown }).kind;
  if (kind === 'command') {
    const command = (display as { command?: string }).command;
    return command !== undefined && command !== '' ? { label: 'Command', text: command } : undefined;
  }
  if (kind === 'file_io') {
    const d = display as { operation?: string; path?: string };
    const text = `${d.operation ?? ''} ${d.path ?? ''}`.trim();
    return text !== '' ? { label: 'File', text } : undefined;
  }
  if (kind === 'diff') {
    const path = (display as { path?: string }).path;
    return path !== undefined ? { label: 'File', text: path } : undefined;
  }
  if (kind === 'generic') {
    const summary = (display as { summary?: string }).summary;
    return summary !== undefined && summary !== '' ? { label: 'Details', text: summary } : undefined;
  }
  try {
    const json = JSON.stringify(display, null, 2);
    if (json === undefined || json === '{}') return undefined;
    return { label: 'Details', text: json.length > 800 ? `${json.slice(0, 800)}…` : json };
  } catch {
    return undefined;
  }
}

export function ApprovalCard({
  block,
  onResolve,
}: {
  block: ApprovalBlock;
  onResolve: (decision: ApprovalDecision, scope?: 'session') => Promise<void>;
}) {
  const [forSession, setForSession] = useState(false);
  const [submitting, setSubmitting] = useState<ApprovalIntent | null>(null);
  const [answered, setAnswered] = useState<ApprovalDecision | null>(null);
  const [failed, setFailed] = useState(false);
  const respondingRef = useRef(false);
  // Epoch guard: bumped whenever this card's request identity changes; async
  // completions compare against their captured epoch before touching state.
  const epochRef = useRef(0);
  const approvalId = block.request.approval_id;
  useEffect(() => {
    epochRef.current += 1;
    respondingRef.current = false;
    setSubmitting(null);
    setAnswered(null);
    setFailed(false);
  }, [approvalId]);
  useEffect(
    () => () => {
      epochRef.current += 1; // unmount: late completions become no-ops
    },
    [],
  );

  if (block.resolution !== undefined) {
    const { decision } = block.resolution;
    const label =
      decision === 'approved'
        ? 'Approved'
        : decision === 'rejected'
          ? 'Rejected'
          : decision === 'cancelled'
            ? 'Cancelled'
            : decision === 'expired'
              ? 'Expired'
              : 'Resolved elsewhere';
    const tone =
      decision === 'approved'
        ? 'border-success/40 text-success'
        : decision === 'resolved_elsewhere'
          ? 'border-hairline text-ink-faint'
          : 'border-danger/40 text-danger';
    return (
      <div
        className={`anim-enter flex items-center gap-2 rounded-lg border bg-panel px-3 py-1.5 text-[12px] ${tone}`}
      >
        <span aria-hidden>{decision === 'approved' ? '✓' : decision === 'resolved_elsewhere' ? '·' : '×'}</span>
        <span className="font-medium">{label}</span>
        <span className="truncate font-mono text-[11px] text-ink-faint">
          {block.request.tool_name} — {block.request.action}
        </span>
      </div>
    );
  }

  const detail = approvalDetail(block);

  const submit = (decision: ApprovalDecision) => {
    // In-flight guard: drop double-clicks and clicks during submission.
    if (respondingRef.current || answered !== null) return;
    const scope = forSession ? ('session' as const) : undefined;
    const intent = intentFor(decision, scope);
    const epoch = epochRef.current;
    respondingRef.current = true;
    setSubmitting(intent);
    setFailed(false);
    void onResolve(decision, scope)
      .then(() => {
        if (epochRef.current !== epoch) return; // stale response — newer request owns the card
        setAnswered(decision);
      })
      .catch(() => {
        if (epochRef.current !== epoch) return;
        setFailed(true);
      })
      .finally(() => {
        if (epochRef.current !== epoch) return;
        respondingRef.current = false;
        setSubmitting(null);
      });
  };

  return (
    <div className="anim-enter overflow-hidden rounded-xl border border-amber-rule/50 bg-amber-card shadow-[0_2px_12px_-6px_rgba(180,83,9,0.25)]">
      <div className="flex">
        <div className="w-1 shrink-0 bg-amber-rule" />
        <div className="min-w-0 flex-1 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-amber-ink">Approval needed</span>
            <span className="text-[10.5px] text-amber-ink/60">
              {timeUntil(block.request.expires_at)}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-ink">
            <span className="font-mono font-semibold">{block.request.tool_name}</span>
            <span className="text-ink-soft"> · {block.request.action}</span>
          </p>
          {detail !== undefined ? (
            <div className="mt-2">
              <p className="mb-0.5 text-[10px] font-semibold tracking-wide text-amber-ink/60 uppercase">
                {detail.label}
              </p>
              <pre className="max-h-40 overflow-auto rounded-lg border border-amber-rule/30 bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink">
                {detail.text}
              </pre>
            </div>
          ) : null}

          {answered === null ? (
            <>
              <label className="mt-2.5 flex cursor-pointer items-center gap-1.5 text-[11.5px] text-amber-ink/80">
                <input
                  type="checkbox"
                  checked={forSession}
                  disabled={submitting !== null}
                  onChange={(event) => setForSession(event.target.checked)}
                  className="h-3 w-3 accent-[#e8590c]"
                />
                Remember for this session
              </label>

              <div className="mt-3 flex items-center gap-2" aria-busy={submitting !== null}>
                <button
                  type="button"
                  disabled={submitting !== null}
                  onClick={() => submit('approved')}
                  className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-60"
                >
                  {submitting === 'allow-once' || submitting === 'allow-always'
                    ? 'Approving…'
                    : 'Approve'}{' '}
                  <kbd className="ml-1 rounded bg-white/20 px-1 font-mono text-[10px]">y</kbd>
                </button>
                <button
                  type="button"
                  disabled={submitting !== null}
                  onClick={() => submit('rejected')}
                  className="rounded-lg border border-hairline-strong bg-panel px-3.5 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:border-danger hover:text-danger disabled:opacity-60"
                >
                  {submitting === 'reject-once' ? 'Rejecting…' : 'Reject'}{' '}
                  <kbd className="ml-1 rounded bg-paper px-1 font-mono text-[10px]">n</kbd>
                </button>
              </div>
              {failed ? (
                <p role="alert" className="mt-2 text-[11.5px] text-danger">
                  Could not send the decision — the request may have expired. Try again.
                </p>
              ) : null}
            </>
          ) : (
            <p
              role="status"
              className={`mt-3 flex items-center gap-1.5 text-[12px] font-medium ${
                answered === 'approved' ? 'text-success' : 'text-danger'
              }`}
            >
              <span aria-hidden>{answered === 'approved' ? '✓' : '×'}</span>
              {answered === 'approved' ? 'Approved' : 'Rejected'} — sent to kiki
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Question card (AskUserQuestion) — single/multi select per the schema, an
 * "Other" free-text path when allowed, submit + dismiss.
 */

function QuestionItemView({
  item,
  answer,
  onChange,
}: {
  item: QuestionItem;
  answer: { optionIds: string[]; otherText: string; useOther: boolean };
  onChange: (next: { optionIds: string[]; otherText: string; useOther: boolean }) => void;
}) {
  const multi = item.multi_select === true;
  const toggle = (optionId: string) => {
    if (multi) {
      const optionIds = answer.optionIds.includes(optionId)
        ? answer.optionIds.filter((id) => id !== optionId)
        : [...answer.optionIds, optionId];
      onChange({ ...answer, optionIds });
    } else {
      onChange({ ...answer, optionIds: [optionId], useOther: false });
    }
  };
  return (
    <div>
      {item.header !== undefined ? (
        <p className="text-[10.5px] font-semibold tracking-wide text-amber-ink/70 uppercase">
          {item.header}
        </p>
      ) : null}
      <p className="mt-0.5 text-[13px] font-medium text-ink">{item.question}</p>
      {item.body !== undefined ? (
        <div className="mt-1 text-[12px] text-ink-soft">
          <Markdown text={item.body} />
        </div>
      ) : null}
      <div className="mt-2 space-y-1">
        {item.options.map((option) => {
          const selected = answer.optionIds.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => toggle(option.id)}
              className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                selected
                  ? 'border-accent bg-accent-soft'
                  : 'border-hairline bg-panel hover:border-hairline-strong'
              }`}
            >
              <span
                aria-hidden
                className={`mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center border text-[9px] ${
                  multi ? 'rounded-[4px]' : 'rounded-full'
                } ${selected ? 'border-accent bg-accent text-white' : 'border-hairline-strong bg-panel'}`}
              >
                {selected ? '✓' : ''}
              </span>
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium text-ink">{option.label}</span>
                {option.description !== undefined ? (
                  <span className="block text-[11.5px] text-ink-soft">{option.description}</span>
                ) : null}
              </span>
            </button>
          );
        })}
        {item.allow_other === true ? (
          <div
            className={`rounded-lg border px-2.5 py-1.5 ${
              answer.useOther ? 'border-accent bg-accent-soft' : 'border-hairline bg-panel'
            }`}
          >
            <button
              type="button"
              onClick={() => onChange({ ...answer, useOther: !answer.useOther })}
              className="flex w-full items-center gap-2 text-left"
            >
              <span
                aria-hidden
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-[9px] ${
                  answer.useOther ? 'border-accent bg-accent text-white' : 'border-hairline-strong'
                }`}
              >
                {answer.useOther ? '✓' : ''}
              </span>
              <span className="text-[12.5px] font-medium text-ink">
                {item.other_label ?? 'Other'}
              </span>
            </button>
            {answer.useOther ? (
              <input
                className="mt-1.5 w-full rounded-md border border-hairline bg-panel px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
                placeholder={item.other_description ?? 'Type your answer…'}
                value={answer.otherText}
                onChange={(event) => onChange({ ...answer, otherText: event.target.value })}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function QuestionCard({
  block,
  onAnswer,
  onDismiss,
}: {
  block: QuestionBlock;
  onAnswer: (answers: Record<string, QuestionAnswer>) => void;
  onDismiss: () => void;
}) {
  const [selections, setSelections] = useState<
    Record<string, { optionIds: string[]; otherText: string; useOther: boolean }>
  >({});
  const [busy, setBusy] = useState(false);

  if (block.outcome !== undefined) {
    const label =
      block.outcome.kind === 'answered'
        ? 'Question answered'
        : block.outcome.kind === 'dismissed'
          ? 'Question dismissed'
          : 'Question expired';
    return (
      <div className="anim-enter flex items-center gap-2 rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[12px] text-ink-faint">
        <span aria-hidden>·</span>
        <span className="font-medium">{label}</span>
      </div>
    );
  }

  const answerFor = (id: string) =>
    selections[id] ?? { optionIds: [] as string[], otherText: '', useOther: false };

  const submit = () => {
    const answers: Record<string, QuestionAnswer> = {};
    for (const item of block.request.questions) {
      const selection = answerFor(item.id);
      const multi = item.multi_select === true;
      if (selection.useOther && multi) {
        answers[item.id] = {
          kind: 'multi_with_other',
          option_ids: selection.optionIds,
          other_text: selection.otherText,
        };
      } else if (selection.useOther) {
        answers[item.id] = { kind: 'other', text: selection.otherText };
      } else if (multi) {
        if (selection.optionIds.length === 0) continue;
        answers[item.id] = { kind: 'multi', option_ids: selection.optionIds };
      } else {
        const first = selection.optionIds[0];
        if (first === undefined) continue;
        answers[item.id] = { kind: 'single', option_id: first };
      }
    }
    if (Object.keys(answers).length === 0) return;
    setBusy(true);
    onAnswer(answers);
  };

  return (
    <div className="anim-enter overflow-hidden rounded-xl border border-amber-rule/50 bg-amber-card">
      <div className="flex">
        <div className="w-1 shrink-0 bg-amber-rule" />
        <div className="min-w-0 flex-1 space-y-4 px-4 py-3">
          <span className="text-[13px] font-semibold text-amber-ink">kiki asks</span>
          {block.request.questions.map((item) => (
            <QuestionItemView
              key={item.id}
              item={item}
              answer={answerFor(item.id)}
              onChange={(next) => setSelections((prev) => ({ ...prev, [item.id]: next }))}
            />
          ))}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={submit}
              className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-60"
            >
              Submit
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                onDismiss();
              }}
              className="rounded-lg border border-hairline-strong bg-panel px-3.5 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:text-danger disabled:opacity-60"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
