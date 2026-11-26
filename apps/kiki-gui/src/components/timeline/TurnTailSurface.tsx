import { memo, useMemo } from 'react';

import type { SessionInterruptedWork } from '@kiki/protocol';
import {
  resolveRecoverableInterruption,
  type TurnReplyGap,
  type TurnTailInfo,
  type UserBlock,
} from '@kiki/session-core/session';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { decodeFullDiagnostic } from '../agent-panel/failureText';
import { Icon } from '../icons';
import { RelativeTime } from '../RelativeTime';
import { ActivityRow } from './ActivityRow';
import { TimelineErrorCallout, type TimelineErrorAction } from './TimelineErrorCallout';
import { TurnFootnote } from './TurnFootnote';

const CANCELLATION_LABEL_KEY = {
  user: 'transcript.stopped',
  aborted: 'transcript.interrupted',
  recovery: 'transcript.interruptedByRestart',
  unknown: 'transcript.interrupted',
} as const satisfies Record<NonNullable<TurnTailInfo['cancellation']>, I18nKey>;

export interface TurnTailSurfaceProps {
  readonly agentId: string;
  readonly tail?: TurnTailInfo;
  readonly gap?: TurnReplyGap;
  readonly interruptedWork?: SessionInterruptedWork;
  readonly promptQueueHold?: { readonly reason: 'recovery'; readonly count: number };
  readonly readOnly?: boolean;
  readonly busy?: boolean;
  readonly footnoteAttachedInline?: boolean;
  readonly failedTurnUserBlock?: UserBlock;
  readonly failedHasWork?: boolean;
  readonly hasOriginalRetry?: boolean;
  readonly hasDraftRestore?: boolean;
  readonly retryDisabled?: boolean;
  readonly resumeDisabled?: boolean;
  readonly recoveringInterruption?: boolean;
  readonly onContinueFailed?: () => void;
  readonly onRetryFailed?: (failedUserBlock: UserBlock | undefined) => void;
  readonly onRestoreDraft?: () => void;
  readonly onOpenModelPicker?: () => void;
  readonly onOpenProviderSettings?: () => void;
  readonly onCompactContext?: () => void;
  readonly onResumeStopped?: () => void;
  readonly onRecoverInterruption?: () => void;
  readonly errorOpen?: boolean;
  readonly onToggleErrorOpen?: () => void;
  readonly announceNew?: boolean;
}

export function canFaithfullyRetryUserBlock(
  block: UserBlock | undefined,
  allowRegenerate = true,
): boolean {
  if (block === undefined) return false;
  if (allowRegenerate && block.userMessageId !== undefined) return true;
  if ((block.media?.length ?? 0) > 0) return false;
  if (block.contentPending === true) return false;
  if (Array.isArray(block.queuedContent) && block.queuedContent.some((part) => part.type !== 'text')) {
    return false;
  }
  return block.text.trim() !== '';
}

export function hasTurnTailSurfaceContent(input: {
  readonly agentId: string;
  readonly tail?: TurnTailInfo;
  readonly interruptedWork?: SessionInterruptedWork;
  readonly promptQueueHold?: { readonly reason: 'recovery'; readonly count: number };
  readonly busy?: boolean;
  readonly footnoteAttachedInline?: boolean;
}): boolean {
  if (input.busy === true) return false;
  const recovery = resolveRecoverableInterruption({
    agentId: input.agentId,
    turnTail: input.tail,
    interruptedWork: input.interruptedWork,
    promptQueueHold: input.promptQueueHold,
  });
  if (recovery.recoverable) return true;
  if (input.tail === undefined) return false;
  if (input.tail.state === 'failed' || input.tail.state === 'cancelled') return true;
  return input.footnoteAttachedInline !== true;
}

