/**
 * Transcript — journal-style rendering of the session blocks: generous
 * whitespace, assistant answers set as unframed prose, soft paper user
 * bubbles, quiet italic thinking lines, tool steps as a compact timeline,
 * dark shell islands, and inline decision strips for approvals/questions.
 *
 * The variable-height block list is windowed with TanStack Virtual. Its
 * end-anchor is the single owner of append follow, streaming growth, prepend
 * anchoring, and full-measurement reset restoration. Runs of ≥2 consecutive
 * tool blocks fold into a "Steps · N" group (aionui's
 * MessageToolGroupSummary, Apache-2.0; kiki auto-expands on error only, not
 * while running).
 */

import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type UIEvent as ReactUIEvent,
} from 'react';
import { parseMarkdownIntoBlocks } from 'streamdown';
import { shiftTextPresentation, type TextPresentation, type ContentRef } from '@kiki/transcript';
import { defaultRangeExtractor, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';

import type { ApprovalDecision, QuestionAnswer } from '@kiki/protocol';

import type { I18nKey } from '@kiki/session-core/i18n';
import {
  collectDraftAnnotationTargets,
  collectTimelineAnnotations,
  applyAnnotationOverrides,
  getAnnotationOverridesSnapshot,
  subscribeAnnotationOverrides,
  writeAnnotationOverride,
  sourceTextVersion,
  parseSelectionCarryovers,
  selectionCarryoverPresentation,
  buildQuotePrefix,
  type TimelineAnnotation,
  type ComposerAttachment,
  appendToDraft,
  prepareThreadRefContext,
  findThreadRefs,
} from '@kiki/session-core/composer';
import {
  subscribeSettings,
  settingsServerSnapshot,
  settingsSnapshot,
} from '@kiki/session-core/settings';
import {
  agentChildren,
  foldHistory,
  groupBlocks,
  groupHasError,
  groupHasRunning,
  groupSummary,
  latestFinalAssistantBlockId,
  latestTurnId,
  MAIN_AGENT_ID,
  readSubagentEndings,
  snapshotSubagentAgentId,
  stepObject,
  stabilizeAgentForest,
  type AgentForest,
  type AgentTreeNode,
  type AssistantBlock,
  type Block,
  type DisplayNode,
  type HistoryFold,
  type MediaRun,
  type NoticeBlock,
  type SubagentEnding,
  type SessionViewState,
  type ShellBlock,
  type SkillBlock,
  type SubagentBlock,
  type SubagentEventBlock,
  type SystemBlock,
  type SystemReminderBlock,
  type ThinkingBlock,
  type ToolBlock,
  type ToolGroup,
  type TurnExecutionInfo,
  type TurnRetryInfo,
  type TurnTailInfo,
  type UserBlock,
  type ActivitySummary,
  type MessageBlock,
  type MessageViewNode,
} from '@kiki/session-core/session';
import { firstSentence, formatTokensPerSecond, plainInline } from '@kiki/session-core/util';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { pushToast } from '../lib/toasts';
import {
  locateInTimeline,
  normalizeTurnId,
  registerTimelineLocator,
  timelineBecameVisible,
  timelineTargetKey,
  type LocateOutcome,
  type TimelineTarget,
} from '../lib/timelineLocate';
import { timelineSnapshotKey, type TimelineReadingSnapshot } from '../lib/navViewState';
import { restoreTimelineReading, type TimelineReadingAdapter } from '../lib/timelineReading';
import { useNavSnapshotAdapter } from '../lib/useNavSnapshot';
import { useTimelineVisitLocator } from '../lib/useTimelineNavigation';
import {
  HistoryLine,
  isAbortedPromptNotice,
  isInterruptionNotice,
} from './ActivityHistory';
import {
  ActivityRow,
  ACTIVITY_GUTTER,
  TimelineDivider,
} from './timeline/ActivityRow';
import { AnnotationPopover, type AnnotationPopoverOpen } from './AnnotationPopover';
import { QuoteChip } from './ContextChips';
import { ModelSwitchNotice } from './model-switch/ModelSwitchNotice';
import { SentAnnotationsBubble } from './SentAnnotationsBubble';
import { FloorNavRail } from './FloorNavRail';
import {
  TRANSCRIPT_END_THRESHOLD,
  TRANSCRIPT_ESTIMATED_ROW_HEIGHT,
  installTranscriptAnchoring,
  landAtEnd,
  measureTranscriptRow,
  reconcileMountedRows,
} from './transcriptVirtualizer';
import { ApprovalCard, InteractionRecord, QuestionCard, useInteractionPlacement } from './Interactions';
import { ExecutorNoteRow, TurnExecutionBadge } from './timeline/ExecutorNotes';
import { ExternalTextRow } from './timeline/ExternalTextRow';
import { MediaRunRow, SubagentEndedRow, SubagentGroupRow } from './timeline/FoldRows';
import { FindBar } from './timeline/FindBar';
import { buildFindItems } from './timeline/findItems';
import { createFindRevealStore, FindRevealContext, useFindReveal } from './timeline/findReveal';
import { KikiHookRow } from './timeline/KikiHookRow';
import { parseKikiHookEvent } from './harness/kikiHook';
import {
  attrSelector,
  findRanges,
  paintFindHighlights,
  rangeIsClipped,
  registerFindHost,
  scrollRangeIntoView,
  turnOrdinal,
  type FindHost,
  type FindItem,
  type FindMatch,
} from '../lib/timelineFind';
import {
  EarlierPromptOutcomesRow,
  PromptOutcomeActionsContext,
  PromptOutcomeLine,
  usePromptOutcomeActions,
  type PromptOutcomeActions,
} from './timeline/PromptOutcome';
import { Markdown } from './Markdown';
import { projectTextWithAnnotationMarks } from './markdown/annotationMarks';
import { MediaPartList } from './mediaParts';
import { RelativeTime } from './RelativeTime';
import { NestedFoldContext, NestedFoldStore, countFoldedDescendants, groupDescendantsByDispatch, useDispatchGroup, useNestedFold } from './timeline/nestedFold';
import { InvocationContext, useInvocationDetails } from './timeline/SubagentInvocationView';
import { AgentTurnOutcomeLine } from './timeline/AgentTurnOutcomeLine';
import { MessageLinkContext, MessageRowActions, messageLinkHref, UserMessageEditor, useMessageLink, useMessageRowTapActions } from './RowActions';
import { ThreadRefText } from './ThreadRefChip';
import { useThreadRefDirectory } from '../lib/threadRefs';
import { resolveSubagentToolCalls, type SubagentToolCalls } from './subagentToolCalls';
import { activityOutcomeLabels, DURATION_WORTH_SHOWING_MS, ToolCard } from './ToolCard';
import { DisclosureChevron, Icon, OutcomeMark } from './icons';
import { Wordmark } from './Wordmark';
import { useContentContinuation, useTranscriptDetail, useTranscriptController } from './transcriptDetail';
import { ContentContinuation, frameContentSource, MESSAGE_TEXT_ROOTS, OUTPUT_ROOTS, SHELL_COMMAND_ROOTS, TASK_OUTPUT_ROOTS, TURN_STEP_ROOTS } from './ContentContinuation';
import { useSessionRemainderPending } from './SessionRemainder';
import { BridgedOriginRow } from './message/BridgedOriginLine';
import { MessageRow, SpeakerHead, speakerOf } from './message/MessageRow';
import { ActivitySummaryRow, HandoffRow, isSilentActivity, OutcomeLine, PresenceLine } from './message/MessageTimelineRows';
import { buildMessageNodes, isInboundHandoff, presenceOf, speakerKey } from './message/messageTimeline';
import { writeTimelineView, type TimelineView } from './message/messageViewMode';
import { useMessageViewContext } from './message/messageViewContext';

/**
 * Split streaming assistant text into a settled prefix (safe to parse as
 * markdown — ends at a blank-line boundary with balanced code fences) and a
 * hot tail. The prefix re-parses only when it grows past another boundary;
 * the tail renders as plain text until a step/turn boundary settles the block
 * and the whole text upgrades to full markdown. This keeps live rendering off
 * the O(full-text) re-parse path the lexer benchmarks showed dominating
 * long streams.
 */
export function splitStreamingText(text: string): { prefix: string; tail: string } {
  let cut = text.lastIndexOf('\n\n');
  while (cut > 0) {
    const prefix = text.slice(0, cut);
    if ((prefix.match(/```/g) ?? []).length % 2 === 0) {
      return { prefix, tail: text.slice(cut + 2) };
    }
    cut = text.lastIndexOf('\n\n', cut - 1);
  }
  return { prefix: '', tail: text };
}

/**
 * Reference/footnote definitions (`[label]: target`) register document-level
 * symbols: a definition in one block rewrites inline links in every other
 * block, so block-local parsing is unsafe when one is present. Same rule as
 * pi-tui's markdown block cache (packages/pi-tui/src/components/markdown.ts).
 * Rare in assistant output — the prefix then stays one document.
 */
const REFERENCE_DEFINITION_LINE = /^ {0,3}\[[^\n]*\]:/m;

/** Chunks up to this size keep per-delta memo-skip reconciliation short. */
const STREAMING_SEGMENT_TARGET = 2000;

/**
 * Split a settled streaming prefix into independently parseable chunks.
 *
 * Boundaries come from `parseMarkdownIntoBlocks` (marked's top-level token
 * boundaries — the same splitter Streamdown itself uses), NOT from character
 * scanning: a fence (``` or ~~~), a loose list, or a blockquote that spans
 * blank lines is a single token and therefore never split. Blocks are exact
 * source slices (they join back to the input verbatim), so small blocks are
 * coalesced into chunks of up to ~2k chars by plain concatenation, and a
 * growing stream only ever extends the final chunk — earlier chunk strings
 * stay referentially stable, which is what makes the per-chunk Markdown
 * memo effective.
 *
 * Reference definitions are the one cross-block construct tokenization
 * cannot isolate; when present, the whole prefix stays a single chunk (the
 * pre-segmentation behavior — correct, just slower for that rare stream).
 */
export function splitPrefixSegments(prefix: string): string[] {
  if (REFERENCE_DEFINITION_LINE.test(prefix)) return [prefix];
  const blocks = parseMarkdownIntoBlocks(prefix);
  if (blocks.length <= 1) return blocks;
  const chunks: string[] = [];
  let chunk = '';
  for (const block of blocks) {
    if (chunk !== '' && chunk.length + block.length > STREAMING_SEGMENT_TARGET) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += block;
  }
  if (chunk !== '') chunks.push(chunk);
  return chunks;
}

/**
 * Decorate `@subagent` tokens in user prose as accent chips
 * (deepseek-harness's projectUserText, MIT — token shape only, no
 * lexicon). Presentation-only: every slice comes from the original string at
 * exact offsets, so selection/copy keeps the verbatim text.
 *
 * Slash-looking tokens are deliberately NOT chipped: a leading `/` is plain
 * prose unless the submit-time command resolution matched a registered
 * skill/command (that path renders from the activation record as a SkillBlock
 * instead), so text shape alone is never sufficient evidence for a skill
 * label.
 */
export function projectUserText(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/(^|\s)(@[\w-]+)(?=\s|$)/g)) {
    const tokenStart = match.index + (match[1]?.length ?? 0);
    const label = match[2] ?? '';
    if (tokenStart > cursor) parts.push(text.slice(cursor, tokenStart));
    parts.push(
      <span
        key={tokenStart}
        data-ref-chip="subagent"
        className="rounded-md bg-ink/[0.05] px-1 py-px font-mono text-[12px] font-medium text-ink"
      >
        {label}
      </span>,
    );
    cursor = tokenStart + label.length;
  }
  if (parts.length === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/**
 * Row-level action surface handed down from SessionView. Absent on read-only
 * or subagent transcripts — no hover actions render there.
 */
export interface TranscriptRowActions {
  /** Turn running / resyncing: mutating actions render but disable. */
  disabled: boolean;
  onEditMessage: (block: UserBlock, text: string, attachments?: readonly ComposerAttachment[], presentation?: TextPresentation) => void | Promise<void>;
  loadEditAttachments?: (block: UserBlock) => Promise<readonly ComposerAttachment[]>;
  onRegenerate: (block: AssistantBlock) => void;
  onFork: (block: UserBlock | AssistantBlock) => void;
  /** False when the session's engine cannot fork (external handshake said no): the fork action leaves the row. */
  canFork?: boolean;
  /** Re-run the stopped turn (regenerate its assistant reply). */
  onResumeStopped?: (block: AssistantBlock) => void;
}

/**
 * The role profile and model an injected message's sender agent runs under,
 * read from the session's subagent roster (`snapshot.subagents`). The wire
 * prompt origin carries only `senderAgentId`/`senderTaskName`, so the label
 * joins the roster by agent id and degrades to the name alone when the
 * roster has no row for that sender yet.
 */
export interface SenderIdentity {
  readonly profile?: string;
  readonly model?: string;
}

const UserMessage = memo(function UserMessage({
  block,
  onCancelQueued: _onCancelQueued,
  rowActions,
  annotations,
  senderIdentities,
}: {
  block: UserBlock;
  onCancelQueued?: (promptId: string) => void;
  rowActions?: TranscriptRowActions;
  /** Timeline annotations anchored to this message's text (identity-stable). */
  annotations?: readonly TimelineAnnotation[];
  /** senderAgentId → role profile / model, for the injected-message label. */
  senderIdentities?: ReadonlyMap<string, SenderIdentity>;
}) {
  const { t, time } = useI18n();
  const outcomeActions = usePromptOutcomeActions();
  const messageLink = useMessageLink();
  const [editing, setEditing] = useState(false);
  const tapActions = useMessageRowTapActions<HTMLDivElement>();

  // Edit/fork need the stable wire identity; parked prompts settle through
  // the queue strip instead of a rewrite.
  const settled = block.promptStatus === undefined && block.steerStatus === undefined;
  const incomplete = useContentContinuation(block.contentSource, MESSAGE_TEXT_ROOTS).pending.length > 0;
  const canMutate = rowActions !== undefined && block.userMessageId !== undefined && settled && !incomplete;
  const agentMessageLabel =
    block.agentMessage === undefined
      ? undefined
      : block.agentMessage.senderAgentId === 'main'
        ? t('agentMessage.fromMain')
        : t('agentMessage.fromAgent', {
            name:
              block.agentMessage.senderTaskName ??
              block.agentMessage.senderAgentId ??
              t('agentMessage.agent'),
          });
  const peerThreadLabel =
    block.peerThread === undefined
      ? undefined
      : t('agentMessage.fromThread', { id: block.peerThread.sessionId ?? '?' });
  const senderLabel = agentMessageLabel ?? peerThreadLabel;
  // The sender's role profile and model come from the session roster, keyed by
  // the sender's agent id: the prompt origin carries no profile/model of its
  // own. A sender with no roster row keeps the plain "{name} injected" label.
  const senderAgentId = block.agentMessage?.senderAgentId;
  const senderIdentity =
    senderAgentId === undefined ? undefined : senderIdentities?.get(senderAgentId);
  const senderMeta = [
    senderIdentity?.profile === undefined
      ? undefined
      : t('agentMessage.senderProfile', { profile: senderIdentity.profile }),
    senderIdentity?.model === undefined
      ? undefined
      : t('agentMessage.senderModel', { model: senderIdentity.model }),
  ].filter((part): part is string => part !== undefined).join(' · ');
  // Hover details: every field the row knows, with an explicit "unknown" for
  // the roster facts the client has no row for (rather than omitting a line).
  const unknownDetail = t('agentMessage.detailsUnknown');
  const senderDetails =
    senderAgentId === undefined
      ? undefined
      : t('agentMessage.senderDetails', {
          agentId: senderAgentId,
          profile: senderIdentity?.profile ?? unknownDetail,
          model: senderIdentity?.model ?? unknownDetail,
          task: block.agentMessage?.senderTaskName ?? unknownDetail,
        });
  const carry = useMemo(() => parseSelectionCarryovers(block.text, block.presentation), [block.text, block.presentation]);
  const bodyText = carry.body;
  const typedText = [
    ...carry.annotations.map((annotation) => `${buildQuotePrefix(annotation.quote)}${annotation.comment}\n\n`),
    carry.quote === null ? '' : buildQuotePrefix(carry.quote),
    bodyText,
  ].join('');
  const threadRefDirectory = useThreadRefDirectory(
    useMemo(() => findThreadRefs(bodyText).map((ref) => ref.sessionId), [bodyText]),
  );
  const carried = carry.annotations.length > 0 || carry.quote !== null;
  const media = block.media ?? [];
  const projectBody = useCallback(
    (segment: string) => <ThreadRefText text={segment} projectSegment={projectUserText} />,
    [],
  );
  return (
    <div
      ref={tapActions.rowRef}
      data-actions-open={tapActions.open ? 'true' : undefined}
      className="anim-enter group/msg relative flex flex-col items-end"
      title={time.absoluteTime(block.createdAt)}
      onClick={tapActions.onClick}
    >
      {/* Meta line: the sender shows only when it is not the user (agent or
          peer-thread messages); the time stays quiet until hover/focus so the
          bubble reads as the user's own voice. */}
      <span className="mb-1 flex min-h-[18px] items-baseline gap-1.5 pr-1">
        {senderLabel !== undefined ? (
          <span
            data-agent-message-sender={block.agentMessage?.senderAgentId}
            data-peer-thread={block.peerThread?.sessionId}
            className="text-[12px] font-medium text-ink-soft"
            title={senderDetails}
          >
            {senderLabel}
          </span>
        ) : null}
        {senderMeta === '' ? null : (
          <span
            data-agent-message-sender-meta={block.agentMessage?.senderAgentId}
            className="text-[12px] text-ink-faint"
            title={senderDetails}
          >
            {senderMeta}
          </span>
        )}
        <span
          data-user-time
          className={`text-[12px] text-ink-faint transition-opacity duration-[var(--kiki-motion-quick)] ${
            senderLabel !== undefined
              ? ''
              : 'opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 [@media(hover:none)]:opacity-100'
          }`}
        >
          <RelativeTime at={block.createdAt} />
        </span>
      </span>
      {carried && !editing ? (
        <div data-user-context className="mb-1.5 flex max-w-[80%] flex-wrap items-center justify-end gap-1.5">
          {carry.quote !== null ? <QuoteChip quote={carry.quote} /> : null}
          {/* Sent notes fold into one bubble beside the message; the timeline
              itself only marks notes still riding the composer's draft. */}
          {carry.annotations.length > 0 ? (
            <SentAnnotationsBubble blockId={block.id} annotations={carry.annotations} />
          ) : null}
        </div>
      ) : null}
      {media.length > 0 ? <div data-user-media className="mb-1.5"><MediaPartList media={media} align="end" /></div> : null}
      {/* A message that crossed a machine names where it came from, above the
          bubble it belongs to; a source this window can open is a link. */}
      {block.bridgedPeer !== undefined && !editing ? (
        <div className="mb-1 flex justify-end"><BridgedOriginRow block={block} /></div>
      ) : null}
      {editing && rowActions !== undefined ? (
        <UserMessageEditor
          initialText={bodyText}
          loadAttachments={rowActions.loadEditAttachments === undefined ? undefined : () => rowActions.loadEditAttachments!(block)}
          onSubmit={async (text, attachments, editedPresentation) => {
            const prepared = editedPresentation === undefined
              ? prepareThreadRefContext(text, threadRefDirectory.info)
              : { text, presentation: editedPresentation };
            const selections = selectionCarryoverPresentation(carry.annotations.map((annotation, index) => ({ ...annotation, id: String(index) })), carry.quote, carry.quoteSource);
            const presentation = { spans: [...selections.presentation.spans, ...(shiftTextPresentation(prepared.presentation, selections.prefix.length)?.spans ?? [])] };
            await rowActions.onEditMessage(block, selections.prefix + prepared.text, attachments, presentation);
            setEditing(false);
          }}
          onCancel={() => { setEditing(false); }}
        />
      ) : bodyText.trim() === '' ? null : (
        <div
          data-steer-status={block.steerStatus}
          className={`max-w-[80%] rounded-[14px] rounded-br-[6px] px-4 py-2 text-[14px] leading-[1.6] whitespace-pre-wrap text-ink steer-bubble ${
            block.steerStatus === undefined ? 'bg-bubble-user' : 'steer-bubble-pending'
          }`}
        >
          <div
            data-source-block-id={block.id}
            data-source-version={sourceTextVersion(block.text)}
          >
            {annotations === undefined || annotations.length === 0
              ? projectBody(bodyText)
              : projectTextWithAnnotationMarks(bodyText, annotations, projectBody)}
          </div>
        </div>
      )}
      <ContentContinuation source={block.contentSource} roots={MESSAGE_TEXT_ROOTS} presentation={block.presentation} renderText={projectBody} label={t('subagent.message')} className="mt-1 justify-end" />
      {/* Row actions hang under the bubble they belong to, flush right: an
          overlay off the row's bottom edge that reserves no height and never
          sits over the bubble's own inline links. */}
      {(rowActions !== undefined || messageLink !== undefined) && !editing ? (
        <MessageRowActions
          align="right"
          copyText={incomplete ? undefined : typedText}
          linkHref={messageLink?.(block.id)}
          canEdit={canMutate}
          canFork={canMutate && rowActions?.canFork !== false}
          disabled={rowActions?.disabled}
          onEdit={() => { setEditing(true); }}
          onFork={() => { rowActions?.onFork(block); }}
        />
      ) : null}

      {block.optimisticStatus !== undefined ? (
        <span role="status" data-optimistic-status={block.optimisticStatus} className="mt-1 mr-1 text-[11px] text-ink-faint">
          {t(block.optimisticStatus === 'slow' ? 'transcript.stillSending' : 'transcript.sending')}
        </span>
      ) : null}
      {block.steerStatus !== undefined ? (
        <span
          role="status"
          data-steer-line={block.steerStatus}
          title={block.steerStatus === 'waiting' ? t('transcript.steerWaitingTitle') : undefined}
          className="mt-1 mr-1 flex items-center gap-1.5 text-[11px]"
        >
          <span aria-hidden className="steer-mark" />
          {block.steerStatus === 'waiting' ? (
            <>
              <span className="font-medium text-selected-ink">{t('transcript.steerWaiting')}</span>
              <span className="text-ink-faint">· {t('transcript.steerWaitingHint')}</span>
            </>
          ) : (
            <span className="text-ink-faint">{t('transcript.steerSending')}</span>
          )}
        </span>
      ) : null}
      {block.promptStatus === 'blocked' ? (
        <span className="mt-1 mr-1 flex items-center gap-1.5 text-[11px] font-medium text-danger">
          {t('transcript.blocked')}
        </span>
      ) : null}
      {block.promptOutcome !== undefined && !editing ? (
        <PromptOutcomeLine
          outcome={block.promptOutcome}
          onRetry={outcomeActions.onRetry === undefined || typedText.trim() === ''
            ? undefined
            : () => { outcomeActions.onRetry?.(typedText); }}
          retryDisabled={outcomeActions.disabled === true}
        />
      ) : null}
    </div>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  block,
  rowActions,
  isLatestFinal = false,
  annotations,
  stopShownByTail = false,
}: {
  block: AssistantBlock;
  rowActions?: TranscriptRowActions;
  /** Latest completed turn's final reply — the regenerate/fork anchor. */
  isLatestFinal?: boolean;
  /** The visible turn tail already carries this turn's stop. */
  stopShownByTail?: boolean;
  /** Timeline annotations anchored to this message's text (identity-stable). */
  annotations?: readonly TimelineAnnotation[];
}) {
  const { t, time } = useI18n();
  const messageLink = useMessageLink();
  const tapActions = useMessageRowTapActions<HTMLDivElement>();
  const source = frameContentSource(block);
  const incomplete = useContentContinuation(source, MESSAGE_TEXT_ROOTS).pending.length > 0;
  const internalProse = useMessageViewContext().internalProse && block.text !== '';
  const streaming = block.streaming && block.text !== '';
  const { prefix, tail } = useMemo(
    () => (streaming ? splitStreamingText(block.text) : { prefix: '', tail: '' }),
    [streaming, block.text],
  );
  const segments = useMemo(
    () => (streaming && prefix !== '' ? splitPrefixSegments(prefix) : []),
    [streaming, prefix],
  );
  const showActions =
    !block.streaming &&
    (block.text !== '' || (rowActions !== undefined && isLatestFinal));
  return (
    <div
      ref={tapActions.rowRef}
      data-actions-open={tapActions.open ? 'true' : undefined}
      className="anim-enter group/msg relative"
      title={time.absoluteTime(block.createdAt)}
      onClick={tapActions.onClick}
    >
      {/* Bot mode: plain prose never reaches the user; the process view marks
          it once, in the margin, without restyling the text itself. */}
      {internalProse ? (
        <span data-assistant-internal className="mb-0.5 block text-[11px] leading-4 font-medium tracking-wide text-ink-faint">
          {t('message.internal')}
        </span>
      ) : null}
      {/* No leading marker: the right-aligned user bubble already carries
          the turn boundary, so the answer sits on the page as prose. */}
      <div data-assistant-prose className="kiki-prose min-w-0">
        {streaming ? (
          <>
            {segments.length > 0 ? (
              <div className="kiki-md-segments">
                {segments.map((segment, index) => (
                  <Markdown key={index} text={segment} preserveEdgeMargins />
                ))}
              </div>
            ) : null}
            <div className="kiki-prose-tail break-words whitespace-pre-wrap text-ink">
              {tail}
              <span className="stream-caret font-mono">▍</span>
            </div>
          </>
        ) : (
          <>
            {/* Marks ride the settled render only: a streaming block's text
                still moves under the quote, and a quote split across the
                memoized prefix chunks would silently lose its mark anyway. */}
            {block.text !== '' ? <Markdown text={block.text} sourceBlockId={block.id} annotationTargets={annotations} /> : null}
            {block.streaming ? <span className="stream-caret font-mono">▍</span> : null}
          </>
        )}
        {block.media !== undefined ? <MediaPartList media={block.media} /> : null}
        {/* The turn tail's "Stopped by you" divider already states the stop
            of the latest turn; the inline mark stays for older stopped turns. */}
        {block.stopped === true && !stopShownByTail ? (
          <span className="mt-1.5 inline-flex items-center gap-1.5 font-sans text-[12px] font-medium text-ink-faint">
            <span aria-hidden className="h-2 w-2 rounded-[2px] bg-ink-faint/70" />
            {t('transcript.stopped')}
          </span>
        ) : null}
      </div>
      <ContentContinuation source={source} roots={MESSAGE_TEXT_ROOTS} label={t('subagent.message')} className="mt-1" />
      {showActions ? (
        <MessageRowActions
          align="left"
          copyText={incomplete ? undefined : block.text}
          linkHref={messageLink?.(block.id)}
          canRegenerate={rowActions !== undefined && isLatestFinal}
          canFork={rowActions !== undefined && rowActions.canFork !== false && isLatestFinal}
          disabled={rowActions?.disabled ?? false}
          onRegenerate={() => { rowActions?.onRegenerate(block); }}
          onFork={() => { rowActions?.onFork(block); }}
        />
      ) : null}
    </div>
  );
});

function firstLineOf(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

/** An injected body's first readable line: envelope tags are transport. */
function injectionSummary(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi, '').trim();
    if (line !== '') return line;
  }
  return '';
}

function latestLineOf(text: string): string {
  const visible = text.trimEnd();
  const newline = visible.lastIndexOf('\n');
  return newline === -1 ? visible : visible.slice(newline + 1);
}

const ThinkingMessage = memo(function ThinkingMessage({ block }: { block: ThinkingBlock }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  useFindReveal(block.id, open, setOpen);
  // deepseek-harness's ReasoningRow summary rule: while tokens are streaming
  // the collapsed line tracks the LATEST line; once settled it pins the first.
  const summary = block.streaming ? latestLineOf(block.text) : firstLineOf(block.text);
  // Thinking is the one activity row set in italic: it is the agent's voice,
  // not an action it performed, so it reads adjacent to the prose while still
  // keeping the lane's glyph column and rhythm.
  return (
    <ActivityRow
      className="thinking-row"
      attrs={{ 'data-streaming': block.streaming || undefined }}
      glyph={<Icon name="think" />}
      label={
        <span className="font-normal text-ink-faint italic">
          {t('transcript.thinking')}{block.streaming ? '…' : ''}
        </span>
      }
      detail={summary === '' ? undefined : <span className="text-ink-faint/80 italic">{summary}</span>}
      expanded={open}
      onToggle={() => { setOpen((value) => !value); }}
    >
      {open ? (
        <div className="border-l border-hairline pl-3 text-[14px] leading-[1.6] whitespace-pre-wrap text-ink-soft italic">
          {block.text}
          <ContentContinuation source={frameContentSource(block)} roots={MESSAGE_TEXT_ROOTS} label={t('transcript.thinking')} className="mt-1 not-italic" />
        </div>
      ) : undefined}
    </ActivityRow>
  );
});

/** Category heading per reminder disclosure kind (continuity reminders). */
const REMINDER_CATEGORY_KEYS = {
  directive: 'transcript.reminder.directive',
  renew: 'transcript.reminder.renew',
  rebuild: 'transcript.reminder.rebuild',
  history: 'transcript.reminder.history',
  progress: 'transcript.reminder.progress',
} as const;

/** Daemon-injected reminder peeled out of a user message — left lane, dimmed,
 * collapsed by default so the user's own bubble stays clean. The first line
 * rides the collapsed row so it never reads as an empty "System reminder".
 * A reminder whose disclosure names its kind takes that kind as its heading
 * (same weight and ink as the generic one, so it never outranks prose); the
 * trigger facts wait in the expanded body. */
const SystemReminderMessage = memo(function SystemReminderMessage({
  block,
}: {
  block: SystemReminderBlock;
}) {
  const { t, time } = useI18n();
  const [open, setOpen] = useState(false);
  useFindReveal(block.id, open, setOpen);
  const category = block.category;
  const facts = category === undefined ? [] : [
    category.triggers.length > 0 ? t('transcript.reminder.triggers', { triggers: category.triggers.join(' · ') }) : undefined,
    category.epoch !== undefined ? t('transcript.reminder.epoch', { epoch: category.epoch }) : undefined,
    category.userTurn !== undefined ? t('transcript.reminder.userTurn', { turn: category.userTurn }) : undefined,
  ].filter((fact): fact is string => fact !== undefined);
  return (
    <ActivityRow
      attrs={{ 'data-reminder-kind': category?.kind }}
      glyph={<Icon name="system" />}
      label={<span className="font-normal text-ink-faint">{t(category === undefined ? 'transcript.systemReminder' : REMINDER_CATEGORY_KEYS[category.kind])}</span>}
      detail={<span className="text-ink-faint/80">{injectionSummary(block.text)}</span>}
      title={time.absoluteTime(block.createdAt)}
      expanded={open}
      onToggle={() => { setOpen((value) => !value); }}
    >
      {open ? (
        <div className="max-h-[140px] overflow-auto border-l border-hairline pr-2 pl-3 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-faint">
          {facts.length > 0 ? (
            <p data-reminder-facts className="mb-1 font-mono text-[11px] whitespace-normal text-ink-faint/80">{facts.join('  ·  ')}</p>
          ) : null}
          {block.text}
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
  retry: 'transcript.system.retry',
  agent_message: 'transcript.system.agent',
  system: 'transcript.system.generic',
} as const;

/**
 * A background-task notification that reports a failure must stay visible in a
 * scan; a success is an ordinary quiet row. agent-core owns the title format.
 */
function isFailedTaskNotificationText(text: string): boolean {
  const firstLine = text.split('\n', 1)[0] ?? '';
  return (
    /^(?:Title:\s*)?Background \S+ (?:failed|timed_out|killed|lost)\b/.test(firstLine) ||
    /^Severity:\s*warning\s*$/m.test(text)
  );
}

/**
 * A background-task notification's own headline ("Background process
 * completed"), so the settled row still names what happened when the event
 * carries no source. Only task notifications: their first line is a status
 * headline, while other variants carry injected content that stays folded.
 * Envelope tags and the `Title:` prefix are transport, not content.
 */
function systemHeadline(text: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/<\/?notification[^>]*>/g, '').replace(/^Title:\s*/, '').trim();
    if (line !== '') return line;
  }
  return undefined;
}

const SystemMessage = memo(function SystemMessage({ block }: { block: SystemBlock }) {
  const hook = block.variant === 'hook_result' ? parseKikiHookEvent(block.hookEvent) : undefined;
  if (hook !== undefined) return <KikiHookRow block={block} hook={hook} />;
  return <PlainSystemMessage block={block} />;
});

function PlainSystemMessage({ block }: { block: SystemBlock }) {
  const { t, time } = useI18n();
  const [open, setOpen] = useState(false);
  useFindReveal(block.id, open, setOpen);
  const failed = block.variant === 'task' && isFailedTaskNotificationText(block.text);
  return (
    <ActivityRow
      attrs={{ 'data-system': block.variant }}
      glyph={<Icon name={block.variant === 'task' ? 'task' : block.variant === 'cron_job' || block.variant === 'cron_missed' ? 'clock' : 'system'} />}
      tone={failed ? 'danger' : 'plain'}
      label={t(SYSTEM_VARIANT_KEYS[block.variant])}
      detail={block.source ?? (block.variant === 'task' ? systemHeadline(block.text) : undefined)}
      title={time.absoluteTime(block.createdAt)}
      expanded={open}
      onToggle={() => { setOpen((value) => !value); }}
    >
      {open ? (
        <div className="max-h-[140px] overflow-auto border-l border-hairline pr-2 pl-3 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-faint">
          {block.text}
        </div>
      ) : undefined}
    </ActivityRow>
  );
}

const SkillMessage = memo(function SkillMessage({ block }: { block: SkillBlock }) {
  const { t, time } = useI18n();
  const [open, setOpen] = useState(false);
  useFindReveal(block.id, open, setOpen);
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
      onToggle={block.text === '' ? undefined : () => { setOpen((value) => !value); }}
    >
      {open && block.text !== '' ? (
        <div className="max-h-36 overflow-auto border-l border-hairline pr-2 pl-3 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-faint">
          {block.text}
        </div>
      ) : undefined}
    </ActivityRow>
  );
});

export const ShellMessage = memo(function ShellMessage({ block }: { block: ShellBlock }) {
  const { t } = useI18n();
  // Collapsed by default — running and finished alike (the full log was
  // eating the timeline). The header keeps the status and the command, while
  // the latest output line remains a separate muted preview.
  const [open, setOpen] = useState(false);
  useFindReveal(block.id, open, setOpen);
  const preview = latestLineOf(block.output);
  // A shell run is an activity line like any other; only its OUTPUT keeps the
  // dark island. The old always-dark collapsed header made every command look
  // like the loudest thing in the turn even when it succeeded quietly.
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
            {/* A failure says the word: a red glyph alone makes the reader
                decode a symbol, and the aria-label is not on screen. */}
            {block.done && block.isError === true ? (
              <span className="font-medium"> — {t('transcript.failed')}</span>
            ) : null}
            {/* The latest output line is the reason not to expand: a green
                suite or an exit code answers the question in place. */}
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
          <pre className={`max-h-80 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-shell-ink${block.command === undefined && block.outputDetail === undefined ? '' : ' border-t border-shell-hairline'}`}>
            {block.output === '' ? '…' : block.output}
          </pre>
        </div>
      ) : undefined}
      {open ? (
        // Beyond the island, on paper: the command line and the output it
        // produced are each continued by their own control, and neither ever
        // points at the other's entity.
        <div className="mt-1 space-y-1">
          {block.command === undefined ? null : (
            <ContentContinuation
              source={frameContentSource(block)}
              roots={SHELL_COMMAND_ROOTS}
              label={t('transcript.content.command')}
            />
          )}
          <ContentContinuation
            source={block.outputTaskId === undefined
              ? frameContentSource(block)
              : { kind: 'task', id: block.outputTaskId }}
            roots={block.outputTaskId === undefined ? OUTPUT_ROOTS : TASK_OUTPUT_ROOTS}
            label={t('tc.output')}
          />
        </div>
      ) : undefined}
    </ActivityRow>
  );
});

/**
 * A turn whose structure did not fit the window: its step list — and one
 * step's own frames — can be cut as an array, so the turn's tail carries the
 * outlet. The row names the turn it belongs to, never an array index it would
 * have to guess.
 */
function TurnStepsContinuation({ turnId }: { turnId: string }) {
  const { t } = useI18n();
  return (
    <ContentContinuation
      source={{ kind: 'turn', id: turnId }}
      roots={TURN_STEP_ROOTS}
      label={t('transcript.content.steps')}
    />
  );
}

/**
 * The window carried only the tail of this task's output: say so where the
 * missing lines would be (above the tail), and read the rest on request.
 */
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
        className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-shell-hairline px-2 font-medium text-shell-ink-strong transition-colors hover:bg-shell-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-80 motion-reduce:transition-none"
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

/**
 * Parse an ISO timeline timestamp that may be absent (undefined / the
 * legacy '' sentinel) or unparseable; undefined means "unknown", never 0.
 */
function parseTimelineMs(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Elapsed time for a subagent card. undefined when either end is genuinely
 * unknown (the card then shows an explicit "—" instead of a fabricated 0ms);
 * a live run ticks against the live clock. The forest node is the
 * authoritative source for the CURRENT run (a resume re-stamps its timing);
 * the block's frozen dispatch snapshot is only the fallback, and its stale
 * endedAt must never pin a live run at 0ms.
 */
function useSubagentElapsed(
  block: SubagentBlock,
  node: AgentTreeNode | undefined,
  status: AgentTreeNode['status'] | SubagentBlock['status'],
): number | undefined {
  const live = status === 'running' || status === 'background' || status === 'suspended';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [live]);
  const start = parseTimelineMs(node?.startedAt) ?? parseTimelineMs(block.startedAt);
  if (start === undefined) return undefined;
  const end = live ? now : (parseTimelineMs(node?.endedAt) ?? parseTimelineMs(block.endedAt));
  if (end === undefined) return undefined;
  return Math.max(0, end - start);
}

function subagentStatusTone(status: AgentTreeNode['status'] | SubagentBlock['status']): string {
  switch (status) {
    case 'running':
    case 'background':
      // Working is not "needs you": accent is reserved for waiting.
      return 'bg-ink-soft';
    case 'completed':
      // A settled child is ordinary history, not news: neutral like every
      // other finished row. `success` is reserved for "just finished, you
      // should know", which the timeline never needs to say.
      return 'bg-ink-faint';
    case 'failed':
    case 'lost':
      return 'bg-danger';
    case 'cancelled':
    case 'idle':
    case 'unknown':
      return 'bg-ink-faint';
    case 'suspended':
      return 'bg-amber-rule';
  }
}

function SubagentCardBody({
  name,
  model,
  status,
  toolCallCount,
  toolCallCountKnown,
  childCount,
  thinkingEffort,
  description,
  error,
  elapsed,
}: {
  name: string;
  model?: string;
  status: AgentTreeNode['status'] | SubagentBlock['status'];
  toolCallCount: number;
  /** false = neither the task nor the roster ever reported a count. */
  toolCallCountKnown: boolean;
  childCount: number;
  thinkingEffort?: string;
  description?: string;
  error?: string;
  /** undefined = start or end unknown — rendered as an explicit "—". */
  elapsed: number | undefined;
}) {
  const { t, tp, time } = useI18n();
  const busy = status === 'running' || status === 'background';
  return (
    <>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${subagentStatusTone(status)} ${busy ? 'status-dot-busy' : ''}`} />
        <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{name}</span>
        {model !== undefined ? (
          <span className="min-w-0 shrink truncate text-[12px] text-ink-faint">{model}</span>
        ) : null}
        <span className="ml-auto shrink-0 text-[12px] tabular-nums text-ink-faint">
          {elapsed === undefined ? null : time.formatDuration(elapsed)}
        </span>
        <Icon name="arrowRight" size={12} className="text-ink-faint transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 pl-4 text-[12px] text-ink-faint">
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
          className={`mt-1 truncate pl-4 text-[13px] ${error !== undefined ? 'text-danger' : 'text-ink-soft'}`}
        >
          {error ?? description}
        </p>
      ) : null}
    </>
  );
}

/**
 * Manual form override for a subagent card: once the user expands or
 * collapses a card by hand the automatic rule (active run → full, terminal →
 * compact) no longer touches that card.
 */
export type SubagentCardForm = 'full' | 'compact';

/**
 * Automatic card form: only a genuinely active run (running / background)
 * earns the full card. Completed, suspended and unknown runs stay compact
 * one-liners — a completed parent whose own child still runs does NOT
 * inflate; the child carries its own card.
 */
export function subagentAutoForm(
  status: AgentTreeNode['status'] | SubagentBlock['status'],
): SubagentCardForm {
  return status === 'running' || status === 'background' ? 'full' : 'compact';
}

/** What a running subagent is doing now: its newest step, else its task. */
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

/**
 * Compact collapsed form of a subagent card (terminal runs land here by
 * default): one row with status dot, name, terminal status, result summary,
 * duration and tool count. Click jumps to the agent page; the trailing
 * expand-arrows control grows it back to the full card (manual override).
 * The card-form control is never a chevron — chevrons belong to disclosure
 * (invocation details) — so the two toggles can never read as the same icon.
 */
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
  invocationButton,
  invocationBody,
}: {
  invocationButton?: ReactNode;
  invocationBody?: ReactNode;
  block: SubagentBlock;
  status: AgentTreeNode['status'] | SubagentBlock['status'];
  /** Terminal-run error for the current run; undefined while a live run is active. */
  error: string | undefined;
  /** Result summary, live-node first with the frozen block as fallback. */
  summary: string | undefined;
  elapsed: number | undefined;
  depth: number;
  toolCalls: SubagentToolCalls;
  onOpenAgent?: (agentId: string) => void;
  onExpand?: () => void;
  /** A nested agent folded by the view rule: its expand opens it for the rest of the view. */
  folded?: boolean;
}) {
  const { t, tp, time } = useI18n();
  // A live run says what it is doing now (its latest step, else its task);
  // an old receipt would contradict "Running". A settled run gives the
  // receipt's first sentence as plain text, never raw markdown.
  const live = status === 'running' || status === 'background' || status === 'suspended';
  const line = error ?? (live ? subagentActivity(block) : summary === undefined ? undefined : firstSentence(summary));
  // The agent is the subject: its name is the label (the same line the main
  // and child timelines both use), the status word opens the detail and the
  // result summary follows. Unknown counts and timings leave their columns
  // empty rather than printing a placeholder.
  const detail = (
    <>
      <span className={error !== undefined ? undefined : 'text-ink-soft'}>{t(`subagent.status.${status}` as I18nKey)}</span>
      {line === undefined || line === '' ? null : <> · {line}</>}
    </>
  );
  return (
    <ActivityRow
      className={`@container ${depth === 0 ? '' : `ml-4${block.orphaned === true ? ' opacity-60' : ''}`}`}
      attrs={{
        'data-subagent-id': block.subagentId,
        'data-agent-depth': depth,
        'data-card-form': 'compact',
        'data-nested-folded': folded || undefined,
        'data-orphaned': block.orphaned === true || undefined,
      }}
      buttonAttrs={{ 'data-agent-open': block.subagentId }}
      glyph={<span className={`inline-block h-2 w-2 rounded-full align-middle ${subagentStatusTone(status)}`} />}
      tone={error !== undefined ? 'danger' : 'plain'}
      label={block.name}
      detail={detail}
      title={error ?? t('subagent.openAgent', { name: block.name })}
      onOpen={() => { onOpenAgent?.(block.subagentId); }}
      stats={toolCalls.known && !folded ? <span className="font-sans">{tp('transcript.toolCalls', toolCalls.count)}</span> : undefined}
      meta={elapsed === undefined ? undefined : time.formatDuration(elapsed)}
      metaWidth="wide"
      aside={
        <>{onExpand === undefined ? null : (
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
        )}{invocationButton}</>
      }
    >{invocationBody}</ActivityRow>
  );
}

/**
 * The descendants this dispatch did not create: one quiet line carrying how
 * many they are and whether any still run or failed, opened by the reader. It
 * says nothing about their age and removes nothing — it exists only so a
 * whole subtree does not fill the timeline before it is asked for. It sits
 * inside the card that owns them rather than beside it, because it groups that
 * card's own children — the same hairline spine the history fold and the
 * subagent group use — rather than introducing a new event. Its open state is
 * the reader's for the rest of the view: a descendant that starts running
 * later does not unfold a group they closed.
 */
function OtherDescendantGroup({
  groupKey,
  members,
  renderMember,
}: {
  groupKey: string;
  members: readonly AgentTreeNode[];
  renderMember: (member: AgentTreeNode) => ReactNode;
}) {
  const { t, tp } = useI18n();
  const { open, toggle } = useDispatchGroup(groupKey);
  const counts = countFoldedDescendants(members);
  const summary = [
    tp('subagent.otherGroupCount', counts.total),
    counts.running > 0 ? t('subagent.otherGroupRunning', { count: counts.running }) : null,
    counts.failed > 0 ? t('subagent.otherGroupFailed', { count: counts.failed }) : null,
  ].filter((part): part is string => part !== null).join(' · ');
  return (
    <ActivityRow
      className="ml-4"
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
          {members.map((member) => renderMember(member))}
        </div>
      ) : undefined}
    </ActivityRow>
  );
}

const SubagentCard = memo(function SubagentCard({
  block,
  forest,
  depth = 0,
  childBlocks,
  onOpenAgent,
  displayStatus,
  formOverride,
  onToggleForm,
}: {
  block: SubagentBlock;
  forest?: AgentForest;
  depth?: number;
  childBlocks?: ReadonlyMap<string, SubagentBlock>;
  onOpenAgent?: (agentId: string) => void;
  displayStatus?: AgentTreeNode['status'];
  formOverride?: SubagentCardForm;
  onToggleForm?: (agentId: string, form: SubagentCardForm) => void;
}) {
  const { t } = useI18n();
  const node = forest?.byId[block.subagentId];
  const children = forest === undefined ? [] : agentChildren(forest, block.subagentId);
  const status = displayStatus ?? node?.status ?? block.status;
  const elapsed = useSubagentElapsed(block, node, status);
  const runIsLive = status === 'running' || status === 'background' || status === 'suspended';
  // The forest node tracks the CURRENT run (a resume re-stamps model, effort
  // and timing and clears the terminal error); the block is a frozen dispatch
  // snapshot. Live values win; the block is the fallback when no node exists.
  const model = node?.model ?? block.model;
  const thinkingEffort = node?.thinkingEffort ?? block.thinkingEffort;
  const runError = runIsLive ? undefined : (node?.error ?? block.error);
  const runSummary = node?.summary ?? block.summary;
  // Only a genuinely active run owns the full card; a completed parent whose
  // child still runs stays compact — the child has its own card. A nested
  // card (a subagent's own subagent) follows the view's fold rule instead:
  // it is a one-line summary only if it had already finished when this view
  // first saw it; running, waiting and failed ones stay full, and one that
  // finishes while the view is open keeps its card (timeline/nestedFold.ts).
  const active = subagentAutoForm(status) === 'full';
  const invocationScope = useContext(InvocationContext);
  const nested = depth > 0 || (invocationScope !== null && invocationScope.callerAgentId !== MAIN_AGENT_ID);
  const nestedFold = useNestedFold(block.subagentId, status, nested);
  const full = nested
    ? !nestedFold.folded
    : formOverride !== undefined ? formOverride === 'full' : active;
  const invocation = useInvocationDetails(block.parentToolCallId, block.parentAgentId, !full);
  const [expanded, setExpanded] = useState(() => active);
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);
  const childCount = node?.childIds.length ?? children.length;
  const toolCalls = resolveSubagentToolCalls(block, node);
    // Membership is a DESCENDANT's immutable birth against THIS CARD's own run
  // window, and the card supplies both ends of that window. The live node is
  // deliberately NOT consulted: it tracks the agent's newest run, so filling a
  // missing window from it would slide this card's boundary onto a later
  // resume and reopen exactly the descendants it must fold. Nothing here is a
  // confirmed same-dispatch record, so it is not a substitute. A card with no
  // window of its own therefore folds every descendant.
  const descendantGroups = groupDescendantsByDispatch(
    { startedAt: block.startedAt, endedAt: block.endedAt, status: block.status },
    children,
  );
  // This card is one AgentRun call, so the call that dispatched it identifies
  // the fold group's open/closed state. Keying on the agent would make two
  // cards for one resumed agent share a single choice, and opening the older
  // card's group would open the newer one's too. The block id is derived from
  // the agent and cannot separate them, so the dispatch call is used, with the
  // block id as the fallback for a card that never recorded one.
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
        invocationButton={invocation.button}
        invocationBody={<><AgentTurnOutcomeLine outcome={node?.turnOutcome} />{invocation.body}</>}
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
  const cardClass =
    'anim-enter group flex items-start gap-1 rounded-[10px] bg-panel px-3 py-2 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-bubble-user/60';
  const body = (
    <SubagentCardBody
      name={block.name}
      model={model}
      status={status}
      toolCallCount={toolCalls.count}
      toolCallCountKnown={toolCalls.known}
      childCount={childCount}
      thinkingEffort={thinkingEffort}
      description={block.description}
      error={runError}
      elapsed={elapsed}
    />
  );
  return (
    <div
      data-subagent-id={block.subagentId}
      data-agent-depth={depth}
      data-card-form="full"
      data-orphaned={block.orphaned === true || undefined}
      className={`${depth === 0 ? '' : 'ml-4'}${block.orphaned === true ? ' opacity-60' : ''}`}
    >
      <div className="flex items-stretch gap-1">
        {depth > 0 ? <span aria-hidden className="w-px shrink-0 bg-hairline" /> : null}
        <div className="min-w-0 flex-1">
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
            <button
              type="button"
              onClick={() => { onOpenAgent?.(block.subagentId); }}
              data-agent-open={block.subagentId}
              className="min-w-0 flex-1 text-left"
            >
              {body}
              <AgentTurnOutcomeLine outcome={node?.turnOutcome} />
            </button>
            <div className="-mt-1 -mr-1.5 flex shrink-0 items-center gap-0.5">
              {invocation.button}
            </div>
          </div>
          {invocation.body}
          {block.orphaned === true ? (
            <p className="mt-1 pl-1 text-[12px] text-ink-faint italic">
              {t('transcript.orphanedSubagent')}
            </p>
          ) : null}
          {childCount > 0 ? (
            <div className="flex items-center gap-1">
              {/* A chevron and the count: the button disclosed the child cards,
                  and the count says how many without a second line of words. */}
              <button
                type="button"
                data-subagent-children={block.subagentId}
                aria-expanded={expanded}
                aria-label={t(expanded ? 'subagent.collapseChildren' : 'subagent.expandChildren')}
                title={t(expanded ? 'subagent.collapseChildren' : 'subagent.expandChildren')}
                onClick={() => {
                  setExpanded((value) => !value);
                }}
                className="mt-1 inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 text-[12px] tabular-nums text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
              >
                <DisclosureChevron open={expanded} className="text-current" />
                {childCount}
              </button>
            </div>
          ) : null}
          {expanded && children.length > 0 ? (
            <div className="mt-1 space-y-1">
              {/* The descendants this dispatch provably created lay out; every
                  other one folds into one line, including any this view cannot
                  place. Folding is a default, not a deletion and not a claim
                  about age — the reader opens it and finds the same subtree. */}
              {descendantGroups.current.map((child) => renderChildCard(child))}
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
      </div>
    </div>
  );
});

function agentMessageSummary(message: string, limit = 140): string {
  const compact = message.replaceAll(/\s+/g, ' ').trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * One-line lifecycle entry (G-4 compact form): status dot + name + event +
 * relative time; the whole row jumps to the agent page. Rows sit in place at
 * their event timestamp among the regular transcript blocks.
 */
const SubagentEventRow = memo(function SubagentEventRow({
  block,
  onOpenAgent,
}: {
  block: SubagentEventBlock;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const invocation = useInvocationDetails(block.anchorToolCallId);
  const busy = block.status === 'running' || block.status === 'suspended';
  const isFailed = block.event === 'failed' || block.status === 'failed';
  const messageSummary = block.message === undefined ? undefined : agentMessageSummary(block.message);
  // The EVENT is the label ("Dispatched", "Reported") and the agent plus what
  // it carried is the detail, so a column of these reads as a sequence of
  // things that happened rather than a list of names. A queued delivery is
  // NAMED rather than reduced to a glyph — "waiting to be delivered" is not
  // something a reader should have to decode from a symbol.
  const line = block.error ?? messageSummary;
  const detail = (
    <>
      <span className="text-ink">{block.name}</span>
      {line === undefined || line === '' ? null : (
        <>
          {' · '}
          <span data-agent-message-summary={block.message === undefined ? undefined : true} title={block.message}>
            {line}
          </span>
        </>
      )}
    </>
  );
  return (
    <ActivityRow
      glyph={
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full align-middle ${subagentStatusTone(block.status)} ${busy ? 'status-dot-busy' : ''}`}
        />
      }
      tone={isFailed ? 'danger' : 'plain'}
      label={t(`subagent.event.${block.event}` as I18nKey)}
      detail={detail}
      title={block.error ?? t('subagent.openAgent', { name: block.name })}
      onOpen={() => { onOpenAgent?.(block.subagentId); }}
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
      }}
      buttonAttrs={{ 'data-agent-open': block.subagentId }}
      aside={invocation.button}
    >{invocation.body}</ActivityRow>
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

