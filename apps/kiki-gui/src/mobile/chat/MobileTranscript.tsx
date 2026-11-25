import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { ApprovalDecision, SessionInterruptedWork } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import { isNativeExecutor } from '@kiki/session-core/composer';
import type { CatalogModelLike } from '@kiki/session-core/settings';
import {
  buildNoticePlacementContext,
  classifyNoticePlacement,
  hasConfirmedSubsequentSuccess,
  hasSubsequentCompactionResolution,
  hasSubsequentModelSwitchResolution,
  latestUnresolvedCompactionId,
  resolveInjectionHeading,
  turnReplyGap,
  type ActivitySummary,
  type ApprovalBlock,
  type Block,
  type MessageBlock,
  type NoticeBlock,
  type NoticePlacementContext,
  type SessionViewState,
  type SkillBlock,
  type SystemBlock,
  type SystemReminderBlock,
  type ToolBlock,
  type TurnTailInfo,
  type UserBlock,
} from '@kiki/session-core/session';

import { DisclosureChevron, Icon } from '../../components/icons';
import { Markdown } from '../../components/Markdown';
import { buildMessageNodes } from '../../components/message/messageTimeline';
import { ModelSwitchNotice } from '../../components/model-switch/ModelSwitchNotice';
import { RelativeTime } from '../../components/RelativeTime';
import { ActivityRow, TimelineDivider } from '../../components/timeline/ActivityRow';
import { CopyButton } from '../../components/timeline/ContentCopyButton';
import { ModelDisplayProvider, useResolvedModelDisplay } from '../../components/timeline/ModelDisplayContext';
import { EarlierPromptOutcomesRow, PromptOutcomeLine } from '../../components/timeline/PromptOutcome';
import { TimelineErrorCallout, type TimelineErrorAction } from '../../components/timeline/TimelineErrorCallout';
import { TurnFootnote } from '../../components/timeline/TurnFootnote';
import { canFaithfullyRetryUserBlock, TurnTailSurface } from '../../components/timeline/TurnTailSurface';
import { useI18n } from '../../i18n';
import { isInlineDecidable, summarizeApproval } from '../approvalSummary';
import { ApprovalHeadline, RejectReasonSheet } from '../components/ApprovalParts';
import { extractFileChanges, type HoodTab } from './LiftTheHoodSheet';
import { MobileQuestionCard, type QuestionAnswers } from './MobileQuestionCard';

interface MobileTranscriptProps {
  readonly state?: SessionViewState;
  readonly blocks: readonly Block[];
  readonly loaded: boolean;
  readonly loadError?: string;
  readonly busy: boolean;
  readonly hasMoreHistory: boolean;
  readonly loadingOlder: boolean;
  readonly messageMode: boolean;
  readonly personaName?: string;
  readonly greeting?: MessageBlock;
  readonly readOnly?: boolean;
  readonly connected?: boolean;
  readonly modelCatalog?: readonly CatalogModelLike[];
  readonly modelCatalogScope?: string;
  readonly interruptedWork?: SessionInterruptedWork;
  readonly recoveringInterruption?: boolean;
  readonly onLoadOlder: () => void;
  readonly onRetryLoad?: () => void;
  readonly onOpenHood: (tab: HoodTab, changeId?: string) => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalDecision, reason?: string) => void;
  readonly onAnswerQuestion: (questionId: string, answers: QuestionAnswers) => Promise<void>;
  readonly onDismissQuestion: (questionId: string) => Promise<void>;
  readonly onOpenWorkbench: () => void;
  readonly onContinueFailedTurn?: () => void;
  readonly onRetryFailedTurn?: (failedUserBlock: UserBlock | undefined) => void;
  readonly onRestoreDraft?: (text: string) => void;
  readonly onOpenModelPicker?: () => void;
  readonly onOpenProviderSettings?: () => void;
  readonly onRecoverInterruption?: () => void;
  readonly onRetryCompaction?: (strategy: 'summarize' | 'relay') => void;
}

type MobileFoldedDetailItem = SystemReminderBlock | SystemBlock | SkillBlock | NoticeBlock;

type RenderEntry =
  | { readonly kind: 'block'; readonly block: Block; readonly turnId?: string }
  | {
      readonly kind: 'steps';
      readonly id: string;
      readonly turnId?: string;
      readonly count: number;
      readonly running?: ToolBlock;
      readonly single?: ToolBlock;
      readonly injections: readonly MobileFoldedDetailItem[];
    };

function normTurn(turnId: string | undefined): string | undefined {
  if (turnId === undefined || turnId === '') return undefined;
  return turnId.startsWith('t') ? turnId : `t${turnId}`;
}

