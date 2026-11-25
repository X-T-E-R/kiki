import { memo } from 'react';
import { ConfirmDialog } from '../ConfirmDialog';
import { compactIdentifier, formatImIdentityDisplay, formatSessionOwnerLabel } from '../../lib/compactIdentifier';
import { useChannelsI18n as useI18n } from './channelsI18n';
import type { RebindCandidate, RebindConflictDetails } from './channelTypes';

export interface RebindModalProps {
  readonly open: boolean;
  readonly candidate?: RebindCandidate;
  readonly conflict?: RebindConflictDetails;
  readonly targetSessionId: string;
  readonly targetSessionTitle?: string;
  readonly busy?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export const RebindModal = memo(function RebindModal({
  open,
  candidate,
  conflict,
  targetSessionId,
  targetSessionTitle,
  busy = false,
  onCancel,
  onConfirm,
}: RebindModalProps) {
  const { t } = useI18n();
  if (!open) return null;

  const variantLabel = conflict?.variant_label
    ? compactIdentifier(conflict.variant_label)
    : candidate
      ? `${candidate.provider_kind} · ${formatImIdentityDisplay(candidate.identity).primary}`
      : '';
  const rawIdentityDetail = conflict?.variant_key
    ? `${conflict.variant_key.provider_instance_id} · chat:${conflict.variant_key.chat_id} · topic:${conflict.variant_key.topic_id ?? '0'} · sender:${conflict.variant_key.sender_id}`
    : candidate
      ? `${candidate.provider_instance_id} · chat:${candidate.identity.chat_id} · topic:${candidate.identity.topic_id ?? '0'} · sender:${candidate.identity.sender_id}`
      : '';
  const compactIdentityDetail = conflict?.variant_key
    ? `${compactIdentifier(conflict.variant_key.provider_instance_id)} · chat:${compactIdentifier(conflict.variant_key.chat_id)} · topic:${compactIdentifier(conflict.variant_key.topic_id ?? '0')} · sender:${compactIdentifier(conflict.variant_key.sender_id)}`
    : candidate
      ? `${compactIdentifier(candidate.provider_instance_id)} · chat:${compactIdentifier(candidate.identity.chat_id)} · topic:${compactIdentifier(candidate.identity.topic_id ?? '0')} · sender:${compactIdentifier(candidate.identity.sender_id)}`
      : '';

  const previousSessionId = conflict?.previous_session_id ?? candidate?.currentSessionId;
  const previousSession = formatSessionOwnerLabel(
    previousSessionId,
    conflict?.previous_session_title ?? candidate?.currentSessionTitle,
    t('st.im.unknownSession'),
  );

  const targetSession = formatSessionOwnerLabel(
    targetSessionId,
    targetSessionTitle,
    compactIdentifier(targetSessionId),
  );

  return (
    <ConfirmDialog
      open={open}
      title={t('st.im.rebind.title')}
      confirmLabel={t('st.im.rebind.confirm')}
      cancelLabel={t('st.im.rebind.cancel')}
      busy={busy}
      tone="danger"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <div className="space-y-3 py-1 text-[13px] text-ink-soft">
        <p className="leading-relaxed">
          {t('st.im.rebind.description')}
        </p>

        <div className="rounded-lg border border-hairline bg-panel p-2.5 space-y-1.5 text-[12px]">
          <div className="flex items-start justify-between gap-2">
            <span className="text-ink-faint shrink-0">{t('st.im.rebind.variant')}</span>
            <span className="font-normal text-ink truncate text-right" title={conflict?.variant_label ?? (candidate ? formatImIdentityDisplay(candidate.identity).fullTitle : undefined)}>{variantLabel}</span>
          </div>
          <div className="flex items-start justify-between gap-2">
            <span className="text-ink-faint shrink-0">{t('st.im.rebind.identity')}</span>
            <span className="font-mono text-[11px] text-ink-soft truncate text-right" title={rawIdentityDetail}>{compactIdentityDetail}</span>
          </div>
          <div className="flex items-start justify-between gap-2">
            <span className="text-ink-faint shrink-0">{t('st.im.rebind.currentOwner')}</span>
            <span className="text-ink-soft truncate text-right" title={previousSessionId}>{previousSession}</span>
          </div>
          <div className="flex items-start justify-between gap-2">
            <span className="text-ink-faint shrink-0">{t('st.im.rebind.targetOwner')}</span>
            <span className="font-normal text-selected-ink truncate text-right" title={targetSessionId}>{targetSession}</span>
          </div>
        </div>
      </div>
    </ConfirmDialog>
  );
});