/**
 * A notice is a boundary, not an event: compaction, a marker, the start of a
 * plan. It gets the divider rule so the log reads as regions. A danger notice
 * (a failed prompt) is the exception — it keeps the amber-coded rule so a
 * failure is visible in a fast scroll, but it stays one line of type rather
 * than a filled card.
 */
const Notice = memo(function Notice({ block }: { block: NoticeBlock }) {
  const { t, time } = useI18n();
  const [open, setOpen] = useState(false);
  const baseText = block.i18n !== undefined ? t(block.i18n.key, block.i18n.params) : block.text;
  const text = block.reasonCodes?.includes('notes_directives_budget') ? t('transcript.marker.reason.notes_directives_budget') : baseText;
  // Why a compaction took the path it did (e.g. summary instead of a fresh
  // window): one sentence per engine reason code; an unknown code reads as-is.
  const reasonText = (code: string) => {
    const key = `transcript.marker.reason.${code}` as I18nKey;
    const translated = t(key);
    return translated === key ? code : translated;
  };
  const reasons = [...(block.reasonCodes ?? []).map(reasonText), ...(block.compactionFailure === undefined ? [] : [block.compactionFailure])];
  const history = block.compactionHistory ?? [];
  const expandable = reasons.length > 0 || history.length > 0;
  const title = [time.absoluteTime(block.createdAt), ...reasons].filter(Boolean).join('\n');
  const count = block.markerRepeatCount ?? 1;
  const repeatedText = count > 1 ? history.length > 0
    ? t('transcript.marker.compactionRepeated', { label: text, count }) : `${text} ×${count}` : text;
  const label = block.tone === 'danger' ? <span className="font-medium text-danger">{repeatedText}</span> : repeatedText;
  return (
    <div data-notice-reasons={reasons.length > 0 ? reasons.length : undefined}>
      <TimelineDivider
        tone={block.tone === 'danger' ? 'warn' : 'plain'}
        title={title}
        attrs={{ 'data-notice-tone': block.tone, 'data-notice-key': block.i18n?.key }}
      >
        {expandable ? (
          <button
            type="button"
            data-notice-reasons-toggle
            aria-expanded={open}
            onClick={() => { setOpen((value) => !value); }}
            className="inline-flex min-h-6 items-center gap-1 rounded-sm px-1 transition-colors hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-selected-ink"
          >
            {label}
            <DisclosureChevron open={open} />
          </button>
        ) : label}
      </TimelineDivider>
      {/* The reasons are body text under the rule, not a centred aside: the
          list starts on the column's left edge with the same hanging indent
          as a list in an answer (.kiki-md ul), faint bullets like there too. */}
      {open && history.length > 0 ? (
        <ol data-compaction-history className="mt-0.5 mb-1 flex list-decimal flex-col gap-1 pl-[1.4em] text-[12px] leading-snug text-ink-soft marker:text-ink-faint">
          {history.map((entry) => <li key={entry.id}>
            <span>{time.absoluteTime(entry.createdAt)}</span>
            {entry.source !== undefined ? <span> · {t(`transcript.marker.compactionSource.${entry.source}` as I18nKey)}</span> : null}
            {entry.startedAt !== undefined ? <span className="text-ink-faint"> · {t('transcript.marker.compactionStartedAt', { time: time.absoluteTime(entry.startedAt) ?? entry.startedAt })}</span> : null}
            {(entry.reasonCodes ?? []).map((code) => <p key={code} className="text-ink-faint">{reasonText(code)}</p>)}
          </li>)}
        </ol>
      ) : open && reasons.length > 0 ? (
        <ul data-notice-reason-list className="mt-0.5 mb-1 flex list-disc flex-col gap-0.5 pl-[1.4em] text-[12px] leading-snug text-ink-soft marker:text-ink-faint">
          {reasons.map((reason, index) => <li key={`${block.id}:${index}`}>{reason}</li>)}
        </ul>
      ) : null}
    </div>
  );
});

