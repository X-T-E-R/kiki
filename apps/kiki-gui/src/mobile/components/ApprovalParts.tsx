import { useState } from 'react';

import { ActionSheet } from '../../components/overlays/ActionSheet';
import { useI18n } from '../../i18n';
import type { ApprovalSummary } from '../approvalSummary';

/** Verb title (or the raw action) over the command/path/URL in a monospace box. */
export function ApprovalHeadline({ summary, className }: { readonly summary: ApprovalSummary; readonly className?: string }) {
  const { t } = useI18n();
  const title = summary.verb !== undefined ? t(`mobile.approval.verb.${summary.verb}`) : summary.headline;
  return (
    <div className={className}>
      <p className="line-clamp-2 text-[15px] font-medium leading-[1.4] text-ink">{title}</p>
      {summary.snippet !== undefined ? (
        <pre
          data-mobile-approval-snippet
          className="mt-2 max-h-[4.6rem] overflow-hidden whitespace-pre-wrap break-all rounded-xl bg-canvas px-3 py-2 font-mono text-[12.5px] leading-[1.45] text-ink-soft"
        >
          {summary.snippet}
        </pre>
      ) : null}
    </div>
  );
}

interface RejectReasonSheetProps {
  readonly overlayId: string;
  readonly headline: string;
  readonly submitting: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (reason: string) => void;
}

/** Second step before rejecting: optional note for the assistant, then the explicit reject verb. */
export function RejectReasonSheet({ overlayId, headline, submitting, onCancel, onSubmit }: RejectReasonSheetProps) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  return (
    <ActionSheet
      role="dialog"
      ariaLabel={t('mobile.approval.rejectTitle')}
      overlayId={overlayId}
      onClose={onCancel}
      sheetClassName="rounded-t-[24px]!"
    >
      <div className="kiki-mobile-sheet-grabber" aria-hidden="true" />
      <div className="space-y-3 px-4 pb-4 pt-1">
        <h3 className="text-[16px] font-semibold text-ink">{t('mobile.approval.rejectTitle')}</h3>
        <p className="line-clamp-3 break-all font-mono text-[12.5px] text-ink-soft">{headline}</p>
        <textarea
          rows={3}
          value={reason}
          onChange={(event) => { setReason(event.target.value); }}
          placeholder={t('mobile.approval.rejectPlaceholder')}
          className="w-full resize-none rounded-xl border border-hairline bg-paper px-3 py-2.5 text-[16px] text-ink placeholder:text-ink-faint focus:border-selected-ink focus:outline-none"
        />
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex h-11 flex-1 items-center justify-center rounded-full border border-hairline bg-paper text-[14px] font-medium text-ink-soft"
          >
            {t('mobile.voice.cancel')}
          </button>
          <button
            type="button"
            data-mobile-reject-submit
            disabled={submitting}
            onClick={() => { onSubmit(reason); }}
            className="flex h-11 flex-1 items-center justify-center rounded-full bg-danger text-[14px] font-medium text-primary-foreground disabled:opacity-55"
          >
            {t('mobile.approval.rejectSubmit')}
          </button>
        </div>
      </div>
    </ActionSheet>
  );
}
