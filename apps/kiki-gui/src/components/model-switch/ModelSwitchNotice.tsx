/**
 * ModelSwitchNotice — the timeline row for one model-switch operation. Same
 * divider rule as every other notice; the state decides the copy, and only
 * actionable states grow a quiet action row underneath:
 *
 *   pending    "空闲时切换到 B · 方式" with 更改 / 取消
 *   preparing  the honest in-flight line — no cancel: by contract only a
 *              pending operation can be cancelled
 *   completed  per-mode done line (same-model fresh reads as a new context)
 *   failed     what failed + why, with 重试 / 使用全新上下文 / 保留原模型
 *   cancelled  one neutral line
 *
 * Actions arrive through ModelSwitchActionsContext so the Transcript renderer
 * stays presentational; without a provider the row is copy only.
 */

import { createContext, memo, useContext } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import type { NoticeBlock } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { TimelineDivider } from '../timeline/ActivityRow';

export interface ModelSwitchNoticeActions {
  /** Edit a pending operation (reopens the switch panel). */
  readonly edit?: (operationId: string) => void;
  /** Cancel a pending operation. */
  readonly cancel?: (operationId: string) => void;
  /** Retry a failed operation with its accepted input. */
  readonly retry?: (operationId: string) => void;
  /** Retry a failed operation as a fresh-context switch (same operation id). */
  readonly retryAsFresh?: (operationId: string) => void;
  /** Release dependent messages back onto the original binding. */
  readonly keepOriginal?: (operationId: string) => void;
  /** Operation with an in-flight action; its buttons hold disabled. */
  readonly pendingOperationId?: string;
}

export const ModelSwitchActionsContext = createContext<ModelSwitchNoticeActions | undefined>(undefined);

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
  'h-6 rounded-md px-1.5 text-[12px] font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-8';

export const ModelSwitchNotice = memo(function ModelSwitchNotice({ block }: { readonly block: NoticeBlock }) {
  const { t, time } = useI18n();
  const actions = useContext(ModelSwitchActionsContext);
  const info = block.modelSwitch;
  if (info === undefined) return null;
  const params = { from: info.from, to: info.to };
  const primary = t(primaryKey(info), params);
  const detail = detailKey(info);
  const pendingAction = actions?.pendingOperationId === info.operationId;
  const modeName = t(`modelSwitch.modeName.${info.mode}` as I18nKey);

  const row = (
    label: string, run: ((operationId: string) => void) | undefined, dataAttr: string,
  ) => run === undefined ? null : (
    <button
      key={dataAttr}
      type="button"
      data-model-switch-action={dataAttr}
      disabled={pendingAction}
      onClick={() => { run(info.operationId); }}
      className={ACTION_CLASS}
    >
      {label}
    </button>
  );

  return (
    <div data-model-switch-notice={info.state} data-model-switch-operation={info.operationId}>
      <TimelineDivider
        tone={info.state === 'failed' ? 'warn' : 'plain'}
        title={time.absoluteTime(block.createdAt)}
        attrs={{ 'data-notice-key': 'transcript.marker.modelSwitch' }}
      >
        <span className={info.state === 'failed' ? 'font-medium' : undefined}>
          {info.state === 'pending' ? `${primary} · ${modeName}` : primary}
        </span>
      </TimelineDivider>
      {detail !== undefined || info.error !== undefined ? (
        <p data-model-switch-detail className="mt-0.5 mb-1 pl-[1.4em] text-[12px] leading-snug text-ink-faint">
          {detail !== undefined ? t(detail, params) : null}
          {info.error !== undefined ? (
            <span className={detail !== undefined ? 'ml-1' : undefined}>{info.error.message}</span>
          ) : null}
        </p>
      ) : null}
      {info.state === 'pending' && (actions?.edit !== undefined || actions?.cancel !== undefined) ? (
        <div data-model-switch-actions className="mt-0.5 mb-1 flex items-center gap-1 pl-[1.4em]">
          {row(t('modelSwitch.action.edit'), actions.edit, 'edit')}
          {row(t('modelSwitch.action.cancel'), actions.cancel, 'cancel')}
        </div>
      ) : null}
      {info.state === 'failed' && actions !== undefined ? (
        <div data-model-switch-actions className="mt-0.5 mb-1 flex flex-wrap items-center gap-1 pl-[1.4em]">
          {row(t('modelSwitch.action.retry'), actions.retry, 'retry')}
          {row(t('modelSwitch.action.useFresh'), actions.retryAsFresh, 'retry-fresh')}
          {row(t('modelSwitch.action.keepOriginal'), actions.keepOriginal, 'keep-original')}
        </div>
      ) : null}
    </div>
  );
});