/**
 * Folded read run (opt-in, `foldSteps`): ≥3 consecutive pure reads collapse
 * into one line that still names every object it looked at — "read plan.ts,
 * notes.md · searched TODO" — so folding hides the rows, never the facts.
 * Spinner while a member runs, auto-expands on error only, and the duration
 * sums real framed timings (unknown timings never fabricate a total).
 */
function ReadRunSummary({ group }: { group: ToolGroup }) {
  const { t } = useI18n();
  const parts = groupSummary(group);
  return (
    <>
      {parts.map((part, index) => (
        <span key={index} data-read-run-part={part.verb}>
          {index > 0 ? <span aria-hidden className="text-ink-faint/70"> · </span> : null}
          {/* Read runs only ever hold read / list / search / fetch verbs. */}
          {t(`transcript.step.${part.verb}` as I18nKey)}
          {part.targets.length > 0 ? (
            <span className="font-mono text-ink-soft"> {part.targets.join(', ')}</span>
          ) : null}
          {part.more > 0 ? <span> {t('transcript.step.more', { count: part.more })}</span> : null}
        </span>
      ))}
    </>
  );
}

const ToolGroupRow = memo(
  function ToolGroupRow({
    group,
    agentId,
    agentNames,
    onOpenAgent,
  }: {
    group: ToolGroup;
    agentId: string;
    agentNames?: ReadonlyMap<string, string>;
    onOpenAgent?: (agentId: string) => void;
  }) {
  const { t, time } = useI18n();
  const running = groupHasRunning(group);
  const hasError = groupHasError(group);
  const [expanded, setExpanded] = useState(false);
  useFindReveal(group.id, expanded, setExpanded);
  // Auto-expand on error (once per error arrival), never auto-collapse.
  useEffect(() => {
    if (hasError) setExpanded(true);
  }, [hasError]);

  // Unlike a bare "N actions" lid, the line names every object the run looked
  // at and sits ON the run it describes; the count rides the aria label.
  return (
    <ActivityRow
      attrs={{ 'data-read-run': group.count }}
      glyph={<DisclosureChevron open={expanded} className="text-ink-faint" />}
      chevronInGlyph
      label={t('transcript.readRun')}
      detail={<ReadRunSummary group={group} />}
      expanded={expanded}
      onToggle={() => { setExpanded((value) => !value); }}
      ariaLabel={t('transcript.stepsAria', { count: group.count })}
      meta={
        !running && !hasError && group.durationMs !== undefined && group.durationMs >= DURATION_WORTH_SHOWING_MS
          ? time.formatDuration(group.durationMs)
          : undefined
      }
      status={
        <OutcomeMark
          state={running ? 'running' : hasError ? 'failed' : 'done'}
          labels={activityOutcomeLabels(t)}
        />
      }
    >
      {expanded ? (
        // Members hang off a hairline spine in the glyph column — a timeline,
        // not a box inside a box. Their own glyphs keep the shared axis, and
        // their hover wash stops at the spine (`nested`).
        <div className="-ml-[9px] border-l border-hairline pl-[17px]">
          {group.tools.map((member) => (
            <ToolCard key={member.id} nested block={member} agentId={agentId} agentNames={agentNames} onOpenAgent={onOpenAgent} />
          ))}
        </div>
      ) : undefined}
    </ActivityRow>
  );
  },
  // groupBlocks rebuilds the wrapper per publish; the step blocks themselves
  // keep identity, so element-wise comparison preserves the memo. Every
  // ordered member compares — the aggregations alone would miss a shell
  // turning failed or a thinking block's streaming text.
  (prev, next) =>
    prev.agentId === next.agentId &&
    prev.group.members.length === next.group.members.length &&
    prev.group.members.every((member, index) => member === next.group.members[index]) &&
    prev.group.durationMs === next.group.durationMs &&
    prev.group.startedAt === next.group.startedAt &&
    prev.agentNames === next.agentNames &&
    prev.onOpenAgent === next.onOpenAgent &&
    prev.group.tools.every((tool, index) => tool === next.group.tools[index]),
);