export const TurnTailSurface = memo(function TurnTailSurface({
  agentId,
  tail,
  gap: replyGap,
  interruptedWork,
  promptQueueHold,
  readOnly = false,
  busy = false,
  footnoteAttachedInline = false,
  failedTurnUserBlock,
  failedHasWork = false,
  hasOriginalRetry = false,
  hasDraftRestore = false,
  retryDisabled = false,
  resumeDisabled = false,
  recoveringInterruption = false,
  onContinueFailed,
  onRetryFailed,
  onRestoreDraft,
  onOpenModelPicker,
  onOpenProviderSettings,
  onCompactContext,
  onResumeStopped,
  onRecoverInterruption,
  errorOpen,
  onToggleErrorOpen,
  announceNew = false,
}: TurnTailSurfaceProps) {
  const { t, time } = useI18n();

  const recovery = useMemo(
    () => resolveRecoverableInterruption({
      agentId,
      turnTail: tail,
      interruptedWork,
      promptQueueHold,
    }),
    [agentId, tail, interruptedWork, promptQueueHold],
  );

  const diagnostic = useMemo(
    () => (tail?.state === 'failed' ? decodeFullDiagnostic(tail.error, tail.errorDetails) : undefined),
    [tail?.state, tail?.error, tail?.errorDetails],
  );

  if (busy) return null;

  const isFailed = tail?.state === 'failed';
  const isCancelled = tail?.state === 'cancelled';
  const cancellation = tail?.cancellation ?? 'unknown';
  const isRecoveryCancelled = isCancelled && cancellation === 'recovery';

  const recoverySummary = recovery.lostTasks > 0
    ? t('transcript.interruptedTasksSummary', { count: recovery.lostTasks })
    : recovery.interruptedBranches > 0
      ? t('transcript.interruptedBranchesSummary', { count: recovery.interruptedBranches })
      : t('transcript.interruptedByRestart');

  const recoveryDetailLines = recovery.targets.map((target) => {
    const targetName = target.label ?? target.agent_id;
    const tasksPart = target.lost_tasks !== undefined && target.lost_tasks > 0 ? ` (${target.lost_tasks})` : '';
    return `${targetName}${tasksPart}`;
  });

  if (isFailed && tail !== undefined) {
    const actions: TimelineErrorAction[] = [];
    const canMutate = !readOnly && !retryDisabled;
    const category = diagnostic?.category ?? 'unknown';

    const canRetryNow = hasOriginalRetry && (
      failedTurnUserBlock === undefined ||
      canFaithfullyRetryUserBlock(failedTurnUserBlock, agentId === 'main')
    );

    if (canMutate) {
      const canSwitchModel = (category === 'capacity' || category === 'rate_limit' || category === 'quota') && onOpenModelPicker !== undefined;
      const canOpenProvider = category === 'auth' && onOpenProviderSettings !== undefined;
      const canCompact = category === 'context_limit' && onCompactContext !== undefined;
      const primaryActionId = canOpenProvider
        ? 'provider-settings'
        : canCompact
          ? 'compact-context'
          : (category === 'capacity' || category === 'quota') && canSwitchModel
            ? 'switch-model'
            : failedHasWork && onContinueFailed !== undefined
              ? 'continue'
              : canRetryNow && onRetryFailed !== undefined
                ? 'retry'
                : hasDraftRestore && onRestoreDraft !== undefined
                  ? 'restore-draft'
                  : canSwitchModel
                    ? 'switch-model'
                    : undefined;

      if (failedHasWork && onContinueFailed !== undefined) {
        actions.push({
          id: 'continue',
          label: t('transcript.error.continue'),
          onClick: onContinueFailed,
          primary: primaryActionId === 'continue',
          dataAttr: 'data-turn-tail-continue',
        });
      }
      if (canRetryNow && onRetryFailed !== undefined) {
        actions.push({
          id: 'retry',
          label: t('transcript.error.retry'),
          onClick: () => { onRetryFailed(failedTurnUserBlock); },
          primary: primaryActionId === 'retry',
          dataAttr: 'data-turn-tail-retry-now',
        });
      } else if (hasDraftRestore && onRestoreDraft !== undefined) {
        actions.push({
          id: 'restore-draft',
          label: t('transcript.error.restoreDraft'),
          onClick: onRestoreDraft,
          primary: primaryActionId === 'restore-draft',
          dataAttr: 'data-turn-tail-retry',
        });
      }
      if (canSwitchModel) {
        actions.push({
          id: 'switch-model',
          label: t('transcript.error.switchModel'),
          onClick: onOpenModelPicker,
          primary: primaryActionId === 'switch-model',
          dataAttr: 'data-turn-tail-switch-model',
        });
      }
      if (canOpenProvider) {
        actions.push({
          id: 'provider-settings',
          label: t('transcript.error.providerSettings'),
          onClick: onOpenProviderSettings,
          primary: primaryActionId === 'provider-settings',
          dataAttr: 'data-turn-tail-provider-settings',
        });
      }
      if (canCompact) {
        actions.push({
          id: 'compact-context',
          label: t('transcript.error.compactContext'),
          onClick: onCompactContext,
          primary: primaryActionId === 'compact-context',
          dataAttr: 'data-turn-tail-compact',
        });
      }
    }

    if (!readOnly && recovery.recoverable && onRecoverInterruption !== undefined) {
      actions.push({
        id: 'recover',
        label: recoveringInterruption
          ? t('transcript.recoveringInterruption')
          : t('transcript.recoverInterruption'),
        onClick: onRecoverInterruption,
        disabled: resumeDisabled || recoveringInterruption,
        busy: recoveringInterruption,
        dataAttr: 'data-interruption-recover',
      });
    }

    const extraErrorDetails = recovery.recoverable && recoveryDetailLines.length > 0
      ? [tail.errorDetails, `${recoverySummary}: ${recoveryDetailLines.join(', ')}`].filter(Boolean).join('\n\n')
      : tail.errorDetails;

    return (
      <div data-turn-tail data-turn-tail-state="failed">
        <TimelineErrorCallout
          incidentId={`turn-tail-${tail.turnId}`}
          severity="error"
          message={tail.error}
          errorDetails={extraErrorDetails}
          createdAt={tail.endedAt}
          announce={announceNew}
          actions={actions}
          rawOpen={errorOpen}
          onToggleRawOpen={onToggleErrorOpen}
        />
      </div>
    );
  }

  if (recovery.recoverable) {
    const recoveryActions: TimelineErrorAction[] = [];
    const recoverHandler = onRecoverInterruption ?? (isRecoveryCancelled ? onResumeStopped : undefined);
    if (!readOnly && recoverHandler !== undefined) {
      recoveryActions.push({
        id: 'recover',
        label: recoveringInterruption
          ? t('transcript.recoveringInterruption')
          : onRecoverInterruption !== undefined
            ? t('transcript.recoverInterruption')
            : t('transcript.resume'),
        onClick: recoverHandler,
        primary: true,
        disabled: resumeDisabled || recoveringInterruption,
        busy: recoveringInterruption,
        dataAttr: onRecoverInterruption !== undefined ? 'data-interruption-recover' : 'data-turn-tail-resume',
        attrs: isRecoveryCancelled && onRecoverInterruption !== undefined
          ? { 'data-turn-tail-resume': '' }
          : undefined,
      });
    }
    const recoveryBody = recoveryDetailLines.length > 0
      ? recoveryDetailLines.join(' · ')
      : recoverySummary;
    return (
      <div
        data-turn-tail={isRecoveryCancelled ? '' : undefined}
        data-turn-tail-state={isRecoveryCancelled ? 'cancelled' : undefined}
        data-interruption-recovery=""
      >
        <TimelineErrorCallout
          incidentId={`recovery-${tail?.turnId ?? agentId}`}
          severity="warn"
          title={recoverySummary}
          message={recoveryBody}
          createdAt={tail?.endedAt ?? interruptedWork?.interrupted_at}
          announce={announceNew}
          actions={recoveryActions}
        />
      </div>
    );
  }

  if (isCancelled && tail !== undefined) {
    const label = t(CANCELLATION_LABEL_KEY[cancellation]);
    return (
      <div data-turn-tail data-turn-tail-state="cancelled">
        <ActivityRow
          glyph={<span aria-hidden className="inline-block h-2 w-2 rounded-[2px] bg-ink-faint" />}
          label={<span data-turn-tail-cancellation={cancellation}>{label}</span>}
          meta={tail.endedAt !== '' ? <RelativeTime at={tail.endedAt} /> : undefined}
          metaTitle={time.absoluteTime(tail.endedAt)}
          aside={!readOnly && onResumeStopped !== undefined ? (
            <button
              type="button"
              data-turn-tail-resume=""
              onClick={onResumeStopped}
              disabled={resumeDisabled}
              title={t('transcript.resumeTitle')}
              className="inline-flex min-h-7 min-w-7 cursor-pointer items-center rounded-[6px] border border-hairline bg-paper px-2 text-[12px] leading-[16px] font-normal text-ink-soft transition-colors hover:border-hairline-strong hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-55 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            >
              {t('transcript.resume')}
            </button>
          ) : undefined}
        />
      </div>
    );
  }

  if (tail !== undefined && !footnoteAttachedInline) {
    return (
      <TurnFootnote
        tail={tail}
        gap={replyGap}
        onRetryGap={!readOnly ? onRestoreDraft : undefined}
        retryDisabled={retryDisabled}
      />
    );
  }

  return null;
});
