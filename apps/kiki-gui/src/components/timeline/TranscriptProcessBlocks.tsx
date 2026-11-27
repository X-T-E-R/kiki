import { memo, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import type { GoalMarkerChange } from '@kiki/transcript';
import { isNativeExecutor } from '@kiki/session-core/composer';
import type { I18nKey } from '@kiki/session-core/i18n';
import {
  agentChildren,
  classifyNoticePlacement,
  effectiveSubagentStatus,
  hasSubsequentCompactionResolution,
  MAIN_AGENT_ID,
  resolveInjectionHeading,
  stepObject,
  type AgentForest,
  type AgentTreeNode,
  type NoticeBlock,
  type ShellBlock,
  type SkillBlock,
  type SubagentBlock,
  type SubagentEventBlock,
  type SystemBlock,
  type SystemReminderBlock,
} from '@kiki/session-core/session';
import { firstSentence, plainInline } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import { lazyComponent } from '../../lib/lazyComponent';
import { getSubagentScaleConfig } from '../../lib/subagentScaleConfig';
import { plainFailure } from '../agent-panel/failureText';
import { useAgentRefResolution } from '../AgentRefChip';
import {
  ContentContinuation,
  frameContentSource,
  INPUT_ROOTS,
  MESSAGE_TEXT_ROOTS,
  OUTPUT_ROOTS,
  SHELL_COMMAND_ROOTS,
  TASK_COMMAND_ROOTS,
  TASK_OUTPUT_ROOTS,
  TASK_SUMMARY_ROOTS,
} from '../ContentContinuation';
import { DisclosureChevron, Icon, OutcomeMark, Spinner } from '../icons';
import { Markdown } from '../Markdown';
import { RelativeTime } from '../RelativeTime';
import { resolveSubagentToolCalls, type SubagentToolCalls } from '../subagentToolCalls';
import { useContentContinuation, useTranscriptDetail } from '../transcriptDetail';
import { ActivityRow, ACTIVITY_BODY_INDENT, TimelineDivider } from './ActivityRow';
import { AgentTurnOutcomeLine } from './AgentTurnOutcomeLine';
import { CopyButton } from './ContentCopyButton';
import { useFindReveal } from './findReveal';
import { useResolvedModelDisplay } from './ModelDisplayContext';
import {
  countFoldedDescendants,
  groupDescendantsByDispatch,
  useDispatchGroup,
  useNestedFold,
} from './nestedFold';
import { SubagentResultSummary, useInvocationDetails } from './SubagentInvocationView';
import {
  CompactionRecoveryContext,
  InvocationContext,
  latestLineOf,
  NoticePlacementCtx,
  parseTimelineMs,
  subagentAutoForm,
  subagentStatusTone,
  useSharedSecondClock,
  type SubagentCardForm,
} from './subagentShared';
import type { TimelineErrorAction } from './TimelineErrorCallout';
import { activityOutcomeLabels } from './transcriptDeliveryContext';

const TimelineErrorCallout = lazyComponent(() =>
  import('./TimelineErrorCallout').then((m) => m.TimelineErrorCallout),
);

if (import.meta.env.MODE === 'test') {
  await TimelineErrorCallout.preload();
}

export const ShellMessage = memo(function ShellMessage({ block }: { block: ShellBlock }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  useFindReveal(block.id, open, setOpen);
  const preview = latestLineOf(block.output);
  const commandSource = block.commandTaskId === undefined
    ? frameContentSource(block)
    : { kind: 'task' as const, id: block.commandTaskId };
  const commandRoots = block.commandTaskId === undefined ? SHELL_COMMAND_ROOTS : TASK_COMMAND_ROOTS;
  const outputSource = block.outputTaskId === undefined
    ? frameContentSource(block)
    : { kind: 'task' as const, id: block.outputTaskId };
  const outputRoots = block.outputTaskId === undefined ? OUTPUT_ROOTS : TASK_OUTPUT_ROOTS;
  const outputPending = useContentContinuation(outputSource, outputRoots).pending.length > 0 || block.outputDetail !== undefined;

  return (
    <ActivityRow
      attrs={{ 'data-shell': true }}
      glyph={<Icon name="terminal" />}
      tone={block.done && block.isError === true ? 'danger' : 'plain'}
      label={t('transcript.shell')}
      detail={
        block.command === undefined ? (
          preview === '' ? undefined : <span className="font-mono">{preview}</span>
        ) : (
          <>
            <span data-shell-command-preview title={block.command} className="truncate font-mono">
              <span className="text-ink-faint select-none">$ </span>{block.command}
            </span>
            {block.done && block.isError === true ? (
              <span className="font-normal"> — {t('transcript.failed')}</span>
            ) : null}
            {open || preview === '' ? null : (
              <span className="font-mono text-ink-faint"> — {preview}</span>
            )}
          </>
        )
      }
      expanded={open}
      onToggle={() => { setOpen((value) => !value); }}
      ariaLabel={open ? t('transcript.showLess') : t('transcript.showMore')}
      status={
        <OutcomeMark
          state={!block.done ? 'running' : block.isError === true ? 'failed' : 'done'}
          labels={activityOutcomeLabels(t)}
        />
      }
    >
      {open ? (
        <div className="overflow-hidden rounded-[10px] bg-shell">
          {block.command !== undefined ? (
            <div
              data-shell-command-full
              className="px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-shell-ink-strong"
            >
              <span className="mr-1 text-shell-ink-soft select-none">$ </span>
              {block.command}
            </div>
          ) : null}
          <ShellOutputDetail block={block} />
          {block.output !== '' ? (
            <pre className={`max-h-80 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-shell-ink${block.command === undefined && block.outputDetail === undefined ? '' : ' border-t border-shell-hairline'}`}>
              {block.output}
            </pre>
          ) : outputPending ? null : (
            <p data-shell-output-empty className="px-3 py-2 text-[12px] text-shell-ink-soft">
              {t(block.done ? 'transcript.shell.noOutput' : 'tasks.noOutput')}
            </p>
          )}
        </div>
      ) : undefined}
      {open ? (
        <div className="mt-1 space-y-1">
          <ContentContinuation
            source={commandSource}
            roots={commandRoots}
            label={t('transcript.content.command')}
          />
          <ContentContinuation
            source={outputSource}
            roots={outputRoots}
            label={t('tc.output')}
          />
        </div>
      ) : undefined}
    </ActivityRow>
  );
});

function ShellOutputDetail({ block }: { block: ShellBlock }) {
  const { t } = useI18n();
  const detail = useTranscriptDetail(
    block.outputDetail === undefined
      ? undefined
      : { agentId: block.outputDetail.agentId, kind: 'task', id: block.outputDetail.taskId },
  );
  if (block.outputDetail === undefined || detail.request === undefined) return null;
  const status = detail.status?.status;
  return (
    <div
      data-shell-output-detail={status ?? 'idle'}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[12px] leading-5${block.command === undefined ? '' : ' border-t border-shell-hairline'}`}
    >
      <span role={status === 'error' ? 'alert' : undefined} className={status === 'error' ? 'text-shell-danger' : 'text-shell-ink'}>
        {status === 'error' ? t('transcript.detail.failed') : t('transcript.detail.tailOnly')}
      </span>
      <button
        type="button"
        data-shell-output-detail-action
        onClick={detail.request}
        disabled={status === 'loading'}
        aria-busy={status === 'loading'}
        className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-shell-hairline px-2 font-normal text-shell-ink-strong transition-colors hover:bg-shell-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-80 motion-reduce:transition-none"
      >
        {status === 'loading' ? (
          <>
            <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-shell-ink" />
            {t('transcript.detail.loading')}
          </>
        ) : status === 'error' ? t('transcript.detail.retry') : t('transcript.detail.showAll')}
      </button>
    </div>
  );
}

function useSubagentElapsed(
  block: SubagentBlock,
  node: AgentTreeNode | undefined,
  status: AgentTreeNode['status'] | SubagentBlock['status'],
  isLatestRun = true,
): number | undefined {
  const live = status === 'running' || status === 'background' || status === 'suspended';
  const now = useSharedSecondClock(live);
  const start = isLatestRun
    ? (parseTimelineMs(node?.startedAt) ?? parseTimelineMs(block.startedAt))
    : (parseTimelineMs(block.startedAt) ?? parseTimelineMs(node?.startedAt));
  if (start === undefined) return undefined;
  const end = live
    ? now
    : isLatestRun
      ? (parseTimelineMs(node?.endedAt) ?? parseTimelineMs(block.endedAt))
      : (parseTimelineMs(block.endedAt) ?? parseTimelineMs(node?.endedAt));
  if (end === undefined) return undefined;
  return Math.max(0, end - start);
}

function SubagentCardBody({
  name,
  model,
  status,
  toolCallCount,
  toolCallCountKnown,
  childCount = 0,
  thinkingEffort,
  description,
  error,
  elapsed,
  depth = 0,
  externalExecutor = false,
}: {
  name: string;
  model?: string;
  status: AgentTreeNode['status'] | SubagentBlock['status'];
  toolCallCount: number;
  toolCallCountKnown: boolean;
  childCount?: number;
  thinkingEffort?: string;
  description?: string;
  error?: string;
  elapsed: number | undefined;
  depth?: number;
  externalExecutor?: boolean;
}) {
  const { t, tp, time } = useI18n();
  const resolvedModel = useResolvedModelDisplay(model, { externalExecutor });
  const busy = status === 'running' || status === 'background';
  const bodyIndent = depth > 0 ? 'pl-[26px]' : 'pl-4';
  return (
    <>
      <div className="flex items-center gap-2">
        {depth > 0 ? (
          <span aria-hidden className="flex h-4 w-[18px] shrink-0 items-center justify-center">
            <span className={`h-2 w-2 shrink-0 rounded-full ${subagentStatusTone(status)} ${busy ? 'status-dot-busy' : ''}`} />
          </span>
        ) : (
          <span className={`h-2 w-2 shrink-0 rounded-full ${subagentStatusTone(status)} ${busy ? 'status-dot-busy' : ''}`} />
        )}
        <span className="min-w-0 truncate text-[13px] leading-[20px] font-normal text-ink">{name}</span>
        {model !== undefined ? (
          <span
            data-subagent-model={model}
            title={resolvedModel.rawId}
            className="min-w-0 shrink truncate text-[12px] leading-[16px] font-normal text-ink-faint"
          >
            {resolvedModel.label}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-[12px] tabular-nums text-ink-faint">
          {elapsed === undefined ? null : time.formatDuration(elapsed)}
        </span>
        <Icon name="arrowRight" size={12} className="text-ink-faint transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
      </div>
      <div className={`mt-0.5 flex flex-wrap items-center gap-x-1.5 ${bodyIndent} text-[12px] text-ink-faint`}>
        <span>{t(`subagent.status.${status}` as I18nKey)}</span>
        {toolCallCountKnown ? (
          <>
            <span>·</span>
            <span>{tp('transcript.toolCalls', toolCallCount)}</span>
          </>
        ) : null}
        {childCount > 0 ? (
          <>
            <span>·</span>
            <span>{tp('subagent.children', childCount)}</span>
          </>
        ) : null}
        {thinkingEffort !== undefined ? (
          <>
            <span>·</span>
            <span>{t('transcript.thinkingSuffix', { effort: thinkingEffort })}</span>
          </>
        ) : null}
      </div>
      {description !== undefined || error !== undefined ? (
        <p
          title={error}
          className={`mt-0.5 truncate ${bodyIndent} text-[13px] ${error !== undefined ? 'text-danger' : 'text-ink-soft'}`}
        >
          {(error !== undefined ? plainFailure(error) ?? error : undefined) ?? description}
        </p>
      ) : null}
    </>
  );
}

function subagentActivity(block: SubagentBlock): string | undefined {
  for (let index = block.transcript.length - 1; index >= 0; index -= 1) {
    const step = block.transcript[index]!;
    if (step.kind === 'tool') {
      const object = stepObject(step);
      return object.target === undefined ? step.name : `${step.name} ${object.target}`;
    }
    if ((step.kind === 'assistant' || step.kind === 'thinking') && step.text.trim() !== '') {
      return firstSentence(step.text);
    }
  }
  const task = block.description ?? block.instruction;
  return task === undefined || task.trim() === '' ? undefined : plainInline(task.split('\n')[0]!);
}

function SubagentCompactCard({
  block,
  status,
  error,
  summary,
  elapsed,
  depth,
  toolCalls,
  onOpenAgent,
  onExpand,
  folded = false,
  superseded = false,
  invocationButton,
  invocationBody,
}: {
  invocationButton?: ReactNode;
  invocationBody?: ReactNode;
  block: SubagentBlock;
  status: AgentTreeNode['status'] | SubagentBlock['status'];
  error: string | undefined;
  summary: string | undefined;
  elapsed: number | undefined;
  depth: number;
  toolCalls: SubagentToolCalls;
  onOpenAgent?: (agentId: string) => void;
  onExpand?: () => void;
  folded?: boolean;
  superseded?: boolean;
}) {
  const { t, tp, time } = useI18n();
  const [errorOpen, setErrorOpen] = useState(false);
  const errorDetailsId = useId();
  const hasErrorBody = error !== undefined && error.trim() !== '';
  const live = status === 'running' || status === 'background' || status === 'suspended';
  const errorSummary = error === undefined ? undefined : plainFailure(error) ?? error;
  const line = errorSummary ?? (live ? subagentActivity(block) : summary === undefined ? undefined : firstSentence(summary));
  const detail = (
    <>
      <span className={error !== undefined ? undefined : 'text-ink-soft'}>{t(`subagent.status.${status}` as I18nKey)}</span>
      {line === undefined || line === '' ? null : <> · {line}</>}
    </>
  );
  const combinedBody = (errorOpen && hasErrorBody) || invocationBody !== undefined ? (
    <>
      {errorOpen && hasErrorBody ? (
        <div className={`${ACTIVITY_BODY_INDENT} mt-1 flex max-w-full items-start gap-1 rounded-md bg-ink/[0.04] px-3 py-1.5 text-ink-soft`}>
          <p
            id={errorDetailsId}
            data-subagent-error-details
            className="min-w-0 flex-1 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap"
          >
            {error}
          </p>
          <CopyButton text={error} label={t('transcript.promptOutcome.details')} />
        </div>
      ) : null}
      {invocationBody}
    </>
  ) : undefined;
  return (
    <ActivityRow
      nested={depth > 0}
      shrinkLabel
      className={`@container${block.orphaned === true && depth > 0 ? ' opacity-60' : ''}`}
      attrs={{
        'data-subagent-id': block.subagentId,
        'data-agent-depth': depth,
        'data-card-form': 'compact',
        'data-nested-folded': folded || undefined,
        'data-orphaned': block.orphaned === true || undefined,
      }}
      buttonAttrs={{ 'data-agent-open': block.subagentId }}
      glyph={<span className={`inline-block h-2 w-2 rounded-full align-middle ${error !== undefined && superseded ? 'bg-ink/25' : subagentStatusTone(status)}`} />}
      tone={error !== undefined && !superseded ? 'danger' : 'plain'}
      label={block.name || block.label || block.subagentId}
      detail={detail}
      title={error ?? t('subagent.openAgent', { name: block.name || block.label || block.subagentId })}
      onOpen={() => { onOpenAgent?.(block.subagentId); }}
      stats={toolCalls.known && !folded ? <span className="font-sans">{tp('transcript.toolCalls', toolCalls.count)}</span> : undefined}
      meta={elapsed === undefined ? undefined : time.formatDuration(elapsed)}
      metaWidth="wide"
      aside={
        <>
          {hasErrorBody ? (
            <button
              type="button"
              data-subagent-error-toggle={block.subagentId}
              aria-expanded={errorOpen}
              aria-controls={errorDetailsId}
              aria-label={t('transcript.promptOutcome.details')}
              title={t('transcript.promptOutcome.details')}
              onClick={() => { setErrorOpen((value) => !value); }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-panel hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
            >
              <DisclosureChevron open={errorOpen} className="text-current" />
            </button>
          ) : null}
          {onExpand === undefined ? null : (
            <button
              type="button"
              data-card-expand={block.subagentId}
              aria-label={t('subagent.expandCard')}
              title={t('subagent.expandCard')}
              onClick={onExpand}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-panel hover:text-ink"
            >
              <Icon name="expand" size={12} className="text-current" />
            </button>
          )}
          {invocationButton}
        </>
      }
    >{combinedBody}</ActivityRow>
  );
}

function OtherDescendantGroup({
  groupKey,
  members,
  renderMember,
}: {
  groupKey: string;
  members: readonly AgentTreeNode[];
  renderMember: (member: AgentTreeNode) => ReactNode;
}) {
  const { t, tp, locale } = useI18n();
  const { open, toggle } = useDispatchGroup(groupKey);
  const batchLimit = getSubagentScaleConfig().inlineBatchPreviewLimit;
  const [visibleLimit, setVisibleLimit] = useState(batchLimit);
  const counts = countFoldedDescendants(members);
  const summary = [
    tp('subagent.otherGroupCount', counts.total),
    counts.running > 0 ? t('subagent.otherGroupRunning', { count: counts.running }) : null,
    counts.failed > 0 ? t('subagent.otherGroupFailed', { count: counts.failed }) : null,
  ].filter((part): part is string => part !== null).join(' · ');
  const shownMembers = open && members.length > visibleLimit ? members.slice(0, visibleLimit) : members;
  const remaining = members.length - shownMembers.length;
  return (
    <ActivityRow
      nested
      attrs={{ 'data-other-descendants': counts.total, 'data-other-descendants-open': open || undefined }}
      glyph={<DisclosureChevron open={open} className="text-ink-faint" />}
      chevronInGlyph
      label={t('subagent.otherGroup')}
      detail={<span className="text-ink-faint">{summary}</span>}
      status={counts.failed > 0
        ? <OutcomeMark state="failed" labels={activityOutcomeLabels(t)} />
        : counts.running > 0
          ? <OutcomeMark state="running" labels={activityOutcomeLabels(t)} />
          : undefined}
      expanded={open}
      onToggle={toggle}
      ariaLabel={t('subagent.otherGroupAria', { summary })}
    >
      {open ? (
        <div className="space-y-1">
          {shownMembers.map((member) => renderMember(member))}
          {remaining > 0 ? (
            <button
              type="button"
              onClick={() => { setVisibleLimit((limit) => limit + batchLimit); }}
              className="cursor-pointer rounded px-1.5 py-0.5 text-[11.5px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink"
            >
              {locale === 'zh' ? `显示更多（剩余 ${remaining} 项）` : `Show more (${remaining} remaining)`}
            </button>
          ) : null}
        </div>
      ) : undefined}
    </ActivityRow>
  );
}

export const SubagentCard = memo(function SubagentCard({
  block,
  forest,
  depth = 0,
  childBlocks,
  onOpenAgent,
  displayStatus,
  formOverride,
  onToggleForm,
  superseded = false,
}: {
  block: SubagentBlock;
  forest?: AgentForest;
  depth?: number;
  childBlocks?: ReadonlyMap<string, SubagentBlock>;
  onOpenAgent?: (agentId: string) => void;
  displayStatus?: AgentTreeNode['status'];
  formOverride?: SubagentCardForm;
  onToggleForm?: (agentId: string, form: SubagentCardForm) => void;
  superseded?: boolean;
}) {
  const { t, tp, locale } = useI18n();
  const batchLimit = getSubagentScaleConfig().inlineBatchPreviewLimit;
  const [childrenVisibleLimit, setChildrenVisibleLimit] = useState(batchLimit);
  const node = forest?.byId[block.subagentId];
  const children = forest === undefined ? [] : agentChildren(forest, block.subagentId);
  const latestCard = childBlocks?.get(block.subagentId);
  const isLatestRun = latestCard === undefined || latestCard.id === block.id;
  const status = displayStatus ?? (isLatestRun ? effectiveSubagentStatus(block, forest) : block.status);
  const elapsed = useSubagentElapsed(block, node, status, isLatestRun);
  const runIsLive = status === 'running' || status === 'background' || status === 'suspended';
  const model = isLatestRun ? (node?.model ?? block.model) : block.model;
  const rawExecutorId = block.executorId ?? (isLatestRun ? node?.executorId : undefined);
  const externalExecutor = rawExecutorId !== undefined && !isNativeExecutor(rawExecutorId);
  const [modelDetailsOpen, setModelDetailsOpen] = useState(false);
  const modelDetailsId = useId();
  const hasModelRawId = model !== undefined && model !== '';
  const modelDetailsButton = hasModelRawId ? (
    <button
      type="button"
      data-subagent-model-toggle={block.subagentId}
      aria-expanded={modelDetailsOpen}
      aria-controls={modelDetailsId}
      aria-label={t('transcript.promptOutcome.details')}
      title={model}
      onClick={() => { setModelDetailsOpen((value) => !value); }}
      className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11"
    >
      <DisclosureChevron open={modelDetailsOpen} />
    </button>
  ) : null;
  const modelDetailsBody = hasModelRawId && modelDetailsOpen ? (
    <div
      id={modelDetailsId}
      data-subagent-model-details={block.subagentId}
      className="mt-1 flex items-center gap-2 border-l border-hairline pl-3 text-[12px] leading-[16px] text-ink-soft"
    >
      <code data-subagent-model-raw className="min-w-0 flex-1 select-text font-mono [overflow-wrap:anywhere]">
        {model}
      </code>
      <CopyButton text={model} label={t('cb.copy')} showLabel />
    </div>
  ) : null;
  const thinkingEffort = isLatestRun ? (node?.thinkingEffort ?? block.thinkingEffort) : block.thinkingEffort;
  const runError = runIsLive ? undefined : (isLatestRun ? (node?.error ?? block.error) : (block.error ?? node?.error));
  const blockSummary = block.summary !== undefined && block.summary !== '' ? block.summary : undefined;
  const continuationOwnedByEnding =
    block.absorbedTaskIds !== undefined &&
    block.absorbedTaskIds.length > 0 &&
    block.resultTaskId === undefined;
  const runSummary = blockSummary ?? (continuationOwnedByEnding ? undefined : node?.summary);
  const resultTaskId = block.resultTaskId ?? block.taskId;
  const active = subagentAutoForm(status) === 'full';
  const invocationScope = useContext(InvocationContext);
  const nested = depth > 0 || (invocationScope !== null && invocationScope.callerAgentId !== MAIN_AGENT_ID);
  const nestedFold = useNestedFold(block.subagentId, status, nested);
  const full = nested
    ? !nestedFold.folded
    : formOverride !== undefined ? formOverride === 'full' : active;
  const resultSummary = runIsLive ? undefined : runSummary;
  const invocation = useInvocationDetails(block.parentToolCallId, block.parentAgentId, !full, {
    taskId: runIsLive ? undefined : resultTaskId,
    summary: resultSummary,
    toggleKey: block.id,
  });
  const [expanded, setExpanded] = useState(() => active);
  const [fullErrorOpen, setFullErrorOpen] = useState(false);
  const fullErrorDetailsId = useId();
  const hasFullError = runError !== undefined && runError.trim() !== '';
  const fullTaskSource = runIsLive || resultTaskId === undefined || resultTaskId === '' ? undefined : { kind: 'task' as const, id: resultTaskId };
  const fullTaskPending = useContentContinuation(full ? fullTaskSource : undefined, TASK_SUMMARY_ROOTS, block.parentAgentId).pending.length > 0;
  const showInlineFullResult = full && !invocation.open && ((resultSummary !== undefined && resultSummary.trim() !== '') || fullTaskPending);
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);
  const childCount = node?.childIds.length ?? children.length;
  const toolCalls = resolveSubagentToolCalls(block, node);
  const descendantGroups = groupDescendantsByDispatch(
    { startedAt: block.startedAt, endedAt: block.endedAt, status: block.status },
    children,
  );
  const dispatchGroupKey = `${block.parentToolCallId ?? block.id}`;
  const renderChildCard = (child: AgentTreeNode): ReactNode => (
    <SubagentCard
      key={child.agentId}
      block={childBlocks?.get(child.agentId) ?? syntheticChildBlock(child)}
      forest={forest}
      depth={depth + 1}
      childBlocks={childBlocks}
      onOpenAgent={onOpenAgent}
      displayStatus={child.status}
    />
  );
  if (!full) {
    return (
      <SubagentCompactCard
        block={block}
        status={status}
        error={runError}
        summary={runSummary}
        elapsed={elapsed}
        depth={depth}
        toolCalls={toolCalls}
        onOpenAgent={onOpenAgent}
        folded={nested}
        superseded={superseded}
        invocationButton={<>{modelDetailsButton}{invocation.button}</>}
        invocationBody={<>{modelDetailsBody}<AgentTurnOutcomeLine outcome={node?.turnOutcome} />{invocation.body}</>}
        onExpand={
          nested
            ? nestedFold.open
            : onToggleForm === undefined
              ? undefined
              : () => { onToggleForm(block.subagentId, 'full'); }
        }
      />
    );
  }
  const cardClass = depth === 0
    ? 'anim-enter group flex items-start gap-1 rounded-[10px] bg-panel px-3 py-2 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-bubble-user/60'
    : 'anim-enter group -ml-[17px] flex w-[calc(100%+25px)] items-start gap-1 rounded-md py-1.5 pl-[17px] pr-2 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04]';
  const body = (
    <SubagentCardBody
      name={block.name || block.label || block.subagentId}
      model={model}
      status={status}
      toolCallCount={toolCalls.count}
      toolCallCountKnown={toolCalls.known}
      thinkingEffort={thinkingEffort}
      description={block.description}
      error={runError}
      elapsed={elapsed}
      depth={depth}
      externalExecutor={externalExecutor}
    />
  );
  return (
    <div
      data-subagent-id={block.subagentId}
      data-agent-depth={depth}
      data-card-form="full"
      data-orphaned={block.orphaned === true || undefined}
      className={block.orphaned === true ? 'opacity-60' : undefined}
    >
      <div className="min-w-0">
        <div className={cardClass}>
          {onToggleForm !== undefined && !nested ? (
            <button
              type="button"
              data-card-collapse={block.subagentId}
              aria-label={t('subagent.collapseCard')}
              title={t('subagent.collapseCard')}
              onClick={() => { onToggleForm(block.subagentId, 'compact'); }}
              className="-mt-1 -ml-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-paper hover:text-ink"
            >
              <Icon name="collapse" size={12} className="text-current" />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => { onOpenAgent?.(block.subagentId); }}
              data-agent-open={block.subagentId}
              className="block w-full min-w-0 text-left"
            >
              {body}
            </button>
            {hasFullError && node?.turnOutcome === undefined ? (
              <div className={`mt-0.5 ${depth > 0 ? 'pl-[26px]' : 'pl-4'}`}>
                <button
                  type="button"
                  data-subagent-error-toggle={block.subagentId}
                  aria-expanded={fullErrorOpen}
                  aria-controls={fullErrorDetailsId}
                  onClick={() => { setFullErrorOpen((value) => !value); }}
                  className="inline-flex min-h-6 cursor-pointer items-center gap-0.5 rounded-sm px-1 text-[12px] font-normal text-ink-soft underline-offset-2 transition-colors duration-[var(--kiki-motion-quick)] hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
                >
                  {t('transcript.promptOutcome.details')}
                  <DisclosureChevron open={fullErrorOpen} />
                </button>
                {fullErrorOpen ? (
                  <div className="mt-1 flex max-w-full items-start gap-1 rounded-md bg-ink/[0.04] px-3 py-1.5 text-ink-soft">
                    <p
                      id={fullErrorDetailsId}
                      data-subagent-error-details
                      className="min-w-0 flex-1 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap"
                    >
                      {runError}
                    </p>
                    <CopyButton text={runError} label={t('transcript.promptOutcome.details')} />
                  </div>
                ) : null}
              </div>
            ) : null}
            <AgentTurnOutcomeLine outcome={node?.turnOutcome} />
          </div>
          <div className="-mt-1 -mr-1.5 flex shrink-0 items-center gap-0.5">
            {modelDetailsButton}
            {invocation.button}
          </div>
        </div>
        {modelDetailsBody}
        {showInlineFullResult ? (
          <div className="mt-1 space-y-3 border-l border-hairline pl-3">
            <SubagentResultSummary taskId={resultTaskId} summary={resultSummary} callerAgentId={block.parentAgentId} />
          </div>
        ) : null}
        {invocation.body}
        {block.orphaned === true ? (
          <p className="mt-1 pl-1 text-[12px] text-ink-faint italic">
            {t('transcript.orphanedSubagent')}
          </p>
        ) : null}
        {childCount > 0 ? (
          <div className={depth === 0 ? 'mt-0.5 pl-3' : 'mt-0.5 pl-4'}>
            <button
              type="button"
              data-subagent-children={block.subagentId}
              aria-expanded={expanded}
              aria-label={t(expanded ? 'subagent.collapseChildren' : 'subagent.expandChildren')}
              title={t(expanded ? 'subagent.collapseChildren' : 'subagent.expandChildren')}
              onClick={() => {
                setExpanded((value) => !value);
              }}
              className="inline-flex min-h-6 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] tabular-nums text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
            >
              <DisclosureChevron open={expanded} className="text-current" />
              <span>{tp('subagent.children', childCount)}</span>
            </button>
            {expanded && children.length > 0 ? (
              <div className="mt-0.5 ml-1.5 space-y-0.5 border-l border-hairline pl-[17px]">
                {descendantGroups.current.slice(0, childrenVisibleLimit).map((child) => renderChildCard(child))}
                {descendantGroups.current.length > childrenVisibleLimit ? (
                  <button
                    type="button"
                    onClick={() => { setChildrenVisibleLimit((limit) => limit + batchLimit); }}
                    className="cursor-pointer rounded px-1.5 py-0.5 text-[11.5px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink"
                  >
                    {locale === 'zh'
                      ? `显示更多（剩余 ${descendantGroups.current.length - childrenVisibleLimit} 项）`
                      : `Show more (${descendantGroups.current.length - childrenVisibleLimit} remaining)`}
                  </button>
                ) : null}
                {descendantGroups.other.length > 0 ? (
                  <OtherDescendantGroup
                    groupKey={dispatchGroupKey}
                    members={descendantGroups.other}
                    renderMember={renderChildCard}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

function agentMessageSummary(message: string, limit = 140): string {
  const compact = message.replaceAll(/\s+/g, ' ').trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1).trimEnd()}…`;
}

const SUBAGENT_EVENT_ERROR_ROOTS: readonly string[] = ['error', 'stateReason'];

export const SubagentEventRow = memo(function SubagentEventRow({
  block,
  onOpenAgent,
  superseded = false,
}: {
  block: SubagentEventBlock;
  onOpenAgent?: (agentId: string) => void;
  superseded?: boolean;
}) {
  const { t } = useI18n();
  const [openMessage, setOpenMessage] = useState(false);
  useFindReveal(block.id, openMessage, setOpenMessage);
  const invocation = useInvocationDetails(block.anchorToolCallId, block.parentAgentId);
  const eventRoots = block.error !== undefined ? SUBAGENT_EVENT_ERROR_ROOTS : INPUT_ROOTS;
  const eventPending = useContentContinuation(block.contentSource, eventRoots, block.parentAgentId).pending.length > 0;
  const busy = block.status === 'running' || block.status === 'suspended';
  const isFailed = block.event === 'failed' || block.status === 'failed';
  const messageSummary = block.message === undefined ? undefined : agentMessageSummary(block.message);
  const errorSummary = block.error === undefined ? undefined : plainFailure(block.error) ?? block.error;
  const line = errorSummary ?? messageSummary;
  const detail = (
    <>
      <span className="text-ink">{block.name}</span>
      {line === undefined || line === '' ? null : (
        <>
          {' · '}
          <span data-agent-message-summary={block.message === undefined ? undefined : true} title={block.error ?? block.message}>
            {line}
          </span>
        </>
      )}
    </>
  );
  const bodyText = block.error ?? block.message;
  const canToggleBody = ((bodyText !== undefined && bodyText.trim() !== '') || eventPending) && invocation.button === null;
  const errorToggle = block.error !== undefined && block.error.trim() !== '' && invocation.button !== null ? (
    <button
      type="button"
      data-subagent-event-error-toggle={block.id}
      aria-expanded={openMessage}
      aria-label={t('transcript.promptOutcome.details')}
      title={t('transcript.promptOutcome.details')}
      onClick={() => { setOpenMessage((value) => !value); }}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
    >
      <DisclosureChevron open={openMessage} className="text-current" />
    </button>
  ) : null;
  return (
    <ActivityRow
      glyph={
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full align-middle ${isFailed && superseded ? 'bg-ink/25' : subagentStatusTone(block.status)} ${busy ? 'status-dot-busy' : ''}`}
        />
      }
      tone={isFailed && !superseded ? 'danger' : 'plain'}
      status={isFailed && superseded ? <span aria-label={t('transcript.failedAria')} className="text-ink-faint"><Icon name="warning" size={12} /></span> : undefined}
      label={t(`subagent.event.${block.event}` as I18nKey)}
      detail={detail}
      title={block.error ?? t('subagent.openAgent', { name: block.name })}
      onOpen={() => { onOpenAgent?.(block.subagentId); }}
      expanded={canToggleBody ? openMessage : undefined}
      onToggle={canToggleBody ? () => { setOpenMessage((value) => !value); } : undefined}
      meta={
        block.delivery !== undefined ? (
          <span
            data-agent-message-delivery={block.delivery}
            className={block.delivery === 'queued' ? 'text-amber-ink' : 'text-ink-faint'}
          >
            {t(block.delivery === 'queued' ? 'agentMessage.pending' : 'agentMessage.delivered')}
          </span>
        ) : block.at === undefined ? undefined : (
          <RelativeTime at={block.at} />
        )
      }
      metaWidth={block.delivery === undefined ? 'fixed' : 'auto'}
      attrs={{
        'data-subagent-event': block.subagentId,
        'data-agent-event': block.event,
        'data-agent-message-id': block.messageId,
      }}
      buttonAttrs={{ 'data-agent-open': block.subagentId }}
      aside={<>{errorToggle}{invocation.button}</>}
    >
      {openMessage && block.error !== undefined ? (
        <div className={`${ACTIVITY_BODY_INDENT} mt-1 space-y-1`}>
          <div
            data-subagent-event-error
            className="flex max-w-full items-start gap-1 rounded-md bg-ink/[0.04] px-3 py-1.5 text-ink-soft"
          >
            <p className="min-w-0 flex-1 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap">
              {block.error}
            </p>
            <CopyButton text={block.error} label={t('transcript.promptOutcome.details')} />
          </div>
          <ContentContinuation
            source={block.contentSource}
            roots={SUBAGENT_EVENT_ERROR_ROOTS}
            callerAgentId={block.parentAgentId}
            label={t('transcript.promptOutcome.details')}
          />
        </div>
      ) : null}
      {invocation.body ?? (openMessage && block.error === undefined && (block.message !== undefined || eventPending) ? (
        <div className="mt-1 space-y-1">
          {block.message !== undefined ? (
            <div
              data-agent-message-body
              className="flex max-w-full items-start gap-2 border-l border-hairline pl-3"
            >
              <div className="min-w-0 flex-1 max-h-[28rem] overflow-auto pr-1 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-ink">
                {block.messageId !== undefined ? (
                  <div className="mb-1 font-mono text-[11px] text-ink-faint">message_id: {block.messageId}</div>
                ) : null}
                {block.message}
              </div>
              <CopyButton text={block.message} label={t('tc.sem.message')} />
            </div>
          ) : null}
          <ContentContinuation
            source={block.contentSource}
            roots={INPUT_ROOTS}
            callerAgentId={block.parentAgentId}
            label={t('tc.sem.message')}
          />
        </div>
      ) : null)}
    </ActivityRow>
  );
});

function syntheticChildBlock(node: AgentTreeNode): SubagentBlock {
  const status: SubagentBlock['status'] =
    node.status === 'background' ? 'running' : node.status;
  return {
    kind: 'subagent',
    id: `subagent-${node.agentId}`,
    subagentId: node.agentId,
    parentAgentId: node.parentAgentId,
    parentToolCallId: node.parentToolCallId,
    name: node.label,
    description: node.summary,
    model: node.model,
    thinkingEffort: node.thinkingEffort,
    status,
    summary: node.summary,
    error: node.error,
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    toolCallCount: node.toolCallCount,
    transcript: [],
  };
}

const SYSTEM_MESSAGE_ROOTS: readonly string[] = [...MESSAGE_TEXT_ROOTS, 'content', 'payload'];

function injectionSummary(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi, '').trim();
    if (line !== '') return line;
  }
  return '';
}

export const SystemReminderMessage = memo(function SystemReminderMessage({
  block,
}: {
  block: SystemReminderBlock;
}) {
  const { t, time } = useI18n();
  const [open, setOpen] = useState(false);
  useFindReveal(block.id, open, setOpen);
  const category = block.category;
  const resolved = resolveInjectionHeading({ category, variant: block.variant });
  const heading = t(resolved.labelKey);
  const labelText = resolved.secondary === undefined ? heading : `${heading} · ${resolved.secondary}`;
  const facts = [
    ...(category === undefined ? [] : [
      category.triggers.length > 0 ? t('transcript.reminder.triggers', { triggers: category.triggers.join(' · ') }) : undefined,
      category.epoch !== undefined ? t('transcript.reminder.epoch', { epoch: category.epoch }) : undefined,
      category.userTurn !== undefined ? t('transcript.reminder.userTurn', { turn: category.userTurn }) : undefined,
    ]),
    resolved.verbatimSource !== undefined ? t('transcript.injection.sourceLabel', { source: resolved.verbatimSource }) : undefined,
  ].filter((fact): fact is string => fact !== undefined);
  return (
    <ActivityRow
      attrs={{ 'data-reminder-kind': category?.kind, 'data-reminder-variant': block.variant }}
      glyph={<Icon name="system" />}
      label={<span className="font-normal text-ink-soft">{labelText}</span>}
      detail={<span className="text-ink-faint">{injectionSummary(block.text)}</span>}
      title={time.absoluteTime(block.createdAt)}
      expanded={open}
      onToggle={() => { setOpen((value) => !value); }}
    >
      {open ? (
        <div className="space-y-1">
          <div className="flex max-w-full items-start gap-2 border-l border-hairline pl-3">
            <div className="min-w-0 flex-1 max-h-[28rem] overflow-auto pr-2 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink-faint">
              {facts.length > 0 ? (
                <p data-reminder-facts className="mb-1 select-text font-mono text-[12px] leading-[16px] whitespace-normal text-ink-faint">{facts.join('  ·  ')}</p>
              ) : null}
              {block.text}
            </div>
            {block.text !== '' ? <CopyButton text={block.text} label={labelText} /> : null}
          </div>
          <ContentContinuation source={block.contentSource} roots={SYSTEM_MESSAGE_ROOTS} label={labelText} />
        </div>
      ) : undefined}
    </ActivityRow>
  );
});

const SYSTEM_VARIANT_KEYS = {
  injection: 'transcript.system.injection',
  system_trigger: 'transcript.system.trigger',
  compaction_summary: 'transcript.system.compaction',
  hook_result: 'transcript.system.hook',
  cron_job: 'transcript.system.cron',
  cron_missed: 'transcript.system.cronMissed',
  task: 'transcript.system.task',
  thread_watch: 'transcript.system.threadWatch',
  retry: 'transcript.system.retry',
  agent_message: 'transcript.system.agent',
  system: 'transcript.system.generic',
} as const;

function isFailedTaskNotificationText(text: string): boolean {
  const firstLine = text.split('\n', 1)[0] ?? '';
  return (
    /^(?:Title:\s*)?Background \S+ (?:failed|timed_out|killed|lost)\b/.test(firstLine) ||
    /^Severity:\s*warning\s*$/m.test(text)
  );
}

function systemHeadline(text: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/<\/?notification[^>]*>/g, '').replace(/^Title:\s*/, '').trim();
    if (line !== '') return line;
  }
  return undefined;
}

export function PlainSystemMessage({ block, superseded = false }: { block: SystemBlock; superseded?: boolean }) {
  const { t, time } = useI18n();
  const resolution = useAgentRefResolution();
  const [open, setOpen] = useState(false);
  useFindReveal(block.id, open, setOpen);
  const task = block.variant === 'task' && block.taskId !== undefined
    ? resolution?.tasks.find((candidate) => candidate.id === block.taskId)
    : undefined;
  const meta = block.taskNotification;
  const isFailed =
    (block.variant === 'task' && (
      task?.status === 'failed' ||
      isFailedTaskNotificationText(block.text) ||
      meta?.type === 'task.failed' ||
      meta?.status === 'failed' ||
      meta?.severity === 'warning' ||
      meta?.severity === 'error'
    )) ||
    (block.variant === 'thread_watch' && (
      meta?.severity === 'warning' ||
      meta?.severity === 'error' ||
      meta?.type === 'thread.attention' ||
      meta?.type === 'thread.watch_stopped' ||
      meta?.status === 'failed' ||
      meta?.status === 'cancelled' ||
      meta?.status === 'deleted' ||
      meta?.status === 'attention' ||
      meta?.status === 'stopped'
    ));
  const isProcess = block.variant === 'task' && (
    task?.kind === 'bash' ||
    task?.task_kind === 'process' ||
    task?.command !== undefined ||
    (meta?.title !== undefined && /^Background process\b/i.test(meta.title))
  );
  const injectionHeading = block.variant === 'injection'
    ? resolveInjectionHeading({ category: block.category, variant: block.originVariant, fallbackSource: block.source })
    : undefined;
  let label = injectionHeading !== undefined
    ? (injectionHeading.secondary === undefined ? t(injectionHeading.labelKey) : `${t(injectionHeading.labelKey)} · ${injectionHeading.secondary}`)
    : t(SYSTEM_VARIANT_KEYS[block.variant]);
  let detail: ReactNode = injectionHeading !== undefined
    ? injectionSummary(block.text)
    : (block.source ?? (block.variant === 'task' ? systemHeadline(block.text) : undefined));
  const injectionFacts = injectionHeading === undefined ? [] : [
    ...(block.category === undefined ? [] : [
      block.category.triggers.length > 0 ? t('transcript.reminder.triggers', { triggers: block.category.triggers.join(' · ') }) : undefined,
      block.category.epoch !== undefined ? t('transcript.reminder.epoch', { epoch: block.category.epoch }) : undefined,
      block.category.userTurn !== undefined ? t('transcript.reminder.userTurn', { turn: block.category.userTurn }) : undefined,
    ]),
    injectionHeading.verbatimSource !== undefined ? t('transcript.injection.sourceLabel', { source: injectionHeading.verbatimSource }) : undefined,
  ].filter((fact): fact is string => fact !== undefined);
  if (block.variant === 'thread_watch') {
    if (meta?.title !== undefined && meta.title !== '') label = meta.title;
    const previewFirstLine = meta?.outputPreview?.split('\n', 1)[0]?.trim();
    const bodyFirstLine = meta?.body?.split('\n', 1)[0]?.trim();
    const summaryLine = previewFirstLine && previewFirstLine !== '' ? previewFirstLine : bodyFirstLine;
    detail = summaryLine !== undefined && summaryLine !== ''
      ? (summaryLine.length > 120 ? `${summaryLine.slice(0, 119)}…` : summaryLine)
      : undefined;
  } else if (block.variant === 'task') {
    const desc = (task?.description || task?.command || meta?.description)?.trim();
    const exitCode = task?.exit_code ?? meta?.exitCode;
    if (isProcess) {
      label = t(isFailed ? 'transcript.task.commandFailed' : 'transcript.task.commandCompleted');
      const parts = [
        desc !== undefined && desc !== '' ? desc : systemHeadline(block.text),
        exitCode !== undefined && exitCode !== null ? t('transcript.task.exitCode', { code: exitCode }) : undefined,
      ].filter((part): part is string => part !== undefined && part !== '');
      detail = parts.join(' · ');
    } else if (block.source === undefined && meta?.sourceKind === undefined && task === undefined && meta?.title === undefined) {
      label = t('transcript.task.neutralNotification');
    }
  }
  const watchBody = block.variant === 'thread_watch' ? (meta?.body ?? block.text) : block.text;
  const watchPreview = block.variant === 'thread_watch' ? meta?.outputPreview : undefined;
  return (
    <ActivityRow
      attrs={{ 'data-system': block.variant, 'data-injection-variant': block.originVariant, 'data-superseded': superseded || undefined }}
      glyph={<Icon name={block.variant === 'task' ? 'task' : block.variant === 'cron_job' || block.variant === 'cron_missed' ? 'clock' : 'system'} />}
      tone={isFailed && !superseded ? 'danger' : 'plain'}
      status={isFailed && superseded ? <span aria-label={t('transcript.failedAria')} className="text-ink-faint"><Icon name="warning" size={12} /></span> : undefined}
      label={label}
      detail={detail}
      title={time.absoluteTime(block.createdAt)}
      expanded={open}
      onToggle={() => { setOpen((value) => !value); }}
    >
      {open ? (
        <div className="space-y-1.5">
          <div className="flex max-w-full items-start gap-2 border-l border-hairline pl-3">
            <div className="min-w-0 flex-1 max-h-[28rem] overflow-auto pr-2 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink-faint">
              {injectionFacts.length > 0 ? (
                <p data-injection-facts className="mb-1 select-text font-mono text-[12px] leading-[16px] whitespace-normal text-ink-faint">{injectionFacts.join('  ·  ')}</p>
              ) : null}
              {watchBody}
            </div>
            {watchBody !== '' ? <CopyButton text={block.text} label={label} /> : null}
          </div>
          {watchPreview !== undefined && watchPreview !== '' ? (
            <div className="ml-3 rounded border border-hairline/70 bg-paper/70 px-2.5 py-2">
              <div className="mb-1 text-[12px] leading-[16px] font-normal text-ink-faint">
                {t('transcript.threadWatch.latestOutput')}
              </div>
              <div className="max-h-[16rem] overflow-auto text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink-soft">
                {watchPreview}
              </div>
            </div>
          ) : null}
          <ContentContinuation source={block.contentSource} roots={SYSTEM_MESSAGE_ROOTS} label={label} />
        </div>
      ) : undefined}
    </ActivityRow>
  );
}

export const SkillMessage = memo(function SkillMessage({ block }: { block: SkillBlock }) {
  const { t, time } = useI18n();
  const [open, setOpen] = useState(false);
  useFindReveal(block.id, open, setOpen);
  const pending = useContentContinuation(block.contentSource, SYSTEM_MESSAGE_ROOTS).pending.length > 0;
  const hasBody = block.text !== '' || pending;
  const title =
    block.source === 'plugin'
      ? t('transcript.skill.plugin', { name: block.name })
      : t('transcript.skill.skill', { name: block.name });
  return (
    <ActivityRow
      attrs={{ 'data-skill': true }}
      glyph={<Icon name="skill" />}
      label={title}
      detail={
        block.args === undefined || block.args === ''
          ? undefined
          : <span className="font-mono">{block.args}</span>
      }
      title={time.absoluteTime(block.createdAt)}
      expanded={open}
      onToggle={!hasBody ? undefined : () => { setOpen((value) => !value); }}
    >
      {open && hasBody ? (
        <div className="space-y-1">
          {block.text !== '' ? (
            <div className="flex max-w-full items-start gap-2 border-l border-hairline pl-3">
              <div className="min-w-0 flex-1 max-h-[28rem] overflow-auto pr-2 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink-faint">
                {block.text}
              </div>
              <CopyButton text={block.text} label={title} />
            </div>
          ) : null}
          <ContentContinuation source={block.contentSource} roots={SYSTEM_MESSAGE_ROOTS} label={title} />
        </div>
      ) : undefined}
    </ActivityRow>
  );
});

const GOAL_CHANGE_I18N_KEY: Record<GoalMarkerChange['kind'], I18nKey> = {
  created: 'transcript.marker.goal.created',
  updated: 'transcript.marker.goal.updated',
  paused: 'transcript.marker.goal.paused',
  resumed: 'transcript.marker.goal.resumed',
  blocked: 'transcript.marker.goal.blocked',
  completed: 'transcript.marker.goal.completed',
  cleared: 'transcript.marker.goal.cleared',
};

const COMPACTION_ROOTS = ['payload'] as const;

export const Notice = memo(function Notice({ block, superseded = false }: { block: NoticeBlock; superseded?: boolean }) {
  const { t, time } = useI18n();
  const compactionRecovery = useContext(CompactionRecoveryContext);
  const { placement: placementContext, blocks: allBlocks, onOpenAgent, knownAgentIds } = useContext(NoticePlacementCtx);
  const fromResolved = useResolvedModelDisplay(block.modelSwitchFrom);
  const toResolved = useResolvedModelDisplay(block.modelSwitchTo);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  useFindReveal(block.id, open, setOpen);

  const placement = classifyNoticePlacement(block, placementContext);
  const canRecoverCompaction =
    compactionRecovery.onRetryCompaction !== undefined &&
    compactionRecovery.latestFailedNoticeId === block.id;

  const isLegacyModelSwitch = block.modelSwitch === undefined && block.modelSwitchFrom !== undefined && block.modelSwitchTo !== undefined;
  const fullText = block.goalChange !== undefined
    ? t(GOAL_CHANGE_I18N_KEY[block.goalChange.kind])
    : isLegacyModelSwitch && block.i18n !== undefined
      ? t(block.i18n.key, { ...block.i18n.params, from: fromResolved.label, to: toResolved.label })
      : block.i18n !== undefined ? t(block.i18n.key, block.i18n.params) : block.text;

  const isCompactionError =
    block.compactionPhase === 'failed' ||
    block.compactionPhase === 'interrupted' ||
    block.compactionFailure !== undefined;

  if (placement === 'error') {
    const compactionSuperseded = isCompactionError && (superseded || hasSubsequentCompactionResolution(allBlocks, block.id));
    const effectiveSuperseded = isCompactionError ? compactionSuperseded : superseded;
    const isInterruptedCompaction = block.compactionPhase === 'interrupted';
    const rawMsg = isCompactionError
      ? (block.compactionFailure ?? (isInterruptedCompaction ? t('transcript.error.compactionInterruptedDefault') : fullText))
      : (block.text !== '' && block.text !== 'compaction' ? block.text : fullText);
    const title = isCompactionError
      ? fullText
      : block.taskRef !== undefined
        ? fullText
        : undefined;
    if (effectiveSuperseded) {
      const hasErrorBody = block.errorDetails !== undefined && block.errorDetails !== '';
      return (
        <ActivityRow
          glyph={<Icon name="warning" size={12} />}
          tone="plain"
          label={title ?? rawMsg}
          detail={title !== undefined && rawMsg !== title ? rawMsg : undefined}
          title={time.absoluteTime(block.createdAt)}
          aside={<CopyButton text={block.errorDetails ?? rawMsg} label={title ?? rawMsg} />}
          expanded={hasErrorBody ? open : undefined}
          onToggle={hasErrorBody ? () => { setOpen((value) => !value); } : undefined}
          attrs={{
            'data-notice-tone': 'neutral',
            'data-notice-superseded': 'true',
            'data-notice-key': block.i18n?.key,
          }}
        >
          {open && hasErrorBody ? (
            <div id={detailsId} className="flex items-start gap-2 border-l border-hairline pl-3 text-[12px] leading-[16px] text-ink-faint">
              <p className="min-w-0 flex-1 select-text font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{block.errorDetails}</p>
            </div>
          ) : undefined}
        </ActivityRow>
      );
    }
    const actions: TimelineErrorAction[] = [];
    if (isCompactionError && canRecoverCompaction) {
      actions.push({
        id: 'retry-compaction',
        label: t('transcript.error.retryCompaction'),
        onClick: () => { compactionRecovery.onRetryCompaction?.('summarize'); },
        primary: true,
        dataAttr: 'data-compaction-retry-summarize',
      });
      actions.push({
        id: 'relay-compaction',
        label: t('transcript.error.relayCompaction'),
        onClick: () => { compactionRecovery.onRetryCompaction?.('relay'); },
        confirmMessage: t('transcript.error.relayConfirm'),
        confirmLabel: t('transcript.error.relayConfirmAction'),
        dataAttr: 'data-compaction-retry-fresh',
      });
    }
    return (
      <TimelineErrorCallout
        incidentId={`notice-${block.id}`}
        severity={isInterruptedCompaction ? 'warn' : 'error'}
        title={title}
        message={rawMsg}
        errorDetails={block.errorDetails}
        createdAt={block.createdAt}
        superseded={false}
        actions={actions}
        attrs={{
          'data-notice-tone': 'danger',
          'data-notice-key': block.i18n?.key,
        }}
      />
    );
  }

  if (placement === 'epoch') {
    const history = block.compactionHistory ?? [];
    const hasCompactionSummary = block.summary !== undefined || block.summaryPending === true ||
      history.some((entry) => entry.summary !== undefined || entry.summaryPending === true);
    const translatedReasons = (block.reasonCodes ?? [])
      .map((code) => {
        const key = `transcript.marker.reason.${code}` as I18nKey;
        const translated = t(key);
        return translated === key ? undefined : translated;
      })
      .filter((label): label is string => label !== undefined);
    const hasReasons = !hasCompactionSummary && translatedReasons.length > 0;
    const hasTechSwitchIds = isLegacyModelSwitch;
    const expandable = history.length > 1 || hasCompactionSummary || hasReasons || hasTechSwitchIds;
    const count = block.markerRepeatCount ?? 1;
    const repeatedText = count > 1
      ? (history.length > 0 ? t('transcript.marker.compactionRepeated', { label: fullText, count }) : `${fullText} ×${count}`)
      : fullText;
    const isRunningCompaction = block.compactionPhase === 'running' || block.i18n?.key === 'notice.compacting';
    const metrics = block.compactionMetrics;
    const metricsText = metrics === undefined ? undefined : [
      metrics.beforeTokens !== undefined && metrics.afterTokens !== undefined
        ? `${metrics.beforeTokens.toLocaleString()} → ${metrics.afterTokens.toLocaleString()} tokens`
        : undefined,
      metrics.beforeMessages !== undefined && metrics.afterMessages !== undefined
        ? `${metrics.beforeMessages} → ${metrics.afterMessages}`
        : undefined,
    ].filter((part): part is string => part !== undefined).join(' · ');
    const canLinkBranchSource =
      block.branchBase !== undefined &&
      onOpenAgent !== undefined &&
      knownAgentIds?.has(block.branchBase.sourceAgentId) === true;
    const title = [
      time.absoluteTime(block.createdAt),
      isLegacyModelSwitch ? `${block.modelSwitchFrom} → ${block.modelSwitchTo}` : undefined,
    ].filter((part): part is string => part !== undefined && part !== '').join('\n');

    return (
      <div>
        <TimelineDivider
          tone="plain"
          title={title === '' ? undefined : title}
          attrs={{
            'data-notice-tone': 'neutral',
            'data-notice-placement': 'epoch',
            'data-notice-key': block.i18n?.key,
            'data-compaction-phase': block.compactionPhase,
          }}
        >
          {expandable ? (
            <button
              type="button"
              data-notice-toggle
              data-notice-reasons-toggle
              data-notice-summary-toggle={hasCompactionSummary ? '' : undefined}
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => { setOpen((value) => !value); }}
              className="inline-flex min-h-7 min-w-7 max-w-full cursor-pointer items-center justify-center gap-1 rounded-[6px] px-1.5 text-[12px] leading-[16px] font-normal text-ink-faint transition-colors hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
            >
              {isRunningCompaction ? (
                <span aria-hidden className="status-dot-busy h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft motion-reduce:animate-none" />
              ) : null}
              <span>{repeatedText}</span>
              {metricsText !== undefined && metricsText !== '' ? (
                <span className="tabular-nums text-ink-faint">· {metricsText}</span>
              ) : null}
              <DisclosureChevron open={open} />
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {isRunningCompaction ? (
                <span aria-hidden className="status-dot-busy h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft motion-reduce:animate-none" />
              ) : null}
              <span>{repeatedText}</span>
              {metricsText !== undefined && metricsText !== '' ? (
                <span className="tabular-nums text-ink-faint">· {metricsText}</span>
              ) : null}
              {canLinkBranchSource && block.branchBase !== undefined ? (
                <button
                  type="button"
                  data-branch-source-link={block.branchBase.sourceAgentId}
                  onClick={() => { onOpenAgent?.(block.branchBase!.sourceAgentId); }}
                  className="inline-flex min-h-7 cursor-pointer items-center rounded-[6px] px-1 text-[12px] leading-[16px] font-normal text-selected-ink underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
                >
                  {block.branchBase.sourceAgentId}
                </button>
              ) : null}
            </span>
          )}
        </TimelineDivider>
        {open ? (
          <div id={detailsId} className="mt-1 mb-1.5 space-y-2">
            {isLegacyModelSwitch ? (
              <div className="flex items-center justify-center gap-2 text-[12px] leading-[16px] text-ink-faint">
                <span className="select-text font-mono [overflow-wrap:anywhere]">{block.modelSwitchFrom} → {block.modelSwitchTo}</span>
                <CopyButton text={`${block.modelSwitchFrom} → ${block.modelSwitchTo}`} label={fullText} />
              </div>
            ) : null}
            {hasReasons && history.length <= 1 ? (
              <ul data-compaction-reasons className="space-y-0.5 pl-4 text-[12px] leading-[16px] text-ink-faint">
                {translatedReasons.map((reasonLabel) => (
                  <li key={reasonLabel}>{reasonLabel}</li>
                ))}
              </ul>
            ) : null}
            {history.length > 1 ? (
              <ol data-compaction-history className="flex list-decimal flex-col gap-2.5 pl-[1.4em] text-[12px] leading-snug text-ink-soft marker:text-ink-faint">
                {history.map((entry) => (
                  <li key={entry.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        <span>{time.absoluteTime(entry.createdAt)}</span>
                        {entry.source !== undefined ? <span> · {t(`transcript.marker.compactionSource.${entry.source}` as I18nKey)}</span> : null}
                        {entry.startedAt !== undefined ? <span className="text-ink-faint"> · {t('transcript.marker.compactionStartedAt', { time: time.absoluteTime(entry.startedAt) ?? entry.startedAt })}</span> : null}
                      </span>
                      {entry.summary !== undefined && entry.summary !== '' ? (
                        <CopyButton text={entry.summary} label={fullText} />
                      ) : null}
                    </div>
                    {entry.summary !== undefined && entry.summary !== '' ? (
                      <div data-compaction-summary className="border-l border-hairline pl-3 text-[13px] leading-6 text-ink-soft">
                        <Markdown text={entry.summary} />
                      </div>
                    ) : null}
                    {entry.markerId !== undefined ? (
                      <ContentContinuation
                        source={{ kind: 'marker', id: entry.markerId }}
                        roots={COMPACTION_ROOTS}
                        label={fullText}
                      />
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : hasCompactionSummary ? (
              <div data-compaction-summary className="space-y-1.5">
                {block.summary !== undefined && block.summary !== '' ? (
                  <div className="flex items-start gap-2 border-l border-hairline pl-3">
                    <div className="min-w-0 flex-1 text-[13px] leading-6 text-ink-soft">
                      <Markdown text={block.summary} />
                    </div>
                    <CopyButton text={block.summary} label={fullText} />
                  </div>
                ) : null}
                {block.markerId !== undefined ? (
                  <ContentContinuation
                    source={{ kind: 'marker', id: block.markerId }}
                    roots={COMPACTION_ROOTS}
                    label={fullText}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  const goalReason = block.goalChange?.reason?.trim();
  const planPath = block.planRevision?.path;
  const switchTech = isLegacyModelSwitch ? `${block.modelSwitchFrom} → ${block.modelSwitchTo}` : undefined;
  const bodyDetail = goalReason ?? planPath ?? switchTech ?? (block.i18n === undefined && block.text.includes('\n') ? block.text : undefined);
  const inlineExcerpt = goalReason !== undefined
    ? goalReason
    : planPath !== undefined
      ? planPath
      : undefined;
  const isGoalWarn = block.goalChange?.kind === 'blocked' || block.goalChange?.kind === 'paused';
  const isRunningCompactionActivity = block.compactionPhase === 'running' || block.i18n?.key === 'notice.compacting';
  const glyph = isRunningCompactionActivity
    ? <Spinner label={fullText} size={12} />
    : block.markerKind === 'interruption' || block.i18n?.key === 'transcript.marker.interruption'
      ? <span aria-hidden className="inline-block h-2 w-2 rounded-[2px] bg-ink-faint" />
      : block.goalChange !== undefined
        ? <Icon name={isGoalWarn ? 'warning' : 'check'} size={12} />
        : block.markerKind?.startsWith('plan.')
          ? <Icon name="file" size={12} />
          : block.taskRef !== undefined
            ? <Icon name="task" size={12} />
            : <Icon name="dash" size={12} />;

  return (
    <ActivityRow
      glyph={glyph}
      tone={isGoalWarn ? 'warn' : 'plain'}
      label={fullText}
      detail={inlineExcerpt}
      meta={block.createdAt !== undefined ? <RelativeTime at={block.createdAt} /> : undefined}
      metaTitle={time.absoluteTime(block.createdAt)}
      expanded={bodyDetail === undefined ? undefined : open}
      onToggle={bodyDetail === undefined ? undefined : () => { setOpen((value) => !value); }}
      attrs={{
        'data-notice-tone': 'neutral',
        'data-notice-placement': placement,
        'data-notice-key': block.i18n?.key,
        'data-compaction-phase': block.compactionPhase,
        'data-goal-change': block.goalChange?.kind,
      }}
    >
      {open && bodyDetail !== undefined ? (
        <div id={detailsId} data-notice-detail className="flex items-start gap-2 border-l border-hairline pl-3 text-[12px] leading-[16px] text-ink-soft">
          <p className="min-w-0 flex-1 select-text whitespace-pre-wrap [overflow-wrap:anywhere]">{bodyDetail}</p>
          <CopyButton text={bodyDetail} label={fullText} />
        </div>
      ) : undefined}
    </ActivityRow>
  );
});