/** The end row with its agent's name, model and run time (live node first). */
function EndedRow({
  ending,
  forest,
  childBlocks,
  onOpenAgent,
  onLocateDispatch,
}: {
  ending: SubagentEnding;
  forest: AgentForest | undefined;
  childBlocks: ReadonlyMap<string, SubagentBlock>;
  onOpenAgent?: (agentId: string) => void;
  onLocateDispatch?: (agentId: string) => void;
}) {
  const { time } = useI18n();
  const node = forest?.byId[ending.agentId];
  const card = childBlocks.get(ending.agentId);
  const start = parseTimelineMs(ending.task?.started_at);
  const end = parseTimelineMs(ending.task?.completed_at);
  const elapsed = start === undefined || end === undefined ? undefined : Math.max(0, end - start);
  const model = ending.task?.model ?? node?.model ?? card?.model;
  const effort = ending.task?.thinking_effort ?? node?.thinkingEffort ?? card?.thinkingEffort;
  return (
    <SubagentEndedRow
      ending={ending}
      name={node?.label ?? card?.name ?? ending.agentId}
      model={model === undefined ? undefined : [model.replace(/^.*\//, ''), effort].filter(Boolean).join(' · ')}
      summary={ending.task?.output_preview}
      elapsed={elapsed === undefined ? undefined : time.formatDuration(elapsed)}
      onOpenAgent={onOpenAgent}
      onLocateDispatch={onLocateDispatch}
      renderReceipt={(markdown) => <Markdown text={markdown} />}
    />
  );
}

/**
 * Folded history (codeg's settled-turn fold, Apache-2.0): a finished turn's
 * stretch of process rows between two messages reads as one quiet line that
 * still counts what happened ("Worked · 8 steps · 2 thoughts · 1 failed").
 * Opening it lays the original rows back on a hairline spine in their own
 * order. A failure is counted in the line's neutral summary and marked in
 * the outcome column the way a read run marks one (success stays silent);
 * the failed row itself carries the warning once opened.
 */
function HistoryFoldRow({
  fold,
  expanded,
  onToggle,
  renderMember,
}: {
  fold: HistoryFold;
  expanded: boolean;
  onToggle: (id: string) => void;
  renderMember: (member: DisplayNode) => ReactNode;
}) {
  const { t, tp, time } = useI18n();
  const parts = [
    fold.steps > 0 ? tp('transcript.fold.steps', fold.steps) : null,
    fold.thoughts > 0 ? tp('transcript.fold.thoughts', fold.thoughts) : null,
    fold.agents > 0 ? tp('transcript.fold.agents', fold.agents) : null,
    fold.agentsDone > 0 ? tp('transcript.fold.agentsDone', fold.agentsDone) : null,
    fold.notes > 0 ? tp('transcript.fold.notes', fold.notes) : null,
  ].filter((part): part is string => part !== null);
  const summary = parts.join(' · ');
  return (
    <ActivityRow
      attrs={{ 'data-history-fold': fold.members.length, 'data-history-fold-open': expanded || undefined }}
      glyph={<DisclosureChevron open={expanded} className="text-ink-faint" />}
      chevronInGlyph
      label={t('transcript.fold.worked')}
      detail={
        <>
          <span className="text-ink-faint">{summary}</span>
          {fold.failed > 0 ? (
            <span className="text-ink-faint"> · {t('transcript.fold.failed', { count: fold.failed })}</span>
          ) : null}
        </>
      }
      meta={
        fold.durationMs !== undefined && fold.durationMs >= DURATION_WORTH_SHOWING_MS
          ? time.formatDuration(fold.durationMs)
          : undefined
      }
      status={<OutcomeMark state={fold.failed > 0 ? 'failed' : 'done'} labels={activityOutcomeLabels(t)} />}
      expanded={expanded}
      onToggle={() => { onToggle(fold.id); }}
      ariaLabel={t('transcript.fold.aria', { summary })}
    >
      {expanded ? (
        <div data-history-fold-members className="-ml-[9px] flex flex-col gap-0.5 border-l border-hairline pl-[17px]">
          {fold.members.map((member) => (
            <div key={member.id} data-block-id={member.id} data-fold-member>
              {renderMember(member)}
            </div>
          ))}
        </div>
      ) : undefined}
    </ActivityRow>
  );
}

const BlockView = memo(function BlockView({
  block,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onCancelQueued,
  agentNames,
  senderIdentities,
  approvalShortcutHints,
  readOnly,
  forest,
  childBlocks,
  subagentFormOverride,
  onToggleSubagentForm,
  onOpenAgent,
  rowActions,
  latestFinalAssistantId,
  annotations,
  stoppedTailTurnId,
}: {
  block: Exclude<Block, ToolBlock>;
  /** Turn whose stop the visible tail divider already states. */
  stoppedTailTurnId?: string;
  readOnly: boolean;
  onResolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    scope?: 'session',
    selectedOptionId?: string,
  ) => Promise<void>;
  onAnswerQuestion: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  onDismissQuestion: (questionId: string) => Promise<void>;
  onCancelQueued?: (promptId: string) => void;
  /** subagentId → display name, for tagging child-origin interaction cards. */
  agentNames?: ReadonlyMap<string, string>;
  /** senderAgentId → role profile / model, for the injected-message label. */
  senderIdentities?: ReadonlyMap<string, SenderIdentity>;
  /** y/n shortcut hints show on every pending approval card. */
  approvalShortcutHints?: boolean;
  forest?: AgentForest;
  childBlocks?: ReadonlyMap<string, SubagentBlock>;
  subagentFormOverride?: SubagentCardForm;
  onToggleSubagentForm?: (agentId: string, form: SubagentCardForm) => void;
  onOpenAgent?: (agentId: string) => void;
  rowActions?: TranscriptRowActions;
  latestFinalAssistantId?: string;
  annotations?: readonly TimelineAnnotation[];
}) {
  const { t } = useI18n();
  // Pending interactions answer in the composer's tray when it is mounted;
  // the transcript then keeps a one-line record per item.
  const placement = useInteractionPlacement();
  const originUnknown =
    (block.kind === 'approval' || block.kind === 'question') && block.originUnknown === true;
  // Only a subagent origin is named (as its timeline row names it); the
  // main agent's own asks carry no prefix.
  const originAgentName =
    !originUnknown &&
    (block.kind === 'approval' || block.kind === 'question') &&
    block.originAgentId !== undefined &&
    block.originAgentId !== MAIN_AGENT_ID
      ? (agentNames?.get(block.originAgentId) ?? block.originAgentId)
      : undefined;
  // An unknown origin says nothing actionable: show no provenance at all
  // (read-only child transcripts still name their context).
  const originFallback = originUnknown && readOnly ? t('ia.originCurrentContext') : undefined;
  const liveRowActions = readOnly ? undefined : rowActions;
  switch (block.kind) {
    case 'user':
      return (
        <UserMessage
          block={block}
          onCancelQueued={readOnly ? undefined : onCancelQueued}
          rowActions={liveRowActions}
          annotations={annotations}
          senderIdentities={senderIdentities}
        />
      );
    case 'system-reminder':
      return <SystemReminderMessage block={block} />;
    case 'system':
      return <SystemMessage block={block} />;
    case 'skill':
      return <SkillMessage block={block} />;
    case 'assistant':
      return (
        <AssistantMessage
          block={block}
          rowActions={liveRowActions}
          isLatestFinal={block.id === latestFinalAssistantId}
          annotations={annotations}
          stopShownByTail={stoppedTailTurnId !== undefined && sameTurn(block.turnId, stoppedTailTurnId)}
        />
      );
    case 'thinking':
      return <ThinkingMessage block={block} />;
    case 'message':
      return <ProcessMessage block={block} />;
    case 'shell':
      return <ShellMessage block={block} />;
    case 'subagent':
      return (
        <SubagentCard
          block={block}
          forest={forest}
          childBlocks={childBlocks}
          onOpenAgent={onOpenAgent}
          formOverride={subagentFormOverride}
          onToggleForm={onToggleSubagentForm}
        />
      );
    case 'subagent-event':
      return <SubagentEventRow block={block} onOpenAgent={onOpenAgent} />;
    case 'notice':
      return block.executor !== undefined
        ? <ExecutorNoteRow note={block.executor} createdAt={block.createdAt} />
        : block.externalText !== undefined
          ? <ExternalTextRow note={block.externalText} createdAt={block.createdAt} />
          : block.earlierPromptOutcomes !== undefined
            ? <EarlierPromptOutcomesRow block={block} />
            : block.modelSwitch !== undefined
              ? <ModelSwitchNotice block={block} />
              : <Notice block={block} />;
    case 'approval':
      // Terminal facts stay inline as one compact history line (readOnly or
      // not); only a PENDING approval keeps the full interactive card.
      return block.resolution !== undefined ? (
        <HistoryLine node={block} originName={originAgentName ?? originFallback} />
      ) : readOnly ? (
        <Notice
          block={{
            kind: 'notice',
            id: `${block.id}-readonly`,
            text: t('transcript.approvalReadonly', { action: block.request.action }),
            tone: 'neutral',
          }}
        />
      ) : placement.inTray ? (
        <InteractionRecord
          block={block}
          originName={originAgentName ?? originFallback}
          onReview={
            placement.onReview === undefined
              ? undefined
              : () => { placement.onReview?.('approval', block.request.approval_id); }
          }
        />
      ) : (
        <ApprovalCard
          block={block}
          originAgentName={originAgentName ?? originFallback}
          showShortcutHints={approvalShortcutHints === true}
          onResolve={(decision, scope, selectedOptionId) =>
            onResolveApproval(block.request.approval_id, decision, scope, selectedOptionId)
          }
        />
      );
    case 'question':
      return block.outcome !== undefined ? (
        <HistoryLine node={block} originName={originAgentName ?? originFallback} />
      ) : readOnly ? (
        <Notice
          block={{
            kind: 'notice',
            id: `${block.id}-readonly`,
            text: t('transcript.questionReadonly'),
            tone: 'neutral',
          }}
        />
      ) : placement.inTray ? (
        <InteractionRecord
          block={block}
          originName={originAgentName ?? originFallback}
          onReview={
            placement.onReview === undefined
              ? undefined
              : () => { placement.onReview?.('question', block.request.question_id); }
          }
        />
      ) : (
        <QuestionCard
          block={block}
          originAgentName={originAgentName ?? originFallback}
          onAnswer={(answers) => onAnswerQuestion(block.request.question_id, answers)}
          onDismiss={() => onDismissQuestion(block.request.question_id)}
        />
      );
  }
});

/**
 * SendMessage in the process view: the same speech row as the message view,
 * so "this is what it said out loud" reads the same in both.
 */
function ProcessMessage({ block }: { block: MessageBlock }) {
  const { t } = useI18n();
  const context = useMessageViewContext();
  const speaker = speakerOf(block, context.persona, t('agentMessage.agent'));
  if (block.handoff !== undefined && block.status === 'sent') {
    const handoff = block.handoff;
    return (
      <HandoffRow
        from={speaker.name}
        to={handoff.targetName}
        text={block.text}
        openLabel={t('message.openHandoff', { name: handoff.targetName })}
        onOpen={context.onOpenSession === undefined ? undefined : () => { context.onOpenSession?.(handoff.targetSessionId); }}
      />
    );
  }
  return <MessageRow block={block} speaker={speaker} continued={false} currentSessionId={context.sessionId} />;
}

/** A timeline row: the process view's display nodes plus the message view's activity summaries. */
type TimelineNode = DisplayNode | ActivitySummary;

/**
 * Rows the message view draws itself; everything else (your bubbles, open
 * question and approval cards, dividers) keeps the process view's row.
 */
function isMessageViewOwnRow(node: TimelineNode): node is MessageBlock | ActivitySummary | NoticeBlock | UserBlock {
  if (node.kind === 'message' || node.kind === 'activity-summary') return true;
  if (node.kind === 'notice') return node.executor === undefined && node.externalText === undefined;
  if (node.kind === 'user') return isInboundHandoff(node);
  return false;
}

const MessageViewRow = memo(function MessageViewRow({
  node,
  previous,
  blockById,
  agentId,
  agentNames,
  onOpenAgent,
  onOpenProcess,
}: {
  node: MessageBlock | ActivitySummary | NoticeBlock | UserBlock;
  previous: MessageViewNode | undefined;
  blockById: ReadonlyMap<string, Block>;
  agentId: string;
  agentNames: ReadonlyMap<string, string>;
  onOpenAgent?: (agentId: string) => void;
  onOpenProcess: (turnId: string | undefined, blockId?: string) => void;
}) {
  const { t } = useI18n();
  const context = useMessageViewContext();
  const agentLabel = t('agentMessage.agent');
  const turnId = displayNodeTurnId(node);
  let body: ReactNode;
  if (node.kind === 'message') {
    const speaker = speakerOf(node, context.persona, agentLabel);
    if (node.handoff !== undefined && node.status === 'sent') {
      const handoff = node.handoff;
      body = (
        <HandoffRow
          from={speaker.name}
          to={handoff.targetName}
          text={node.text}
          openLabel={t('message.openHandoff', { name: handoff.targetName })}
          onOpen={context.onOpenSession === undefined ? undefined : () => { context.onOpenSession?.(handoff.targetSessionId); }}
        />
      );
    } else {
      const quoted = node.replyTo === undefined ? undefined : blockById.get(node.replyTo) ?? [...blockById.values()].find(
        (block) => (block.kind === 'user' && block.userMessageId === node.replyTo) || (block.kind === 'message' && block.messageId === node.replyTo),
      );
      const replyToText = quoted?.kind === 'user' || quoted?.kind === 'message' ? quoted.text : undefined;
      body = (
        <MessageRow
          block={node}
          speaker={speaker}
          continued={speakerKey(previous) === speakerKey(node) && speakerKey(node) !== undefined}
          replyToText={replyToText}
          currentSessionId={context.sessionId}
          onOpenProcess={() => { onOpenProcess(turnId, node.id); }}
        />
      );
    }
  } else if (node.kind === 'user') {
    const sender = node.peerThread?.senderName ?? node.peerThread?.personaId ?? agentLabel;
    const receiver = context.persona?.name ?? agentLabel;
    const sourceSession = node.peerThread?.sessionId;
    body = (
      <HandoffRow
        from={sender}
        to={receiver}
        text={node.text.replace(/^来自\s*[^：:]+[：:]\s*/u, '')}
        openLabel={t('message.openHandoff', { name: sender })}
        onOpen={sourceSession === undefined || context.onOpenSession === undefined ? undefined : () => { context.onOpenSession?.(sourceSession); }}
      />
    );
  } else if (node.kind === 'notice') {
    // A switch never claims success before it has: its row carries the real
    // state and its own actions in both views. A saved record shows its own
    // body in both views, so neither one can be mistaken for a status line.
    body = node.externalText !== undefined
      ? <ExternalTextRow note={node.externalText} createdAt={node.createdAt} />
      : node.modelSwitch !== undefined
        ? <ModelSwitchNotice block={node} />
        : node.compactionPhase !== undefined ? <Notice block={node} />
        : <OutcomeLine notice={node} onOpenProcess={() => { onOpenProcess(turnId, node.id); }} />;
  } else {
    body = (
      <ActivitySummaryRow
        summary={node}
        onOpenProcess={() => { onOpenProcess(turnId, node.members[0]?.id); }}
        renderMember={(member) =>
          member.kind === 'tool' ? (
            <ToolCard nested block={member} agentId={agentId} agentNames={agentNames} onOpenAgent={onOpenAgent} />
          ) : member.kind === 'shell' ? (
            <ShellMessage block={member} />
          ) : member.kind === 'thinking' ? (
            <ThinkingMessage block={member} />
          ) : member.kind === 'assistant' ? (
            <p className="line-clamp-3 text-[12.5px] leading-snug text-ink-faint">
              <span className="mr-1.5 text-[11px] font-medium">{t('message.internal')}</span>
              {member.text}
            </p>
          ) : member.kind === 'subagent' ? (
            <SubagentEventLine name={member.name} status={member.status} onOpen={onOpenAgent === undefined ? undefined : () => { onOpenAgent(member.subagentId); }} />
          ) : null
        }
      />
    );
  }
  return (
    <div data-block-id={node.id} data-turn-id={turnId} data-message-view-row={node.kind}>
      {body}
    </div>
  );
});

function SubagentEventLine({ name, status, onOpen }: { name: string; status: SubagentBlock['status']; onOpen?: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={onOpen === undefined}
      className="flex min-h-6 items-center gap-2 rounded-sm text-left text-[12.5px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${subagentStatusTone(status)}`} />
      <Icon name="agent" size={12} className="text-ink-faint" />
      <span className="truncate">{name}</span>
    </button>
  );
}

function nodeKey(node: TimelineNode): string {
  return node.id;
}

/**
 * Vertical rhythm by lane transition — the grouping is expressed by space
 * alone, no frame or rule. Consecutive activity rows sit 2px apart so a run
 * of settled work reads as one quiet column (§3.2 S0); a change of lane keeps
 * the base 16px (S5); a new user turn opens with 24px (S6), the largest break
 * on the page, so turns read as chapters.
 *
 * A margin on the row content, on top of the virtualizer's uniform 16px gap.
 * The absolutely positioned row box does not collapse margins, so its
 * measured height moves by exactly the same amount as its content: positions,
 * anchoring and the overlap gate all see one consistent geometry.
 */
function rowSpacing(previous: TranscriptVirtualNode, node: TranscriptVirtualNode, view: 'process' | 'message' = 'process'): string {
  if (previous === undefined || node === undefined) return '';
  if (view === 'message') {
    // One-line status rows (a work summary, "no reply", a failed send) hang
    // off the message above them: 8px instead of the 16px between speakers.
    if (isMessageViewStatusRow(node)) return '-mt-2';
    // A speaker's consecutive messages read as one run: 8px.
    const speaker = speakerKey(node as MessageViewNode);
    if (speaker !== undefined && speakerKey(previous as MessageViewNode) === speaker) return '-mt-2';
  }
  if (node.kind === 'user') return 'mt-2';
  const lane = timelineLane(node);
  return lane === 'activity' && timelineLane(previous) === 'activity' ? '-mt-3' : '';
}

/** Message-view rows that are a single status line rather than speech. */
function isMessageViewStatusRow(node: TimelineNode): boolean {
  if (node.kind === 'activity-summary') return true;
  if (node.kind === 'notice') return node.executor === undefined && node.externalText === undefined;
  return node.kind === 'message' && (node.status === 'failed' || node.status === 'cancelled');
}

/** Lifecycle entries a subagent card already states through its own status. */
const CARD_ABSORBED_EVENTS: ReadonlySet<SubagentEventBlock['event']> = new Set([
  'spawned',
  'completed',
  'failed',
  'cancelled',
]);

/**
 * One subagent, one timeline line. With the agent's card on the page, the
 * lifecycle entries that only restate its status and the tool call that
 * dispatched it are dropped; a failed dispatch call stays, because its error
 * is not on the card. Returns the input array when nothing merges, so row
 * memos keep their identity.
 */
export function mergeSubagentRows(nodes: readonly DisplayNode[]): readonly DisplayNode[] {
  const cards = new Set<string>();
  const dispatchCalls = new Set<string>();
  // An AgentSend call already reads as its "Input sent" entry (message and
  // delivery included), so a settled call gives way to the entry it anchors.
  const sentCalls = new Set<string>();
  for (const node of nodes) {
    if (node.kind === 'subagent-event' && node.event === 'sent' && node.anchorToolCallId !== undefined) {
      sentCalls.add(node.anchorToolCallId);
    }
    if (node.kind !== 'subagent') continue;
    cards.add(node.subagentId);
    if (node.parentToolCallId !== undefined) dispatchCalls.add(node.parentToolCallId);
  }
  if (cards.size === 0 && sentCalls.size === 0) return nodes;
  const absorbed = (node: DisplayNode): boolean => {
    if (node.kind === 'subagent-event') {
      return cards.has(node.subagentId) && CARD_ABSORBED_EVENTS.has(node.event);
    }
    if (node.kind !== 'tool' || node.status === 'error' || node.isError === true) return false;
    if (dispatchCalls.has(node.toolCallId)) return true;
    if (node.status === 'done' && sentCalls.has(node.toolCallId)) return true;
    const refs = node.agentRefs ?? [];
    return refs.length > 0 && refs.every((ref) => cards.has(ref.agentId));
  };
  const merged = nodes.filter((node) => !absorbed(node));
  return merged.length === nodes.length ? nodes : merged;
}

/** Turn a display node belongs to (tool groups take their first tool's). */
function displayNodeTurnId(node: TimelineNode): string | undefined {
  if (node.kind === 'tool-group') return node.tools[0]?.turnId;
  if (node.kind === 'subagent') return node.parentTurnId;
  return 'turnId' in node ? node.turnId : undefined;
}

/**
 * Which lane a display node belongs to — the element taxonomy in one place.
 *
 * `conversation`: what was said. Owns the full content column, gets the widest
 *   vertical rhythm, and is what the eye lands on first (user bubble, assistant
 *   prose, and a pending approval/question, because an unanswered question IS
 *   the conversation's current turn).
 * `activity`: what was done. Inset to the shared glyph column, one line each
 *   until opened (tools, step groups, shell, file writes, dispatches, agent
 *   reports, plan/todo, background tasks, memory, settled decisions, skills).
 * `divider`: a boundary between regions rather than an event inside one
 *   (compaction, markers, stop notices, system injections) — spans the column.
 */
function timelineLane(node: TimelineNode): 'conversation' | 'activity' | 'divider' {
  switch (node.kind) {
    case 'user':
    case 'assistant':
    case 'message':
      return 'conversation';
    case 'approval':
      return node.resolution === undefined ? 'conversation' : 'activity';
    case 'question':
      return node.outcome === undefined ? 'conversation' : 'activity';
    case 'notice':
      // An engine compaction is a boundary; other engine notes happened in the turn.
      // A saved external record is a thing that happened, never a divider: a
      // rule above the record would read as the record having no content.
      if (node.externalText !== undefined) return 'activity';
      return node.executor === undefined || node.executor.kind === 'compaction' ? 'divider' : 'activity';
    case 'system':
      // A compaction summary is a boundary; the rest are things that happened.
      return node.variant === 'compaction_summary' ? 'divider' : 'activity';
    default:
      return 'activity';
  }
}

/** Turn ids arrive as `3` or `t3` depending on the source; compare normalized. */
function sameTurn(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const norm = (value: string) => (value.startsWith('t') ? value : `t${value}`);
  return norm(left) === norm(right);
}

/**
 * Derived-map identity stabilization: the maps Transcript passes to every
 * row (childBlocks, agentNames) are rebuilt from a fresh scan each render —
 * cheap, since the reducer structurally shares unchanged blocks — but the
 * PREVIOUS map object is returned while every entry is identical, so
 * memoized rows see referentially stable props across streaming deltas and
 * only the touched block re-renders. (Render-phase identity cache — the
 * "latest equal value" pattern; safe here because the transcript subtree is
 * never rendered concurrently with a conflicting cache writer.)
 */
function useStableMap<K, V>(build: () => Map<K, V>): ReadonlyMap<K, V> {
  const ref = useRef<ReadonlyMap<K, V> | null>(null);
  const next = build();
  const prev = ref.current;
  if (prev !== null && prev.size === next.size) {
    let identical = true;
    for (const [key, value] of next) {
      if (prev.get(key) !== value) {
        identical = false;
        break;
      }
    }
    if (identical) return prev;
  }
  ref.current = next;
  return next;
}

function annotationListsEqual(
  previous: readonly TimelineAnnotation[] | undefined,
  next: readonly TimelineAnnotation[],
): previous is readonly TimelineAnnotation[] {
  return (
    previous !== undefined &&
    previous.length === next.length &&
    previous.every((annotation, index) => {
      const candidate = next[index];
      return (
        candidate !== undefined &&
        annotation.id === candidate.id &&
        annotation.quote === candidate.quote &&
        annotation.comment === candidate.comment &&
        JSON.stringify(annotation.source) === JSON.stringify(candidate.source)
      );
    })
  );
}

function useStableAnnotationTargets(
  next: ReadonlyMap<string, readonly TimelineAnnotation[]>,
): ReadonlyMap<string, readonly TimelineAnnotation[]> {
  const ref = useRef<ReadonlyMap<string, readonly TimelineAnnotation[]> | null>(null);
  const previous = ref.current;
  let allIdentical = previous !== null && previous.size === next.size;
  const stable = new Map<string, readonly TimelineAnnotation[]>();
  for (const [blockId, annotations] of next) {
    const previousList = previous?.get(blockId);
    if (annotationListsEqual(previousList, annotations)) {
      stable.set(blockId, previousList);
    } else {
      stable.set(blockId, annotations);
      allIdentical = false;
    }
  }
  if (allIdentical && previous !== null) return previous;
  ref.current = stable;
  return stable;
}

/**
 * Content-level identity stabilization for the forest prop. SessionView
 * rebuilds the agent forest from the whole session state on every publish;
 * structurally sharing unchanged branches keeps historical roster rows and
 * transcript cards memo-stable even when a different agent changes.
 */
export function useStableForest<T extends AgentForest | undefined>(forest: T): T {
  const ref = useRef<AgentForest | undefined>(undefined);
  if (forest === undefined) {
    ref.current = undefined;
    return forest;
  }
  const stable = stabilizeAgentForest(ref.current, forest);
  ref.current = stable;
  return stable as T;
}

function displayNodesEqual(a: DisplayNode, b: DisplayNode): boolean {
  if (a === b) return true;
  // groupBlocks rebuilds the ToolGroup wrapper per publish while the step
  // blocks inside keep identity — compare every ordered member element-wise
  // (same rule as ToolGroupRow's own memo comparator): the tool list alone
  // would miss a shell turning failed or a thinking block's streaming text.
  if (a.kind === 'tool-group' && b.kind === 'tool-group') {
    return (
      a.id === b.id &&
      a.members.length === b.members.length &&
      a.members.every((member, index) => member === b.members[index])
    );
  }
  if ((a.kind === 'media-run' && b.kind === 'media-run') || (a.kind === 'subagent-group' && b.kind === 'subagent-group')) {
    return (
      a.id === b.id &&
      (a.kind !== 'media-run' || a.latest === (b as MediaRun).latest) &&
      a.members.length === b.members.length &&
      a.members.every((member, index) => member === b.members[index])
    );
  }
  if (a.kind === 'subagent-ended' && b.kind === 'subagent-ended') {
    return a.id === b.id && a.note === b.note && a.task === b.task && a.outcome === b.outcome && a.dispatchOnPage === b.dispatchOnPage;
  }
  if (a.kind === 'history-fold' && b.kind === 'history-fold') {
    return (
      a.id === b.id &&
      a.members.length === b.members.length &&
      a.members.every((member, index) => displayNodesEqual(member, b.members[index]!))
    );
  }
  return false;
}

/**
 * The agent's lane: every row the agent produces (prose, thinking, tools,
 * folds, cards, notices, dividers) ends on one right edge, set by the
 * agent's reading measure rather than by the user's bubbles, which keep the
 * full row and sit on the right on their own.
 */
const AGENT_LANE = 'w-full max-w-[var(--kiki-agent-column,640px)]';

const TRANSCRIPT_OVERSCAN = 6;
const EMPTY_HELD: ReadonlySet<string> = new Set();
const TRANSCRIPT_OLDER_INTENT_MS = 1000;
const EMPTY_TRANSCRIPT_ITEM_KEY = 'transcript-live-status';
/** Row-offset tolerance for "the reader is still at that locate target". */
const TRANSCRIPT_ANCHOR_SLACK_PX = 24;

type TranscriptVirtualNode = TimelineNode | undefined;
type TranscriptViewportAnchor = {
  atEnd: boolean;
  key: string | undefined;
  offset: number;
};

type PendingResetRestore = {
  version: number;
  anchor: TranscriptViewportAnchor;
  frame: number | null;
};

/**
 * Converge on the reader's row after an offset restore. A freshly mounted
 * timeline resolves the row's start from estimates until the rows are
 * measured, so the first scroll can land a few rows off; this corrects against
 * the measured row until it sits at the saved offset from the viewport top.
 */
async function settleRestoredAnchor(
  scroll: HTMLDivElement | null,
  resolveAnchor: () => { index: number; blockId?: string } | undefined,
  offset: number,
  cancelled: () => boolean,
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>,
  settledFrames = 1,
): Promise<void> {
  let requestedIndex: number | undefined;
  let stableFrames = 0;
  for (let frame = 0; frame < 120; frame += 1) {
    await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); });
    if (cancelled() || scroll === null || !scroll.isConnected) throw new Error('Reading restore cancelled');
    const hit = resolveAnchor();
    if (hit === undefined) continue;
    const needsMeasurement = [...virtualizer.elementsCache].some(([key, element]) => {
      const rowIndex = virtualizer.indexFromElement(element);
      return element.isConnected && rowIndex >= 0 && rowIndex < virtualizer.options.count
        && virtualizer.options.getItemKey(rowIndex) === key && element.offsetHeight > 0
        && virtualizer.itemSizeCache.get(key) !== element.offsetHeight;
    });
    // An estimated row can already be at the right DOM offset. Its first
    // measurement still compensates scroll and positions on the following
    // frame; drain that existing measurement path before accepting geometry.
    reconcileMountedRows(virtualizer);
    if (needsMeasurement) { stableFrames = 0; continue; }
    const row = scroll.querySelector<HTMLElement>(`[data-transcript-virtual-item][data-index="${hit.index}"]`);
    if (row === null) {
      if (hit.index !== requestedIndex) {
        requestedIndex = hit.index;
        virtualizer.scrollToIndex(requestedIndex, { align: 'start' });
      }
      continue;
    }
    const block = [...row.querySelectorAll<HTMLElement>('[data-block-id]')]
      .find((candidate) => candidate.dataset['blockId'] === hit.blockId);
    if (block === undefined && hit.blockId !== undefined) continue;
    const element = block ?? row;
    // offset = scrollTop - blockStart, so the block belongs at -offset.
    const delta = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + offset;
    if (Math.abs(delta) < 2) {
      stableFrames += 1;
      if (stableFrames >= settledFrames) return;
      continue;
    }
    stableFrames = 0;
    // Replace the estimate-based command as well as the DOM position, so its
    // pending reconcile cannot later undo an exact fold-member correction.
    virtualizer.scrollToOffset(scroll.scrollTop + delta, { align: 'start' });
  }
  throw new Error('Reading anchor is not measured yet');
}

function virtualNodeKey(node: TranscriptVirtualNode): string {
  return node === undefined ? EMPTY_TRANSCRIPT_ITEM_KEY : nodeKey(node);
}

function captureTranscriptAnchor(
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>,
  measured = false,
): TranscriptViewportAnchor {
  const scroll = virtualizer.scrollElement;
  const scrollOffset = virtualizer.scrollOffset ?? scroll?.scrollTop ?? 0;
  const item = virtualizer.getVirtualItemForOffset(scrollOffset);
  const key = typeof item?.key === 'string' ? item.key : undefined;
  const modelAnchor = { atEnd: virtualizer.isAtEnd(TRANSCRIPT_END_THRESHOLD), key, offset: item === undefined ? 0 : scrollOffset - item.start };
  if (!measured || scroll === null) return modelAnchor;
  const top = scroll.getBoundingClientRect().top;
  const rows = [...scroll.querySelectorAll<HTMLElement>('[data-transcript-virtual-item]')]
    .map((row) => ({ row, box: row.getBoundingClientRect() }));
  // Direct DOM updates and the model can settle on different frames. Select
  // the row the reader actually sees, never an unmounted model-only key.
  const row = rows.find(({ box }) => box.top <= top && box.bottom > top)?.row
    ?? rows.filter(({ box }) => box.top >= top).sort((left, right) => left.box.top - right.box.top)[0]?.row;
  if (row === undefined) return modelAnchor;
  const rowKey = virtualizer.options.getItemKey(Number(row.dataset['index']));
  const block = [...row.querySelectorAll<HTMLElement>('[data-block-id]')]
    .find((candidate) => candidate.dataset['blockId'] === rowKey);
  return {
    atEnd: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= TRANSCRIPT_END_THRESHOLD,
    key: typeof rowKey === 'string' ? rowKey : undefined,
    offset: top - (block ?? row).getBoundingClientRect().top,
  };
}