function blockTurnId(block: Block): string | undefined {
  if (block.kind === 'subagent') return normTurn(block.parentTurnId);
  if (block.kind === 'approval' || block.kind === 'question') {
    return block.request.turn_id === undefined ? undefined : `t${block.request.turn_id}`;
  }
  return normTurn(block.turnId);
}

function groupReplyBlocks(
  blocks: readonly Block[],
  placementContext: NoticePlacementContext,
): readonly RenderEntry[] {
  const entries: RenderEntry[] = [];
  let pendingTools: ToolBlock[] = [];
  let pendingThinking = 0;
  let pendingInjections: MobileFoldedDetailItem[] = [];
  let pendingTurn: string | undefined;

  const flushGroup = () => {
    if (pendingTools.length === 0 && pendingThinking === 0 && pendingInjections.length === 0) return;
    const firstId = pendingTools[0]?.id ?? pendingInjections[0]?.id ?? `think-${entries.length}`;
    entries.push({
      kind: 'steps',
      id: `grp-${firstId}`,
      turnId: pendingTurn,
      count: pendingTools.length + pendingThinking + pendingInjections.length,
      running: pendingTools.find((tool) => tool.status === 'running'),
      single:
        pendingTools.length === 1 && pendingThinking === 0 && pendingInjections.length === 0
          ? pendingTools[0]
          : undefined,
      injections: pendingInjections,
    });
    pendingTools = [];
    pendingThinking = 0;
    pendingInjections = [];
    pendingTurn = undefined;
  };

  for (const block of blocks) {
    const turn = blockTurnId(block);
    if (block.kind === 'tool') {
      if (pendingTurn !== undefined && turn !== undefined && pendingTurn !== turn) flushGroup();
      pendingTurn ??= turn;
      pendingTools.push(block);
      continue;
    }
    if (block.kind === 'thinking') {
      if (pendingTurn !== undefined && turn !== undefined && pendingTurn !== turn) flushGroup();
      pendingTurn ??= turn;
      pendingThinking += 1;
      continue;
    }
    if (block.kind === 'system-reminder' || block.kind === 'skill') {
      if (pendingTurn !== undefined && turn !== undefined && pendingTurn !== turn) flushGroup();
      pendingTurn ??= turn;
      pendingInjections.push(block);
      continue;
    }
    if (block.kind === 'system') {
      if (block.variant === 'compaction_summary') {
        flushGroup();
        entries.push({ kind: 'block', block, turnId: turn });
        continue;
      }
      if (pendingTurn !== undefined && turn !== undefined && pendingTurn !== turn) flushGroup();
      pendingTurn ??= turn;
      pendingInjections.push(block);
      continue;
    }
    if (block.kind === 'notice' && classifyNoticePlacement(block, placementContext) === 'foldable') {
      if (pendingTurn !== undefined && turn !== undefined && pendingTurn !== turn) flushGroup();
      pendingTurn ??= turn;
      pendingInjections.push(block);
      continue;
    }
    flushGroup();
    entries.push({ kind: 'block', block, turnId: turn });
  }
  flushGroup();
  return entries;
}

function messageModeEntries(
  blocks: readonly Block[],
  busy: boolean,
  personaName: string | undefined,
  failedTurnIds?: readonly string[],
): readonly RenderEntry[] {
  const entries: RenderEntry[] = [];
  for (const node of buildMessageNodes(blocks, { busy, personaName, failedTurnIds })) {
    if (node.kind === 'activity-summary') {
      const summary = node as ActivitySummary;
      const tools = summary.members.filter((member): member is ToolBlock => member.kind === 'tool');
      const injections = summary.members.filter(
        (member): member is MobileFoldedDetailItem =>
          member.kind === 'system-reminder' ||
          member.kind === 'system' ||
          member.kind === 'skill' ||
          member.kind === 'notice',
      );
      entries.push({
        kind: 'steps',
        id: `act-${summary.id}`,
        turnId: normTurn(summary.turnId),
        count: Math.max(1, summary.members.length),
        running: busy ? tools.find((tool) => tool.status === 'running') : undefined,
        single: tools.length === 1 && summary.members.length === 1 ? tools[0] : undefined,
        injections,
      });
      continue;
    }
    const block = node as Block;
    entries.push({ kind: 'block', block, turnId: blockTurnId(block) });
  }
  return entries;
}

function toolLabel(tool: ToolBlock): string {
  return tool.description ? `${tool.name} · ${tool.description}` : tool.name;
}

const GOAL_CHANGE_KEY: Record<string, I18nKey> = {
  created: 'transcript.marker.goal.created',
  updated: 'transcript.marker.goal.updated',
  paused: 'transcript.marker.goal.paused',
  resumed: 'transcript.marker.goal.resumed',
  blocked: 'transcript.marker.goal.blocked',
  completed: 'transcript.marker.goal.completed',
  cleared: 'transcript.marker.goal.cleared',
};

