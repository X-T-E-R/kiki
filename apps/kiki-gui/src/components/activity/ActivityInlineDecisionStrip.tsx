import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  ApprovalDecision,
  ApprovalRequest,
  QuestionAnswer,
  QuestionItem,
  QuestionRequest,
  Session,
} from '@kiki/protocol';
import type { SessionListData } from '@kiki/session-core/sessions';

import { useI18n } from '../../i18n';
import { isImeKeyEvent } from '../../lib/shortcuts';
import { pushToast } from '../../lib/toasts';
import { useOptionalConnection } from '../../state/connection';
import { Icon } from '../icons';

import {
  extractApprovalDetail,
  sharedActivityDetailLimiter,
  type ConcurrencyLimiter,
} from './activityTriageLimiter';

const PRIMARY_BTN =
  'inline-flex min-h-7 pointer-coarse:min-h-8 items-center rounded-md bg-accent px-3 text-[12px] font-normal text-primary-foreground transition-colors hover:bg-accent-deep focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:opacity-55';
const SECONDARY_BTN =
  'inline-flex min-h-7 pointer-coarse:min-h-8 items-center rounded-md border border-hairline bg-paper px-3 text-[12px] font-normal text-ink-soft transition-colors hover:border-ink/25 hover:bg-ink/[0.03] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:opacity-55';
const QUIET_BTN =
  'inline-flex min-h-7 pointer-coarse:min-h-8 items-center gap-1 rounded-md px-2 text-[12px] font-normal text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:opacity-55';

export interface ActivityThreadTarget {
  readonly agentId?: string;
  readonly interactionId?: string;
}

export type ActivityInlineDetail =
  | { readonly kind: 'approval'; readonly approvals: readonly ApprovalRequest[] }
  | { readonly kind: 'question'; readonly questions: readonly QuestionRequest[] };

export function activityInlineQueryKey(
  sessionId: string,
  reason: 'approval' | 'question',
  lastSeq: number,
) {
  return ['activity-inline-interaction', sessionId, reason, lastSeq] as const;
}

function isRejectOptionKind(kind: string): boolean {
  const lower = kind.toLowerCase();
  return lower.includes('reject') || lower.includes('deny') || lower.includes('cancel');
}