type TranscriptRowProps = {
  node: DisplayNode;
  agentId: string;
  readOnly: boolean;
  approvalShortcutHints: boolean;
  agentNames: ReadonlyMap<string, string>;
  /** senderAgentId → role profile / model, for the injected-message label. */
  senderIdentities: ReadonlyMap<string, SenderIdentity>;
  childBlocks: ReadonlyMap<string, SubagentBlock>;
  forest?: AgentForest;
  rowActions?: TranscriptRowActions;
  latestFinalAssistantId?: string;
  annotations?: readonly TimelineAnnotation[];
  /** External-executor badge shown above the first row of the turn. */
  executionBadge?: TurnExecutionInfo;
  /** Turn whose stop the visible tail divider already states. */
  stoppedTailTurnId?: string;
  /** Manual subagent card form overrides, keyed by subagentId (empty = auto). */
  subagentFormOverrides: ReadonlyMap<string, SubagentCardForm>;
  onToggleSubagentForm?: (agentId: string, form: SubagentCardForm) => void;
  /** History folds the reader (or a locate request) opened, by fold id. */
  openFolds: ReadonlySet<string>;
  onToggleFold: (foldId: string) => void;
  onResolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    scope?: 'session',
    selectedOptionId?: string,
  ) => Promise<void>;
  onAnswerQuestion: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  onDismissQuestion: (questionId: string) => Promise<void>;
  onCancelQueued?: (promptId: string) => void;
  onOpenAgent?: (agentId: string) => void;
  /** Scroll back to a subagent's dispatch card (the end row's "Dispatch ↑"). */
  onLocateDispatch?: (agentId: string) => void;
};

function nodeUsesAgentNames(node: DisplayNode): boolean {
  return (
    node.kind === 'history-fold' ||
    node.kind === 'approval' ||
    node.kind === 'question' ||
    node.kind === 'tool' ||
    node.kind === 'tool-group'
  );
}

function subagentBranchEqual(
  node: DisplayNode,
  previousForest: AgentForest | undefined,
  nextForest: AgentForest | undefined,
): boolean {
  // Cards now also sit inside folds and live groups; each must repaint with
  // its own agent's node.
  if (node.kind === 'history-fold') {
    return node.members.every((member) => member.kind === 'tool-group' || subagentBranchEqual(member, previousForest, nextForest));
  }
  if (node.kind === 'subagent-group') {
    return node.members.every((member) => subagentBranchEqual(member, previousForest, nextForest));
  }
  if (node.kind !== 'subagent') return true;
  return previousForest?.byId[node.subagentId] === nextForest?.byId[node.subagentId];
}

/**
 * One transcript row. This memo boundary is what keeps a streaming delta
 * from re-rendering the whole tree: the reducer preserves block identity
 * for untouched blocks, so with stable map/callback props a delta re-renders
 * only the row whose block actually changed.
 */
const TranscriptRow = memo(
  function TranscriptRow({
    node,
    agentId,
    readOnly,
    approvalShortcutHints,
    agentNames,
    senderIdentities,
    childBlocks,
    forest,
    rowActions,
    latestFinalAssistantId,
    annotations,
    executionBadge,
    stoppedTailTurnId,
    subagentFormOverrides,
    onToggleSubagentForm,
    openFolds,
    onToggleFold,
    onResolveApproval,
    onAnswerQuestion,
    onDismissQuestion,
    onCancelQueued,
    onOpenAgent,
    onLocateDispatch,
  }: TranscriptRowProps) {
    // data-turn-id makes a turn addressable from outside the transcript (the
    // /usage drilldown's ?turn= locator scrolls to it); absent on turn-less
    // nodes, so the attribute simply doesn't render there.
    const rowTurnId = displayNodeTurnId(node);
    // Inside a live group every agent is one compact line until the reader
    // opens it; elsewhere a running card takes its full form.
    const renderNode = (member: DisplayNode, cardForm?: SubagentCardForm): ReactNode =>
      member.kind === 'history-fold' ? (
        <HistoryFoldRow
          fold={member}
          expanded={openFolds.has(member.id)}
          onToggle={onToggleFold}
          renderMember={renderNode}
        />
      ) : member.kind === 'subagent-ended' ? (
        <EndedRow ending={member} forest={forest} childBlocks={childBlocks} onOpenAgent={onOpenAgent} onLocateDispatch={onLocateDispatch} />
      ) : member.kind === 'media-run' ? (
        <MediaRunRow run={member} agentId={agentId} />
      ) : member.kind === 'subagent-group' ? (
        <SubagentGroupRow group={member} forest={forest} renderMember={(agent) => renderNode(agent, 'compact')} />
      ) : member.kind === 'tool-group' ? (
        <ToolGroupRow group={member} agentId={agentId} agentNames={agentNames} onOpenAgent={onOpenAgent} />
      ) : member.kind === 'tool' ? (
        <ToolCard block={member} agentId={agentId} agentNames={agentNames} onOpenAgent={onOpenAgent} />
      ) : member.kind === 'shell' ? (
        <ShellMessage block={member} />
      ) : (
        <BlockView
          block={member}
          onResolveApproval={onResolveApproval}
          onAnswerQuestion={onAnswerQuestion}
          onDismissQuestion={onDismissQuestion}
          onCancelQueued={onCancelQueued}
          agentNames={agentNames}
          senderIdentities={senderIdentities}
          approvalShortcutHints={approvalShortcutHints}
          readOnly={readOnly}
          forest={forest}
          childBlocks={childBlocks}
          subagentFormOverride={
            member.kind === 'subagent' ? subagentFormOverrides.get(member.subagentId) ?? cardForm : undefined
          }
          onToggleSubagentForm={onToggleSubagentForm}
          onOpenAgent={onOpenAgent}
          rowActions={rowActions}
          latestFinalAssistantId={latestFinalAssistantId}
          annotations={member.id === node.id ? annotations : undefined}
          stoppedTailTurnId={stoppedTailTurnId}
        />
      );
    // Conversation keeps the full content column; everything the agent DID is
    // inset into the shared activity lane, so a scan follows one glyph axis.
    // Dividers span the column by design and are therefore not inset.
    return (
      <div
        data-block-id={nodeKey(node)}
        data-turn-id={rowTurnId}
        data-timeline-lane={timelineLane(node)}
        className={timelineLane(node) === 'activity' ? ACTIVITY_GUTTER : undefined}
      >
        {executionBadge !== undefined ? <TurnExecutionBadge execution={executionBadge} /> : null}
        {renderNode(node)}
      </div>
    );
  },
  (prev, next) =>
    displayNodesEqual(prev.node, next.node) &&
    prev.agentId === next.agentId &&
    prev.readOnly === next.readOnly &&
    prev.approvalShortcutHints === next.approvalShortcutHints &&
    (!nodeUsesAgentNames(prev.node) || prev.agentNames === next.agentNames) &&
    (prev.node.kind !== 'user' || prev.senderIdentities === next.senderIdentities) &&
    subagentBranchEqual(prev.node, prev.forest, next.forest) &&
    prev.rowActions === next.rowActions &&
    prev.latestFinalAssistantId === next.latestFinalAssistantId &&
    prev.annotations === next.annotations &&
    prev.executionBadge === next.executionBadge &&
    prev.stoppedTailTurnId === next.stoppedTailTurnId &&
    prev.subagentFormOverrides === next.subagentFormOverrides &&
    prev.onToggleSubagentForm === next.onToggleSubagentForm &&
    (prev.node.kind !== 'history-fold' || prev.openFolds.has(prev.node.id) === next.openFolds.has(next.node.id)) &&
    prev.onToggleFold === next.onToggleFold &&
    prev.onResolveApproval === next.onResolveApproval &&
    prev.onAnswerQuestion === next.onAnswerQuestion &&
    prev.onDismissQuestion === next.onDismissQuestion &&
    prev.onCancelQueued === next.onCancelQueued &&
    prev.onOpenAgent === next.onOpenAgent &&
    prev.onLocateDispatch === next.onLocateDispatch,
);

/** Jump-to-bottom pill driven by the virtualizer's end state. */
function JumpToBottom({
  virtualizer, onJump,
}: {
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
  onJump: () => void;
}) {
  const { t } = useI18n();
  if (virtualizer.isAtEnd(TRANSCRIPT_END_THRESHOLD)) return null;
  return (
    <button
      type="button"
      data-jump-to-latest
      onClick={onJump}
      className="anim-enter absolute bottom-4 left-1/2 z-10 flex min-h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-panel px-3 text-[12px] font-medium text-ink-soft shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/.18)] transition-colors duration-[var(--kiki-motion-quick)] hover:text-ink"
    >
      <Icon name="arrowDown" size={12} /> {t('transcript.jumpToLatest')}
    </button>
  );
}

function HistoryPreviewReader({ agentId, turnId, state }: { agentId: string; turnId: string; state: SessionViewState }) {
  const controller = useTranscriptController();
  const { t } = useI18n();
  useEffect(() => {
    const releasePreview = controller?.retainHistoryPreview(agentId, turnId);
    const releaseStructure = controller?.retainHistoryStructure(agentId, turnId);
    return () => { releaseStructure?.(); releasePreview?.(); };
  }, [controller, agentId, turnId]);
  if (!controller?.historyPreviewPending(agentId, turnId)) return null;
  const status = state.detailLoads[`history:${turnId}`];
  return <div role="status" data-history-preview className="flex items-center gap-2 text-[12px] text-ink-faint">
    {status?.status === 'error' ? <><span>{status.message}</span><button type="button" onClick={() => { void controller.loadHistoryPreview(agentId, turnId); }}>{t('transcript.retryEarlier')}</button></>
      : <><span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" />{t('transcript.loadingEarlier')}</>}
  </div>;
}

function TopEdge({ state, onLoadOlder }: {
  state: SessionViewState;
  onLoadOlder: (signal?: AbortSignal) => Promise<boolean>;
}) {
  const { t } = useI18n();
  // Unverified coverage says one thing: the top of what loaded cannot be
  // vouched for as the beginning. While older pages remain there is nothing
  // to warn about yet (the reader just loads them); it replaces the
  // "beginning of history" boundary once the pages run out.
  if (state.historyCoverageKind === 'unknown' && !state.hasMoreHistory && !state.loadingOlder && state.olderError === undefined) {
    return (
      <div role="status" data-top-edge="unverified" className="flex items-center gap-3 pb-1">
        <span className="h-px flex-1 bg-hairline" />
        <span className="text-[12px] text-ink-faint" title={t('transcript.historyUnverifiedHint')}>
          {t('transcript.historyPartial')}
        </span>
        <span className="h-px flex-1 bg-hairline" />
      </div>
    );
  }

  if (state.loadingOlder) {
    return (
      <div className="flex items-center justify-center gap-2 pb-2 text-[12px] text-ink-faint">
        <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" />
        {t('transcript.loadingEarlier')}
      </div>
    );
  }
  if (state.olderError !== undefined) {
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 pb-2 text-center">
        <p className="text-[12px] text-danger">{t('transcript.olderFailed')}</p>
        <p className="max-w-[360px] font-mono text-[11px] text-danger/80">{state.olderError}</p>
        <button
          type="button"
          onClick={() => { void onLoadOlder(); }}
          className="rounded-full border border-hairline px-2 py-0.5 text-[11px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
        >
          {t('transcript.retryEarlier')}
        </button>
      </div>
    );
  }
  if (!state.hasMoreHistory && state.fetchedOlder) {
    return (
      <div className="flex items-center gap-3 pb-1">
        <span className="h-px flex-1 bg-hairline" />
        <span className="text-[12px] text-ink-faint">{t('transcript.beginning')}</span>
        <span className="h-px flex-1 bg-hairline" />
      </div>
    );
  }
  if (state.hasMoreHistory) {
    return (
      <button
        type="button"
        onClick={() => { void onLoadOlder(); }}
        className="mx-auto block rounded-full border border-hairline px-3 py-1 text-[12px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
      >
        {t('transcript.loadEarlier')}
      </button>
    );
  }
  return null;
}

/** The running clock appears only once the wait is visibly long. */
const TURN_CLOCK_AFTER_MS = 15_000;

/**
 * Turn-level running signal (deepseek-harness's TurnStatus, MIT): a
 * status line for the gaps where no token is streaming (first-token wait,
 * tool execution between steps), with a cumulative clock once the turn has
 * run ≥15s. The clock anchors ONLY to the live `turn.started` frame — when
 * no real start is known (e.g. a mid-turn reload whose snapshot carries no
 * running-turn timestamp) the line still names the wait but shows no clock
 * rather than timing from an arbitrary mount point.
 */
const TurnStatusLine = memo(function TurnStatusLine({
  startedAt,
  retry,
}: {
  startedAt: number | undefined;
  retry?: TurnRetryInfo;
}) {
  const { t, time } = useI18n();
  const [elapsedMs, setElapsedMs] = useState(() =>
    startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt),
  );
  useEffect(() => {
    if (startedAt === undefined) return;
    const tick = () => { setElapsedMs(Math.max(0, Date.now() - startedAt)); };
    tick();
    const timer = setInterval(tick, 1000);
    return () => { clearInterval(timer); };
  }, [startedAt]);
  // A provider retry names the wait: cause + attempt counter + backoff delay,
  // in warn tone, so a failing relay reads as such instead of a stuck tool.
  const retryText =
    retry === undefined
      ? undefined
      : t('transcript.turnRetrying', {
          cause: retry.statusCode !== undefined ? String(retry.statusCode) : (retry.errorName ?? '?'),
          attempt: String(retry.failedAttempt),
          max: String(retry.maxAttempts),
          delay: time.formatDuration(retry.delayMs),
        });
  return (
    <div
      role="status"
      aria-live="polite"
      data-turn-status
      className={`anim-enter flex min-h-6 items-center gap-2 text-[13px] ${retryText === undefined ? 'text-ink-faint' : 'text-amber-ink'}`}
    >
      <span className={`status-dot-busy h-1.5 w-1.5 rounded-full ${retryText === undefined ? 'bg-ink-soft' : 'bg-amber-ink'}`} />
      <span>{retryText ?? t('transcript.turnWorking')}</span>
      {startedAt !== undefined && elapsedMs >= TURN_CLOCK_AFTER_MS ? (
        <span aria-hidden className="text-[12px] tabular-nums text-ink-faint">
          {time.formatDuration(elapsedMs)}
        </span>
      ) : null}
    </div>
  );
});

/** Latency readout: one decimal under 10s, whole seconds beyond. */
function formatLatencySeconds(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s));
}

export { TurnExecutionBadge };

const CANCELLATION_LABEL_KEY = {
  user: 'transcript.stoppedByYou',
  aborted: 'transcript.interrupted',
  recovery: 'transcript.interruptedByRestart',
  unknown: 'transcript.interrupted',
} as const satisfies Record<NonNullable<TurnTailInfo['cancellation']>, I18nKey>;

/**
 * End-of-turn readout (deepseek-harness's turn tail, MIT): end clock ·
 * Ran for … · TTFT … · output decode throughput.
 */
const TAIL_ACTION = 'min-h-6 rounded-md px-1.5 text-[12px] font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-60';

export const TurnTailLine = memo(function TurnTailLine({
  tail,
  onResume,
  resumeDisabled = false,
  onRetry,
  retryDisabled = false,
}: {
  tail: TurnTailInfo;
  /** Present when the stopped turn can be re-run (cancelled tails only). */
  onResume?: () => void;
  resumeDisabled?: boolean;
  /** Present when the failed turn's message can be sent again (failed tails only). */
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  const { t, time } = useI18n();
  const [copied, setCopied] = useState(false);
  const isFailed = tail.state === 'failed';
  const isCancelled = tail.state === 'cancelled';
  // Only an explicit stop request reads as "Stopped by you"; engine aborts,
  // restarts and records without provenance say "Interrupted".
  const cancellation = tail.cancellation ?? 'unknown';
  const facts: string[] = [];
  if (tail.durationMs !== undefined) {
    facts.push(t('transcript.ranFor', { duration: time.formatDuration(tail.durationMs) }));
  }
  if (tail.ttftMs !== undefined) {
    facts.push(t('transcript.ttft', { seconds: formatLatencySeconds(tail.ttftMs) }));
  }
  if (tail.tokensPerSecond !== undefined) {
    facts.push(
      t('transcript.tokensPerSecond', { rate: formatTokensPerSecond(tail.tokensPerSecond) }),
    );
  }

  const handleCopyError = useCallback(() => {
    if (tail.error === undefined) return;
    void copyTextToClipboard(tail.error).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 1500);
    });
  }, [tail.error]);

  // A failed turn is a settled fact, not a call to act: it reads in neutral
  // ink with one small danger dot as the only colour (FOLDING: failures are
  // neutral; only what waits on the reader is emphasised).
  return (
    <div
      data-turn-tail
      data-turn-tail-state={tail.state}
      className={`anim-enter py-1 ${isCancelled ? 'text-amber-ink' : ''}`}
    >
      <div className="flex items-center gap-3">
        <span className={`h-px flex-1 ${isCancelled ? 'bg-amber-rule/30' : 'bg-hairline'}`} />
        <div className="flex items-center gap-2">
          {isFailed ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-soft">
              <span aria-hidden data-turn-tail-dot className="h-1.5 w-1.5 rounded-full bg-danger" />
              {t('notice.turnFailed')}
            </span>
          ) : isCancelled ? (
            <span data-turn-tail-cancellation={cancellation} className="text-[12px] font-semibold text-amber-ink">
              {t(CANCELLATION_LABEL_KEY[cancellation])}
            </span>
          ) : null}
          {isCancelled && onResume !== undefined ? (
            <>
              <span aria-hidden className="text-[12px] text-amber-ink">·</span>
              <button
                type="button"
                data-turn-tail-resume
                onClick={onResume}
                disabled={resumeDisabled}
                title={t('transcript.resumeTitle')}
                className="min-h-6 rounded-md px-1 text-[12px] font-semibold text-amber-ink underline underline-offset-2 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-amber-rule/15 disabled:cursor-default disabled:no-underline disabled:opacity-60"
              >
                {t('transcript.resume')}
              </button>
            </>
          ) : null}
          <span className={`text-[12px] tabular-nums ${isCancelled ? 'text-amber-ink' : 'text-ink-faint'}`}>
            <RelativeTime at={tail.endedAt} />{facts.length > 0 ? ` · ${facts.join(' · ')}` : ''}
          </span>
          {isFailed && tail.error !== undefined ? (
            <button
              type="button"
              onClick={handleCopyError}
              className={TAIL_ACTION}
              title={tail.error}
            >
              {copied ? t('cb.copied') : t('cb.copy')}
            </button>
          ) : null}
          {isFailed && onRetry !== undefined ? (
            <button
              type="button"
              data-turn-tail-retry
              onClick={onRetry}
              disabled={retryDisabled}
              title={t('transcript.promptOutcome.retryTitle')}
              className={TAIL_ACTION}
            >
              {t('transcript.promptOutcome.retry')}
            </button>
          ) : null}
        </div>
        <span className={`h-px flex-1 ${isCancelled ? 'bg-amber-rule/30' : 'bg-hairline'}`} />
      </div>
      {isFailed && tail.error !== undefined ? (
        <div
          title={tail.error}
          data-turn-tail-error
          className="mx-auto mt-1 max-w-[var(--kiki-chat-content-width,760px)] truncate rounded-md bg-ink/[0.04] px-3 py-1 text-center font-mono text-[12px] text-ink-soft"
        >
          {tail.error}
        </div>
      ) : null}
    </div>
  );
});

export function TranscriptLoading() {
  const { t } = useI18n();
  const [startedAt] = useState(Date.now);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => { clearInterval(timer); };
  }, [startedAt]);
  return (
    <div data-transcript-loading role="status" aria-live="polite" className="flex flex-1 items-center justify-center gap-2 text-[12px] text-ink-faint">
      <span aria-hidden="true" className="status-dot-busy h-1 w-1 rounded-full bg-ink-faint" />
      <span>{elapsedSeconds >= 3
        ? t('transcript.openingElapsed', { seconds: elapsedSeconds })
        : t('transcript.opening')}</span>
    </div>
  );
}