function MobileNoticeRow({
  block,
  blocks,
  placementContext,
  turnTerminals,
  latestFailedCompactionId,
  readOnly,
  onRetryCompaction,
}: {
  readonly block: NoticeBlock;
  readonly blocks: readonly Block[];
  readonly placementContext: NoticePlacementContext;
  readonly turnTerminals?: Readonly<Record<string, TurnTailInfo>>;
  readonly latestFailedCompactionId?: string;
  readonly readOnly: boolean;
  readonly onRetryCompaction?: (strategy: 'summarize' | 'relay') => void;
}) {
  const { t, time } = useI18n();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const fromResolved = useResolvedModelDisplay(block.modelSwitchFrom);
  const toResolved = useResolvedModelDisplay(block.modelSwitchTo);

  if (block.earlierPromptOutcomes !== undefined) {
    return <EarlierPromptOutcomesRow block={block} />;
  }
  if (block.modelSwitch !== undefined) {
    const superseded = block.modelSwitch.state === 'failed' && hasSubsequentModelSwitchResolution(blocks, block.id);
    return <ModelSwitchNotice block={block} superseded={superseded} />;
  }
  if (block.executor !== undefined) {
    if (block.executor.kind === 'compaction') {
      return (
        <TimelineDivider title={time.absoluteTime(block.createdAt)} attrs={{ 'data-executor-note': 'compaction' }}>
          {t('transcript.exec.compacted')}
        </TimelineDivider>
      );
    }
    return null;
  }

  const placement = classifyNoticePlacement(block, placementContext);
  const isLegacyModelSwitch =
    block.modelSwitch === undefined && block.modelSwitchFrom !== undefined && block.modelSwitchTo !== undefined;
  const fullText = block.goalChange !== undefined
    ? t(GOAL_CHANGE_KEY[block.goalChange.kind] ?? 'transcript.marker.goal')
    : isLegacyModelSwitch && block.i18n !== undefined
      ? t(block.i18n.key, { ...block.i18n.params, from: fromResolved.label, to: toResolved.label })
      : block.i18n !== undefined
        ? t(block.i18n.key, block.i18n.params)
        : block.text;

  const isCompactionError =
    block.compactionPhase === 'failed' ||
    block.compactionPhase === 'interrupted' ||
    block.compactionFailure !== undefined;

  if (placement === 'error') {
    const superseded = isCompactionError
      ? hasSubsequentCompactionResolution(blocks, block.id)
      : hasConfirmedSubsequentSuccess(block.turnId, blocks, turnTerminals);
    const isInterrupted = block.compactionPhase === 'interrupted';
    const actions: TimelineErrorAction[] = [];
    if (isCompactionError && !readOnly && !superseded && onRetryCompaction !== undefined && latestFailedCompactionId === block.id) {
      actions.push({
        id: 'retry-compaction',
        label: t('transcript.error.retryCompaction'),
        onClick: () => { onRetryCompaction('summarize'); },
        primary: true,
        dataAttr: 'data-compaction-retry-summarize',
      });
      actions.push({
        id: 'relay-compaction',
        label: t('transcript.error.relayCompaction'),
        onClick: () => { onRetryCompaction('relay'); },
        confirmMessage: t('transcript.error.relayConfirm'),
        confirmLabel: t('transcript.error.relayConfirmAction'),
        dataAttr: 'data-compaction-retry-fresh',
      });
    }
    const rawMsg = isCompactionError
      ? (block.compactionFailure ?? (isInterrupted ? t('transcript.error.compactionInterruptedDefault') : fullText))
      : (block.text !== '' && block.text !== 'compaction' ? block.text : fullText);
    return (
      <TimelineErrorCallout
        incidentId={`mobile-notice-${block.id}`}
        severity={isInterrupted ? 'warn' : 'error'}
        title={isCompactionError ? fullText : undefined}
        message={rawMsg}
        errorDetails={block.errorDetails}
        createdAt={block.createdAt}
        superseded={superseded}
        actions={actions}
        attrs={{ 'data-notice-key': block.i18n?.key }}
      />
    );
  }

  if (placement === 'epoch') {
    const hasSummary = block.summary !== undefined && block.summary !== '';
    return (
      <div>
        <TimelineDivider title={time.absoluteTime(block.createdAt)} attrs={{ 'data-notice-key': block.i18n?.key }}>
          {hasSummary ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => { setOpen((value) => !value); }}
              className="inline-flex min-h-11 items-center gap-1 text-[12px] leading-[16px] font-normal text-ink-faint"
            >
              <span>{fullText}</span>
              <DisclosureChevron open={open} />
            </button>
          ) : fullText}
        </TimelineDivider>
        {open && hasSummary ? (
          <div id={detailsId} className="mt-1 flex items-start gap-2 border-l border-hairline pl-3 text-[13px] leading-6 text-ink-soft">
            <div className="min-w-0 flex-1"><Markdown text={block.summary!} /></div>
            <CopyButton text={block.summary!} label={fullText} />
          </div>
        ) : null}
      </div>
    );
  }

  const detail = block.goalChange?.reason ?? block.planRevision?.path;
  const isGoalWarn = block.goalChange?.kind === 'blocked' || block.goalChange?.kind === 'paused';
  return (
    <ActivityRow
      glyph={<Icon name={isGoalWarn ? 'warning' : 'dash'} size={12} />}
      tone={isGoalWarn ? 'warn' : 'plain'}
      label={fullText}
      detail={detail}
      meta={block.createdAt !== undefined ? <RelativeTime at={block.createdAt} /> : undefined}
      expanded={detail === undefined ? undefined : open}
      onToggle={detail === undefined ? undefined : () => { setOpen((value) => !value); }}
      attrs={{ 'data-notice-key': block.i18n?.key, 'data-goal-change': block.goalChange?.kind }}
    >
      {open && detail !== undefined ? (
        <div id={detailsId} className="flex items-start gap-2 border-l border-hairline pl-3 text-[12px] leading-[16px] text-ink-soft">
          <p className="min-w-0 flex-1 select-text whitespace-pre-wrap [overflow-wrap:anywhere]">{detail}</p>
          <CopyButton text={detail} label={fullText} />
        </div>
      ) : undefined}
    </ActivityRow>
  );
}

