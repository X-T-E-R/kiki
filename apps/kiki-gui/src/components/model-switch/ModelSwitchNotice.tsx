import { createContext, memo, useContext, useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import type { NoticeBlock } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import { ActivityRow, TimelineDivider } from '../timeline/ActivityRow';
import { CopyButton } from '../timeline/ContentCopyButton';
import { useResolvedModelDisplay } from '../timeline/ModelDisplayContext';
import {
  ModelSwitchActionsContext,
  type ModelSwitchNoticeActions,
} from '../timeline/transcriptDeliveryContext';
import { TimelineErrorCallout, type TimelineErrorAction } from '../timeline/TimelineErrorCallout';

export { ModelSwitchActionsContext, type ModelSwitchNoticeActions };

type ModelSwitchBlock = NonNullable<NoticeBlock['modelSwitch']>;

function primaryKey(info: ModelSwitchBlock): I18nKey {
  const sameModel = info.from === info.to;
  switch (info.state) {
    case 'pending': return sameModel ? 'transcript.modelSwitch.pending.binding' : 'transcript.modelSwitch.pending';
    case 'preparing':
      return info.mode === 'compact'
        ? 'transcript.modelSwitch.preparing.compact'
        : info.mode === 'fresh'
          ? 'transcript.modelSwitch.preparing.fresh'
          : sameModel ? 'transcript.modelSwitch.preparing.binding' : 'transcript.modelSwitch.preparing.direct';
    case 'completed':
      if (!sameModel) return 'transcript.modelSwitch.done';
      if (info.mode === 'fresh') return 'transcript.modelSwitch.done.sameModelFresh';
      if (info.mode === 'compact') return 'transcript.modelSwitch.done.sameModelCompact';
      if (info.change === 'effort') return 'transcript.modelSwitch.done.effort';
      return info.change === 'resume' || info.operationId.startsWith('resume:') ? 'transcript.modelSwitch.done.resume' : 'transcript.modelSwitch.done.binding';
    case 'failed':
      return info.mode === 'compact' ? 'transcript.modelSwitch.failed.compact' : sameModel ? 'transcript.modelSwitch.failed.binding' : 'transcript.modelSwitch.failed';
    case 'cancelled': return sameModel ? 'transcript.modelSwitch.cancelled.binding' : 'transcript.modelSwitch.cancelled';
  }
}

function detailKey(info: ModelSwitchBlock): I18nKey | undefined {
  if (info.state !== 'completed') return undefined;
  if (info.from === info.to && info.mode === 'fresh') return 'transcript.modelSwitch.done.sameModelFreshHint';
  if (info.mode === 'direct') return 'transcript.modelSwitch.done.direct';
  if (info.mode === 'fresh') return 'transcript.modelSwitch.done.fresh';
  return info.summaryGenerated === false
    ? 'transcript.modelSwitch.done.compactNone'
    : 'transcript.modelSwitch.done.compact';
}

const ACTION_CLASS =
  'inline-flex min-h-7 min-w-7 cursor-pointer items-center justify-center rounded-[6px] border border-hairline bg-paper px-2 text-[12px] leading-[16px] font-normal text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:border-hairline-strong hover:bg-ink/[0.04] hover:text-ink disabled:cursor-default disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-3';

export const ModelSwitchNotice = memo(function ModelSwitchNotice({
  block,
  superseded = false,
}: {
  readonly block: NoticeBlock;
  readonly superseded?: boolean;
}) {
  const { t, time } = useI18n();
  const actions = useContext(ModelSwitchActionsContext);
  const [techOpen, setTechOpen] = useState(false);
  const info = block.modelSwitch;
  const fromResolved = useResolvedModelDisplay(info?.from);
  const toResolved = useResolvedModelDisplay(info?.to);
  if (info === undefined) return null;

  const sameModel = info.from === info.to;
  const params = { from: fromResolved.label, to: toResolved.label };
  const primary = t(primaryKey(info), params);
  const detail = detailKey(info);
  const pendingAction = actions?.pendingOperationId === info.operationId;
  const modeName = t(`modelSwitch.modeName.${info.mode}` as I18nKey);
  const rawIdsLine = sameModel ? info.to : `${info.from} → ${info.to}`;
  const isEpoch = info.state === 'completed' && (!sameModel || info.mode === 'fresh' || info.mode === 'compact');

  if (info.state === 'failed') {
    const rawDetailParts = [
      info.error?.code !== undefined ? `code=${info.error.code}` : undefined,
      `operationId=${info.operationId}`,
      `mode=${info.mode}`,
      `from=${info.from}`,
      `to=${info.to}`,
    ].filter((part): part is string => part !== undefined);
    const rawDetailText = rawDetailParts.join('\n');
    if (superseded) {
      return (
        <div data-model-switch-notice="failed" data-model-switch-operation={info.operationId}>
          <ActivityRow
            glyph={<Icon name="warning" size={12} />}
            tone="plain"
            label={primary}
            detail={info.error?.message}
            title={[time.absoluteTime(block.createdAt), rawIdsLine].filter(Boolean).join('\n')}
            expanded={techOpen}
            onToggle={() => { setTechOpen((value) => !value); }}
            attrs={{ 'data-notice-key': 'transcript.marker.modelSwitch', 'data-notice-superseded': 'true' }}
          >
            {techOpen ? (
              <div data-model-switch-tech className="flex items-start gap-2 border-l border-hairline pl-3 text-[12px] leading-[16px] text-ink-faint">
                <span className="min-w-0 flex-1 select-text font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{rawDetailText}</span>
                <CopyButton text={rawDetailText} label={primary} />
              </div>
            ) : undefined}
          </ActivityRow>
        </div>
      );
    }
    const errorActions: TimelineErrorAction[] = [];
    if (actions?.retry !== undefined) {
      errorActions.push({
        id: 'retry',
        label: t('modelSwitch.action.retry'),
        onClick: () => { actions.retry?.(info.operationId); },
        primary: true,
        disabled: pendingAction,
        busy: pendingAction,
        dataAttr: 'data-model-switch-action',
      });
    }
    if (actions?.retryAsFresh !== undefined) {
      errorActions.push({
        id: 'retry-fresh',
        label: t('modelSwitch.action.useFresh'),
        onClick: () => { actions.retryAsFresh?.(info.operationId); },
        disabled: pendingAction,
        confirmMessage: t('transcript.error.freshSwitchConfirm'),
        confirmLabel: t('modelSwitch.action.useFresh'),
        dataAttr: 'data-model-switch-action',
      });
    }
    if (actions?.keepOriginal !== undefined) {
      errorActions.push({
        id: 'keep-original',
        label: t('modelSwitch.action.keepOriginal'),
        onClick: () => { actions.keepOriginal?.(info.operationId); },
        disabled: pendingAction,
        dataAttr: 'data-model-switch-action',
      });
    }
    return (
      <div data-model-switch-notice="failed" data-model-switch-operation={info.operationId}>
        <TimelineErrorCallout
          incidentId={`model-switch-${info.operationId}`}
          severity="error"
          title={primary}
          message={info.error?.message}
          errorDetails={rawDetailText}
          createdAt={block.createdAt}
          superseded={false}
          actions={errorActions}
          attrs={{ 'data-notice-key': 'transcript.marker.modelSwitch' }}
        />
      </div>
    );
  }

  if (isEpoch) {
    return (
      <div data-model-switch-notice={info.state} data-model-switch-operation={info.operationId}>
        <TimelineDivider
          tone="plain"
          title={[time.absoluteTime(block.createdAt), rawIdsLine].filter(Boolean).join('\n')}
          attrs={{ 'data-notice-key': 'transcript.marker.modelSwitch' }}
        >
          <button
            type="button"
            aria-expanded={techOpen}
            onClick={() => { setTechOpen((value) => !value); }}
            className="inline-flex min-h-7 min-w-7 cursor-pointer items-center gap-1 rounded-[6px] px-1.5 text-[12px] leading-[16px] font-normal text-ink-faint transition-colors hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
          >
            <span>{primary}</span>
            {detail !== undefined ? <span data-model-switch-detail>· {t(detail, params)}</span> : null}
          </button>
        </TimelineDivider>
        {techOpen ? (
          <div data-model-switch-tech className="mt-1 flex items-center justify-center gap-2 text-[12px] leading-[16px] text-ink-faint">
            <span className="select-text font-mono [overflow-wrap:anywhere]">{rawIdsLine}</span>
            <CopyButton text={rawIdsLine} label={primary} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div data-model-switch-notice={info.state} data-model-switch-operation={info.operationId}>
      <ActivityRow
        glyph={<Icon name={info.state === 'preparing' ? 'clock' : 'sliders'} size={12} />}
        label={primary}
        detail={info.state === 'pending' ? modeName : detail !== undefined ? t(detail, params) : undefined}
        title={[time.absoluteTime(block.createdAt), rawIdsLine].filter(Boolean).join('\n')}
        expanded={techOpen}
        onToggle={() => { setTechOpen((value) => !value); }}
        attrs={{ 'data-notice-key': 'transcript.marker.modelSwitch' }}
        aside={info.state === 'pending' && (actions?.edit !== undefined || actions?.cancel !== undefined) ? (
          <span data-model-switch-actions className="flex shrink-0 items-center gap-1">
            {actions.edit !== undefined ? (
              <button
                type="button"
                data-model-switch-action="edit"
                disabled={pendingAction}
                onClick={() => { actions.edit?.(info.operationId); }}
                className={ACTION_CLASS}
              >
                {t('modelSwitch.action.edit')}
              </button>
            ) : null}
            {actions.cancel !== undefined ? (
              <button
                type="button"
                data-model-switch-action="cancel"
                disabled={pendingAction}
                onClick={() => { actions.cancel?.(info.operationId); }}
                className={ACTION_CLASS}
              >
                {t('modelSwitch.action.cancel')}
              </button>
            ) : null}
          </span>
        ) : undefined}
      >
        {techOpen ? (
          <div data-model-switch-tech className="flex items-center gap-2 border-l border-hairline pl-3 text-[12px] leading-[16px] text-ink-faint">
            <span className="select-text font-mono [overflow-wrap:anywhere]">{rawIdsLine}</span>
            <CopyButton text={rawIdsLine} label={primary} />
          </div>
        ) : undefined}
      </ActivityRow>
    </div>
  );
});