export function Transcript({
  state,
  agentId = 'main',
  onLoadOlder,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onCancelQueued,
  onRetryLoad,
  readOnly = false,
  forest,
  onOpenAgent,
  rowActions,
  visible = true,
  view = 'process',
  draftAnnotations,
  onSaveDraftAnnotation,
  onRemoveDraftAnnotation,
}: {
  state: SessionViewState;
  agentId?: string;
  /** `message`: only delivered speech, your cards and one-line activity summaries. */
  view?: TimelineView;
  /**
   * False while the timeline sits in a hidden tab or collapsed panel: its
   * viewport anchor is frozen, and showing it again restores the reader's
   * place (or the latest message) instead of whatever the hidden box kept.
   */
  visible?: boolean;
  onLoadOlder: (signal?: AbortSignal) => Promise<boolean>;
  onResolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    scope?: 'session',
    selectedOptionId?: string,
  ) => Promise<void>;
  onAnswerQuestion: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  onDismissQuestion: (questionId: string) => Promise<void>;
  onCancelQueued?: (promptId: string) => void;
  onRetryLoad?: () => void;
  readOnly?: boolean;
  forest?: AgentForest;
  onOpenAgent?: (agentId: string) => void;
  rowActions?: TranscriptRowActions;
  /**
   * Composer draft annotations: while the draft quotes part of a message, the
   * quoted range is marked in the timeline and the popover edits the draft
   * annotation itself. Sent notes also remain marked on their source.
   */
  draftAnnotations?: readonly TimelineAnnotation[];
  onSaveDraftAnnotation?: (id: string, comment: string) => void;
  onRemoveDraftAnnotation?: (id: string) => void;
}) {
  const { t } = useI18n();
  const { blocks } = state;
  const controller = useTranscriptController();
  const stateRef = useRef(state);
  stateRef.current = state;
  const readSeekStructure = useCallback(async (signal: AbortSignal): Promise<boolean | undefined> => {
    const ref = stateRef.current.contentRefs?.findLast((candidate) => candidate.source.kind === 'turn' &&
      candidate.path[0] === 'steps' && (candidate.path.length === 1 || candidate.path.length === 3 && candidate.path[2] === 'frames'));
    if (ref === undefined || controller === undefined) return undefined;
    const key = JSON.stringify(ref);
    const lease = controller.beginContentRead(agentId, ref.source, ['steps']);
    try {
      while (stateRef.current.contentRefs?.some((candidate) => JSON.stringify(candidate) === key)) {
        if (signal.aborted || stateRef.current.detailLoads[`content:${key}`]?.status === 'error') return false;
        await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); });
      }
      return !signal.aborted;
    } finally { lease.release(); }
  }, [controller, agentId]);
  const loaded = state.loaded && state.transcriptReady;
  const loadError = state.loadError ?? (!loaded && state.resyncFailed ? state.resyncError?.message : undefined);
  const sessionIdForLocate = state.sessionId === '' ? undefined : state.sessionId;
  // Failed / aborted prompts: send again puts the text back in this session's
  // composer (nothing is rewritten or re-run behind the reader's back); an
  // earlier one is reached through the one locate entry point.
  const promptOutcomeActions = useMemo<PromptOutcomeActions>(() => {
    if (readOnly || sessionIdForLocate === undefined) return {};
    return {
      disabled: rowActions?.disabled === true,
      onRetry: agentId === 'main' ? (text) => { appendToDraft(sessionIdForLocate, text); } : undefined,
      onLocate: (userMessageId) => {
        void locateInTimeline({ kind: 'block', blockId: `user-${userMessageId}` }, { sessionId: sessionIdForLocate, agentId });
      },
    };
  }, [readOnly, sessionIdForLocate, rowActions?.disabled, agentId]);
  // "link" on a message row copies the same `?block=` deep link this
  // session's route resolves through locateInTimeline.
  const messageLink = useMemo(
    () => (sessionIdForLocate === undefined
      ? undefined
      : (blockId: string) => messageLinkHref(sessionIdForLocate, agentId, blockId)),
    [sessionIdForLocate, agentId],
  );
  const timelineBlocks = useMemo(
    () => blocks.filter((block) => block.kind !== 'user' || block.promptStatus !== 'queued'),
    [blocks],
  );
  const annotationOverrides = useSyncExternalStore(subscribeAnnotationOverrides, getAnnotationOverridesSnapshot, getAnnotationOverridesSnapshot);
  const annotationTargets = useStableAnnotationTargets(
    useMemo(() => {
      const sent = applyAnnotationOverrides(collectTimelineAnnotations(blocks), annotationOverrides);
      const merged = new Map(sent);
      for (const [blockId, drafts] of collectDraftAnnotationTargets(timelineBlocks, draftAnnotations ?? [])) {
        merged.set(blockId, [...drafts, ...(merged.get(blockId) ?? [])]);
      }
      return merged;
    }, [blocks, timelineBlocks, draftAnnotations, annotationOverrides]),
  );
  const annotationsById = useMemo(() => {
    const map = new Map<string, TimelineAnnotation>();
    for (const annotations of annotationTargets.values()) {
      for (const annotation of annotations) map.set(annotation.id, annotation);
    }
    return map;
  }, [annotationTargets]);
  const [annotationPopover, setAnnotationPopover] = useState<AnnotationPopoverOpen | null>(null);
  const openAnnotation =
    annotationPopover === null ? undefined : annotationsById.get(annotationPopover.annotationId);
  const closeAnnotationPopover = useCallback(() => { setAnnotationPopover(null); }, []);
  const openAnnotationMark = useCallback((mark: HTMLElement) => {
    const annotationId = mark.dataset['annotationRef'];
    if (annotationId === undefined) return;
    const rect = mark.getBoundingClientRect();
    setAnnotationPopover({
      annotationId,
      anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    });
  }, []);
  const handleAnnotationClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const mark = event.target.closest<HTMLElement>('[data-annotation-ref]');
    if (mark === null || !event.currentTarget.contains(mark)) return;
    event.preventDefault();
    event.stopPropagation();
    openAnnotationMark(mark);
  }, [openAnnotationMark]);
  const handleAnnotationKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-annotation-ref]')) return;
    event.preventDefault();
    event.stopPropagation();
    openAnnotationMark(event.target);
  }, [openAnnotationMark]);
  const handleAnnotationScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    if (annotationPopover === null) return;
    const transcript = event.currentTarget;
    setAnnotationPopover((current) => {
      if (current === null) return null;
      const mark = [...transcript.querySelectorAll<HTMLElement>('[data-annotation-ref]')].find(
        (candidate) => candidate.dataset['annotationRef'] === current.annotationId,
      );
      if (mark === undefined) return null;
      const rect = mark.getBoundingClientRect();
      const anchor = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      return current.anchor.left === anchor.left &&
        current.anchor.top === anchor.top &&
        current.anchor.right === anchor.right &&
        current.anchor.bottom === anchor.bottom
        ? current
        : { ...current, anchor };
    });
  }, [annotationPopover]);
  useEffect(() => {
    if (annotationPopover !== null && openAnnotation === undefined) setAnnotationPopover(null);
  }, [annotationPopover, openAnnotation]);
  // The fold-steps preference is app-global chrome (Settings' Timeline card
  // writes it), so the transcript reacts immediately via its pub/sub snapshot.
  const foldSteps = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  ).foldSteps;
  // The fold preference is part of the grouping input: off renders the raw
  // step blocks (no groups at all), on folds runs of ≥2, and toggling it
  // re-groups on the next render — the switch applies instantly.
  const nodes = useMemo(
    () => (foldSteps ? groupBlocks(timelineBlocks) : timelineBlocks),
    [foldSteps, timelineBlocks],
  );
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set());
  const handleToggleFold = useCallback((foldId: string) => {
    setOpenFolds((previous) => {
      const next = new Set(previous);
      if (next.has(foldId)) next.delete(foldId);
      else next.add(foldId);
      return next;
    });
  }, []);
  // The forest prop is rebuilt per publish upstream; stabilize it by content
  // so row memos survive unrelated deltas (Finding: forest identity).
  const stableForest = useStableForest(forest);
  // Manual subagent card form overrides (G-4): once the user expands or
  // collapses a card by hand the automatic active→full / terminal→compact
  // rule no longer touches that agent's card. Keyed by subagentId so the
  // choice survives block identity churn across publishes.
  const [cardForms, setCardForms] = useState<ReadonlyMap<string, SubagentCardForm>>(new Map());
  // Nested agents settled at first sight fold for this view only; the store
  // lives as long as this Transcript (keyed per session and agent).
  const nestedFolds = useMemo(() => new NestedFoldStore(), [state.sessionId, agentId, visible]);
  if (visible) {
    for (const node of Object.values(stableForest?.byId ?? {})) nestedFolds.see(node.agentId, node.status);
    for (const block of blocks) {
      if (block.kind === 'subagent') nestedFolds.see(block.subagentId, stableForest?.byId[block.subagentId]?.status ?? block.status);
    }
  }
  const invocationTools = useMemo(() => new Map(blocks.filter((block): block is ToolBlock => block.kind === 'tool').map((block) => [block.toolCallId, block])), [blocks]);
  const invocationContext = useMemo(() => ({ callerAgentId: agentId, tools: invocationTools, hasMore: state.hasMoreHistory, loadOlder: onLoadOlder }), [agentId, invocationTools, state.hasMoreHistory, onLoadOlder]);
  const handleToggleSubagentForm = useCallback((agentId: string, form: SubagentCardForm) => {
    setCardForms((previous) => {
      const next = new Map(previous);
      next.set(agentId, form);
      return next;
    });
  }, []);
  const visibleTailTurnId = state.busy ? undefined : state.turnTail?.turnId;
  // A user stop reads as ONE line: the tail's "Stopped by you · Resume". The
  // same turn's "Prompt aborted" / interruption notices would repeat it.
  const stoppedTailTurnId =
    visibleTailTurnId !== undefined && state.turnTail?.state === 'cancelled' ? visibleTailTurnId : undefined;
  // Same rule for a failure: the tail's "Turn failed" line owns it, so the
  // bubble of that turn drops its own failed line (and send-again moves to
  // the tail). Bubbles without a tail — a prompt that never started, or an
  // older turn — keep theirs.
  const failedTailTurnId =
    visibleTailTurnId !== undefined && state.turnTail?.state === 'failed' ? visibleTailTurnId : undefined;
  const tailNodes = useMemo(() => {
    if (stoppedTailTurnId === undefined && failedTailTurnId === undefined) return nodes;
    // Live abort notices can lack a turn id; anything after the last user row
    // belongs to the stopped tail turn too.
    const lastUserIndex = nodes.findLastIndex((node) => node.kind === 'user');
    return nodes
      .filter(
        (node, index) =>
          stoppedTailTurnId === undefined ||
          !(
            node.kind === 'notice' &&
            (isAbortedPromptNotice(node) || isInterruptionNotice(node)) &&
            (sameTurn(node.turnId, stoppedTailTurnId) || (node.turnId === undefined && index > lastUserIndex))
          ),
      )
      .map((node) =>
        node.kind === 'user' &&
        ((node.promptOutcome?.status === 'aborted' && sameTurn(node.turnId, stoppedTailTurnId)) ||
          (node.promptOutcome?.status === 'failed' && sameTurn(node.turnId, failedTailTurnId)))
          ? { ...node, promptOutcome: undefined }
          : node,
      );
  }, [nodes, stoppedTailTurnId, failedTailTurnId]);
  // The failed turn's message, for the tail's send-again.
  const failedTailText = useMemo(() => {
    if (failedTailTurnId === undefined) return undefined;
    const user = blocks.findLast(
      (block): block is UserBlock => block.kind === 'user' && sameTurn(block.turnId, failedTailTurnId),
    );
    return user === undefined || user.text.trim() === '' ? undefined : user.text;
  }, [blocks, failedTailTurnId]);
  // Settled entries are NOT folded behind a counter: they stay in place at
  // their own timestamp, one quiet activity line each. One subagent is ONE
  // line, though: when its card is on the page, the card absorbs the
  // lifecycle entries (spawned / completed / failed / cancelled) and the
  // dispatching tool call — all three said the same thing three times.
  // Deliveries (sent / resumed) carry their own message and stay.
  // A subagent's task notification is read as that agent's end: dropped
  // when its card is in the same turn (the card says it), a row of its own
  // with a way back to the card when it ended in a later turn.
  // The task list is rebuilt per publish; only the fields endings read count.
  const endingTasksKey = JSON.stringify(state.tasks.map((task) => [
    task.id, task.agent_id, task.status, task.stop_reason,
    task.started_at, task.completed_at, task.output_preview, task.model, task.thinking_effort,
  ]));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content, see above
  const endingTasks = useMemo(() => state.tasks, [endingTasksKey]);
  const mergedNodes = useMemo(
    () => readSubagentEndings(mergeSubagentRows(tailNodes), endingTasks),
    [tailNodes, endingTasks],
  );
  // Settled process folds (FOLDING.md): finished turns fold whole, and the
  // latest turn folds everything but its newest process row, which stays in
  // view until the next one arrives. Rows the reader is looking at while
  // scrolled up (`heldRows`) are left in place until they return.
  const liveTurnId = latestTurnId(mergedNodes);
  const [heldRows, setHeldRows] = useState<ReadonlySet<string>>(EMPTY_HELD);
  const processNodes = useMemo(
    () => foldHistory(mergedNodes, liveTurnId, { keepOpen: heldRows }),
    [mergedNodes, liveTurnId, heldRows],
  );
  // Message view: the same blocks through the delivery projection — speech,
  // your cards, one activity line per stretch, outcomes. Nothing is dropped:
  // every block stays inside a summary's members.
  const messageContext = useMessageViewContext();
  const messageNodes = useMemo<readonly MessageViewNode[]>(
    () => (view === 'message'
      // A silent stretch draws nothing; as a virtual row it would still
      // take a gap, so it is not a row at all.
      ? buildMessageNodes(timelineBlocks, { busy: state.busy, personaName: messageContext.persona?.name })
        .filter((node) => node.kind !== 'activity-summary' || !isSilentActivity(node))
      : []),
    [view, timelineBlocks, state.busy, messageContext.persona?.name],
  );
  const groupedNodes: readonly TimelineNode[] = view === 'message' ? messageNodes : processNodes;
  const blockById = useMemo(() => new Map(timelineBlocks.map((block) => [block.id, block] as const)), [timelineBlocks]);
  // "查看过程" / "在过程中查看": flip this session to the process view, then
  // let the process timeline (same locator key) scroll to the turn.
  const pendingProcessTarget = useRef<{ turnId?: string; blockId?: string } | null>(null);
  const openProcessAt = useCallback((turnId: string | undefined, blockId?: string) => {
    if (sessionIdForLocate === undefined) return;
    pendingProcessTarget.current = { turnId, blockId };
    writeTimelineView(sessionIdForLocate, 'process');
  }, [sessionIdForLocate]);
  const presence = useMemo(() => (view === 'message' ? presenceOf(messageNodes, state.busy) : undefined), [view, messageNodes, state.busy]);
  const childBlocks = useStableMap(() => {
    const map = new Map<string, SubagentBlock>();
    for (const block of blocks) {
      if (block.kind === 'subagent') map.set(block.subagentId, block);
    }
    return map;
  });
  const agentNames = useStableMap(() => {
    const map = new Map<string, string>();
    for (const block of blocks) {
      if (block.kind === 'subagent') map.set(block.subagentId, block.name);
    }
    if (stableForest !== undefined) {
      for (const node of Object.values(stableForest.byId)) {
        if (!map.has(node.agentId)) map.set(node.agentId, node.label);
      }
    }
    return map;
  });
  // Sender identities for injected bubbles: the roster (`snapshot.subagents`)
  // is the one place the client holds an agent's role profile and model, and
  // its array identity only changes when the roster itself does, so rows keep
  // referentially stable props across ordinary deltas.
  const senderIdentities = useMemo(() => {
    const map = new Map<string, SenderIdentity>();
    for (const row of state.snapshotSubagents) {
      const profile = row.profile === undefined || row.profile === '' ? undefined : row.profile;
      const model = row.model === undefined || row.model === '' ? undefined : row.model;
      if (profile === undefined && model === undefined) continue;
      map.set(snapshotSubagentAgentId(row), { profile, model });
    }
    return map;
  }, [state.snapshotSubagents]);
  // y/n acts on the focused card, else the topmost visible pending card
  // (SessionView's resolver); every pending card advertises that shortcut.
  const hasUnresolvedApproval = useMemo(
    () => blocks.some((b) => b.kind === 'approval' && b.resolution === undefined),
    [blocks],
  );
  // The turn-level status line fills the no-token gaps (first-token wait,
  // tool execution); while text streams the stream-caret is the signal.
  const streamingNow = blocks.some(
    (b) => (b.kind === 'assistant' || b.kind === 'thinking') && b.streaming,
  );
  const showTurnStatus = state.busy && !streamingNow;
  // Regenerate/fork anchor: the latest completed turn's final assistant reply.
  // Changes only at turn boundaries, so the page memos survive token deltas.
  const latestFinalAssistantId = useMemo(() => latestFinalAssistantBlockId(blocks), [blocks]);
  // Resume = regenerate the stopped turn's reply; offered only when that reply
  // exists and the session is writable.
  const stoppedAssistant = useMemo(
    () =>
      stoppedTailTurnId === undefined
        ? undefined
        : blocks.findLast(
          (block): block is AssistantBlock => block.kind === 'assistant' && sameTurn(block.turnId, stoppedTailTurnId),
        ),
    [blocks, stoppedTailTurnId],
  );
  const onResumeStopped = readOnly ? undefined : rowActions?.onResumeStopped;
  const resumeStopped = useMemo(
    () =>
      stoppedAssistant === undefined || onResumeStopped === undefined
        ? undefined
        : () => { onResumeStopped(stoppedAssistant); },
    [stoppedAssistant, onResumeStopped],
  );
  const onRetryPrompt = promptOutcomeActions.onRetry;
  const retryFailed = useMemo(
    () =>
      failedTailText === undefined || onRetryPrompt === undefined
        ? undefined
        : () => { onRetryPrompt(failedTailText); },
    [failedTailText, onRetryPrompt],
  );
  // External-executor badges: first display node of each turn that carries
  // `execution` provenance. Entry identity is stabilized upstream (the
  // projection reuses unchanged TurnExecutionInfo objects), so the map — and
  // thus every row prop — survives unrelated deltas.
  const executionBadges = useStableMap(() => {
    const map = new Map<string, TurnExecutionInfo>();
    const seenTurns = new Set<string>();
    for (const node of groupedNodes) {
      const turnId = displayNodeTurnId(node);
      if (turnId === undefined || seenTurns.has(turnId)) continue;
      seenTurns.add(turnId);
      const execution = state.turnExecutions[turnId];
      if (execution !== undefined) map.set(nodeKey(node), execution);
    }
    return map;
  });
  // A blank transcript is only blank when the session has nothing left
  // unloaded: the snapshot's own structures count as pending reading here.
  const sessionRemainderPending = useSessionRemainderPending();
  const virtualNodes = useMemo<readonly TranscriptVirtualNode[]>(
    () => groupedNodes.length === 0 ? [undefined] : groupedNodes,
    [groupedNodes],
  );
  const nodeIndexes = useMemo(() => {
    const map = new Map<string, number>();
    virtualNodes.forEach((node, index) => { map.set(virtualNodeKey(node), index); });
    return map;
  }, [virtualNodes]);
  const nodeIndexesRef = useRef(nodeIndexes);
  nodeIndexesRef.current = nodeIndexes;
  // Every block id and turn id on the page → the virtual row that shows it
  // (a block inside a history fold or read run resolves to that row, plus the
  // fold that must open). The locate entry resolves targets through this.
  const locateIndex = useMemo(() => {
    const blocks = new Map<string, { index: number; foldId?: string }>();
    const turns = new Map<string, number>();
    const subagents = new Map<string, { index: number; foldId?: string }>();
    const visit = (node: TimelineNode, index: number, foldId: string | undefined) => {
      blocks.set(node.id, { index, foldId });
      if (node.kind === 'subagent' && !subagents.has(node.subagentId)) subagents.set(node.subagentId, { index, foldId });
      if (node.kind === 'history-fold') {
        for (const member of node.members) visit(member, index, node.id);
      } else if (node.kind === 'subagent-group' || node.kind === 'media-run') {
        for (const member of node.members) visit(member, index, foldId);
      } else if (node.kind === 'activity-summary') {
        for (const member of node.members) blocks.set(member.id, { index, foldId });
      } else if (node.kind === 'tool-group') {
        for (const member of node.members) blocks.set(member.id, { index, foldId });
      }
      const turnId = displayNodeTurnId(node);
      if (turnId !== undefined) {
        const key = normalizeTurnId(turnId);
        if (!turns.has(key)) turns.set(key, index);
      }
    };
    virtualNodes.forEach((node, index) => { if (node !== undefined) visit(node, index, undefined); });
    return { blocks, turns, subagents };
  }, [virtualNodes]);
  const locateIndexRef = useRef(locateIndex);
  locateIndexRef.current = locateIndex;
  const [editingBlockIds, setEditingBlockIds] = useState<readonly string[]>([]);
  const pinnedIndexes = useMemo(() => {
    const indexes = new Set<number>();
    virtualNodes.forEach((node, index) => {
      if (
        (node?.kind === 'approval' && node.resolution === undefined) ||
        (node?.kind === 'question' && node.outcome === undefined)
      ) {
        indexes.add(index);
      }
    });
    for (const blockId of editingBlockIds) {
      const index = nodeIndexes.get(blockId);
      if (index !== undefined) indexes.add(index);
    }
    return [...indexes].sort((left, right) => left - right);
  }, [editingBlockIds, nodeIndexes, virtualNodes]);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    if (pinnedIndexes.length === 0) return defaultRangeExtractor(range);
    const indexes = new Set(defaultRangeExtractor(range));
    for (const index of pinnedIndexes) indexes.add(index);
    return [...indexes].sort((left, right) => left - right);
  }, [pinnedIndexes]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const olderIntentRef = useRef(false);
  const olderIntentAtRef = useRef(0);
  const olderInflightRef = useRef(false);
  const readingIntentRef = useRef(0);
  const seekRequestRef = useRef<AbortController | null>(null);
  const olderRequestRef = useRef<AbortController | null>(null);
  const loadOlderRef = useRef(onLoadOlder);
  const loadOlderAtReadingAnchor = useCallback(async (signal: AbortSignal) => {
    const instance = virtualizerRef.current;
    const intent = readingIntentRef.current;
    const firstKey = instance?.options.getItemKey(0);
    let anchor = instance === null ? undefined : captureTranscriptAnchor(instance, true);
    const scroll = scrollRef.current;
    const capture = () => {
      if (instance !== null && readingIntentRef.current === intent && instance.options.getItemKey(0) === firstKey) anchor = captureTranscriptAnchor(instance, true);
    };
    scroll?.addEventListener('scroll', capture, { passive: true });
    let frame: number;
    const captureFrame = () => {
      capture();
      frame = requestAnimationFrame(captureFrame);
    };
    frame = requestAnimationFrame(captureFrame);
    let loaded: boolean;
    try {
      loaded = await loadOlderRef.current(signal);
    } finally {
      scroll?.removeEventListener('scroll', capture);
      cancelAnimationFrame(frame);
    }
    if (olderRequestRef.current?.signal === signal) olderInflightRef.current = false;
    if (loaded && instance !== null && anchor?.key !== undefined && !anchor.atEnd) {
      const key = anchor.key;
      try {
        await settleRestoredAnchor(scrollRef.current, () => {
          const index = nodeIndexesRef.current.get(key);
          return index === undefined ? undefined : { index, blockId: key };
        }, anchor.offset, () => signal.aborted || readingIntentRef.current !== intent || !visibleRef.current, instance, 4);
      } catch {
        return loaded;
      }
    }
    return loaded;
  }, []);
  const requestOlderPage = useCallback(() => {
    readingIntentRef.current += 1;
    olderIntentRef.current = false;
    seekRequestRef.current?.abort();
    olderRequestRef.current?.abort();
    const request = new AbortController();
    olderRequestRef.current = request;
    olderInflightRef.current = true;
    return loadOlderAtReadingAnchor(request.signal).finally(() => {
      if (olderRequestRef.current !== request) return;
      olderRequestRef.current = null;
      olderInflightRef.current = false;
    });
  }, [loadOlderAtReadingAnchor]);
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    let touchY: number | undefined;
    let pointerY: number | undefined;
    const recordIntent = (upward: boolean) => {
      readingIntentRef.current += 1;
      seekRequestRef.current?.abort();
      if (!upward) olderRequestRef.current?.abort();
      olderIntentRef.current = upward;
      if (upward) olderIntentAtRef.current = Date.now();
    };
    const loadAtTop = () => {
      if (!visible || element.clientHeight === 0 || !olderIntentRef.current) return;
      if (Date.now() - olderIntentAtRef.current > TRANSCRIPT_OLDER_INTENT_MS) {
        olderIntentRef.current = false;
        return;
      }
      if (olderInflightRef.current || state.loadingOlder || state.olderError !== undefined ||
          !state.hasMoreHistory || element.scrollTop > Math.min(192, element.clientHeight / 3)) return;
      olderIntentRef.current = false;
      olderInflightRef.current = true;
      const request = new AbortController();
      olderRequestRef.current = request;
      void loadOlderAtReadingAnchor(request.signal).finally(() => {
        if (olderRequestRef.current !== request) return;
        olderRequestRef.current = null;
        olderInflightRef.current = false;
      });
    };
    const onWheel = (event: WheelEvent) => {
      recordIntent(event.deltaY < 0);
      loadAtTop();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) recordIntent(true);
      else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) recordIntent(false);
      loadAtTop();
    };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
    const onTouchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY;
      if (touchY !== undefined && next !== undefined && next !== touchY) recordIntent(next > touchY);
      touchY = next;
      loadAtTop();
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerY = event.offsetX >= element.clientWidth - 20 ? event.clientY : undefined;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (pointerY === undefined || event.buttons === 0) return;
      recordIntent(event.clientY < pointerY);
      pointerY = event.clientY;
      loadAtTop();
    };
    const onPointerUp = () => { pointerY = undefined; };
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('scroll', loadAtTop, { passive: true });
    const frame = requestAnimationFrame(loadAtTop);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('scroll', loadAtTop);
    };
  }, [state.loadingOlder, state.hasMoreHistory, state.olderError, loaded, loadError, visible, loadOlderAtReadingAnchor]);
  const viewportAnchorRef = useRef<TranscriptViewportAnchor>({
    atEnd: true,
    key: undefined,
    offset: 0,
  });
  const navViewportAnchorRef = useRef<TranscriptViewportAnchor | null>(null);
  loadOlderRef.current = onLoadOlder;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const initialScrollDoneRef = useRef(false);
  const initialScrollFrameRef = useRef<number | null>(null);
  const measuredResetRef = useRef(state.transcriptResetVersion);
  const pendingResetRestoreRef = useRef<PendingResetRestore | null>(null);
  // Measurement + anchoring model: see transcriptVirtualizer.ts.
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  const priorHistoryShapeRef = useRef({ resetVersion: state.transcriptResetVersion, length: virtualNodes.length });
  useInsertionEffect(() => {
    const prior = priorHistoryShapeRef.current;
    if (prior.resetVersion !== state.transcriptResetVersion || virtualNodes.length < prior.length) {
      olderIntentRef.current = false;
    }
    priorHistoryShapeRef.current = { resetVersion: state.transcriptResetVersion, length: virtualNodes.length };
  }, [state.transcriptResetVersion, virtualNodes.length]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtualNodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TRANSCRIPT_ESTIMATED_ROW_HEIGHT,
    measureElement: measureTranscriptRow,
    getItemKey: (index) => virtualNodeKey(virtualNodes[index]),
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: TRANSCRIPT_END_THRESHOLD,
    overscan: TRANSCRIPT_OVERSCAN,
    rangeExtractor,
    paddingStart: 24,
    paddingEnd: 60,
    // The base gap; rowSpacing tightens or widens it per lane transition.
    gap: 16,
    initialRect: { width: 760, height: 600 },
    useAnimationFrameWithResizeObserver: false,
    useFlushSync: false,
    directDomUpdates: true,
    directDomUpdatesMode: 'position',
    onChange: (instance) => {
      // A hidden (display:none) box reports scrollTop 0 on every tick; the
      // reader's real place is the anchor captured while it was shown.
      if (!visibleRef.current) return;
      viewportAnchorRef.current = captureTranscriptAnchor(instance);
      if (scrollRef.current?.isConnected === true && instance.scrollElement === scrollRef.current) {
        navViewportAnchorRef.current = captureTranscriptAnchor(instance, true);
      }
    },
  });
  // The instance field (not an option), installed before ResizeObserver delivery.
  virtualizerRef.current = virtualizer;
  useLayoutEffect(() => installTranscriptAnchoring(virtualizer), [loaded, loadError, virtualizer]);
  // Settle pass: re-read mounted rows once scrolling goes idle. A resize the
  // observer delivered mid-scroll can be skipped by virtual-core, and the
  // observer never repeats it; this is the only path that heals such a row.
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        reconcileMountedRows(virtualizer);
      }, 160);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      if (timer !== null) clearTimeout(timer);
    };
  }, [loaded, loadError, virtualizer]);

  useLayoutEffect(() => {
    if (!loaded || loadError !== undefined) return;
    const scroll = scrollRef.current;
    if (scroll === null) return;
    const updateEditingRows = () => {
      const blockIds = [...scroll.querySelectorAll<HTMLElement>('[data-edit-editor]')]
        .map((editor) => editor.closest<HTMLElement>('[data-block-id]')?.dataset['blockId'])
        .filter((blockId): blockId is string => blockId !== undefined)
        .sort();
      setEditingBlockIds((previous) =>
        previous.length === blockIds.length && previous.every((blockId, index) => blockId === blockIds[index])
          ? previous
          : blockIds,
      );
    };
    updateEditingRows();
    const observer = new MutationObserver(updateEditingRows);
    observer.observe(scroll, { childList: true, subtree: true });
    return () => { observer.disconnect(); };
  }, [loadError, loaded, virtualNodes.length]);

  useLayoutEffect(() => {
    if (!loaded || loadError !== undefined || scrollRef.current === null) return;
    // A visit being restored owns the viewport: its saved anchor lands after
    // the folds are applied and the rows it needs are paged in, so the
    // initial landing must not claim the position first.
    if (navRestorePendingRef.current) return;
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      measuredResetRef.current = state.transcriptResetVersion;
      landAtEnd(virtualizer);
      // One more landing after the first measured frame, unless something
      // moved the viewport off the end in between (a floor jump, a reader
      // scroll) — that intent wins over the initial placement.
      initialScrollFrameRef.current = requestAnimationFrame(() => {
        initialScrollFrameRef.current = null;
        // First measurements keep the end pinned (following → compensate), so
        // a real distance past the threshold means someone else moved it.
        const scroll = scrollRef.current;
        if (scroll !== null && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > TRANSCRIPT_END_THRESHOLD) return;
        landAtEnd(virtualizer);
        viewportAnchorRef.current = { atEnd: true, key: undefined, offset: 0 };
      });
      viewportAnchorRef.current = { atEnd: true, key: undefined, offset: 0 };
      return;
    }
    if (measuredResetRef.current !== state.transcriptResetVersion) {
      measuredResetRef.current = state.transcriptResetVersion;
      const previousPending = pendingResetRestoreRef.current;
      if (previousPending?.frame !== null && previousPending?.frame !== undefined) {
        cancelAnimationFrame(previousPending.frame);
      }
      const anchor = previousPending?.anchor ?? viewportAnchorRef.current;
      // Keys survive a reset, so cached sizes stay valid for unchanged rows;
      // mounted rows whose content changed are re-read in place. (A full
      // `measure()` here would drop every cached size while mounted rows keep
      // their height — the observer then never fires and estimates stick.)
      reconcileMountedRows(virtualizer);
      pendingResetRestoreRef.current = {
        version: state.transcriptResetVersion,
        anchor,
        frame: null,
      };
    }
    const pending = pendingResetRestoreRef.current;
    if (pending === null || pending.frame !== null) return;
    pending.frame = requestAnimationFrame(() => {
      if (pendingResetRestoreRef.current !== pending) return;
      olderIntentRef.current = false;
      const { anchor } = pending;
      if (anchor.atEnd) {
        virtualizer.scrollToEnd();
        pendingResetRestoreRef.current = null;
        return;
      }
      const index = anchor.key === undefined ? undefined : nodeIndexesRef.current.get(anchor.key);
      if (index === undefined) {
        virtualizer.scrollToEnd();
        pendingResetRestoreRef.current = null;
        return;
      }
      const offset = virtualizer.getOffsetForIndex(index, 'start')?.[0];
      if (offset !== undefined) {
        virtualizer.scrollToOffset(offset + anchor.offset, { align: 'start' });
      }
      pendingResetRestoreRef.current = null;
    });
  }, [loadError, loaded, state.transcriptResetVersion, virtualNodes.length, virtualizer]);

  // ---- visibility: a hidden tab keeps its reader's place ----
  // While hidden the scroll box has no layout, so its scroll events report a
  // meaningless offset; the anchor captured before hiding is what counts.
  // Showing it again lands on the latest message when the reader was there
  // (the new rows that arrived meanwhile included), else restores the row.
  const wasVisibleRef = useRef(visible);
  useLayoutEffect(() => {
    const was = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!visible || was || !initialScrollDoneRef.current) return;
    const anchor = viewportAnchorRef.current;
    reconcileMountedRows(virtualizer);
    const index = anchor.key === undefined ? undefined : nodeIndexesRef.current.get(anchor.key);
    if (anchor.atEnd || index === undefined) {
      landAtEnd(virtualizer);
      viewportAnchorRef.current = { atEnd: true, key: undefined, offset: 0 };
    } else {
      const offset = virtualizer.getOffsetForIndex(index, 'start')?.[0];
      if (offset !== undefined) virtualizer.scrollToOffset(offset + anchor.offset, { align: 'start' });
    }
    if (sessionIdForLocate !== undefined) timelineBecameVisible(sessionIdForLocate, agentId);
  }, [visible, virtualizer, agentId, sessionIdForLocate]);

  // ---- unified locate entry (see lib/timelineLocate.ts) ----
  const liveRef = useRef({ loaded, hasMore: state.hasMoreHistory, olderError: state.olderError, coverage: state.historyCoverageKind, visible });
  liveRef.current = { loaded, hasMore: state.hasMoreHistory, olderError: state.olderError, coverage: state.historyCoverageKind, visible };
  const nextFrame = useCallback(() => new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); }), []);
  // Where the last explicit locate put the reader. A repeated jump to the same
  // place is recognized from this (view geometry), not from the URL, so it does
  // not open another visit for a position the reader never left.
  const locateTargetRef = useRef<{ key: string; anchor: TranscriptViewportAnchor } | null>(null);
  const recordLocateTarget = useCallback((target: TimelineTarget): void => {
    locateTargetRef.current = { key: timelineTargetKey(target), anchor: { ...viewportAnchorRef.current } };
  }, []);
  const isAtRecordedTarget = useCallback((target: TimelineTarget): boolean => {
    const recorded = locateTargetRef.current;
    if (recorded === null || recorded.key !== timelineTargetKey(target)) return false;
    const anchor = viewportAnchorRef.current;
    if (anchor.atEnd !== recorded.anchor.atEnd) return false;
    if (anchor.atEnd) return true;
    return anchor.key !== undefined && anchor.key === recorded.anchor.key &&
      Math.abs(anchor.offset - recorded.anchor.offset) <= TRANSCRIPT_ANCHOR_SLACK_PX;
  }, []);
  // `quiet` (find steps): land on the row without the flash or the
  // whole-block centering — the find landing scrolls to the match itself.
  const locate = useCallback(async (
    target: TimelineTarget,
    options?: { quiet?: boolean; signal?: AbortSignal },
  ): Promise<LocateOutcome> => {
    const intent = ++readingIntentRef.current;
    olderIntentRef.current = false;
    seekRequestRef.current?.abort();
    olderRequestRef.current?.abort();
    const request = new AbortController();
    seekRequestRef.current = request;
    const signal = options?.signal === undefined ? request.signal : AbortSignal.any([request.signal, options.signal]);
    const cancelled = () => signal.aborted || intent !== readingIntentRef.current || !visibleRef.current;
    for (let wait = 0; !liveRef.current.loaded || !initialScrollDoneRef.current; wait += 1) {
      if (cancelled() || wait > 120) return { status: 'no-timeline' };
      await nextFrame();
    }
    if (cancelled()) return { status: 'no-timeline' };
    if (target.kind === 'latest') {
      if (target.respectReader === true && !viewportAnchorRef.current.atEnd) return { status: 'kept' };
      landAtEnd(virtualizer);
      viewportAnchorRef.current = { atEnd: true, key: undefined, offset: 0 };
      await nextFrame();
      if (cancelled()) return { status: 'no-timeline' };
      landAtEnd(virtualizer);
      locateTargetRef.current = { key: timelineTargetKey(target), anchor: { ...viewportAnchorRef.current } };
      return { status: 'found' };
    }
    const resolve = (): { index: number; foldId?: string; blockId?: string } | undefined => {
      const { blocks, turns, subagents } = locateIndexRef.current;
      switch (target.kind) {
        case 'block':
          return blocks.has(target.blockId) ? { ...blocks.get(target.blockId)!, blockId: target.blockId } : undefined;
        case 'annotation':
          return blocks.has(target.blockId) ? { ...blocks.get(target.blockId)!, blockId: target.blockId } : undefined;
        case 'turn': {
          const index = turns.get(normalizeTurnId(target.turnId));
          return index === undefined ? undefined : { index };
        }
        case 'subagent': {
          const hit = subagents.get(target.agentId);
          // Land on the card itself, even when it sits inside a fold or group.
          return hit === undefined ? undefined : { ...hit, blockId: `subagent-${target.agentId}` };
        }
        case 'interaction':
          for (const blockId of [`approval-${target.id}`, `question-${target.id}`]) {
            const hit = blocks.get(blockId);
            if (hit !== undefined) return { ...hit, blockId };
          }
          return undefined;
      }
    };
    let hit = resolve();
    while (hit === undefined) {
      if (cancelled()) return { status: 'no-timeline' };
      const structure = await readSeekStructure(signal);
      if (cancelled()) return { status: 'no-timeline' };
      if (structure === undefined && !liveRef.current.hasMore) {
        return { status: liveRef.current.coverage === 'unknown' ? 'load-failed' : 'not-found' };
      }
      const loadedMore = structure ?? await loadOlderRef.current(signal);
      for (let frame = 0; frame < 4; frame += 1) {
        await nextFrame();
        if (cancelled()) return { status: 'no-timeline' };
      }
      if (liveRef.current.olderError !== undefined) return { status: 'load-failed' };
      hit = resolve();
      if (!loadedMore && hit === undefined) return { status: 'load-failed' };
    }
    if (hit.foldId !== undefined) {
      const foldId = hit.foldId;
      setOpenFolds((previous) => (previous.has(foldId) ? previous : new Set(previous).add(foldId)));
      await nextFrame();
    }
    // Row first (virtualized: it may not be mounted), then the exact element
    // (a fold member or an annotation mark inside a tall row).
    if (cancelled()) return { status: 'no-timeline' };
    hit = resolve();
    if (hit === undefined) return { status: 'load-failed' };
    let requestedIndex = hit.index;
    virtualizer.scrollToIndex(requestedIndex, { align: 'center' });
    let element: HTMLElement | null = null;
    for (let frame = 0; frame < 120 && element === null; frame += 1) {
      await nextFrame();
      if (cancelled()) return { status: 'no-timeline' };
      hit = resolve();
      const scroll = scrollRef.current;
      if (scroll === null || hit === undefined) return { status: 'load-failed' };
      // Let the virtualizer settle its existing scroll; only a changed row
      // index needs a new request, not a reset of its reconciliation each frame.
      if (hit.index !== requestedIndex) {
        requestedIndex = hit.index;
        virtualizer.scrollToIndex(requestedIndex, { align: 'center' });
      }
      const row = scroll.querySelector<HTMLElement>(`[data-transcript-virtual-item][data-index="${hit.index}"]`);
      if (row === null) continue;
      const blockId = hit.blockId;
      element =
        target.kind === 'annotation'
          ? ([...row.querySelectorAll<HTMLElement>('[data-annotation-ref]')].find(
            (mark) => mark.dataset['annotationRef'] === target.annotationId && mark.tagName === 'MARK',
          ) ?? null)
          : blockId === undefined
            ? row
            : ([...row.querySelectorAll<HTMLElement>('[data-block-id]')].find(
              (candidate) => candidate.dataset['blockId'] === blockId,
            ) ?? row);
    }
    if (element === null) return { status: 'load-failed' };
    if (cancelled()) return { status: 'no-timeline' };
    if (options?.quiet === true) return { status: 'found' };
    element.scrollIntoView?.({ block: 'center' });
    viewportAnchorRef.current = captureTranscriptAnchor(virtualizer);
    if (target.kind === 'annotation') element.focus({ preventScroll: true });
    recordLocateTarget(target);
    const flashed = element;
    flashed.classList.add('settings-card-flash');
    window.setTimeout(() => { flashed.classList.remove('settings-card-flash'); }, 1800);
    return { status: 'found' };
  }, [virtualizer, readSeekStructure]);
  useEffect(() => {
    if (sessionIdForLocate === undefined) return undefined;
    return registerTimelineLocator(sessionIdForLocate, agentId, {
      // `hidden` tabpanels and display:none panels both leave the box
      // unrendered; either means the timeline is not what the reader sees.
      isVisible: () => {
        const scroll = scrollRef.current;
        if (!liveRef.current.visible || scroll === null || !scroll.isConnected) return false;
        return scroll.closest('[hidden], [style*="display: none"]') === null;
      },
      locate: (target, options) => locate(target, options),
      isAtTarget: isAtRecordedTarget,
    });
  }, [sessionIdForLocate, agentId, locate, isAtRecordedTarget]);
  const handleLocateDispatch = useCallback((subagentId: string) => {
    void locate({ kind: 'subagent', agentId: subagentId });
  }, [locate]);

  // ---- per-visit reading snapshot (see lib/navViewState.ts) ----
  // The reader's place belongs to a visit, not to the page: coming back to an
  // earlier visit restores that visit's own anchor and folds, while a new visit
  // still starts at the latest message.
  const navVisitRef = useRef<string | null>(null);
  const navRestoredVisitRef = useRef<string | null>(null);
  const navRestorePendingRef = useRef(false);
  const [readingRestoreFailed, setReadingRestoreFailed] = useState<string | null>(null);
  const departingReadingAnchorRef = useRef<TranscriptViewportAnchor | null>(null);
  const readingKey = sessionIdForLocate === undefined ? 'timeline:unsessioned' : timelineSnapshotKey(sessionIdForLocate, agentId);
  // A saved row key may no longer be a row: a raw process row that was current
  // when the reader left can be folded into a settled-turn history fold while
  // the turn keeps streaming. The block still exists, so the anchor resolves
  // through the existing locate index (and opens that fold) instead of reading
  // as a deleted position.
  const resolveAnchorRow = useCallback((key: string): { index: number; foldId?: string; blockId?: string } | undefined => {
    const rowIndex = nodeIndexesRef.current.get(key);
    if (rowIndex !== undefined) return { index: rowIndex };
    const hit = locateIndexRef.current.blocks.get(key);
    return hit === undefined ? undefined : { ...hit, blockId: key };
  }, []);
  const restoreReading = useCallback(async (snapshot: TimelineReadingSnapshot, restoreSignal: AbortSignal): Promise<void> => {
    setReadingRestoreFailed(null);
    const intent = ++readingIntentRef.current;
    olderIntentRef.current = false;
    seekRequestRef.current?.abort();
    olderRequestRef.current?.abort();
    const request = new AbortController();
    seekRequestRef.current = request;
    const signal = AbortSignal.any([request.signal, restoreSignal]);
    const cancelled = () => signal.aborted || intent !== readingIntentRef.current || !visibleRef.current ||
      (scrollRef.current !== null && !scrollRef.current.isConnected);
    const adapter: TimelineReadingAdapter = {
      applyFolds: async (value) => {
        setOpenFolds(new Set(value.openFolds));
        setCardForms(new Map(Object.entries(value.cardForms ?? {})));
        // Two measured frames: the restored folds change the row set the
        // anchor key has to resolve against.
        await nextFrame();
        await nextFrame();
      },
      hasAnchor: (key) => resolveAnchorRow(key) !== undefined,
      hasMore: () => liveRef.current.hasMore || liveRef.current.coverage === 'unknown' || liveRef.current.olderError !== undefined ||
        stateRef.current.contentRefs?.some((ref) => ref.source.kind === 'turn' && ref.path[0] === 'steps') === true,
      loadOlder: async () => {
        const structure = await readSeekStructure(signal);
        if (cancelled()) return false;
        return structure ?? loadOlderRef.current(signal);
      },
      hasLoadError: () => liveRef.current.olderError !== undefined,
      nextFrame,
      restoreAnchor: async (anchor) => {
        // The saved anchor is the reader's place even while this timeline sits
        // in a hidden tab: showing it again re-applies it (visibility effect).
        viewportAnchorRef.current = { atEnd: anchor.atEnd, key: anchor.key, offset: anchor.offset };
        if (!visibleRef.current) return;
        if (anchor.atEnd) {
          landAtEnd(virtualizer);
          return;
        }
        const hit = anchor.key === undefined ? undefined : resolveAnchorRow(anchor.key);
        if (hit === undefined) return;
        if (hit.foldId !== undefined) {
          // Same automatic reveal the locate entry performs: the reader's row
          // is inside a fold now, so that fold opens for this visit.
          const foldId = hit.foldId;
          setOpenFolds((previous) => (previous.has(foldId) ? previous : new Set(previous).add(foldId)));
          await nextFrame();
        }
        if (cancelled()) return;
        const resolve = () => anchor.key === undefined ? undefined : resolveAnchorRow(anchor.key);
        const current = resolve();
        const offset = current === undefined ? undefined : virtualizer.getOffsetForIndex(current.index, 'start')?.[0];
        if (offset !== undefined) virtualizer.scrollToOffset(offset + anchor.offset, { align: 'start' });
        await settleRestoredAnchor(scrollRef.current, resolve, anchor.offset, cancelled, virtualizer);
      },
      beginRestore: () => { navRestorePendingRef.current = true; },
      endRestore: (outcome) => {
        if (restoreSignal.aborted || (outcome.status !== 'found' && intent === readingIntentRef.current)) return;
        navRestorePendingRef.current = false;
        navRestoredVisitRef.current = navVisitRef.current;
        initialScrollDoneRef.current = true;
        measuredResetRef.current = state.transcriptResetVersion;
      },
      isCancelled: cancelled,
    };
    const outcome = await restoreTimelineReading(snapshot, adapter);
    if (cancelled()) return;
    if (outcome.status === 'found') {
      // Focus returns to the reading surface when the control that started the
      // jump is gone (a removed trigger leaves focus on <body>).
      const active = document.activeElement;
      if (active === null || active === document.body) scrollRef.current?.focus({ preventScroll: true });
    }
    const failure = outcome.status === 'load-failed'
      ? t('locate.failedLoad')
      : outcome.status === 'not-found'
        ? t('locate.notFound')
        : undefined;
    if (failure !== undefined) pushToast({ tone: outcome.status === 'load-failed' ? 'error' : 'info', text: failure });
    if (outcome.status !== 'found') {
      setReadingRestoreFailed(failure ?? t('locate.failedLoad'));
      throw new Error(failure ?? 'Reading restore is not ready');
    }
  }, [nextFrame, resolveAnchorRow, state.transcriptResetVersion, t, virtualizer, readSeekStructure]);
  const reading = useNavSnapshotAdapter<TimelineReadingSnapshot>(readingKey, {
    // Reading a place back only makes sense once this transcript has rows: a
    // not-yet-loaded timeline would page history for an anchor it cannot see.
    ready: loaded && loadError === undefined && visible,
    capture: () => ({
      anchor: departingReadingAnchorRef.current ?? (visibleRef.current && scrollRef.current?.isConnected === true && virtualizer.scrollElement === scrollRef.current
        ? captureTranscriptAnchor(virtualizer, true) : { ...(navViewportAnchorRef.current ?? viewportAnchorRef.current) }),
      openFolds: [...openFolds],
      cardForms: Object.fromEntries(cardForms),
    }),
    restore: (snapshot, signal) => restoreReading(snapshot, signal),
    onRestoreError: () => { setReadingRestoreFailed((previous) => previous ?? t('locate.failedLoad')); },
  });
  navVisitRef.current = reading.visitId;
  navRestorePendingRef.current = reading.hasSnapshot && navRestoredVisitRef.current !== reading.visitId;
  // Freeze source geometry before the virtualizer's layout cleanup detaches
  // its scroll element and publishes a temporary end anchor.
  useInsertionEffect(() => () => {
    readingIntentRef.current += 1;
    olderIntentRef.current = false;
    departingReadingAnchorRef.current = visibleRef.current && scrollRef.current?.isConnected === true && virtualizer.scrollElement === scrollRef.current
      ? captureTranscriptAnchor(virtualizer, true) : navViewportAnchorRef.current;
  }, [reading.visitId, virtualizer]);
  useLayoutEffect(() => { departingReadingAnchorRef.current = null; }, [reading.visitId]);
  useEffect(() => { setReadingRestoreFailed(null); }, [reading.visitId]);
  useEffect(() => () => {
    seekRequestRef.current?.abort();
    olderRequestRef.current?.abort();
  }, [reading.visitId, visible]);
  useTimelineVisitLocator(sessionIdForLocate, agentId);

  // ---- find in this conversation (Ctrl/⌘+F; lib/timelineFind.ts) ----
  const [findRequest, setFindRequest] = useState<{ prefill?: string; nonce: number } | null>(null);
  const [findIncludeToolOutput, setFindIncludeToolOutput] = useState(false);
  const findReturnFocusRef = useRef<HTMLElement | null>(null);
  const findStepRef = useRef<((direction: 1 | -1) => void) | null>(null);
  const [findReveal] = useState(createFindRevealStore);
  const [findOwner] = useState(() => Symbol('transcript-find'));
  const findOpen = findRequest !== null;
  // Find reads what the rows show; a message-view activity summary is one
  // collapsed line whose members stay in the process view.
  const findItems = useMemo(
    () => (findOpen
      ? buildFindItems(groupedNodes.filter((node): node is DisplayNode => node.kind !== 'activity-summary'), true)
      : []),
    [findOpen, groupedNodes],
  );
  const loadedTurns = useMemo(() => {
    const turns = new Set<number>();
    for (const item of findItems) {
      const ordinal = turnOrdinal(item.turnId);
      if (ordinal !== undefined) turns.add(ordinal);
    }
    return turns;
  }, [findItems]);
  const findHostRef = useRef<FindHost | null>(null);
  useEffect(() => {
    const host: FindHost = {
      isVisible: () => {
        const scroll = scrollRef.current;
        if (!liveRef.current.visible || scroll === null || !scroll.isConnected) return false;
        return scroll.closest('[hidden], [style*="display: none"]') === null;
      },
      root: () => scrollRef.current?.parentElement ?? null,
      open: ({ prefill, returnFocus }) => {
        // Re-pressing Ctrl+F inside the bar keeps the original return target.
        if (returnFocus !== null && returnFocus.closest('[data-find-bar]') === null) findReturnFocusRef.current = returnFocus;
        setFindRequest((previous) => ({ prefill, nonce: (previous?.nonce ?? 0) + 1 }));
      },
      step: (direction, returnFocus) => {
        if (findStepRef.current !== null) findStepRef.current(direction);
        else host.open({ returnFocus });
      },
      lastUsedAt: 0,
    };
    findHostRef.current = host;
    const unregister = registerFindHost(host);
    const box = scrollRef.current?.parentElement;
    const touch = () => { host.lastUsedAt = Date.now(); };
    box?.addEventListener('pointerdown', touch, true);
    box?.addEventListener('focusin', touch);
    return () => {
      unregister();
      box?.removeEventListener('pointerdown', touch, true);
      box?.removeEventListener('focusin', touch);
    };
  }, [loaded, loadError]);
  const clearFindPaint = useCallback(() => { paintFindHighlights(findOwner, [], undefined); }, [findOwner]);
  const closeFind = useCallback(() => {
    setFindRequest(null);
    setFindIncludeToolOutput(false);
    findStepRef.current = null;
    clearFindPaint();
    const target = findReturnFocusRef.current;
    findReturnFocusRef.current = null;
    // Back to where Ctrl+F was pressed (the composer included); a target that
    // left the page falls back to the timeline itself.
    if (target !== null && target.isConnected) target.focus({ preventScroll: true });
    else scrollRef.current?.focus({ preventScroll: true });
  }, [clearFindPaint]);
  useEffect(() => clearFindPaint, [clearFindPaint]);

  // The current match, re-resolved against the DOM on every paint: rows
  // remount as the virtualizer scrolls, so a stored Range would go stale.
  const findCurrentRef = useRef<{ match: FindMatch; pattern: RegExp; rangeKey?: string } | null>(null);
  const findLandTokenRef = useRef(0);
  const findScope = useCallback((match: FindMatch): HTMLElement | null => {
    const scroll = scrollRef.current;
    if (scroll === null) return null;
    const selector = match.item.toolCallId !== undefined
      ? attrSelector('data-tool-id', match.item.toolCallId)
      : attrSelector('data-block-id', match.item.blockId);
    return scroll.querySelector<HTMLElement>(selector);
  }, []);
  const paintFind = useCallback((): Range | undefined => {
    const scroll = scrollRef.current;
    const current = findCurrentRef.current;
    if (scroll === null || current === null) {
      clearFindPaint();
      return undefined;
    }
    const row = findScope(current.match);
    const scope = current.rangeKey === undefined ? row : [...(row?.querySelectorAll<HTMLElement>('[data-content-range-key]') ?? [])].find((element) => element.dataset['contentRangeKey'] === current.rangeKey) ?? null;
    const rangesForItem = (root: HTMLElement | null, item: FindItem): Range[] => {
      if (root === null) return [];
      if (item.textSelector === undefined) return findRanges(root, current.pattern);
      return [...root.querySelectorAll<HTMLElement>(item.textSelector)].flatMap((field) => findRanges(field, current.pattern));
    };
    const all = current.rangeKey === undefined ? rangesForItem(scope, current.match.item) : scope === null ? [] : findRanges(scope, current.pattern);
    // An opened row repeats its first line in the summary above the body;
    // the current match is the one in the body the model text came from.
    // Rendering can also drop or add text around the model's (labels,
    // markup), so the occurrence is clamped to what the row really shows.
    const inBody = all.filter((candidate) => candidate.startContainer.parentElement?.closest('[data-activity-toggle]') === null);
    const own = inBody.length > 0 ? inBody : all;
    const range = own.length === 0 ? undefined : own[Math.min(current.match.occurrence, own.length - 1)];
    const others = findItems.filter((item) => !item.toolOutput || findIncludeToolOutput).flatMap((item) => rangesForItem(findScope({ item, occurrence: 0, start: 0 }), item)).filter((candidate) =>
      range === undefined ||
      candidate.compareBoundaryPoints(Range.START_TO_START, range) !== 0 ||
      candidate.compareBoundaryPoints(Range.END_TO_END, range) !== 0);
    paintFindHighlights(findOwner, others, range);
    return range;
  }, [clearFindPaint, findOwner, findScope, findItems, findIncludeToolOutput]);
  const landFind = useCallback(async (match: FindMatch, pattern: RegExp, contentRange?: { ref: ContentRef; offset: number }): Promise<boolean> => {
    const token = findLandTokenRef.current + 1;
    findLandTokenRef.current = token;
    findCurrentRef.current = { match: contentRange === undefined ? match : { ...match, occurrence: 0 }, pattern, rangeKey: contentRange === undefined ? undefined : JSON.stringify([contentRange.ref.source, contentRange.ref.path, contentRange.ref.revision]) };
    findReveal.set(match.item.reveal);
    const outcome = await locate({ kind: 'block', blockId: match.item.blockId }, { quiet: true });
    if (findLandTokenRef.current !== token) return false;
    if (outcome.status !== 'found') {
      paintFind();
      return false;
    }
    // The row's own disclosure opens on the next commit; wait for its text.
    let range: Range | undefined;
    for (let frame = 0; frame < (contentRange === undefined ? 12 : 60); frame += 1) {
      if (contentRange === undefined) findScope(match)?.querySelectorAll('[data-virtual-tool-text]').forEach((element) => { element.dispatchEvent(new CustomEvent('kiki:reveal-tool-match', { detail: { pattern, occurrence: match.occurrence } })); });
      else findScope(match)?.querySelectorAll('[data-content-range-text] > div').forEach((element) => { element.dispatchEvent(new CustomEvent('kiki:reveal-content-match', { detail: { key: JSON.stringify([contentRange.ref.source, contentRange.ref.path, contentRange.ref.revision]), offset: contentRange.offset } })); });
      range = paintFind();
      if (range !== undefined) break;
      await nextFrame();
      if (findLandTokenRef.current !== token) return false;
    }
    if (range !== undefined && rangeIsClipped(range)) {
      findReveal.set([...match.item.reveal, `clamp:${match.item.blockId}`]);
      await nextFrame();
      await nextFrame();
      if (findLandTokenRef.current !== token) return false;
      range = paintFind();
    }
    const scroll = scrollRef.current;
    if (range === undefined || scroll === null) return false;
    scrollRangeIntoView(range, scroll);
    viewportAnchorRef.current = captureTranscriptAnchor(virtualizer);
    paintFind();
    return true;
  }, [findReveal, locate, findScope, paintFind, virtualizer]);
  const handleFindClear = useCallback(() => {
    findLandTokenRef.current += 1;
    findCurrentRef.current = null;
    clearFindPaint();
  }, [clearFindPaint]);
  // Start from the first match at or below the top of what the reader sees.
  const findStartIndex = useCallback((matches: readonly FindMatch[]) => {
    const top = virtualizer.getVirtualItemForOffset(virtualizer.scrollOffset ?? 0)?.index ?? 0;
    const { blocks: rows } = locateIndexRef.current;
    const at = matches.findIndex((match) => (rows.get(match.item.blockId)?.index ?? -1) >= top);
    return at === -1 ? 0 : at;
  }, [virtualizer]);
  const findLocateTurn = useCallback(async (ordinal: number) => {
    const outcome = await locate({ kind: 'turn', turnId: normalizeTurnId(ordinal) });
    return outcome.status === 'found';
  }, [locate]);
  const findLoadOlder = useCallback(() => loadOlderRef.current(), []);
  // Rows mount and unmount as the reader scrolls: repaint what is on screen.
  useEffect(() => {
    if (!findOpen) return undefined;
    const content = scrollRef.current;
    if (content === null) return undefined;
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (findCurrentRef.current !== null) paintFind();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(content, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [findOpen, paintFind]);
  // Esc with focus back in the timeline (after clicking a result) closes too.
  const handleFindKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!findOpen || event.key !== 'Escape' || event.defaultPrevented) return;
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]') !== null) return;
    event.preventDefault();
    event.stopPropagation();
    closeFind();
  }, [findOpen, closeFind]);

  // ---- reading hold: an auto-fold never pulls rows from under the reader ----
  // Scrolled up (off the end) in the live turn, the rows on screen keep their
  // place: they are held out of the fold until the reader is back at the end,
  // then fold together. A fold forming above the viewport is absorbed by the
  // virtualizer's anchor (keys and offsets survive), so it does not move them.
  const liveProcessKeys = useMemo(() => {
    const keys = new Set<string>();
    if (liveTurnId === undefined) return keys;
    for (const node of groupedNodes) {
      if (node.kind === 'history-fold' || node.kind === 'user' || node.kind === 'assistant') continue;
      if (normalizeTurnId(displayNodeTurnId(node) ?? '') === liveTurnId) keys.add(node.id);
    }
    return keys;
  }, [groupedNodes, liveTurnId]);
  useLayoutEffect(() => {
    const anchor = viewportAnchorRef.current;
    if (anchor.atEnd) {
      if (heldRows.size > 0) setHeldRows(EMPTY_HELD);
      return;
    }
    const onScreen = virtualizer.getVirtualItems()
      .map((item) => virtualNodes[item.index])
      .filter((node): node is DisplayNode => node !== undefined && liveProcessKeys.has(node.id))
      .map((node) => node.id);
    const missing = onScreen.filter((id) => !heldRows.has(id));
    if (missing.length > 0) setHeldRows((previous) => new Set([...previous, ...missing]));
  });

  // The message view asked to see a turn's process: once the process rows
  // are on the page, land on the exact block (or the turn when it has none).
  useEffect(() => {
    const target = pendingProcessTarget.current;
    if (view !== 'process' || target === null) return;
    pendingProcessTarget.current = null;
    const blockTarget = target.blockId !== undefined && locateIndexRef.current.blocks.has(target.blockId);
    void locate(blockTarget
      ? { kind: 'block', blockId: target.blockId! }
      : target.turnId !== undefined ? { kind: 'turn', turnId: target.turnId } : { kind: 'latest' });
  }, [view, locate]);

  useEffect(() => () => {
    const initialFrame = initialScrollFrameRef.current;
    if (initialFrame !== null) cancelAnimationFrame(initialFrame);
    const resetFrame = pendingResetRestoreRef.current?.frame;
    if (resetFrame !== null && resetFrame !== undefined) cancelAnimationFrame(resetFrame);
  }, []);

  if (loadError !== undefined) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
        <div className="max-w-[360px] rounded-xl border border-danger/30 bg-danger/5 p-4 text-center">
          <p className="text-[13px] font-medium text-danger">{t('transcript.couldNotOpen')}</p>
          <p className="mt-1 font-mono text-[11px] text-danger/80">{loadError}</p>
          {onRetryLoad !== undefined ? (
            <button
              type="button"
              onClick={onRetryLoad}
              className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-on-accent transition-colors hover:bg-accent-deep"
            >
              {t('common.retry')}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!loaded) return <TranscriptLoading />;

  // An unknown cold read and a failed anchor restore keep their existing
  // Retry action in the blank shell. Known tail coverage, an in-flight older
  // read, and an older-page failure otherwise let TopEdge own the state.
  const showTopEdgeForEmptyHistory =
    readingRestoreFailed === null &&
    (state.hasMoreHistory || state.loadingOlder || state.olderError !== undefined) &&
    (state.historyCoverageKind !== 'unknown' || state.loadingOlder || state.olderError !== undefined);
  if (timelineBlocks.length === 0 && !state.busy && !showTopEdgeForEmptyHistory) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 opacity-70">
        <Wordmark size="lg" />
        {sessionRemainderPending ? null : (
          <p className="text-[13px] text-ink-faint" title={state.historyCoverageKind === 'unknown' ? t('transcript.historyUnverifiedHint') : undefined}>
            {t(state.historyCoverageKind === 'unknown' ? 'transcript.historyPartial' : 'transcript.blank')}
          </p>
        )}
        {/* The session's own remainder is offered from the composer's footer
            now, so the reader sees what is missing from where they are typing
            rather than having to scroll back through a transcript that is not
            there. The blank-state sentence above still yields to it, so an
            unread session is never announced as an empty one. */}
        {state.historyCoverageKind === 'unknown' || readingRestoreFailed !== null ? (
          <button type="button" data-reading-restore-retry={readingRestoreFailed !== null || undefined}
            onClick={() => { if (readingRestoreFailed !== null) reading.retryRestore(); else if (onRetryLoad !== undefined) onRetryLoad(); else void onLoadOlder(); }}
            className="rounded-full border border-hairline px-3 py-1 text-[12px] text-ink-faint hover:text-ink-soft">
            {t('common.retry')}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <InvocationContext.Provider value={invocationContext}>
    <NestedFoldContext.Provider value={nestedFolds}>
    <PromptOutcomeActionsContext.Provider value={promptOutcomeActions}>
    <MessageLinkContext.Provider value={messageLink}>
    <FindRevealContext.Provider value={findReveal}>
    <div className="relative min-h-0 flex-1" onKeyDown={handleFindKeyDown}>
      {readingRestoreFailed ? (
        <button type="button" data-reading-restore-retry onClick={reading.retryRestore}
          className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full border border-hairline bg-paper px-3 py-1 text-[12px] text-ink-soft">
          {readingRestoreFailed} · {t('common.retry')}
        </button>
      ) : null}
      <div
        ref={scrollRef}
        data-transcript-scroll
        role="log"
        tabIndex={-1}
        className="absolute inset-0 overflow-y-auto overflow-x-hidden [overflow-anchor:none] outline-none"
        onClick={handleAnnotationClick}
        onKeyDown={handleAnnotationKeyDown}
        onScroll={handleAnnotationScroll}
      >
        {/* Bottom clearance is 24px of breathing room + the 36px fade band the
            shell's active composer seat overlaps (see index.css). */}
        <div
          ref={virtualizer.containerRef}
          data-transcript-virtual-content
          className="relative w-full"
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const node = virtualNodes[virtualItem.index];
            const first = virtualItem.index === 0;
            const last = virtualItem.index === virtualNodes.length - 1;
            const spacing = first ? '' : rowSpacing(virtualNodes[virtualItem.index - 1], node, view);
            // The turn's own tail: the last row that still belongs to this
            // turn. The turn's structure can be cut by the window (its step
            // list, or one step's frames), and that outlet belongs here rather
            // than at the end of the whole page.
            const turnTailId = node === undefined ? undefined : displayNodeTurnId(node);
            const nextNode = virtualNodes[virtualItem.index + 1];
            const isTurnTail =
              turnTailId !== undefined &&
              (nextNode === undefined || displayNodeTurnId(nextNode) !== turnTailId);
            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                data-transcript-virtual-item
                className="absolute left-0 w-full"
              >
                <div className={`mx-auto flex max-w-[var(--kiki-chat-content-width,760px)] flex-col gap-4 px-6 ${spacing}`}>
                  {first ? <TopEdge state={state} onLoadOlder={readingRestoreFailed ? async () => { reading.retryRestore(); return false; } : requestOlderPage} /> : null}
                  {visible && turnTailId !== undefined ? <HistoryPreviewReader agentId={agentId} turnId={turnTailId} state={state} /> : null}
                  {node === undefined ? null : view === 'message' && isMessageViewOwnRow(node) ? (
                    <div data-transcript-lane="agent" className={AGENT_LANE}>
                      <MessageViewRow
                        node={node}
                        previous={virtualNodes[virtualItem.index - 1] as MessageViewNode | undefined}
                        blockById={blockById}
                        agentId={agentId}
                        agentNames={agentNames}
                        onOpenAgent={onOpenAgent}
                        onOpenProcess={openProcessAt}
                      />
                    </div>
                  ) : (
                    <div data-transcript-lane={node.kind === 'user' ? 'user' : 'agent'} className={node.kind === 'user' ? undefined : AGENT_LANE}>
                      {view === 'message' && node.kind === 'question'
                        && speakerKey(virtualNodes[virtualItem.index - 1] as MessageViewNode | undefined) !== 'bot:self' ? (
                          // A question in Bot mode is the Bot talking: its face
                          // and name lead the card (design §4.6).
                          <SpeakerHead persona={messageContext.persona ?? { id: 'kiki-agent', name: t('agentMessage.agent') }} />
                        ) : null}
                      <TranscriptRow
                        node={node as DisplayNode}
                        agentId={agentId}
                        readOnly={readOnly}
                        approvalShortcutHints={hasUnresolvedApproval}
                        agentNames={agentNames}
                        senderIdentities={senderIdentities}
                        childBlocks={childBlocks}
                        forest={stableForest}
                        rowActions={rowActions}
                        latestFinalAssistantId={latestFinalAssistantId}
                        annotations={annotationTargets.get(virtualNodeKey(node))}
                        executionBadge={executionBadges.get(virtualNodeKey(node))}
                        stoppedTailTurnId={node.kind === 'assistant' ? stoppedTailTurnId : undefined}
                        subagentFormOverrides={cardForms}
                        onToggleSubagentForm={handleToggleSubagentForm}
                        openFolds={openFolds}
                        onToggleFold={handleToggleFold}
                        onResolveApproval={onResolveApproval}
                        onAnswerQuestion={onAnswerQuestion}
                        onDismissQuestion={onDismissQuestion}
                        onCancelQueued={onCancelQueued}
                        onOpenAgent={onOpenAgent}
                        onLocateDispatch={handleLocateDispatch}
                      />
                    </div>
                  )}
                  {isTurnTail && turnTailId !== undefined ? (
                    <div data-transcript-lane="agent" className={AGENT_LANE}>
                      <TurnStepsContinuation turnId={turnTailId} />
                    </div>
                  ) : null}
                  {last && view === 'message' && presence !== undefined ? (
                    <div className={AGENT_LANE}>
                      <PresenceLine
                        text={t(presence.kind === 'typing' ? 'message.typing' : 'message.working', {
                          name: messageContext.persona?.name ?? t('agentMessage.agent'),
                        })}
                        detail={presence.kind === 'working'
                          ? presence.reads > 0
                            ? t('message.readSoFar', { count: presence.reads })
                            : presence.commands > 0
                              ? t('message.ranSoFar', { count: presence.commands })
                              : presence.steps > 0 ? t('message.steps', { count: presence.steps }) : undefined
                          : undefined}
                      />
                    </div>
                  ) : last && showTurnStatus && view !== 'message' ? (
                    <div className={AGENT_LANE}>
                      <TurnStatusLine startedAt={state.turnStartedAt} retry={state.turnRetry} />
                    </div>
                  ) : null}
                  {last && !state.busy && state.turnTail !== undefined ? (
                    <div className={AGENT_LANE}>
                      <TurnTailLine
                        tail={state.turnTail}
                        onResume={resumeStopped}
                        resumeDisabled={rowActions?.disabled === true}
                        onRetry={retryFailed}
                        retryDisabled={promptOutcomeActions.disabled === true}
                      />
                    </div>
                  ) : null}
                  {/* The session's own remainder moved to the composer's footer,
                      which is where a reader looking at the input sees it and
                      where it does not perturb this cell's measurement: it used
                      to be rendered here, after the last row, and that is no
                      longer part of what this cell measures. */}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {annotationPopover !== null && openAnnotation !== undefined ? (
        <AnnotationPopover
          state={annotationPopover}
          annotation={openAnnotation}
          onSave={(id, comment) => {
            if (draftAnnotations?.some((note) => note.id === id)) onSaveDraftAnnotation?.(id, comment);
            else writeAnnotationOverride(id, { ...annotationOverrides[id], comment });
          }}
          onRemove={(id) => {
            if (draftAnnotations?.some((note) => note.id === id)) onRemoveDraftAnnotation?.(id);
            else writeAnnotationOverride(id, { ...annotationOverrides[id], deleted: true });
            closeAnnotationPopover();
          }}
          onClose={closeAnnotationPopover}
        />
      ) : null}
      <FloorNavRail
        blocks={timelineBlocks}
        nodeIndexes={nodeIndexes}
        scrollRef={scrollRef}
        virtualizer={virtualizer}
      />
      <JumpToBottom virtualizer={virtualizer} onJump={() => { void locate({ kind: 'latest' }); }} />
      {findRequest !== null ? (
        <FindBar
          items={findItems}
          onIncludeToolOutputChange={setFindIncludeToolOutput}
          sessionId={sessionIdForLocate}
          agentId={agentId}
          hasMoreHistory={state.hasMoreHistory}
          loadedTurns={loadedTurns}
          request={findRequest}
          onLand={landFind}
          onClear={handleFindClear}
          startIndex={findStartIndex}
          onLoadOlder={findLoadOlder}
          onLocateTurn={findLocateTurn}
          onClose={closeFind}
          stepRef={findStepRef}
        />
      ) : null}
    </div>
    </FindRevealContext.Provider>
    </MessageLinkContext.Provider>
    </PromptOutcomeActionsContext.Provider>
    </NestedFoldContext.Provider>
    </InvocationContext.Provider>
  );
}