const MOBILE_SYSTEM_VARIANT_KEYS: Record<SystemBlock['variant'], I18nKey> = {
  injection: 'transcript.system.injection',
  compaction_summary: 'transcript.system.compaction',
  task: 'transcript.system.task',
  cron_job: 'transcript.system.cron',
  cron_missed: 'transcript.system.cronMissed',
  agent_message: 'transcript.system.agent',
  thread_watch: 'transcript.system.threadWatch',
  hook_result: 'transcript.system.hook',
  retry: 'transcript.system.retry',
  system_trigger: 'transcript.system.trigger',
  system: 'transcript.system.generic',
};

function MobileInjectionList({
  injections,
}: {
  readonly injections: readonly MobileFoldedDetailItem[];
}) {
  const { t } = useI18n();
  const [openId, setOpenId] = useState<string | null>(null);
  if (injections.length === 0) return null;
  return (
    <div data-mobile-injections className="mt-1 space-y-1 border-l border-hairline pl-3">
      {injections.map((item) => {
        let label: string;
        let body: string;
        let detailKind: string;
        if (item.kind === 'system-reminder') {
          const heading = resolveInjectionHeading({ category: item.category, variant: item.variant });
          label = heading.secondary === undefined
            ? t(heading.labelKey)
            : `${t(heading.labelKey)} · ${heading.secondary}`;
          body = item.text;
          detailKind = `reminder:${item.variant ?? item.category?.kind ?? 'generic'}`;
        } else if (item.kind === 'system') {
          if (item.variant === 'injection') {
            const heading = resolveInjectionHeading({
              category: item.category,
              variant: item.originVariant,
              fallbackSource: item.source,
            });
            label = heading.secondary === undefined
              ? t(heading.labelKey)
              : `${t(heading.labelKey)} · ${heading.secondary}`;
          } else if (item.variant === 'thread_watch' && item.taskNotification?.title) {
            label = item.taskNotification.title;
          } else if (item.variant === 'hook_result' && item.hookEvent !== undefined && item.hookEvent !== '') {
            label = `${t('transcript.system.hook')} · ${item.hookEvent}`;
          } else {
            const base = t(MOBILE_SYSTEM_VARIANT_KEYS[item.variant]);
            label = item.source !== undefined && item.source !== '' ? `${base} · ${item.source}` : base;
          }
          body = item.variant === 'thread_watch' ? (item.taskNotification?.body ?? item.text) : item.text;
          detailKind = `system:${item.variant}`;
        } else if (item.kind === 'skill') {
          const kindKey = item.source === 'plugin' ? 'transcript.skill.plugin' : 'transcript.skill.skill';
          label = t(kindKey, { name: item.name });
          body = item.text !== '' ? item.text : (item.args ?? item.name);
          detailKind = `skill:${item.name}`;
        } else {
          const resolved = item.i18n !== undefined ? t(item.i18n.key, item.i18n.params) : item.text;
          label = resolved;
          body = item.errorDetails !== undefined && item.errorDetails !== ''
            ? `${resolved}\n\n${item.errorDetails}`
            : resolved;
          detailKind = `notice:${item.markerKind ?? item.tone}`;
        }
        const expanded = openId === item.id;
        return (
          <div key={item.id} data-mobile-injection-item data-mobile-detail-kind={detailKind}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => { setOpenId((prev) => (prev === item.id ? null : item.id)); }}
              className="flex min-h-11 w-full items-center justify-between gap-2 text-left text-[13px] leading-[20px] font-normal text-ink-soft"
            >
              <span className="min-w-0 truncate">{label}</span>
              <DisclosureChevron open={expanded} />
            </button>
            {expanded ? (
              <div className="mt-1 flex items-start gap-2 text-[12px] leading-[16px] text-ink-faint">
                <p className="min-w-0 flex-1 select-text whitespace-pre-wrap [overflow-wrap:anywhere]">{body}</p>
                {body !== '' ? <CopyButton text={body} label={label} showLabel /> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function InlineApprovalCard({
  block,
  onResolve,
  onOpenWorkbench,
}: {
  readonly block: ApprovalBlock;
  readonly onResolve: (approvalId: string, decision: ApprovalDecision, reason?: string) => void;
  readonly onOpenWorkbench: () => void;
}) {
  const { t } = useI18n();
  const [rejecting, setRejecting] = useState(false);
  const approvalId = block.request.approval_id;
  const summary = summarizeApproval(block.request);
  return (
    <div data-mobile-inline-approval={approvalId} className="rounded-2xl border border-hairline bg-panel p-3.5 shadow-xs">
      <ApprovalHeadline summary={summary} />
      <div className="mt-3 flex items-center gap-2">
        {isInlineDecidable(block.request) ? (
          <>
            <button
              type="button"
              data-mobile-approve-btn={approvalId}
              onClick={() => { onResolve(approvalId, 'approved'); }}
              className="inline-flex h-11 items-center gap-1.5 rounded-full bg-accent px-4 text-[14px] font-normal text-primary-foreground transition-colors hover:bg-accent-deep"
            >
              <Icon name="check" size={14} />
              <span>{t('mobile.approval.approve')}</span>
            </button>
            <button
              type="button"
              data-mobile-reject-btn={approvalId}
              onClick={() => { setRejecting(true); }}
              className="inline-flex h-11 items-center gap-1.5 rounded-full border border-hairline bg-paper px-4 text-[14px] font-normal text-ink-soft transition-colors hover:text-ink"
            >
              <Icon name="cross" size={14} />
              <span>{t('mobile.approval.reject')}</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onOpenWorkbench}
            className="inline-flex h-11 items-center gap-1 rounded-full border border-hairline bg-paper px-4 text-[14px] font-normal text-ink-soft transition-colors hover:text-ink"
          >
            <span>{t('mobile.approval.details')}</span>
            <Icon name="chevron" size={12} />
          </button>
        )}
      </div>
      {rejecting ? (
        <RejectReasonSheet
          overlayId={`mobile-inline-reject-${approvalId}`}
          headline={summary.snippet ?? summary.headline}
          submitting={false}
          onCancel={() => { setRejecting(false); }}
          onSubmit={(reason) => {
            setRejecting(false);
            onResolve(approvalId, 'rejected', reason);
          }}
        />
      ) : null}
    </div>
  );
}

function AssistantBubble({ text }: { readonly text: string }) {
  return (
    <div data-mobile-msg="assistant" className="w-full text-[16px] leading-[1.7] text-ink">
      <Markdown text={text} />
    </div>
  );
}

export function MobileTranscript({
  state,
  blocks,
  loaded,
  loadError,
  busy,
  hasMoreHistory,
  loadingOlder,
  messageMode,
  personaName,
  greeting,
  readOnly = false,
  connected,
  modelCatalog,
  modelCatalogScope,
  interruptedWork,
  recoveringInterruption = false,
  onLoadOlder,
  onRetryLoad,
  onOpenHood,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onOpenWorkbench,
  onContinueFailedTurn,
  onRetryFailedTurn,
  onRestoreDraft,
  onOpenModelPicker,
  onOpenProviderSettings,
  onRecoverInterruption,
  onRetryCompaction,
}: MobileTranscriptProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedBottomRef = useRef(true);
  const [expandedStepsId, setExpandedStepsId] = useState<string | null>(null);

  const placementContext = useMemo(
    () => buildNoticePlacementContext(blocks, { planModeActive: state?.planMode }),
    [blocks, state?.planMode],
  );
  const latestFailedCompactionId = useMemo(
    () => (readOnly || busy || onRetryCompaction === undefined ? undefined : latestUnresolvedCompactionId(blocks)),
    [blocks, busy, onRetryCompaction, readOnly],
  );

  const entries = useMemo(
    () =>
      messageMode
        ? messageModeEntries(blocks, busy, personaName, state?.failedTurnIds)
        : groupReplyBlocks(blocks, placementContext),
    [blocks, busy, messageMode, personaName, placementContext, state?.failedTurnIds],
  );
  const fileChanges = useMemo(() => extractFileChanges(blocks), [blocks]);
  const hasUserTurn = useMemo(() => blocks.some((block) => block.kind === 'user'), [blocks]);
  const showGreeting = loaded && greeting !== undefined && !hasUserTurn && !hasMoreHistory;

  const turnTail = state?.turnTail;
  const turnTerminals = state?.turnTerminals;
  const replyGap = useMemo(
    () => (state === undefined ? undefined : turnReplyGap(state, { connected })),
    [state, connected],
  );
  const completedTurnFootnotes = useMemo(() => {
    const map = new Map<string, TurnTailInfo>();
    if (turnTerminals !== undefined) {
      for (const [id, info] of Object.entries(turnTerminals)) {
        if (info.state === 'completed') {
          const norm = normTurn(id);
          if (norm !== undefined) map.set(norm, info);
        }
      }
    }
    if (turnTail?.state === 'completed') {
      const norm = normTurn(turnTail.turnId);
      if (norm !== undefined) map.set(norm, turnTail);
    }
    return map;
  }, [turnTerminals, turnTail]);
  const latestCompletedTurnId = !busy && turnTail?.state === 'completed' ? normTurn(turnTail.turnId) : undefined;
  const latestCompletedAttachedInline = useMemo(
    () => latestCompletedTurnId !== undefined && entries.some((entry) => entry.turnId === latestCompletedTurnId),
    [entries, latestCompletedTurnId],
  );

  const failedTailTurnId = !busy && turnTail?.state === 'failed' ? normTurn(turnTail.turnId) : undefined;
  const failedTurnUserBlock = useMemo(() => {
    if (failedTailTurnId === undefined) return undefined;
    return blocks.findLast((block): block is UserBlock => block.kind === 'user' && normTurn(block.turnId) === failedTailTurnId);
  }, [blocks, failedTailTurnId]);
  const failedTurnHasWork = useMemo(
    () =>
      failedTailTurnId !== undefined &&
      blocks.some((block) => blockTurnId(block) === failedTailTurnId && (block.kind === 'tool' || block.kind === 'shell' || block.kind === 'subagent')),
    [blocks, failedTailTurnId],
  );

  const firstBlock = blocks[0];
  const topAlreadyEpoch =
    firstBlock?.kind === 'notice' &&
    (firstBlock.markerKind === 'context.clear' || firstBlock.markerKind === 'branch.base' || firstBlock.branchBase !== undefined);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !pinnedBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length, blocks]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pinnedBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, []);

  const renderBlock = (block: Block) => {
    if (block.kind === 'user') {
      const superseded = hasConfirmedSubsequentSuccess(block.turnId, blocks, turnTerminals);
      return (
        <div key={block.id} data-mobile-msg="user" className="flex flex-col items-end">
          <div className="max-w-[84%] rounded-[12px] rounded-br-[6px] bg-bubble-user px-4 py-2.5 text-[16px] leading-[1.7] text-ink whitespace-pre-wrap break-words">
            {block.text}
          </div>
          {block.promptOutcome !== undefined || block.promptStatus === 'blocked' ? (
            <PromptOutcomeLine
              outcome={block.promptOutcome ?? { status: 'blocked', delivered: false, at: block.createdAt }}
              superseded={superseded}
              onRetry={
                !readOnly && onRetryFailedTurn !== undefined && block.text.trim() !== ''
                  ? () => { onRetryFailedTurn(block); }
                  : undefined
              }
            />
          ) : null}
        </div>
      );
    }
    if (block.kind === 'assistant') {
      return <AssistantBubble key={block.id} text={block.text} />;
    }
    if (block.kind === 'message') {
      if (block.text.trim() === '' || block.handoff !== undefined) return null;
      return <AssistantBubble key={block.id} text={block.text} />;
    }
    if (block.kind === 'notice') {
      return (
        <MobileNoticeRow
          key={block.id}
          block={block}
          blocks={blocks}
          placementContext={placementContext}
          turnTerminals={turnTerminals}
          latestFailedCompactionId={latestFailedCompactionId}
          readOnly={readOnly}
          onRetryCompaction={onRetryCompaction}
        />
      );
    }
    if (block.kind === 'approval' && block.resolution === undefined) {
      return (
        <InlineApprovalCard
          key={block.id}
          block={block}
          onResolve={onResolveApproval}
          onOpenWorkbench={onOpenWorkbench}
        />
      );
    }
    if (block.kind === 'question') {
      return (
        <MobileQuestionCard
          key={block.id}
          block={block}
          onAnswer={onAnswerQuestion}
          onDismiss={onDismissQuestion}
          onOpenWorkbench={onOpenWorkbench}
        />
      );
    }
    return null;
  };

  return (
    <ModelDisplayProvider
      catalog={modelCatalog}
      scope={modelCatalogScope}
      externalExecutor={state?.session?.executor_id !== undefined && !isNativeExecutor(state.session.executor_id)}
    >
      <div
        ref={scrollRef}
        data-mobile-transcript
        data-mobile-transcript-mode={messageMode ? 'message' : 'reply'}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinnedBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3"
      >
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
          {hasMoreHistory ? (
            <div className="flex justify-center pb-1">
              <button
                type="button"
                data-mobile-load-older=""
                disabled={loadingOlder}
                onClick={onLoadOlder}
                className="h-11 rounded-full border border-hairline bg-panel px-4 text-[13px] font-normal text-ink-soft transition-colors hover:border-hairline-strong disabled:opacity-55"
              >
                {loadingOlder ? t('mobile.chat.loading') : t('mobile.chat.loadOlder')}
              </button>
            </div>
          ) : state?.historyCoverageKind === 'unknown' && loaded ? (
            <div role="status" data-top-edge="unverified" className="flex items-center justify-center gap-1.5 text-[12px] leading-[16px] font-normal text-ink-faint">
              <Icon name="partial" size={12} />
              <span>{t('transcript.historyPartial')}</span>
            </div>
          ) : state?.fetchedOlder && !topAlreadyEpoch ? (
            <TimelineDivider attrs={{ role: 'status', 'data-top-edge': 'beginning' }}>
              {t('transcript.beginning')}
            </TimelineDivider>
          ) : null}

          {showGreeting ? (
            <div data-mobile-msg="greeting" className="w-full text-[16px] leading-[1.7] text-ink">
              <Markdown text={greeting.text} />
            </div>
          ) : null}

          {loadError !== undefined && (!loaded || entries.length === 0) ? (
            <TimelineErrorCallout
              incidentId="mobile-load-error"
              severity="error"
              title={t('transcript.couldNotOpen')}
              message={loadError}
              announce
              actions={onRetryLoad === undefined ? [] : [{
                id: 'retry-load',
                label: t('common.retry'),
                onClick: onRetryLoad,
                primary: true,
                dataAttr: 'data-mobile-retry-load',
              }]}
              attrs={{ 'data-mobile-load-error': '' }}
            />
          ) : !loaded ? (
            <p className="py-12 text-center text-[13px] font-normal text-ink-faint">{t('mobile.chat.loading')}</p>
          ) : entries.length === 0 && !showGreeting ? (
            <div className="py-16 text-center">
              <p className="font-sans text-[18px] leading-[26px] font-normal text-ink-soft">{t('mobile.chat.emptyHint')}</p>
            </div>
          ) : (
            entries.map((entry, index) => {
              const nextEntry = entries[index + 1];
              const isTurnTail = entry.turnId !== undefined && (nextEntry === undefined || nextEntry.turnId !== entry.turnId);
              const footnoteTail = isTurnTail && entry.turnId !== undefined ? completedTurnFootnotes.get(entry.turnId) : undefined;
              const isLatestCompleted = entry.turnId !== undefined && entry.turnId === latestCompletedTurnId;

              const node = entry.kind === 'steps' ? (() => {
                const label =
                  entry.running !== undefined
                    ? toolLabel(entry.running)
                    : entry.single !== undefined
                      ? toolLabel(entry.single)
                      : entry.count === 1
                        ? t('mobile.chat.thinking')
                        : t('mobile.chat.toolSteps', { count: entry.count });
                const hasInjections = entry.injections.length > 0;
                const openInjections = expandedStepsId === entry.id;
                return (
                  <div key={entry.id} className="flex flex-col items-start">
                    <div className="flex max-w-full items-center gap-1">
                      <button
                        type="button"
                        data-mobile-step-pill
                        onClick={() => { onOpenHood('tools'); }}
                        className="inline-flex min-h-11 max-w-full items-center gap-2 text-left text-[13px] font-normal text-ink-faint transition-colors hover:text-ink-soft"
                      >
                        <Icon
                          name={entry.running !== undefined ? 'task' : 'tool'}
                          size={12}
                          className={entry.running !== undefined ? 'text-accent' : 'text-ink-faint'}
                        />
                        <span className="min-w-0 truncate">{label}</span>
                        <Icon name="chevron" size={12} className="shrink-0 opacity-75" />
                      </button>
                      {hasInjections ? (
                        <button
                          type="button"
                          data-mobile-step-injections-toggle
                          aria-expanded={openInjections}
                          aria-label={t('transcript.systemReminder')}
                          onClick={() => { setExpandedStepsId((prev) => (prev === entry.id ? null : entry.id)); }}
                          className="inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-[6px] text-ink-faint hover:bg-ink/[0.04] hover:text-ink"
                        >
                          <DisclosureChevron open={openInjections} />
                        </button>
                      ) : null}
                    </div>
                    {hasInjections && openInjections ? <MobileInjectionList injections={entry.injections} /> : null}
                  </div>
                );
              })() : renderBlock(entry.block);

              if (node === null && footnoteTail === undefined) return null;
              return (
                <div key={entry.kind === 'steps' ? entry.id : entry.block.id} className="flex flex-col gap-1.5">
                  {node}
                  {footnoteTail !== undefined ? (
                    <TurnFootnote
                      tail={footnoteTail}
                      gap={isLatestCompleted ? replyGap : undefined}
                      onRetryGap={isLatestCompleted && !readOnly && failedTurnUserBlock !== undefined && onRetryFailedTurn !== undefined ? () => { onRetryFailedTurn(failedTurnUserBlock); } : undefined}
                    />
                  ) : null}
                </div>
              );
            })
          )}

          {loaded && !busy ? (
            <TurnTailSurface
              agentId="main"
              tail={turnTail}
              gap={replyGap}
              interruptedWork={interruptedWork}
              promptQueueHold={state?.promptQueueHold}
              readOnly={readOnly}
              busy={busy}
              footnoteAttachedInline={latestCompletedAttachedInline}
              failedTurnUserBlock={failedTurnUserBlock}
              failedHasWork={failedTurnHasWork}
              hasOriginalRetry={canFaithfullyRetryUserBlock(failedTurnUserBlock, true)}
              hasDraftRestore={onRestoreDraft !== undefined && failedTurnUserBlock !== undefined && failedTurnUserBlock.text.trim() !== ''}
              recoveringInterruption={recoveringInterruption}
              onContinueFailed={!readOnly ? onContinueFailedTurn : undefined}
              onRetryFailed={!readOnly ? onRetryFailedTurn : undefined}
              onRestoreDraft={!readOnly && onRestoreDraft !== undefined && failedTurnUserBlock !== undefined ? () => { onRestoreDraft(failedTurnUserBlock.text); } : undefined}
              onOpenModelPicker={!readOnly ? onOpenModelPicker : undefined}
              onOpenProviderSettings={!readOnly ? onOpenProviderSettings : undefined}
              onCompactContext={!readOnly && onRetryCompaction !== undefined ? () => { onRetryCompaction('summarize'); } : undefined}
              onRecoverInterruption={!readOnly ? onRecoverInterruption : undefined}
            />
          ) : null}

          {fileChanges.length > 0 ? (
            <div
              data-mobile-changes-card
              className="w-full overflow-hidden rounded-2xl border border-hairline/90 bg-panel shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.04)]"
            >
              <button
                type="button"
                onClick={() => { onOpenHood('diff'); }}
                className="flex min-h-11 w-full items-center justify-between border-b border-hairline/65 px-3.5 text-left transition-colors hover:bg-ink/[0.02]"
              >
                <span className="text-[13px] leading-[20px] font-bold text-ink">
                  {t('mobile.chat.changes', { count: fileChanges.length })}
                </span>
                <Icon name="chevron" size={12} className="text-ink-faint" />
              </button>
              <div className="divide-y divide-hairline/50">
                {fileChanges.slice(0, 4).map((change) => {
                  const filename = change.path.split(/[\\/]/).pop() ?? change.path;
                  return (
                    <button
                      key={change.id}
                      type="button"
                      data-mobile-change-file={change.id}
                      onClick={() => { onOpenHood('diff', change.id); }}
                      className="flex min-h-11 w-full items-center justify-between gap-2 px-3.5 text-left text-[13px] font-normal transition-colors hover:bg-ink/[0.02]"
                    >
                      <span className="min-w-0 truncate font-mono text-ink">{filename}</span>
                      <span className="shrink-0 font-mono text-[12px] tabular-nums">
                        <span className="text-success">+{change.added}</span>{' '}
                        <span className="text-danger">-{change.removed}</span>
                      </span>
                    </button>
                  );
                })}
                {fileChanges.length > 4 ? (
                  <button
                    type="button"
                    onClick={() => { onOpenHood('diff'); }}
                    className="flex min-h-11 w-full items-center px-3.5 text-left text-[12px] font-normal text-ink-faint"
                  >
                    {t('mobile.chat.changesMore', { count: fileChanges.length - 4 })}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </ModelDisplayProvider>
  );
}
