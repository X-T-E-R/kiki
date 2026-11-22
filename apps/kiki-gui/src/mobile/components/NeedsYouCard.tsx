import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ApprovalDecision } from '@kiki/protocol';
import type { UnifiedInboxItem } from '@kiki/session-core/sessions';

import { Icon } from '../../components/icons';
import { RelativeTime } from '../../components/RelativeTime';
import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import { pushToast } from '../../lib/toasts';
import { isInlineDecidable, summarizeApproval } from '../approvalSummary';
import { ApprovalHeadline, RejectReasonSheet } from './ApprovalParts';

interface NeedsYouCardProps {
  readonly item: UnifiedInboxItem;
  readonly client: KikiClient;
  readonly onOpenThread: () => void;
  readonly onResolved: () => void;
}

export function NeedsYouCard({ item, client, onOpenThread, onResolved }: NeedsYouCardProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [rejectSheetOpen, setRejectSheetOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: ['mobile-needs-you', item.spaceKey, item.sessionId, item.reason, item.lastSeq],
    enabled: !dismissed && (item.reason === 'approval' || item.reason === 'question'),
    staleTime: 10_000,
    queryFn: async () => {
      if (item.reason === 'approval') {
        const approvals = await client.listPendingApprovals(item.sessionId);
        return { kind: 'approval' as const, approvals };
      }
      const questions = await client.listPendingQuestions(item.sessionId);
      return { kind: 'question' as const, questions };
    },
  });

  if (dismissed) return null;

  const firstApproval = detailQuery.data?.kind === 'approval' ? detailQuery.data.approvals[0] : undefined;
  const canDecideInline = firstApproval !== undefined && isInlineDecidable(firstApproval);
  const firstQuestion = detailQuery.data?.kind === 'question' ? detailQuery.data.questions[0] : undefined;
  const approvalSummary = firstApproval !== undefined ? summarizeApproval(firstApproval) : undefined;

  const submitApproval = async (decision: ApprovalDecision, reason?: string) => {
    if (submitting || firstApproval === undefined) return;
    setSubmitting(true);
    try {
      await client.resolveApproval(item.sessionId, firstApproval.approval_id, {
        decision,
        ...(reason !== undefined && reason.trim() !== '' ? { feedback: reason.trim() } : {}),
      });
      setDismissed(true);
      setRejectSheetOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      onResolved();
      pushToast({
        tone: 'success',
        text: t(decision === 'approved' ? 'mobile.approval.approved' : 'mobile.approval.rejected', {
          space: item.spaceName,
        }),
      });
    } catch (error) {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSubmitting(false);
    }
  };

  const headline =
    approvalSummary?.headline ??
    firstQuestion?.questions[0]?.question ??
    item.title;

  return (
    <>
      <article
        data-mobile-needs-you-card={item.sessionId}
        className="rounded-2xl border border-hairline/90 bg-panel p-4 shadow-[0_1px_3px_rgb(var(--kiki-shadow-ink)/0.04)]"
      >
        <div className="mb-1.5 flex items-center gap-2 text-[12px] text-ink-faint">
          <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-accent" aria-hidden="true" />
          <span className="min-w-0 truncate font-medium text-ink-soft">{item.spaceName}</span>
          <span aria-hidden="true">·</span>
          <RelativeTime at={item.at} className="shrink-0 tabular-nums" />
        </div>

        {approvalSummary !== undefined ? (
          <ApprovalHeadline summary={approvalSummary} />
        ) : (
          <h3 className="line-clamp-2 text-[15px] font-medium leading-[1.4] text-ink">{headline}</h3>
        )}

        <div className="mt-3 flex items-center gap-2">
          {firstApproval !== undefined && canDecideInline ? (
            <>
              <button
                type="button"
                data-mobile-approve-btn={firstApproval.approval_id}
                disabled={submitting}
                onClick={() => { void submitApproval('approved'); }}
                className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 text-[13.5px] font-medium text-primary-foreground transition-colors hover:bg-accent-deep disabled:opacity-55"
              >
                <Icon name="check" size={14} />
                <span>{t('mobile.approval.approve')}</span>
              </button>
              <button
                type="button"
                data-mobile-reject-btn={firstApproval.approval_id}
                disabled={submitting}
                onClick={() => { setRejectSheetOpen(true); }}
                className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-paper px-4 text-[13.5px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-55"
              >
                <Icon name="cross" size={14} />
                <span>{t('mobile.approval.reject')}</span>
              </button>
            </>
          ) : detailQuery.isError ? (
            <button
              type="button"
              data-mobile-needs-you-retry={item.sessionId}
              disabled={detailQuery.isFetching}
              title={detailQuery.error instanceof Error ? detailQuery.error.message : String(detailQuery.error)}
              aria-label={t('mobile.space.retry')}
              onClick={() => { void detailQuery.refetch(); }}
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-paper px-4 text-[13px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-55"
            >
              <Icon name="refresh" size={12} />
              <span>{t('mobile.space.retry')}</span>
            </button>
          ) : null}

          <button
            type="button"
            onClick={onOpenThread}
            className="ml-auto inline-flex h-11 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink"
          >
            <span>{t('mobile.approval.details')}</span>
            <Icon name="chevron" size={12} />
          </button>
        </div>
      </article>

      {rejectSheetOpen && firstApproval !== undefined ? (
        <RejectReasonSheet
          overlayId={`mobile-reject-${firstApproval.approval_id}`}
          headline={approvalSummary?.snippet ?? headline}
          submitting={submitting}
          onCancel={() => { setRejectSheetOpen(false); }}
          onSubmit={(reason) => { void submitApproval('rejected', reason); }}
        />
      ) : null}
    </>
  );
}