function ApprovalDecisionRow({
  sessionId,
  request,
  onOpenThread,
  onSettled,
}: {
  sessionId: string;
  request: ApprovalRequest;
  onOpenThread: (target?: ActivityThreadTarget) => void;
  onSettled: (id: string) => void;
}) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const [busy, setBusy] = useState(false);
  const detail = extractApprovalDetail(request);

  const submit = async (
    decision: ApprovalDecision,
    extra: { scope?: 'session'; selected_option_id?: string } = {},
  ) => {
    if (busy || typeof connection?.client.resolveApproval !== 'function') return;
    setBusy(true);
    try {
      await connection.client.resolveApproval(sessionId, request.approval_id, {
        decision,
        scope: extra.scope,
        selected_option_id: extra.selected_option_id,
      });
      onSettled(request.approval_id);
      pushToast({
        tone: 'success',
        text: t(decision === 'approved' ? 'activity.inline.approvedToast' : 'activity.inline.rejectedToast'),
      });
    } catch (error) {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-activity-approval={request.approval_id} className="flex flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] leading-4">
        <span className="inline-flex shrink-0 items-center gap-1 font-normal text-ink">
          <Icon name="gate" size={12} className="text-accent-deep" />
          <span>{request.tool_name}</span>
        </span>
        {request.action.trim() !== ''
          && request.action !== request.tool_name
          && (detail.kind !== 'standard' || detail.snippet === undefined || request.action.trim() !== detail.snippet.trim()) ? (
          <span className="min-w-0 truncate text-ink-soft">{request.action}</span>
        ) : null}
      </div>

      {detail.kind === 'standard' && detail.snippet !== undefined ? (
        <pre
          data-activity-approval-snippet
          className="max-h-24 overflow-auto rounded-md bg-ink/[0.04] px-2.5 py-1.5 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap break-all text-ink"
        >
          {detail.snippet}
        </pre>
      ) : null}

      {detail.kind === 'ssh' ? (
        <p className="font-mono text-[11.5px] break-all text-ink-soft">{detail.summary}</p>
      ) : null}

      {detail.kind === 'external_permission' && detail.ok ? (
        <p className="text-[12px] leading-[18px] break-words text-ink-soft">{detail.summary}</p>
      ) : null}

      {detail.kind === 'plan_review' && detail.excerpt !== '' ? (
        <pre className="max-h-24 overflow-auto rounded-md bg-ink/[0.04] px-2.5 py-1.5 font-sans text-[12px] leading-[18px] whitespace-pre-wrap break-words text-ink-soft">
          {detail.excerpt}
        </pre>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {detail.kind === 'standard' ? (
          <>
            <button
              type="button"
              data-activity-approve={request.approval_id}
              disabled={busy}
              onClick={() => { void submit('approved'); }}
              className={PRIMARY_BTN}
            >
              {t('activity.inline.approve')}
            </button>
            {detail.canAllowSession ? (
              <button
                type="button"
                data-activity-allow-session={request.approval_id}
                disabled={busy}
                onClick={() => { void submit('approved', { scope: 'session' }); }}
                className={SECONDARY_BTN}
              >
                {t('activity.inline.allowSession')}
              </button>
            ) : null}
            <button
              type="button"
              data-activity-reject={request.approval_id}
              disabled={busy}
              onClick={() => { void submit('rejected'); }}
              className={QUIET_BTN}
            >
              {t('activity.inline.reject')}
            </button>
          </>
        ) : null}

        {detail.kind === 'external_permission' && detail.ok
          ? detail.options.map((opt, idx) => {
              const reject = isRejectOptionKind(opt.kind);
              return (
                <button
                  key={opt.id}
                  type="button"
                  data-activity-ext-option={opt.id}
                  disabled={busy}
                  onClick={() => {
                    void submit(reject ? 'rejected' : 'approved', { selected_option_id: opt.id });
                  }}
                  className={idx === 0 && !reject ? PRIMARY_BTN : SECONDARY_BTN}
                >
                  {opt.label}
                </button>
              );
            })
          : null}

        {detail.kind === 'plan_review' && !detail.hasOptions ? (
          <>
            <button
              type="button"
              data-activity-approve={request.approval_id}
              disabled={busy}
              onClick={() => { void submit('approved'); }}
              className={PRIMARY_BTN}
            >
              {t('activity.inline.approvePlan')}
            </button>
            <button
              type="button"
              data-activity-reject={request.approval_id}
              disabled={busy}
              onClick={() => { void submit('rejected'); }}
              className={QUIET_BTN}
            >
              {t('activity.inline.reject')}
            </button>
          </>
        ) : null}

        <button
          type="button"
          data-activity-review-thread={request.approval_id}
          onClick={() => { onOpenThread({ agentId: request.agent_id, interactionId: request.approval_id }); }}
          className={QUIET_BTN}
        >
          <span>{t('activity.reviewInThread')}</span>
          <Icon name="arrowRight" size={12} />
        </button>
      </div>
    </div>
  );
}

function QuestionDecisionRow({
  sessionId,
  request,
  onOpenThread,
  onSettled,
}: {
  sessionId: string;
  request: QuestionRequest;
  onOpenThread: (target?: ActivityThreadTarget) => void;
  onSettled: (id: string) => void;
}) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const [busy, setBusy] = useState(false);
  const [selectedByQuestion, setSelectedByQuestion] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [otherByQuestion, setOtherByQuestion] = useState<Readonly<Record<string, string>>>({});
  const otherComposingRef = useRef(false);

  const singleImmediate =
    request.questions.length === 1 && request.questions[0]?.multi_select !== true;

  const submitAnswers = async (answers: Record<string, QuestionAnswer>) => {
    if (busy || typeof connection?.client.resolveQuestion !== 'function') return;
    setBusy(true);
    try {
      await connection.client.resolveQuestion(sessionId, request.question_id, {
        answers,
        method: 'click',
      });
      onSettled(request.question_id);
      pushToast({ tone: 'success', text: t('activity.inline.answeredToast') });
    } catch (error) {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    if (busy || typeof connection?.client.dismissQuestion !== 'function') return;
    setBusy(true);
    try {
      await connection.client.dismissQuestion(sessionId, request.question_id);
      onSettled(request.question_id);
      pushToast({ tone: 'info', text: t('activity.inline.dismissedToast') });
    } catch (error) {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const toggleOption = (item: QuestionItem, optionId: string) => {
    if (singleImmediate) {
      void submitAnswers({ [item.id]: { kind: 'single', option_id: optionId } });
      return;
    }
    setSelectedByQuestion((prev) => {
      const current = prev[item.id] ?? [];
      if (item.multi_select !== true) {
        return { ...prev, [item.id]: [optionId] };
      }
      const next = current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId];
      return { ...prev, [item.id]: next };
    });
  };

  const buildCompositeAnswers = (): Record<string, QuestionAnswer> | undefined => {
    const out: Record<string, QuestionAnswer> = {};
    for (const item of request.questions) {
      const picked = selectedByQuestion[item.id] ?? [];
      const custom = (otherByQuestion[item.id] ?? '').trim();
      if (item.multi_select === true) {
        if (picked.length > 0 && custom !== '') {
          out[item.id] = { kind: 'multi_with_other', option_ids: [...picked], other_text: custom };
        } else if (picked.length > 0) {
          out[item.id] = { kind: 'multi', option_ids: [...picked] };
        } else if (custom !== '') {
          out[item.id] = { kind: 'other', text: custom };
        } else {
          return undefined;
        }
      } else if (custom !== '') {
        out[item.id] = { kind: 'other', text: custom };
      } else if (picked[0] !== undefined) {
        out[item.id] = { kind: 'single', option_id: picked[0] };
      } else {
        return undefined;
      }
    }
    return out;
  };

  const compositeAnswers = singleImmediate ? undefined : buildCompositeAnswers();

  return (
    <div data-activity-question={request.question_id} className="flex flex-col gap-2">
      {request.questions.map((item) => {
        const picked = selectedByQuestion[item.id] ?? [];
        const otherText = otherByQuestion[item.id] ?? '';
        return (
          <div key={item.id} className="flex flex-col gap-1.5">
            <div className="flex min-w-0 items-start gap-1.5 text-[12.5px] leading-[18px] text-ink">
              <Icon name="ask" size={12} className="mt-[3px] shrink-0 text-accent-deep" />
              <span className="min-w-0 flex-1 break-words font-normal">{item.question}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {item.options.map((opt) => {
                const selected = picked.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    data-activity-question-option={`${item.id}:${opt.id}`}
                    aria-pressed={singleImmediate ? undefined : selected}
                    disabled={busy}
                    title={opt.description}
                    onClick={() => { toggleOption(item, opt.id); }}
                    className={
                      selected
                        ? PRIMARY_BTN
                        : SECONDARY_BTN
                    }
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {item.allow_other !== false ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <input
                  type="text"
                  data-activity-question-other={item.id}
                  value={otherText}
                  disabled={busy}
                  placeholder={item.other_label ?? t('activity.inline.otherPlaceholder')}
                  onChange={(event) => {
                    const value = event.target.value;
                    setOtherByQuestion((prev) => ({ ...prev, [item.id]: value }));
                  }}
                  onCompositionStart={() => { otherComposingRef.current = true; }}
                  onCompositionEnd={() => { otherComposingRef.current = false; }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !otherComposingRef.current && !isImeKeyEvent(event) && singleImmediate && otherText.trim() !== '') {
                      event.preventDefault();
                      void submitAnswers({ [item.id]: { kind: 'other', text: otherText.trim() } });
                    }
                  }}
                  className="h-7 min-w-0 flex-1 rounded-md border border-hairline bg-paper px-2 text-[12px] text-ink placeholder:text-ink-faint focus:border-ink/35 focus:outline-none"
                />
                {singleImmediate && otherText.trim() !== '' ? (
                  <button
                    type="button"
                    data-activity-question-submit-other={item.id}
                    disabled={busy}
                    onClick={() => {
                      void submitAnswers({ [item.id]: { kind: 'other', text: otherText.trim() } });
                    }}
                    className={PRIMARY_BTN}
                  >
                    {t('activity.inline.submitAnswer')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-1.5">
        {!singleImmediate ? (
          <button
            type="button"
            data-activity-question-submit={request.question_id}
            disabled={busy || compositeAnswers === undefined}
            onClick={() => {
              if (compositeAnswers !== undefined) void submitAnswers(compositeAnswers);
            }}
            className={PRIMARY_BTN}
          >
            {t('activity.inline.submitAnswer')}
          </button>
        ) : null}
        <button
          type="button"
          data-activity-question-dismiss={request.question_id}
          disabled={busy}
          onClick={() => { void dismiss(); }}
          className={QUIET_BTN}
        >
          {t('activity.inline.dismissQuestion')}
        </button>
        <button
          type="button"
          data-activity-review-thread={request.question_id}
          onClick={() => {
            const agentId = (request as QuestionRequest & { readonly agent_id?: string }).agent_id;
            onOpenThread({ agentId, interactionId: request.question_id });
          }}
          className={QUIET_BTN}
        >
          <span>{t('activity.reviewInThread')}</span>
          <Icon name="arrowRight" size={12} />
        </button>
      </div>
    </div>
  );
}

export function canInlineTriageSession(
  client: unknown,
  reason: 'approval' | 'question',
): boolean {
  if (typeof client !== 'object' || client === null) return false;
  const record = client as Record<string, unknown>;
  return reason === 'approval'
    ? typeof record['listPendingApprovals'] === 'function'
    : typeof record['listPendingQuestions'] === 'function';
}

export function ActivityInlineDecisionStrip({
  sessionId,
  reason,
  lastSeq,
  onOpenThread,
  limiter = sharedActivityDetailLimiter,
}: {
  sessionId: string;
  reason: 'approval' | 'question';
  lastSeq: number;
  onOpenThread: (target?: ActivityThreadTarget) => void;
  limiter?: ConcurrencyLimiter;
}) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const queryClient = useQueryClient();
  const [settledIds, setSettledIds] = useState<ReadonlySet<string>>(() => new Set());

  const supported = canInlineTriageSession(connection?.client, reason);

  const detailQuery = useQuery<ActivityInlineDetail>({
    queryKey: activityInlineQueryKey(sessionId, reason, lastSeq),
    enabled: supported,
    staleTime: 10_000,
    queryFn: ({ signal }) =>
      limiter.run(async () => {
        const client = connection!.client;
        if (reason === 'approval') {
          const approvals = await client.listPendingApprovals(sessionId);
          return { kind: 'approval' as const, approvals };
        }
        const questions = await client.listPendingQuestions(sessionId);
        return { kind: 'question' as const, questions };
      }, signal),
  });

  const handleSettled = (interactionId: string) => {
    const nextSettled = new Set([...settledIds, interactionId]);
    setSettledIds(nextSettled);
    const hasRemaining = detailQuery.data?.kind === 'approval'
      ? detailQuery.data.approvals.some((req) => !nextSettled.has(req.approval_id))
      : detailQuery.data?.kind === 'question'
        ? detailQuery.data.questions.some((req) => !nextSettled.has(req.question_id))
        : false;
    if (!hasRemaining) {
      queryClient.setQueriesData<SessionListData>({ queryKey: ['sessions'] }, (old) => {
        if (old === undefined || !Array.isArray(old.pages)) return old;
        let changed = false;
        const pages = old.pages.map((page) => {
          if (!Array.isArray(page?.items)) return page;
          let pageChanged = false;
          const items = page.items.map((session) => {
            if (session.id === sessionId && session.pending_interaction === reason) {
              pageChanged = true;
              changed = true;
              return { ...session, pending_interaction: undefined };
            }
            return session;
          });
          return pageChanged ? { ...page, items } : page;
        });
        return changed ? { ...old, pages } : old;
      });
      queryClient.setQueriesData<Session>({ queryKey: ['thread-ref'] }, (old) =>
        old !== undefined && old.id === sessionId && old.pending_interaction === reason
          ? { ...old, pending_interaction: undefined }
          : old,
      );
    }
    void queryClient.invalidateQueries({ queryKey: ['activity-inline-interaction', sessionId] });
  };

  if (!supported) return null;

  const pendingApprovals =
    detailQuery.data?.kind === 'approval'
      ? detailQuery.data.approvals.filter((req) => !settledIds.has(req.approval_id))
      : [];
  const pendingQuestions =
    detailQuery.data?.kind === 'question'
      ? detailQuery.data.questions.filter((req) => !settledIds.has(req.question_id))
      : [];

  return (
    <div
      data-activity-inline-strip={sessionId}
      className="mt-1 mb-1.5 ml-[15px] border-l-2 border-accent py-1.5 pr-2 pl-3"
    >
      {detailQuery.isLoading ? (
        <p data-activity-inline-loading className="text-[12px] leading-4 text-ink-faint">
          {t('activity.inline.loading')}
        </p>
      ) : detailQuery.isError ? (
        <button
          type="button"
          onClick={() => { onOpenThread(); }}
          className={QUIET_BTN}
        >
          <span>{t('activity.reviewInThread')}</span>
          <Icon name="arrowRight" size={12} />
        </button>
      ) : detailQuery.data?.kind === 'approval' ? (
        pendingApprovals.length === 0 ? (
          <p data-activity-inline-settled className="text-[12px] leading-4 text-ink-faint">
            {t('activity.inline.settled')}
          </p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {pendingApprovals.map((req) => (
              <ApprovalDecisionRow
                key={req.approval_id}
                sessionId={sessionId}
                request={req}
                onOpenThread={onOpenThread}
                onSettled={handleSettled}
              />
            ))}
          </div>
        )
      ) : pendingQuestions.length === 0 ? (
        <p data-activity-inline-settled className="text-[12px] leading-4 text-ink-faint">
          {t('activity.inline.settled')}
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {pendingQuestions.map((req) => (
            <QuestionDecisionRow
              key={req.question_id}
              sessionId={sessionId}
              request={req}
              onOpenThread={onOpenThread}
              onSettled={handleSettled}
            />
          ))}
        </div>
      )}
    </div>
  );
}
