/**
 * Session view state: an immutable-ish transcript model rebuilt from the REST
 * snapshot and advanced by WS `session_event` frames.
 *
 * Rebuild rules (matches rest/snapshot.ts docs):
 *   1. `GET /sessions/{sid}/snapshot` → messages + in_flight_turn + watermark
 *   2. subscribe with cursor `{seq: as_of_seq, epoch}`
 *   3. apply durable events with `seq > cursor.seq`; volatile text deltas use
 *      the cumulative envelope `offset` for alignment:
 *        offset === local length → append
 *        offset <  local length → tail rewrite (idempotent for re-sends)
 *        offset >  local length → gap → caller resyncs from a fresh snapshot
 */

import type {
  ApprovalDecision,
  ApprovalRequest,
  GoalSnapshot,
  Message,
  PermissionMode,
  PromptItem,
  PromptListResponse,
  PromptStatus,
  QuestionItem,
  QuestionRequest,
  Session,
  SessionPendingInteraction,
  SessionSnapshotResponse,
  Task,
  TaskInfo,
  ToolInputDisplay,
  UsageStatus,
} from '@moonshot-ai/protocol';

import type {
  AgentTranscriptAgent,
  AgentTranscriptInteraction,
  AgentTranscriptResponse,
  AgentTranscriptTask,
} from '../lib/client';
import {
  isInteractionEvent,
  type ContextBreakdown,
  type SessionEventFrame,
  type WireTokenUsage,
} from '../lib/types';
import type { I18nKey, I18nParams } from '../i18n/locale';
import {
  MAIN_AGENT_ID,
  buildAgentForest,
  countToolBlocks,
  pairTranscriptBlocks,
  type AgentForest,
  type AgentLiveSource,
  type AgentRosterDescriptor,
  type AgentTaskItem,
  type AgentTimelineBlock,
  type AgentTranscriptPage,
  type AgentTreeNode,
} from './agentTree';

// ---------------------------------------------------------------------------

export interface UserBlock {
  readonly kind: 'user';
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly turnId?: string;
  /** Stable daemon identities when known. `turn.started.prompt` placeholders
   * have neither until the REST result or a future prompt.submitted arrives. */
  readonly promptId?: string;
  readonly userMessageId?: string;
  /** Present while the prompt is parked, running, or rejected before launch. */
  readonly promptStatus?: PromptStatus;
}

export interface SystemReminderBlock {
  readonly kind: 'system-reminder';
  readonly id: string;
  readonly text: string;
  readonly createdAt: string | undefined;
}

/** Left-lane fold for internal/system origins that must never render as You. */
export type SystemVariant =
  | 'injection'
  | 'system_trigger'
  | 'compaction_summary'
  | 'hook_result'
  | 'cron_job'
  | 'cron_missed'
  | 'task'
  | 'retry'
  | 'agent_message'
  | 'system';

export interface SystemBlock {
  readonly kind: 'system';
  readonly id: string;
  readonly variant: SystemVariant;
  readonly text: string;
  readonly createdAt: string | undefined;
  readonly turnId?: string;
  /** Producer detail from the origin (variant / trigger name / skill id). */
  readonly source?: string;
}

/** User-slash skill / plugin activation: summary card, body folded. */
export interface SkillBlock {
  readonly kind: 'skill';
  readonly id: string;
  readonly source: 'skill' | 'plugin';
  readonly name: string;
  readonly args: string | undefined;
  readonly text: string;
  readonly createdAt: string | undefined;
}

/** Queued prompt injected into the running turn — stays anchored, never a tail You. */
export interface SteerBlock {
  readonly kind: 'steer';
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly promptId?: string;
  readonly userMessageId?: string;
  readonly activePromptId?: string;
}

export interface AssistantBlock {
  readonly kind: 'assistant';
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string | undefined;
  readonly turnId?: string;
  /** The turn was cancelled while this message was its latest output. */
  readonly stopped?: boolean;
}

export interface ThinkingBlock {
  readonly kind: 'thinking';
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string | undefined;
  readonly turnId?: string;
}

export type ToolStatus = 'running' | 'done' | 'error' | 'stopped';

export interface ToolAgentRef {
  readonly agentId: string;
  readonly role?: 'child' | 'member';
}

export interface ToolBlock {
  readonly kind: 'tool';
  readonly id: string;
  readonly toolCallId: string;
  readonly name: string;
  /** Raw streamed argument text (tool.call.delta), before args are known. */
  readonly argsText: string;
  readonly args: unknown;
  readonly display: ToolInputDisplay | undefined;
  readonly description: string | undefined;
  readonly status: ToolStatus;
  readonly output: unknown;
  readonly isError: boolean | undefined;
  readonly startedAt: number;
  readonly durationMs: number | undefined;
  readonly progressText: string | undefined;
  /** Agents spawned by Agent / AgentSwarm; omitted on ordinary tools. */
  readonly agentRefs?: readonly ToolAgentRef[];
}

export interface ShellBlock {
  readonly kind: 'shell';
  readonly id: string;
  readonly commandId: string;
  readonly output: string;
  readonly done: boolean;
  readonly isError: boolean | undefined;
}

export interface SubagentBlock {
  readonly kind: 'subagent';
  readonly id: string;
  readonly subagentId: string;
  readonly parentAgentId: string | undefined;
  readonly parentToolCallId: string | undefined;
  /** Stable tool UUID used after a streamed call's display id is finalized. */
  readonly parentToolCallUuid?: string;
  /** Parent turn inferred from the spawn tool or temporal assistant anchor. */
  readonly parentTurnId?: string;
  readonly name: string;
  readonly label?: string;
  readonly description: string | undefined;
  readonly model: string | undefined;
  readonly thinkingEffort: string | undefined;
  readonly status: 'running' | 'suspended' | 'completed' | 'failed';
  readonly summary: string | undefined;
  readonly error: string | undefined;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly toolCallCount: number;
  /** Events captured for the child in this client's unfiltered session stream. */
  readonly transcript: readonly Block[];
}

/** Subtle in-flow notice: compaction, abort, errors, turn failures. */
export interface NoticeBlock {
  readonly kind: 'notice';
  readonly id: string;
  readonly text: string;
  readonly tone: 'neutral' | 'danger';
  /**
   * Dictionary key + params for client-authored notices. `text` stays the
   * English rendering (state-layer tests and logs read it); the Transcript
   * prefers this when rendering so notices follow the active locale.
   */
  readonly i18n?: { readonly key: I18nKey; readonly params?: I18nParams };
}

export interface ApprovalResolution {
  readonly decision: ApprovalDecision | 'expired' | 'resolved_elsewhere';
  readonly resolvedAt: string;
}

export interface ApprovalBlock {
  readonly kind: 'approval';
  readonly id: string;
  readonly request: ApprovalRequest;
  readonly resolution: ApprovalResolution | undefined;
  /** Set when a live event proves the originating agent. */
  readonly originAgentId?: string;
  /**
   * Cold REST interactions have no origin_agent_id on the wire. True when the
   * card was projected from a transcript page and must not be labeled as the
   * requested agent.
   */
  readonly originUnknown?: boolean;
}

export type QuestionOutcome =
  | { readonly kind: 'answered'; readonly at: string }
  | { readonly kind: 'dismissed'; readonly at: string }
  | { readonly kind: 'expired' };

export interface QuestionBlock {
  readonly kind: 'question';
  readonly id: string;
  readonly request: QuestionRequest;
  readonly outcome: QuestionOutcome | undefined;
  /** Set when a live event proves the originating agent. */
  readonly originAgentId?: string;
  /**
   * Cold REST interactions have no origin_agent_id on the wire. True when the
   * card was projected from a transcript page and must not be labeled as the
   * requested agent.
   */
  readonly originUnknown?: boolean;
}

export type Block =
  | UserBlock
  | SystemReminderBlock
  | SystemBlock
  | SkillBlock
  | SteerBlock
  | AssistantBlock
  | ThinkingBlock
  | ToolBlock
  | ShellBlock
  | SubagentBlock
  | NoticeBlock
  | ApprovalBlock
  | QuestionBlock;

export interface TodoItem {
  readonly title: string;
  readonly status: string;
}

export interface SessionCursorState {
  readonly seq: number;
  readonly epoch: string | undefined;
}

/** End-of-turn readout facts (drives the transcript's turn-tail line). */
export interface TurnTailInfo {
  readonly turnId: string;
  readonly endedAt: string;
  readonly durationMs: number | undefined;
  /** Turn start → first streamed token, derived from frame timestamps. */
  readonly ttftMs: number | undefined;
  readonly usage: WireTokenUsage | undefined;
  readonly tokensPerSecond: number | undefined;
}

export interface SessionViewState {
  readonly version: number;
  readonly sessionId: string;
  /** Latest session record (from snapshot, list poll, or work_changed). */
  readonly session: Session | undefined;
  readonly blocks: readonly Block[];
  readonly cursor: SessionCursorState;
  readonly busy: boolean;
  /** Live-turn timing anchors (epoch ms from frame timestamps; undefined when
   * the turn predates this client's attach — e.g. resumed from a snapshot). */
  readonly turnStartedAt: number | undefined;
  readonly turnFirstTokenAt: number | undefined;
  /** The most recently ended turn's readout; cleared when a new turn starts. */
  readonly turnTail: TurnTailInfo | undefined;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly activePromptId: string | undefined;
  readonly queuedPromptIds: readonly string[];
  readonly model: string | undefined;
  readonly thinkingEffort: string | undefined;
  readonly permissionMode: PermissionMode | undefined;
  readonly planMode: boolean;
  readonly swarmMode: boolean;
  /** undefined until the goal endpoint has been checked; null means no goal. */
  readonly goal: GoalSnapshot | null | undefined;
  readonly goalUpdatedAt: string | undefined;
  readonly contextTokens: number | undefined;
  readonly maxContextTokens: number | undefined;
  readonly contextBreakdown: ContextBreakdown | undefined;
  readonly usage: UsageStatus | undefined;
  readonly todos: readonly TodoItem[];
  readonly tasks: readonly Task[];
  /** Set when a delta gap was detected and a resync has been requested. */
  readonly resyncing: boolean;
  /** Set when the last resync failed and a retry is scheduled/pending. */
  readonly resyncFailed: boolean;
  /** How many resync attempts have been made since the last success. */
  readonly resyncAttempt: number;
  readonly loaded: boolean;
  /** Human-readable snapshot/resync error; empty when healthy. */
  readonly loadError: string | undefined;
  /** Snapshot said older messages exist beyond the current first block. */
  readonly hasMoreHistory: boolean;
  /** Wire id of the oldest loaded message — the `before_id` pagination cursor. */
  readonly oldestMessageId: string | undefined;
  /** An older-page fetch is in flight (drives the top affordance). */
  readonly loadingOlder: boolean;
  /** At least one older page has been fetched (drives the history-start cap). */
  readonly fetchedOlder: boolean;
  /** Last older-page fetch error; empty when healthy. Not the history-start cap. */
  readonly olderError: string | undefined;
}

export function createViewState(sessionId: string): SessionViewState {
  return {
    version: 0,
    sessionId,
    session: undefined,
    blocks: [],
    cursor: { seq: 0, epoch: undefined },
    busy: false,
    turnStartedAt: undefined,
    turnFirstTokenAt: undefined,
    turnTail: undefined,
    pendingInteraction: 'none',
    activePromptId: undefined,
    queuedPromptIds: [],
    model: undefined,
    thinkingEffort: undefined,
    permissionMode: undefined,
    planMode: false,
    swarmMode: false,
    goal: undefined,
    goalUpdatedAt: undefined,
    contextTokens: undefined,
    maxContextTokens: undefined,
    contextBreakdown: undefined,
    usage: undefined,
    todos: [],
    tasks: [],
    resyncing: false,
    resyncFailed: false,
    resyncAttempt: 0,
    loaded: false,
    loadError: undefined,
    hasMoreHistory: false,
    oldestMessageId: undefined,
    loadingOlder: false,
    fetchedOlder: false,
    olderError: undefined,
  };
}

// ---------------------------------------------------------------------------
// Snapshot → blocks
// ---------------------------------------------------------------------------

function textOfContent(content: Message['content']): string {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push(part.text);
    else if (part.type === 'image') parts.push('[image]');
    else if (part.type === 'video') parts.push('[video]');
    else if (part.type === 'file') parts.push(`[file: ${part.name}]`);
  }
  return parts.join('\n');
}

export interface SplitSystemRemindersResult {
  readonly text: string;
  readonly reminders: readonly string[];
}

/** Peel daemon-injected reminder envelopes out of user-visible text. The
 * non-greedy matcher intentionally supports multiple envelopes in one message. */
export function splitSystemReminders(text: string): SplitSystemRemindersResult {
  const reminders: string[] = [];
  const visible = text.replaceAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/gi, (_match, body: string) => {
    const reminder = body.trim();
    if (reminder !== '') reminders.push(reminder);
    return '';
  });
  return {
    text: visible.replaceAll(/\n{3,}/g, '\n\n').trim(),
    reminders,
  };
}

/** Wire / REST origin payload. Protocol stores this as `metadata.origin`. */
export interface PromptOriginLike {
  readonly kind?: string;
  readonly trigger?: string;
  readonly skillName?: string;
  readonly commandName?: string;
  readonly skillArgs?: string;
  readonly commandArgs?: string;
  readonly pluginId?: string;
  readonly name?: string;
  readonly variant?: string;
  readonly phase?: string;
  readonly isError?: boolean;
  readonly payload?: unknown;
  readonly taskId?: string;
}

/** Transcript TurnOrigin wrappers (`kind: 'other'`) carry the engine origin in `payload`. */
export function unwrapOrigin(origin: PromptOriginLike | undefined): PromptOriginLike | undefined {
  if (origin === undefined) return undefined;
  if (typeof origin.payload === 'object' && origin.payload !== null) {
    const nested = origin.payload as PromptOriginLike;
    if (typeof nested.kind === 'string') return unwrapOrigin(nested);
  }
  return origin;
}

export function originFromMetadata(metadata: unknown): PromptOriginLike | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const origin = (metadata as { origin?: unknown }).origin;
  if (typeof origin !== 'object' || origin === null) return undefined;
  return unwrapOrigin(origin as PromptOriginLike);
}

function originFromRecord(value: unknown): PromptOriginLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const origin = (value as { origin?: unknown }).origin;
  if (typeof origin !== 'object' || origin === null) return undefined;
  return unwrapOrigin(origin as PromptOriginLike);
}

/**
 * Display lane for a text payload. Origin wins, then role, then envelope
 * fallback (`<system-reminder>` / `<bash-*>` / `<cron-fire>`).
 */
export type TextLane = 'you' | 'peer' | 'skill' | 'shell' | 'system' | 'reminder';

export interface ClassifiedText {
  readonly lane: TextLane;
  readonly origin: PromptOriginLike | undefined;
  readonly text: string;
  readonly reminders: readonly string[];
  readonly skill?: { readonly source: 'skill' | 'plugin'; readonly name: string; readonly args: string | undefined };
  readonly systemVariant?: SystemVariant;
  readonly shell?: { readonly commandId: string; readonly output: string; readonly isError: boolean | undefined };
}

const INTERNAL_ORIGIN_KINDS = new Set<string>([
  'injection',
  'system_trigger',
  'compaction_summary',
  'hook_result',
  'cron_job',
  'cron_missed',
  'task',
  'background_task',
  'retry',
  'agent_message',
]);

const SYSTEM_VARIANTS = new Set<SystemVariant>([
  'injection',
  'system_trigger',
  'compaction_summary',
  'hook_result',
  'cron_job',
  'cron_missed',
  'task',
  'retry',
  'agent_message',
  'system',
]);

function asSystemVariant(kind: string | undefined): SystemVariant {
  if (kind === 'background_task') return 'task';
  if (kind !== undefined && SYSTEM_VARIANTS.has(kind as SystemVariant)) return kind as SystemVariant;
  return 'system';
}

/** Small producer label for a system/injection row header — whatever detail
 * the origin carries (variant / trigger name / skill or plugin id). */
function producerFromOrigin(origin: PromptOriginLike | undefined): string | undefined {
  if (origin === undefined) return undefined;
  return origin.variant ?? origin.name ?? origin.skillName ?? origin.commandName ?? origin.pluginId;
}

const BASH_INPUT_RE = /<bash-input>([\s\S]*?)<\/bash-input>/i;
const BASH_STDOUT_RE = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/i;
const BASH_STDERR_RE = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/i;
const CRON_FIRE_RE = /<cron-fire\b[\s\S]*?<\/cron-fire>/i;
const TASK_NOTIFICATION_RE = /<notification\b[^>]*>([\s\S]*?)<\/notification>/i;

function unescapeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

/**
 * Peel a `<notification …>…</notification>` injection envelope (the engine's
 * model-visible task-notification wrapper), keeping the human-readable inner
 * lines plus any surrounding prose. undefined when no envelope is present.
 */
function splitTaskNotification(text: string): string | undefined {
  const match = TASK_NOTIFICATION_RE.exec(text);
  if (match === null) return undefined;
  const inner = (match[1] ?? '').trim();
  const rest = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.trim();
  if (inner === '') return rest === '' ? undefined : rest;
  return rest === '' ? inner : `${rest}\n\n${inner}`;
}

function parseHistoricalShell(
  text: string,
  identity?: string,
): { commandId: string; output: string; isError: boolean | undefined } | undefined {
  const input = BASH_INPUT_RE.exec(text);
  const stdout = BASH_STDOUT_RE.exec(text);
  const stderr = BASH_STDERR_RE.exec(text);
  if (input === null && stdout === null && stderr === null) return undefined;
  const command = input?.[1] === undefined ? '' : unescapeXml(input[1]).trim();
  const out = stdout?.[1] === undefined ? '' : unescapeXml(stdout[1]);
  const err = stderr?.[1] === undefined ? '' : unescapeXml(stderr[1]);
  const combined = [command === '' ? undefined : `$ ${command}`, out === '' ? undefined : out, err === '' ? undefined : err]
    .filter((part): part is string => part !== undefined)
    .join('\n');
  const slug = command.slice(0, 40) || 'shell';
  return {
    commandId: identity !== undefined && identity !== '' ? `history-${identity}-${slug}` : `history-${slug}`,
    output: combined,
    isError: err !== '' ? true : undefined,
  };
}

function skillFromOrigin(origin: PromptOriginLike | undefined): ClassifiedText['skill'] | undefined {
  if (origin?.kind === 'skill_activation') {
    return {
      source: 'skill',
      name: origin.skillName ?? 'skill',
      args: origin.skillArgs,
    };
  }
  if (origin?.kind === 'plugin_command') {
    return {
      source: 'plugin',
      name: origin.commandName ?? origin.pluginId ?? 'plugin',
      args: origin.commandArgs,
    };
  }
  return undefined;
}

/**
 * Unified classifier: origin first, then role, then envelope fallback.
 * Only real user origins (`user`, and `peer_thread` as a peer lane) may
 * become a right-side You bubble. The child-agent transcript additionally
 * opts its `system_trigger/subagent` turns into that lane because those prompts
 * are messages from the parent agent. An unrecognized but present origin is
 * always system — never You.
 */
export function classifyTranscriptText(input: {
  text: string;
  role?: string;
  origin?: PromptOriginLike;
  id?: string;
  subagentPromptAsUser?: boolean;
}): ClassifiedText {
  const origin = unwrapOrigin(input.origin);
  const split = splitSystemReminders(input.text);
  const kind = origin?.kind;

  if (
    kind === 'user' ||
    (input.subagentPromptAsUser === true && kind === 'system_trigger' && origin?.name === 'subagent')
  ) {
    return { lane: 'you', origin, text: split.text, reminders: split.reminders };
  }
  if (kind === 'peer_thread') {
    return { lane: 'peer', origin, text: split.text, reminders: split.reminders };
  }
  if (kind === 'skill_activation' || kind === 'plugin_command') {
    if (origin?.trigger === 'user-slash') {
      return {
        lane: 'skill',
        origin,
        text: split.text,
        reminders: split.reminders,
        skill: skillFromOrigin(origin),
      };
    }
    return {
      lane: 'system',
      origin,
      text: split.text,
      reminders: split.reminders,
      systemVariant: 'system',
    };
  }
  if (kind === 'shell_command') {
    const shell = parseHistoricalShell(input.text, input.id) ?? {
      commandId: `shell-${input.id ?? origin?.phase ?? 'cmd'}`,
      output: split.text,
      isError: origin?.isError === true ? true : undefined,
    };
    return { lane: 'shell', origin, text: split.text, reminders: split.reminders, shell };
  }
  if (kind !== undefined && INTERNAL_ORIGIN_KINDS.has(kind)) {
    return {
      lane: 'system',
      origin,
      text: split.text,
      reminders: split.reminders,
      systemVariant: asSystemVariant(kind),
    };
  }
  if (kind !== undefined) {
    return {
      lane: 'system',
      origin,
      text: split.text,
      reminders: split.reminders,
      systemVariant: 'system',
    };
  }

  if (input.role === 'system') {
    return {
      lane: 'system',
      origin,
      text: split.text,
      reminders: split.reminders,
      systemVariant: 'system',
    };
  }

  const shell = parseHistoricalShell(input.text, input.id);
  if (shell !== undefined) {
    return { lane: 'shell', origin, text: split.text, reminders: split.reminders, shell };
  }
  if (CRON_FIRE_RE.test(input.text)) {
    return {
      lane: 'system',
      origin,
      text: split.text,
      reminders: split.reminders,
      systemVariant: 'cron_job',
    };
  }
  // Origin-less `<notification>` envelopes are injected task notifications —
  // never a typed user prompt, so never the You lane.
  const notification = splitTaskNotification(split.text);
  if (notification !== undefined) {
    return {
      lane: 'system',
      origin,
      text: notification,
      reminders: split.reminders,
      systemVariant: 'task',
    };
  }
  if (split.text === '' && split.reminders.length > 0) {
    return { lane: 'reminder', origin, text: '', reminders: split.reminders };
  }
  if (input.role === 'user' || input.role === undefined) {
    return { lane: 'you', origin, text: split.text, reminders: split.reminders };
  }
  return {
    lane: 'system',
    origin,
    text: split.text,
    reminders: split.reminders,
    systemVariant: 'system',
  };
}

function reminderBlocks(id: string, createdAt: string | undefined, reminders: readonly string[]): SystemReminderBlock[] {
  return reminders.map((reminder, index) => ({
    kind: 'system-reminder',
    id: `reminder-${id}-${index}`,
    text: reminder,
    createdAt,
  }));
}

function classifiedTextToBlocks(input: {
  id: string;
  classified: ClassifiedText;
  createdAt: string;
  promptId?: string;
  userMessageId?: string;
  promptStatus?: PromptStatus;
  turnId?: string;
}): Block[] {
  const { classified } = input;
  const blocks: Block[] = [];
  switch (classified.lane) {
    case 'you':
    case 'peer':
      if (classified.text !== '') {
        blocks.push({
          kind: 'user',
          id: `user-${input.id}`,
          text: classified.text,
          createdAt: input.createdAt,
          promptId: input.promptId,
          userMessageId: input.userMessageId,
          promptStatus: input.promptStatus,
          turnId: input.turnId,
        });
      }
      break;
    case 'skill': {
      const skill = classified.skill ?? { source: 'skill' as const, name: 'skill', args: undefined };
      blocks.push({
        kind: 'skill',
        id: `skill-${input.id}`,
        source: skill.source,
        name: skill.name,
        args: skill.args,
        text: classified.text,
        createdAt: input.createdAt,
      });
      break;
    }
    case 'shell': {
      const shell = classified.shell ?? {
        commandId: input.id,
        output: classified.text,
        isError: undefined,
      };
      blocks.push({
        kind: 'shell',
        id: `shell-${shell.commandId}`,
        commandId: shell.commandId,
        output: shell.output,
        done: true,
        isError: shell.isError,
      });
      break;
    }
    case 'system':
      if (classified.text !== '') {
        blocks.push({
          kind: 'system',
          id: `system-${input.id}`,
          variant: classified.systemVariant ?? 'system',
          text: classified.text,
          createdAt: input.createdAt,
          turnId: input.turnId,
          source: producerFromOrigin(classified.origin),
        });
      }
      break;
    case 'reminder':
      break;
  }
  blocks.push(...reminderBlocks(input.id, input.createdAt, classified.reminders));
  return blocks;
}

function userAndReminderBlocks(input: {
  id: string;
  text: string;
  createdAt: string;
  promptId?: string;
  userMessageId?: string;
  promptStatus?: PromptStatus;
  origin?: PromptOriginLike;
  role?: string;
}): Block[] {
  return classifiedTextToBlocks({
    id: input.id,
    classified: classifyTranscriptText({
      text: input.text,
      role: input.role ?? 'user',
      origin: input.origin,
      id: input.id,
    }),
    createdAt: input.createdAt,
    promptId: input.promptId,
    userMessageId: input.userMessageId,
    promptStatus: input.promptStatus,
  });
}

interface UserBlockIdentity {
  readonly userMessageId?: string;
  readonly promptId?: string;
  readonly messageId?: string;
}

function userBlockMatchesIdentity(block: UserBlock, identity: UserBlockIdentity): boolean {
  if (identity.userMessageId !== undefined && block.userMessageId === identity.userMessageId) {
    return true;
  }
  if (identity.promptId !== undefined && block.promptId === identity.promptId) return true;
  return (
    identity.messageId !== undefined &&
    (block.id === identity.messageId || block.id === `user-${identity.messageId}`)
  );
}

function findUserBlock(
  blocks: readonly Block[],
  identity: UserBlockIdentity,
): UserBlock | undefined {
  return blocks.find(
    (block): block is UserBlock =>
      block.kind === 'user' && userBlockMatchesIdentity(block, identity),
  );
}

function messagesToBlocks(
  messages: readonly Message[],
  existingBlocks: readonly Block[] = [],
): Block[] {
  const blocks: Block[] = [];
  const existingUsers = existingBlocks.filter(
    (block): block is UserBlock => block.kind === 'user',
  );
  const toolByCallId = new Map<string, ToolBlock>();

  const upsertToolResult = (toolCallId: string, output: unknown, isError: boolean | undefined) => {
    const existing = toolByCallId.get(toolCallId);
    if (existing !== undefined) {
      const index = blocks.indexOf(existing);
      const updated: ToolBlock = {
        ...existing,
        status: isError === true ? 'error' : 'done',
        output,
        isError,
      };
      if (index >= 0) blocks[index] = updated;
      toolByCallId.set(toolCallId, updated);
    } else {
      const block: ToolBlock = {
        kind: 'tool',
        id: `tool-${toolCallId}`,
        toolCallId,
        name: 'tool',
        argsText: '',
        args: undefined,
        display: undefined,
        description: undefined,
        status: isError === true ? 'error' : 'done',
        output,
        isError,
        startedAt: 0,
        durationMs: undefined,
        progressText: undefined,
      };
      toolByCallId.set(toolCallId, block);
      blocks.push(block);
    }
  };

  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        const identity = {
          userMessageId: message.id,
          promptId: message.prompt_id,
          messageId: message.id,
        } satisfies UserBlockIdentity;
        const additions = userAndReminderBlocks({
          id: message.id,
          text: textOfContent(message.content),
          createdAt: message.created_at,
          promptId: message.prompt_id,
          userMessageId: message.id,
          origin: originFromMetadata(message.metadata),
          role: 'user',
        });
        const projected = additions.find(
          (block): block is UserBlock => block.kind === 'user',
        );
        if (projected === undefined) {
          blocks.push(...additions);
          break;
        }
        if (findUserBlock(blocks, identity) !== undefined) break;
        const existing = findUserBlock(existingUsers, identity);
        if (existing === undefined) {
          blocks.push(...additions);
          break;
        }
        const merged: UserBlock = {
          ...projected,
          id: existing.id,
          promptId: projected.promptId ?? existing.promptId,
          userMessageId: existing.userMessageId ?? projected.userMessageId,
          promptStatus: existing.promptStatus,
        };
        blocks.push(...additions.map((block) => (block === projected ? merged : block)));
        break;
      }
      case 'assistant': {
        let textIndex = 0;
        for (const part of message.content) {
          if (part.type === 'text') {
            blocks.push({
              kind: 'assistant',
              id: `assistant-${message.id}-${textIndex}`,
              text: part.text,
              streaming: false,
              createdAt: message.created_at,
            });
            textIndex += 1;
          } else if (part.type === 'thinking') {
            blocks.push({
              kind: 'thinking',
              id: `thinking-${message.id}-${textIndex}`,
              text: part.thinking,
              streaming: false,
              createdAt: message.created_at,
            });
            textIndex += 1;
          } else if (part.type === 'tool_use') {
            const block: ToolBlock = {
              kind: 'tool',
              id: `tool-${part.tool_call_id}`,
              toolCallId: part.tool_call_id,
              name: part.tool_name,
              argsText: '',
              args: part.input,
              display: undefined,
              description: undefined,
              status: 'done',
              output: undefined,
              isError: undefined,
              startedAt: Number.isNaN(Date.parse(message.created_at))
                ? 0
                : Date.parse(message.created_at),
              durationMs: undefined,
              progressText: undefined,
            };
            toolByCallId.set(part.tool_call_id, block);
            blocks.push(block);
          }
        }
        break;
      }
      case 'tool': {
        for (const part of message.content) {
          if (part.type === 'tool_result') {
            upsertToolResult(part.tool_call_id, part.output, part.is_error);
          }
        }
        break;
      }
      case 'system': {
        blocks.push(
          ...userAndReminderBlocks({
            id: message.id,
            text: textOfContent(message.content),
            createdAt: message.created_at,
            origin: originFromMetadata(message.metadata),
            role: 'system',
          }),
        );
        break;
      }
    }
  }
  return blocks;
}

/** Engine (v2) question item → protocol QuestionItem, tolerating missing ids. */
function engineQuestionItems(raw: unknown): QuestionItem[] {
  if (!Array.isArray(raw)) return [];
  const items: QuestionItem[] = [];
  for (const [index, value] of raw.entries()) {
    if (typeof value !== 'object' || value === null) continue;
    const item = value as Record<string, unknown> & { options?: unknown };
    const options = Array.isArray(item.options) ? item.options : [];
    items.push({
      id: typeof item['id'] === 'string' ? item['id'] : `q-${index}`,
      header: typeof item['header'] === 'string' ? item['header'] : undefined,
      question: typeof item['question'] === 'string' ? item['question'] : '',
      body: typeof item['body'] === 'string' ? item['body'] : undefined,
      options: options.flatMap((option, optionIndex) => {
        if (typeof option !== 'object' || option === null) return [];
        const record = option as Record<string, unknown>;
        return [
          {
            id:
              typeof record['id'] === 'string'
                ? record['id']
                : `opt-${index}-${optionIndex}`,
            label: typeof record['label'] === 'string' ? record['label'] : '',
            description:
              typeof record['description'] === 'string'
                ? record['description']
                : undefined,
          },
        ];
      }),
      multi_select:
        (item['multi_select'] ?? item['multiSelect']) === true ? true : undefined,
      allow_other: (item['allow_other'] ?? item['allowOther']) === true ? true : undefined,
    });
  }
  return items;
}

/** Transcript-response interaction entity → an actionable card block. */
function interactionToBlock(
  interaction: AgentTranscriptInteraction,
  _agentId: string,
): Block | undefined {
  // Gap: the wire entity has no origin_agent_id. Do not invent one from the
  // requested agent_id — the page is session-global and ships every page.
  if (interaction.interactionKind === 'approval') {
    const request = (interaction.request ?? {}) as {
      turnId?: number;
      toolName?: string;
      action?: string;
      display?: ToolInputDisplay;
    };
    return {
      kind: 'approval',
      id: `approval-${interaction.interactionId}`,
      request: {
        approval_id: interaction.interactionId,
        session_id: '',
        turn_id: request.turnId,
        tool_call_id: interaction.toolCallId ?? interaction.interactionId,
        tool_name: request.toolName ?? 'tool',
        action: request.action ?? 'Approve the action',
        tool_input_display: request.display,
        created_at: '',
        expires_at: '',
      },
      resolution:
        interaction.state === 'pending'
          ? undefined
          : {
              decision:
                interaction.state === 'approved' ||
                interaction.state === 'rejected' ||
                interaction.state === 'cancelled'
                  ? interaction.state
                  : 'resolved_elsewhere',
              resolvedAt: '',
            },
      originUnknown: true,
    } satisfies ApprovalBlock;
  }
  if (interaction.interactionKind === 'question') {
    const request = (interaction.request ?? {}) as {
      turnId?: number;
      questions?: unknown;
    };
    return {
      kind: 'question',
      id: `question-${interaction.interactionId}`,
      request: {
        question_id: interaction.interactionId,
        session_id: '',
        turn_id: request.turnId,
        tool_call_id: interaction.toolCallId,
        questions: engineQuestionItems(request.questions),
        created_at: '',
      },
      outcome:
        interaction.state === 'pending'
          ? undefined
          : interaction.state === 'answered'
            ? { kind: 'answered', at: '' }
            : interaction.state === 'dismissed'
              ? { kind: 'dismissed', at: '' }
              : { kind: 'expired' },
      originUnknown: true,
    } satisfies QuestionBlock;
  }
  return undefined;
}

const HIDDEN_SPLICE_MARKERS = new Set(['undo', 'clear']);

function originFromTurnItem(item: unknown): PromptOriginLike | undefined {
  return originFromRecord(item);
}

function isUserVisibleOrigin(origin: PromptOriginLike | undefined): boolean {
  const kind = unwrapOrigin(origin)?.kind;
  return kind === 'user' || kind === 'peer_thread';
}

function originFromFrame(frame: unknown): PromptOriginLike | undefined {
  return originFromRecord(frame);
}

const MARKER_SUMMARY_KEYS = {
  compaction: 'transcript.marker.compaction',
  hook: 'transcript.marker.hook',
  skill: 'transcript.marker.skill',
  notice: 'transcript.marker.notice',
  cron: 'transcript.marker.cron',
  goal: 'transcript.marker.goal',
} as const satisfies Record<string, I18nKey>;

function markerToBlock(item: {
  markerId: string;
  marker: string;
  at?: string;
  payload?: unknown;
}): Block | undefined {
  if (HIDDEN_SPLICE_MARKERS.has(item.marker)) return undefined;
  const payload = item.payload;
  const text =
    typeof payload === 'string'
      ? payload
      : typeof payload === 'object' && payload !== null
        ? typeof (payload as { text?: unknown }).text === 'string'
          ? (payload as { text: string }).text
          : typeof (payload as { message?: unknown }).message === 'string'
            ? (payload as { message: string }).message
            : undefined
        : undefined;
  if (text !== undefined && text.trim() !== '') {
    return {
      kind: 'notice',
      id: `agent-marker-${item.markerId}`,
      text,
      tone: 'neutral',
    };
  }
  const summaryKey = MARKER_SUMMARY_KEYS[item.marker as keyof typeof MARKER_SUMMARY_KEYS];
  if (summaryKey === undefined) return undefined;
  return {
    kind: 'notice',
    id: `agent-marker-${item.markerId}`,
    text: item.marker,
    tone: 'neutral',
    i18n: { key: summaryKey },
  };
}

export function agentTranscriptToBlocks(response: AgentTranscriptResponse): Block[] {
  const blocks: Block[] = [];
  const subagentPromptAsUser = response.agent_id !== MAIN_AGENT_ID;
  for (const item of response.items) {
    if (item.kind === 'marker') {
      const marker = markerToBlock(item);
      if (marker !== undefined) blocks.push(marker);
      continue;
    }
    if (item.kind !== 'turn') continue;
    if (item.prompt !== undefined && item.prompt.trim() !== '') {
      const origin = originFromTurnItem(item) ?? { kind: 'task', taskId: response.agent_id };
      blocks.push(
        ...classifiedTextToBlocks({
          id: `agent-turn-${item.turnId}-prompt`,
          classified: classifyTranscriptText({
            text: item.prompt,
            role: 'user',
            origin,
            subagentPromptAsUser,
          }),
          createdAt: item.startedAt ?? '',
          turnId: item.turnId,
        }),
      );
    }
    const openingText = splitSystemReminders(item.prompt ?? '').text;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        switch (frame.kind) {
          case 'text':
            if (frame.role === 'user' && openingText !== '' && frame.text === item.prompt) {
              break;
            }
            if (frame.role === 'user') {
              const frameOrigin = originFromFrame(frame);
              const turnOrigin = originFromTurnItem(item);
              // A task-linked user frame without its own origin is an injected
              // task notification (pre-patch servers ship exactly this shape):
              // never let it inherit the enclosing turn's user origin.
              const taskOrigin =
                frame.taskId !== undefined
                  ? { kind: 'task', taskId: frame.taskId }
                  : undefined;
              const origin =
                frameOrigin ??
                taskOrigin ??
                (isUserVisibleOrigin(turnOrigin) ? turnOrigin : undefined);
              blocks.push(
                ...classifiedTextToBlocks({
                  id: `agent-frame-${frame.frameId}`,
                  classified: classifyTranscriptText({
                    text: frame.text,
                    role: 'user',
                    origin,
                    id: frame.frameId,
                    subagentPromptAsUser,
                  }),
                  createdAt: step.startedAt ?? item.startedAt ?? '',
                  turnId: item.turnId,
                }),
              );
              break;
            }
            blocks.push({
              kind: 'assistant',
              id: `agent-frame-${frame.frameId}`,
              text: frame.text,
              streaming: false,
              createdAt: step.endedAt ?? item.endedAt,
              turnId: item.turnId,
            });
            break;
          case 'thinking':
            blocks.push({
              kind: 'thinking',
              id: `agent-frame-${frame.frameId}`,
              text: frame.text,
              streaming: false,
              createdAt: step.endedAt ?? item.endedAt,
              turnId: item.turnId,
            });
            break;
          case 'tool': {
            const startedAt = new Date(step.startedAt ?? item.startedAt ?? '').getTime();
            const endedAt = new Date(step.endedAt ?? item.endedAt ?? '').getTime();
            blocks.push({
              kind: 'tool',
              id: `tool-${frame.toolCallId}`,
              toolCallId: frame.toolCallId,
              name: frame.name,
              argsText: frame.inputText ?? '',
              args: frame.input,
              display: frame.display as ToolInputDisplay | undefined,
              description: undefined,
              status: frame.state === 'error' ? 'error' : frame.state,
              output: frame.output ?? frame.error,
              isError: frame.state === 'error',
              startedAt: Number.isNaN(startedAt) ? 0 : startedAt,
              durationMs:
                Number.isNaN(startedAt) || Number.isNaN(endedAt)
                  ? item.durationMs
                  : Math.max(0, endedAt - startedAt),
              progressText: frame.progress?.text,
              agentRefs: frame.agentRefs,
            });
            break;
          }
          case 'notice':
            blocks.push({
              kind: 'notice',
              id: `agent-frame-${frame.frameId}`,
              text: frame.message,
              tone: frame.level === 'error' ? 'danger' : 'neutral',
            });
            break;
        }
      }
    }
  }
  for (const interaction of response.interactions ?? []) {
    const block = interactionToBlock(interaction, response.agent_id);
    if (block !== undefined && !blocks.some((existing) => existing.id === block.id)) {
      blocks.push(block);
    }
  }
  return blocks;
}

/**
 * Resolve the instruction that opened a subagent conversation. The detail page
 * renders real turn prompts in-flow and uses the spawn-call result only as a
 * pre-patch fallback. `duplicateBlockIds` remains part of the helper contract
 * for callers that still replace a projected prompt with custom chrome.
 *
 * Resolution order: the subagent transcript's first prompt, then the parent
 * transcript's Agent/AgentSwarm tool input (`prompt`, resume map, or template).
 */
export interface SpawnInstruction {
  readonly text: string;
  readonly source: 'transcript' | 'spawn-call';
  readonly turnId?: string;
  readonly duplicateBlockIds: readonly string[];
}

function spawnInstructionFromToolArgs(args: unknown, agentId: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const prompt = record['prompt'];
  if (typeof prompt === 'string' && prompt.trim() !== '') return prompt.trim();
  const resumeMap = record['resume_agent_ids'];
  if (typeof resumeMap === 'object' && resumeMap !== null) {
    const resumed = (resumeMap as Record<string, unknown>)[agentId];
    if (typeof resumed === 'string' && resumed.trim() !== '') return resumed.trim();
  }
  const template = record['prompt_template'];
  if (typeof template === 'string' && template.trim() !== '') return template.trim();
  return undefined;
}

export function resolveSpawnInstruction(input: {
  response: AgentTranscriptResponse | undefined;
  blocks: readonly Block[];
  agentId: string;
  parentToolCallId: string | undefined;
}): SpawnInstruction | undefined {
  const firstTurn = input.response?.items.find((item) => item.kind === 'turn');
  const firstPromptTurn = input.response?.items.find(
    (item) => item.kind === 'turn' && typeof item.prompt === 'string' && item.prompt.trim() !== '',
  );
  if (firstPromptTurn !== undefined && firstPromptTurn.kind === 'turn' && typeof firstPromptTurn.prompt === 'string') {
    const rawTurnId = firstPromptTurn.turnId;
    const turnIds = [...new Set([rawTurnId, rawTurnId.replace(/^t/, '')])];
    const duplicateBlockIds: string[] = [];
    for (const turnId of turnIds) {
      for (const prefix of ['user-turn-', 'system-turn-', 'user-agent-turn-', 'system-agent-turn-']) {
        duplicateBlockIds.push(`${prefix}${turnId}-prompt`);
      }
    }
    return {
      text: firstPromptTurn.prompt.trim(),
      source: 'transcript',
      turnId: firstPromptTurn.turnId,
      duplicateBlockIds,
    };
  }
  const spawnCall = input.blocks.find(
    (block): block is ToolBlock =>
      block.kind === 'tool' &&
      ((input.parentToolCallId !== undefined && block.toolCallId === input.parentToolCallId) ||
        (block.agentRefs?.some((ref) => ref.agentId === input.agentId) ?? false)),
  );
  if (spawnCall === undefined) return undefined;
  const text = spawnInstructionFromToolArgs(spawnCall.args, input.agentId);
  if (text === undefined) return undefined;
  return {
    text,
    source: 'spawn-call',
    turnId: firstTurn?.kind === 'turn' ? firstTurn.turnId : undefined,
    duplicateBlockIds: [],
  };
}

type RestoredSnapshotSubagent = NonNullable<SessionSnapshotResponse['subagents']>[number] & {
  readonly parent_agent_id?: string;
  readonly parent_tool_call_uuid?: string;
  readonly label?: string;
  readonly tool_call_count?: number;
};

type KikiSessionSnapshot = SessionSnapshotResponse & {
  readonly context_tokens?: number;
  readonly max_context_tokens?: number;
  readonly context_breakdown?: {
    readonly system_tokens: number;
    readonly tools_tokens: number;
    readonly messages_tokens: number;
    readonly estimated: true;
  };
};

function timestampMs(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function blockTimelineMs(block: Block): number | undefined {
  switch (block.kind) {
    case 'user':
    case 'steer':
    case 'assistant':
    case 'thinking':
    case 'system':
    case 'system-reminder':
    case 'skill':
      return timestampMs(block.createdAt);
    case 'tool':
      return block.startedAt > 0 ? block.startedAt : undefined;
    case 'subagent':
      return timestampMs(block.startedAt);
    case 'approval':
      return timestampMs(block.request.created_at);
    case 'question':
      return timestampMs(block.request.created_at);
    case 'shell':
    case 'notice':
      return undefined;
  }
}

function compareTimelineIds(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareSubagentTimeline(a: SubagentBlock, b: SubagentBlock): number {
  const aTime = blockTimelineMs(a);
  const bTime = blockTimelineMs(b);
  if (aTime !== undefined && bTime !== undefined && aTime !== bTime) return aTime - bTime;
  if (aTime !== undefined) return -1;
  if (bTime !== undefined) return 1;
  return compareTimelineIds(a.id, b.id);
}

function nearestParentTurn(
  blocks: readonly Block[],
  subagent: SubagentBlock,
  beforeIndex?: number,
): string | undefined {
  if (subagent.parentTurnId !== undefined) return subagent.parentTurnId;
  if (beforeIndex !== undefined) {
    for (let index = beforeIndex - 1; index >= 0; index -= 1) {
      const candidate = blocks[index];
      if (candidate?.kind === 'assistant' && candidate.turnId !== undefined) {
        return candidate.turnId;
      }
    }
  }
  const startedAt = blockTimelineMs(subagent);
  let nearest: { turnId: string; at: number } | undefined;
  for (const candidate of blocks) {
    if (candidate.kind !== 'assistant' || candidate.turnId === undefined) continue;
    const at = blockTimelineMs(candidate);
    if (at === undefined || (startedAt !== undefined && at > startedAt)) continue;
    if (nearest === undefined || at >= nearest.at) nearest = { turnId: candidate.turnId, at };
  }
  return nearest?.turnId;
}

function insertSubagentByTimeline(blocks: Block[], block: SubagentBlock): void {
  if (block.parentTurnId !== undefined) {
    let anchor = -1;
    for (let index = 0; index < blocks.length; index += 1) {
      const candidate = blocks[index];
      if (candidate?.kind === 'assistant' && candidate.turnId === block.parentTurnId) {
        anchor = index;
      }
    }
    if (anchor >= 0) {
      while (
        blocks[anchor + 1]?.kind === 'subagent' &&
        (blocks[anchor + 1] as SubagentBlock).parentTurnId === block.parentTurnId &&
        compareSubagentTimeline(blocks[anchor + 1] as SubagentBlock, block) <= 0
      ) {
        anchor += 1;
      }
      blocks.splice(anchor + 1, 0, block);
      return;
    }
  }

  const startedAt = blockTimelineMs(block);
  if (startedAt !== undefined) {
    const insertionIndex = blocks.findIndex((candidate) => {
      const candidateAt = blockTimelineMs(candidate);
      if (candidateAt === undefined) return false;
      if (candidateAt !== startedAt) return candidateAt > startedAt;
      return candidate.kind === 'subagent' && compareTimelineIds(candidate.id, block.id) > 0;
    });
    if (insertionIndex >= 0) {
      blocks.splice(insertionIndex, 0, block);
      return;
    }
  }
  blocks.push(block);
}

function insertSubagentBlocks(
  source: readonly Block[],
  subagents: readonly SubagentBlock[],
): Block[] {
  if (subagents.length === 0) return source.filter((block) => block.kind !== 'subagent');
  const sorted = [...subagents].sort(compareSubagentTimeline);
  const byParentTool = new Map<string, SubagentBlock[]>();
  for (const subagent of sorted) {
    const aliases = new Set(
      [subagent.parentToolCallId, subagent.parentToolCallUuid].filter(
        (alias): alias is string => alias !== undefined,
      ),
    );
    for (const alias of aliases) {
      const siblings = byParentTool.get(alias) ?? [];
      siblings.push(subagent);
      byParentTool.set(alias, siblings);
    }
  }

  const inserted = new Set<string>();
  const blocks: Block[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const candidate = source[index]!;
    if (candidate.kind === 'subagent') continue;
    if (candidate.kind === 'tool') {
      const anchored = byParentTool.get(candidate.toolCallId);
      if (anchored !== undefined) {
        for (const subagent of anchored) {
          const parentTurnId = nearestParentTurn(source, subagent, index);
          blocks.push(parentTurnId === undefined ? subagent : { ...subagent, parentTurnId });
          inserted.add(subagent.subagentId);
        }
        continue;
      }
    }
    blocks.push(candidate);
  }

  for (const subagent of sorted) {
    if (inserted.has(subagent.subagentId)) continue;
    const parentTurnId = nearestParentTurn(blocks, subagent);
    insertSubagentByTimeline(
      blocks,
      parentTurnId === undefined ? subagent : { ...subagent, parentTurnId },
    );
  }
  return blocks;
}

function mergeCapturedTranscript(
  fresh: readonly Block[],
  captured: readonly Block[],
): readonly Block[] {
  if (fresh === captured) return fresh;
  if (fresh.length === 0) return captured;
  if (captured.length === 0) return fresh;
  return pairTranscriptBlocks(fresh, captured) as Block[];
}

export function applySnapshot(
  sessionId: string,
  snapshot: KikiSessionSnapshot,
  previous?: SessionViewState,
): SessionViewState {
  let blocks = messagesToBlocks(snapshot.messages.items, previous?.blocks);
  for (const prior of previous?.blocks ?? []) {
    if (
      prior.kind !== 'user' ||
      (prior.promptStatus !== 'running' && prior.promptStatus !== 'queued')
    ) {
      continue;
    }
    const identity = {
      userMessageId: prior.userMessageId,
      promptId: prior.promptId,
      messageId: prior.id.replace(/^user-/, ''),
    } satisfies UserBlockIdentity;
    if (findUserBlock(blocks, identity) !== undefined) continue;
    const priorAt = blockTimelineMs(prior);
    const insertionIndex =
      priorAt === undefined
        ? -1
        : blocks.findIndex((candidate) => (blockTimelineMs(candidate) ?? priorAt) > priorAt);
    if (insertionIndex < 0) blocks.push(prior);
    else blocks.splice(insertionIndex, 0, prior);
  }

  const inFlight = snapshot.in_flight_turn;
  if (inFlight !== null) {
    if (inFlight.thinking_text !== '') {
      blocks.push({
        kind: 'thinking',
        id: `thinking-live-${inFlight.turn_id}`,
        text: inFlight.thinking_text,
        streaming: true,
        createdAt: undefined,
        turnId: String(inFlight.turn_id),
      });
    }
    if (inFlight.assistant_text !== '') {
      blocks.push({
        kind: 'assistant',
        id: `assistant-live-${inFlight.turn_id}`,
        text: inFlight.assistant_text,
        streaming: true,
        createdAt: undefined,
        turnId: String(inFlight.turn_id),
      });
    }
    for (const tool of inFlight.running_tools) {
      blocks.push({
        kind: 'tool',
        id: `tool-${tool.tool_call_id}`,
        toolCallId: tool.tool_call_id,
        name: tool.name,
        argsText: '',
        args: tool.args,
        display: tool.display as ToolInputDisplay | undefined,
        description: tool.description,
        status: 'running',
        output: undefined,
        isError: undefined,
        startedAt: Date.now(),
        durationMs: undefined,
        progressText: tool.last_progress?.text,
      });
    }
  }

  const restoredSubagents = (snapshot.subagents ?? []) as readonly RestoredSnapshotSubagent[];
  const previousSubagents = new Map(
    (previous?.blocks ?? [])
      .filter((block): block is SubagentBlock => block.kind === 'subagent')
      .map((block) => [block.subagentId, block]),
  );
  const restoredBlocks: SubagentBlock[] = [];
  for (const subagent of restoredSubagents) {
    const status =
      subagent.subagent_phase === 'failed' || subagent.status === 'failed'
        ? 'failed'
        : subagent.subagent_phase === 'suspended'
          ? 'suspended'
          : subagent.subagent_phase === 'completed' || subagent.status === 'completed'
            ? 'completed'
            : 'running';
    const prior = previousSubagents.get(subagent.id);
    restoredBlocks.push({
      kind: 'subagent',
      id: `subagent-${subagent.id}`,
      subagentId: subagent.id,
      parentAgentId: subagent.parent_agent_id,
      parentToolCallId: subagent.parent_tool_call_id,
      parentToolCallUuid: subagent.parent_tool_call_uuid ?? prior?.parentToolCallUuid,
      parentTurnId: prior?.parentTurnId,
      name: subagent.subagent_type ?? subagent.description,
      label: subagent.label,
      description: subagent.description,
      model: subagent.model,
      thinkingEffort: subagent.thinking_effort,
      status,
      summary: subagent.output_preview,
      error: subagent.suspended_reason,
      startedAt: subagent.started_at ?? subagent.created_at,
      endedAt: subagent.completed_at,
      toolCallCount: subagent.tool_call_count ?? 0,
      transcript: mergeCapturedTranscript([], prior?.transcript ?? []),
    });
  }
  blocks = insertSubagentBlocks(blocks, restoredBlocks);

  for (const approval of snapshot.pending_approvals) {
    blocks.push(approvalBlock(approval));
  }
  for (const question of snapshot.pending_questions) {
    blocks.push(questionBlock(question));
  }

  // Todos ride todo_list tool payloads; recover the latest list from history
  // (live events refine it from here on).
  let todos: readonly TodoItem[] = [];
  for (const message of snapshot.messages.items) {
    for (const part of message.content) {
      if (part.type === 'tool_result') {
        const found = extractTodosFromOutput(part.output);
        if (found !== undefined) todos = found;
      } else if (part.type === 'tool_use') {
        const found = extractTodosFromInput(part.input);
        if (found !== undefined) todos = found;
      }
    }
  }

  const base = createViewState(sessionId);
  return {
    ...base,
    version: 1,
    session: snapshot.session,
    blocks,
    cursor: { seq: snapshot.as_of_seq, epoch: snapshot.epoch },
    busy: snapshot.session.busy,
    pendingInteraction: snapshot.session.pending_interaction ?? 'none',
    activePromptId: inFlight?.current_prompt_id,
    model:
      snapshot.session.agent_config.model !== ''
        ? snapshot.session.agent_config.model
        : undefined,
    permissionMode: snapshot.session.agent_config.permission_mode,
    planMode: snapshot.session.agent_config.plan_mode ?? false,
    swarmMode: snapshot.session.agent_config.swarm_mode ?? false,
    contextTokens: snapshot.context_tokens,
    maxContextTokens: snapshot.max_context_tokens,
    contextBreakdown:
      snapshot.context_breakdown === undefined
        ? undefined
        : {
            systemTokens: snapshot.context_breakdown.system_tokens,
            toolsTokens: snapshot.context_breakdown.tools_tokens,
            messagesTokens: snapshot.context_breakdown.messages_tokens,
            estimated: true,
          },
    loaded: true,
    loadError: undefined,
    resyncFailed: false,
    resyncAttempt: 0,
    todos,
    hasMoreHistory: snapshot.messages.has_more,
    oldestMessageId: snapshot.messages.items[0]?.id,
  };
}

/**
 * Prepend an older messages page (from `GET /sessions/{id}/messages
 * ?before_id=oldest`). The server returns pages newest-first; we reverse them
 * to restore oldest-first reading order before prepending. The new
 * `oldestMessageId` is the oldest message now loaded (the last item of the
 * reversed page), which becomes the next `before_id` cursor.
 */
export function prependOlderMessages(
  state: SessionViewState,
  messages: readonly Message[],
  hasMore: boolean,
): SessionViewState {
  if (messages.length === 0) {
    return {
      ...state,
      version: state.version + 1,
      loadingOlder: false,
      fetchedOlder: true,
      hasMoreHistory: false,
      olderError: undefined,
    };
  }
  const oldestFirst = messages.toReversed();
  const olderBlocks = messagesToBlocks(oldestFirst);
  return {
    ...state,
    version: state.version + 1,
    blocks: [...olderBlocks, ...state.blocks],
    oldestMessageId: oldestFirst[0]?.id ?? state.oldestMessageId,
    hasMoreHistory: hasMore,
    loadingOlder: false,
    fetchedOlder: true,
    olderError: undefined,
  };
}

export function setLoadingOlder(state: SessionViewState, loading: boolean): SessionViewState {
  const olderError = loading ? undefined : state.olderError;
  if (state.loadingOlder === loading && state.olderError === olderError) return state;
  return { ...state, version: state.version + 1, loadingOlder: loading, olderError };
}

/** Todo extraction from a TodoWrite-style tool input ({todos:[...]}). */
function extractTodosFromInput(input: unknown): readonly TodoItem[] | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const list = (input as { todos?: unknown }).todos;
  if (!Array.isArray(list)) return undefined;
  const items: TodoItem[] = [];
  for (const raw of list as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as { title?: unknown; content?: unknown; status?: unknown };
    const title = typeof entry.title === 'string' ? entry.title : entry.content;
    if (typeof title === 'string' && typeof entry.status === 'string') {
      items.push({ title, status: entry.status });
    }
  }
  return items.length > 0 ? items : undefined;
}

function approvalBlock(request: ApprovalRequest, originAgentId?: string): ApprovalBlock {
  return {
    kind: 'approval',
    id: `approval-${request.approval_id}`,
    request,
    resolution: undefined,
    originAgentId,
  };
}

function questionBlock(request: QuestionRequest, originAgentId?: string): QuestionBlock {
  return {
    kind: 'question',
    id: `question-${request.question_id}`,
    request,
    outcome: undefined,
    originAgentId,
  };
}

// ---------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------

let noticeCounter = 0;
function nextNoticeId(prefix: string): string {
  noticeCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${noticeCounter}`;
}

interface DeltaResult {
  readonly text: string;
  readonly gap: boolean;
}

/** Cumulative-offset delta application (see file header). */
export function applyDelta(local: string, delta: string, offset: number | undefined): DeltaResult {
  if (offset === undefined) return { text: local + delta, gap: false };
  if (offset > local.length) return { text: local, gap: true };
  return { text: local.slice(0, offset) + delta, gap: false };
}

export interface ApplyResult {
  readonly state: SessionViewState;
  /** True when a volatile-delta gap was detected — caller should resync. */
  readonly gapDetected: boolean;
}

function replaceBlock(blocks: readonly Block[], updated: Block): Block[] {
  const index = blocks.findIndex((b) => b.id === updated.id);
  if (index < 0) return [...blocks, updated];
  const next = blocks.slice();
  next[index] = updated;
  return next;
}

/**
 * Mark still-streaming text blocks as final at a step/turn boundary AND
 * rename their live ids (`assistant-live-<turn>` → `…-final-<tag>`). The
 * rename matters: volatile offsets reset at every step boundary, so deltas
 * for the next step must start a FRESH block — with the old id kept, the
 * first post-boundary delta (offset 0) would rewrite the finalized text.
 * The tag carries the durable frame's seq because turn ids may repeat across
 * a session (per-agent counters), and React keys must stay unique.
 */
function finalizeStreaming(blocks: readonly Block[], tag: string): Block[] {
  let changed = false;
  const next = blocks.map((block) => {
    if ((block.kind === 'assistant' || block.kind === 'thinking') && block.streaming) {
      changed = true;
      return { ...block, streaming: false, id: `${block.id}-final-${tag}` };
    }
    return block;
  });
  return changed ? next : (blocks as Block[]);
}

function extractTodosFromDisplay(display: ToolInputDisplay): readonly TodoItem[] | undefined {
  if (display.kind === 'todo_list') return display.items;
  return undefined;
}

function extractTodosFromOutput(output: unknown): readonly TodoItem[] | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const candidate = output as { kind?: unknown; items?: unknown };
  if (candidate.kind !== 'todo_list' || !Array.isArray(candidate.items)) return undefined;
  const items: TodoItem[] = [];
  for (const raw of candidate.items as unknown[]) {
    if (typeof raw === 'object' && raw !== null) {
      const item = raw as { title?: unknown; status?: unknown };
      if (typeof item.title === 'string' && typeof item.status === 'string') {
        items.push({ title: item.title, status: item.status });
      }
    }
  }
  return items;
}

function taskInfoToTask(info: TaskInfo, sessionId: string): Task {
  return {
    id: info.taskId,
    session_id: sessionId,
    kind: info.kind === 'agent' ? 'subagent' : info.kind === 'process' ? 'bash' : 'tool',
    description: info.description,
    status:
      info.status === 'running'
        ? 'running'
        : info.status === 'completed'
          ? 'completed'
          : info.status === 'killed'
            ? 'cancelled'
            : 'failed',
    created_at: new Date(info.startedAt).toISOString(),
    started_at: new Date(info.startedAt).toISOString(),
    completed_at: info.endedAt !== null ? new Date(info.endedAt).toISOString() : undefined,
  };
}

function isSubagentLifecycle(type: string): boolean {
  return type.startsWith('subagent.');
}

function createUnknownSubagent(agentId: string, timestamp: string): SubagentBlock {
  return {
    kind: 'subagent',
    id: `subagent-${agentId}`,
    subagentId: agentId,
    parentAgentId: undefined,
    parentToolCallId: undefined,
    name: agentId,
    label: undefined,
    description: undefined,
    model: undefined,
    thinkingEffort: undefined,
    status: 'running',
    summary: undefined,
    error: undefined,
    startedAt: timestamp,
    endedAt: undefined,
    toolCallCount: 0,
    transcript: [],
  };
}

function isPromptIdentity(block: Block, promptId: string, userMessageId?: string): boolean {
  if (block.kind === 'user' || block.kind === 'steer') {
    return block.promptId === promptId || (userMessageId !== undefined && block.userMessageId === userMessageId);
  }
  return false;
}

function userBlockToSteer(
  block: UserBlock,
  input: { activePromptId: string; steeredAt: string },
): SteerBlock {
  return {
    kind: 'steer',
    id: `steer-${block.promptId ?? block.userMessageId ?? block.id}`,
    text: block.text,
    createdAt: input.steeredAt || block.createdAt,
    promptId: block.promptId,
    userMessageId: block.userMessageId,
    activePromptId: input.activePromptId,
  };
}

function insertSteersAtTurnAnchor(
  blocks: readonly Block[],
  steers: readonly SteerBlock[],
  activePromptId: string | undefined,
): Block[] {
  if (steers.length === 0) return blocks as Block[];
  const activeIndex =
    activePromptId === undefined
      ? -1
      : blocks.findIndex((block) => block.kind === 'user' && block.promptId === activePromptId);
  let insertAt = activeIndex >= 0 ? activeIndex + 1 : blocks.length;
  while (
    insertAt < blocks.length &&
    (blocks[insertAt]!.kind === 'system-reminder' ||
      blocks[insertAt]!.kind === 'system' ||
      blocks[insertAt]!.kind === 'skill' ||
      blocks[insertAt]!.kind === 'steer')
  ) {
    insertAt += 1;
  }
  if (activeIndex < 0) {
    while (
      insertAt > 0 &&
      blocks[insertAt - 1]!.kind === 'user' &&
      (blocks[insertAt - 1] as UserBlock).promptStatus === 'queued'
    ) {
      insertAt -= 1;
    }
  }
  return [...blocks.slice(0, insertAt), ...steers, ...blocks.slice(insertAt)];
}

function applySteerToBlocks(
  blocks: readonly Block[],
  input: {
    promptIds: readonly string[];
    activePromptId: string;
    content: string;
    steeredAt: string;
  },
): readonly Block[] {
  const remaining = new Set(input.promptIds);
  const converted: SteerBlock[] = [];
  const kept: Block[] = [];
  for (const block of blocks) {
    if (block.kind === 'steer' && block.promptId !== undefined && remaining.has(block.promptId)) {
      converted.push({
        ...block,
        activePromptId: input.activePromptId,
        createdAt: input.steeredAt || block.createdAt,
      });
      remaining.delete(block.promptId);
      continue;
    }
    if (block.kind === 'user' && block.promptId !== undefined && remaining.has(block.promptId)) {
      converted.push(userBlockToSteer(block, input));
      remaining.delete(block.promptId);
      continue;
    }
    kept.push(block);
  }
  if (remaining.size > 0) {
    const classified = classifyTranscriptText({
      text: input.content,
      role: 'user',
      origin: { kind: 'user' },
    });
    for (const promptId of remaining) {
      converted.push({
        kind: 'steer',
        id: `steer-${promptId}`,
        text: classified.text,
        createdAt: input.steeredAt,
        promptId,
        activePromptId: input.activePromptId,
      });
    }
  }
  return insertSteersAtTurnAnchor(kept, converted, input.activePromptId);
}

/** Snapshot/resync rebuilds steered prompts as ordinary user messages. Keep the
 * in-turn steer identity so they do not jump back to a tail You bubble. */
export function preserveCapturedSteers(
  rebuilt: SessionViewState,
  previous: SessionViewState,
): SessionViewState {
  const prior = previous.blocks.filter((block): block is SteerBlock => block.kind === 'steer');
  if (prior.length === 0) return rebuilt;
  const byPromptId = new Map<string, SteerBlock>();
  const byUserMessageId = new Map<string, SteerBlock>();
  for (const block of prior) {
    if (block.promptId !== undefined) byPromptId.set(block.promptId, block);
    if (block.userMessageId !== undefined) byUserMessageId.set(block.userMessageId, block);
  }
  const used = new Set<SteerBlock>();
  const converted: SteerBlock[] = [];
  const kept: Block[] = [];
  for (const block of rebuilt.blocks) {
    if (block.kind !== 'user') {
      kept.push(block);
      continue;
    }
    const match =
      (block.promptId !== undefined ? byPromptId.get(block.promptId) : undefined) ??
      (block.userMessageId !== undefined ? byUserMessageId.get(block.userMessageId) : undefined);
    if (match === undefined || used.has(match)) {
      kept.push(block);
      continue;
    }
    used.add(match);
    converted.push({
      kind: 'steer',
      id: match.id,
      text: block.text,
      createdAt: match.createdAt,
      promptId: block.promptId ?? match.promptId,
      userMessageId: block.userMessageId ?? match.userMessageId,
      activePromptId: match.activePromptId,
    });
  }
  if (converted.length === 0) return rebuilt;
  const activePromptId =
    converted.find((block) => block.activePromptId !== undefined)?.activePromptId ??
    previous.activePromptId ??
    rebuilt.activePromptId;
  return {
    ...rebuilt,
    version: rebuilt.version + 1,
    blocks: insertSteersAtTurnAnchor(kept, converted, activePromptId),
  };
}

function upsertPromptItemBlocks(
  blocks: readonly Block[],
  item: PromptItem,
): readonly Block[] {
  const text = textOfContent(item.content);
  if (blocks.some((block) => block.kind === 'steer' && isPromptIdentity(block, item.prompt_id, item.user_message_id))) {
    return blocks;
  }
  const stableIndex = blocks.findIndex(
    (block): block is UserBlock =>
      block.kind === 'user' &&
      (block.userMessageId === item.user_message_id || block.promptId === item.prompt_id),
  );
  if (stableIndex >= 0) {
    const existing = blocks[stableIndex] as UserBlock;
    if (existing.promptStatus === item.status) return blocks;
    const next = blocks.slice();
    next[stableIndex] = { ...existing, promptStatus: item.status };
    return next;
  }
  const split = splitSystemReminders(text);
  // Only a running prompt can own a turn.started placeholder. A queued local
  // echo has no turn yet and must append at the current tail; matching an old
  // anonymous same-text turn would otherwise rewrite that historical block
  // in place, making the just-sent message appear near the transcript start.
  // Search from the tail so a current placeholder wins over any older repeat.
  const placeholderIndex =
    item.status === 'running'
      ? blocks.findLastIndex(
          (block): block is UserBlock =>
            block.kind === 'user' &&
            block.userMessageId === undefined &&
            block.promptId === undefined &&
            block.text === split.text,
        )
      : -1;
  const additions = userAndReminderBlocks({
    id: item.user_message_id,
    text,
    createdAt: item.created_at,
    promptId: item.prompt_id,
    userMessageId: item.user_message_id,
    promptStatus: item.status,
  });
  if (placeholderIndex >= 0 && additions[0]?.kind === 'user') {
    const next = blocks.slice();
    next.splice(placeholderIndex, 1, ...additions);
    return next;
  }
  return additions.length === 0 ? blocks : [...blocks, ...additions];
}

export function applyFrame(state: SessionViewState, frame: SessionEventFrame): ApplyResult {
  return applyFrameInternal(state, frame, true);
}

/** Child-agent scoped reducer used by SessionController's per-agent store. */
export function applyAgentFrame(state: SessionViewState, frame: SessionEventFrame): ApplyResult {
  return applyFrameInternal(state, frame, false);
}

function applyFrameInternal(
  state: SessionViewState,
  frame: SessionEventFrame,
  routeSubagentEvents: boolean,
): ApplyResult {
  const payload = frame.payload;
  let next = state;
  let gap = false;

  const evolve = (partial: Partial<SessionViewState>) => {
    next = { ...next, ...partial, version: next.version + 1 };
  };

  /** Frame wall-clock in epoch ms (NaN-safe fallback to the local clock). */
  const frameMs = (): number => {
    const ms = Date.parse(frame.timestamp);
    return Number.isNaN(ms) ? Date.now() : ms;
  };

  // Durable frames advance the cursor; duplicates (replay overlap) are dropped.
  const durable = frame.volatile !== true;
  if (durable) {
    if (frame.seq <= state.cursor.seq) return { state, gapDetected: false };
    const epoch = frame.epoch ?? state.cursor.epoch;
    next = {
      ...next,
      cursor: { seq: frame.seq, epoch },
      version: next.version + 1,
    };
  }

  const emittingAgentId = (payload as { agentId?: string }).agentId;
  if (
    routeSubagentEvents &&
    emittingAgentId !== undefined &&
    emittingAgentId !== 'main' &&
    !isSubagentLifecycle(payload.type) &&
    // Interaction events (approval/question) are session-scoped: a subagent's
    // request must surface as an actionable card in the main transcript, not
    // vanish into the child capture. The controller additionally applies them
    // to the child's sub-store so the agent page carries them too.
    !isInteractionEvent(payload)
  ) {
    const key = `subagent-${emittingAgentId}`;
    const existing =
      (next.blocks.find((block) => block.id === key) as SubagentBlock | undefined) ??
      createUnknownSubagent(emittingAgentId, frame.timestamp);
    const childState: SessionViewState = {
      ...createViewState(next.sessionId),
      loaded: true,
      blocks: existing.transcript,
      cursor: durable
        ? { seq: Math.max(0, frame.seq - 1), epoch: frame.epoch }
        : { seq: 0, epoch: frame.epoch },
    };
    const childResult = applyFrameInternal(childState, frame, false);
    const countedTool =
      payload.type === 'tool.call.started' &&
      !existing.transcript.some(
        (block) => block.kind === 'tool' && block.toolCallId === payload.toolCallId,
      );
    const updated: SubagentBlock = {
      ...existing,
      transcript: childResult.state.blocks,
      toolCallCount: existing.toolCallCount + (countedTool ? 1 : 0),
    };
    return {
      state: {
        ...next,
        version: next.version + 1,
        blocks: replaceBlock(next.blocks, updated),
      },
      gapDetected: childResult.gapDetected,
    };
  }

  // Intentional partial router: the reducer handles the event kinds that
  // mutate transcript blocks; the default case ignores the rest.
  // eslint-disable-next-line typescript/switch-exhaustiveness-check
  switch (payload.type) {
    case 'assistant.delta': {
      const key = `assistant-live-${payload.turnId}`;
      const existing = next.blocks.find((b) => b.id === key) as AssistantBlock | undefined;
      const result = applyDelta(existing?.text ?? '', payload.delta, frame.offset);
      if (result.gap) {
        gap = true;
        break;
      }
      const block: AssistantBlock = {
        kind: 'assistant',
        id: key,
        text: result.text,
        streaming: true,
        createdAt: existing?.createdAt ?? frame.timestamp,
        turnId: String(payload.turnId),
      };
      evolve({
        blocks: replaceBlock(next.blocks, block),
        turnFirstTokenAt: next.turnFirstTokenAt ?? frameMs(),
      });
      break;
    }
    case 'thinking.delta': {
      const key = `thinking-live-${payload.turnId}`;
      const existing = next.blocks.find((b) => b.id === key) as ThinkingBlock | undefined;
      const result = applyDelta(existing?.text ?? '', payload.delta, frame.offset);
      if (result.gap) {
        gap = true;
        break;
      }
      const block: ThinkingBlock = {
        kind: 'thinking',
        id: key,
        text: result.text,
        streaming: true,
        createdAt: existing?.createdAt ?? frame.timestamp,
        turnId: String(payload.turnId),
      };
      evolve({
        blocks: replaceBlock(next.blocks, block),
        turnFirstTokenAt: next.turnFirstTokenAt ?? frameMs(),
      });
      break;
    }
    case 'turn.started': {
      // v2 publishes this before the prompt REST reply and currently does not
      // publish prompt.submitted. Create an unidentified placeholder only when
      // no user block already carries this prompt's text. The match is
      // deliberately status-agnostic: a queued echo may have had its chip
      // cleared by an empty prompt-list reconcile (e.g. the queued prompt ran
      // and finished before any refresh observed it), and an older same-text
      // block suppressing the placeholder is harmless — the REST echo (or the
      // next reconcile) still appends/updates the identified block.
      if (typeof payload.prompt === 'string' && payload.prompt.trim() !== '') {
        const origin = payload.origin as PromptOriginLike | undefined;
        const classified = classifyTranscriptText({
          text: payload.prompt,
          role: 'user',
          origin,
          subagentPromptAsUser: !routeSubagentEvents,
        });
        const additions = classifiedTextToBlocks({
          id: `turn-${payload.turnId}-prompt`,
          classified,
          createdAt: frame.timestamp,
          turnId: String(payload.turnId),
        });
        const exists = additions.some((block) => next.blocks.some((existing) => existing.id === block.id));
        const associatedByPromptId =
          next.activePromptId !== undefined &&
          next.blocks.some(
            (block): block is UserBlock =>
              block.kind === 'user' && block.promptId === next.activePromptId,
          );
        const promptText = classified.text;
        const echoedAlready = next.blocks.some(
          (block): block is UserBlock => block.kind === 'user' && block.text === promptText,
        );
        if (!exists && !associatedByPromptId && !echoedAlready && additions.length > 0) {
          evolve({ blocks: [...next.blocks, ...additions] });
        }
      }
      evolve({
        busy: true,
        turnStartedAt: frameMs(),
        turnFirstTokenAt: undefined,
        turnTail: undefined,
      });
      break;
    }
    case 'turn.step.started':
    case 'turn.ended': {
      let blocks = finalizeStreaming(
        next.blocks,
        payload.type === 'turn.step.started' ? `s${payload.step}@${frame.seq}` : `end@${frame.seq}`,
      );
      if (payload.type === 'turn.ended') {
        if (payload.reason === 'cancelled') {
          // Interrupted turn: the LAST assistant message of the turn carries
          // the stopped marker; still-running tools flip to the stopped state.
          const cancelledTurnId = String(payload.turnId);
          let lastAssistant = -1;
          blocks.forEach((block, index) => {
            if (
              block.kind === 'assistant' &&
              (block.turnId === cancelledTurnId || block.id === `assistant-live-${payload.turnId}`)
            ) {
              lastAssistant = index;
            }
          });
          blocks = blocks.map((block, index) => {
            if (index === lastAssistant) return { ...block, stopped: true } as typeof block;
            if (block.kind === 'tool' && block.status === 'running') {
              return { ...block, status: 'stopped' as const };
            }
            return block;
          });
        }
        if (payload.reason === 'failed') {
          blocks = [
            ...blocks,
            {
              kind: 'notice',
              id: nextNoticeId('turn-failed'),
              text: payload.error?.message ?? 'Turn failed',
              tone: 'danger' as const,
              // A server message is already final copy; only the bare
              // fallback gets a localized rendering.
              i18n: payload.error?.message === undefined ? { key: 'notice.turnFailed' } : undefined,
            },
          ];
        }
        const endedAt = frameMs();
        evolve({
          blocks,
          busy: false,
          activePromptId: undefined,
          turnTail: {
            turnId: String(payload.turnId),
            endedAt: frame.timestamp,
            durationMs:
              payload.durationMs ??
              (next.turnStartedAt !== undefined
                ? Math.max(0, endedAt - next.turnStartedAt)
                : undefined),
            ttftMs:
              next.turnStartedAt !== undefined && next.turnFirstTokenAt !== undefined
                ? Math.max(0, next.turnFirstTokenAt - next.turnStartedAt)
                : undefined,
            usage: payload.usage,
            tokensPerSecond: payload.tokensPerSecond,
          },
          turnStartedAt: undefined,
          turnFirstTokenAt: undefined,
        });
      } else {
        evolve({ blocks });
      }
      break;
    }
    case 'tool.call.delta': {
      const key = `tool-${payload.toolCallId}`;
      const existing = next.blocks.find((b) => b.id === key) as ToolBlock | undefined;
      const block: ToolBlock = {
        kind: 'tool',
        id: key,
        toolCallId: payload.toolCallId,
        name: payload.name ?? existing?.name ?? 'tool',
        argsText: (existing?.argsText ?? '') + (payload.argumentsPart ?? ''),
        args: existing?.args,
        display: existing?.display,
        description: existing?.description,
        status: 'running',
        output: undefined,
        isError: undefined,
        startedAt: existing?.startedAt ?? Date.now(),
        durationMs: undefined,
        progressText: existing?.progressText,
      };
      evolve({ blocks: replaceBlock(next.blocks, block) });
      break;
    }
    case 'tool.call.started': {
      const key = `tool-${payload.toolCallId}`;
      const existing = next.blocks.find((b) => b.id === key) as ToolBlock | undefined;
      const block: ToolBlock = {
        kind: 'tool',
        id: key,
        toolCallId: payload.toolCallId,
        name: payload.name,
        argsText: existing?.argsText ?? '',
        args: payload.args,
        display: payload.display,
        description: payload.description,
        status: 'running',
        output: undefined,
        isError: undefined,
        startedAt: Date.now(),
        durationMs: undefined,
        progressText: existing?.progressText,
      };
      const todos =
        payload.display !== undefined ? extractTodosFromDisplay(payload.display) : undefined;
      evolve({
        blocks: replaceBlock(next.blocks, block),
        ...(todos !== undefined ? { todos } : {}),
      });
      break;
    }
    case 'tool.progress': {
      const key = `tool-${payload.toolCallId}`;
      const existing = next.blocks.find((b) => b.id === key) as ToolBlock | undefined;
      if (existing === undefined) break;
      const text = payload.update.text;
      evolve({
        blocks: replaceBlock(next.blocks, {
          ...existing,
          progressText: text ?? existing.progressText,
        }),
      });
      break;
    }
    case 'tool.result': {
      const key = `tool-${payload.toolCallId}`;
      const existing = next.blocks.find((b) => b.id === key) as ToolBlock | undefined;
      if (existing === undefined) break;
      const todos = extractTodosFromOutput(payload.output);
      evolve({
        blocks: replaceBlock(next.blocks, {
          ...existing,
          status: payload.isError === true ? 'error' : 'done',
          output: payload.output,
          isError: payload.isError,
          durationMs: existing.startedAt > 0 ? Date.now() - existing.startedAt : undefined,
        }),
        ...(todos !== undefined ? { todos } : {}),
      });
      break;
    }
    case 'shell.started': {
      const block: ShellBlock = {
        kind: 'shell',
        id: `shell-${payload.commandId}`,
        commandId: payload.commandId,
        output: '',
        done: false,
        isError: undefined,
      };
      evolve({ blocks: replaceBlock(next.blocks, block) });
      break;
    }
    case 'shell.output': {
      const key = `shell-${payload.commandId}`;
      const existing = next.blocks.find((b) => b.id === key) as ShellBlock | undefined;
      const text = payload.update.text ?? '';
      const block: ShellBlock = {
        kind: 'shell',
        id: key,
        commandId: payload.commandId,
        output: (existing?.output ?? '') + text,
        done: false,
        isError: undefined,
      };
      evolve({ blocks: replaceBlock(next.blocks, block) });
      break;
    }
    case 'shell.completed': {
      const key = `shell-${payload.commandId}`;
      const existing = next.blocks.find((b) => b.id === key) as ShellBlock | undefined;
      if (existing === undefined) break;
      evolve({
        blocks: replaceBlock(next.blocks, { ...existing, done: true, isError: payload.isError }),
      });
      break;
    }
    case 'subagent.spawned': {
      const key = `subagent-${payload.subagentId}`;
      const existing = next.blocks.find((block) => block.id === key) as SubagentBlock | undefined;
      const block: SubagentBlock = {
        kind: 'subagent',
        id: key,
        subagentId: payload.subagentId,
        parentAgentId: payload.parentAgentId ?? existing?.parentAgentId,
        parentToolCallId: payload.parentToolCallId,
        parentToolCallUuid: payload.parentToolCallUuid ?? existing?.parentToolCallUuid,
        parentTurnId: existing?.parentTurnId,
        name: payload.subagentName,
        label: existing?.label,
        description: payload.description,
        model: payload.model,
        thinkingEffort: payload.thinkingEffort,
        status: 'running',
        summary: existing?.summary,
        error: undefined,
        startedAt: existing?.startedAt ?? frame.timestamp,
        endedAt: undefined,
        toolCallCount: existing?.toolCallCount ?? 0,
        transcript: existing?.transcript ?? [],
      };
      const subagents = next.blocks.filter(
        (candidate): candidate is SubagentBlock =>
          candidate.kind === 'subagent' && candidate.subagentId !== payload.subagentId,
      );
      evolve({ blocks: insertSubagentBlocks(next.blocks, [...subagents, block]) });
      break;
    }
    case 'subagent.started': {
      const key = `subagent-${payload.subagentId}`;
      const existing = next.blocks.find((b) => b.id === key) as SubagentBlock | undefined;
      if (existing === undefined) break;
      evolve({
        blocks: replaceBlock(next.blocks, {
          ...existing,
          status: 'running',
          startedAt: existing.startedAt || frame.timestamp,
        }),
      });
      break;
    }
    case 'subagent.suspended': {
      const key = `subagent-${payload.subagentId}`;
      const existing = next.blocks.find((b) => b.id === key) as SubagentBlock | undefined;
      if (existing === undefined) break;
      evolve({
        blocks: replaceBlock(next.blocks, { ...existing, status: 'suspended', error: payload.reason }),
      });
      break;
    }
    case 'subagent.completed': {
      const key = `subagent-${payload.subagentId}`;
      const existing = next.blocks.find((b) => b.id === key) as SubagentBlock | undefined;
      if (existing === undefined) break;
      evolve({
        blocks: replaceBlock(next.blocks, {
          ...existing,
          status: 'completed',
          summary: payload.resultSummary,
          endedAt: frame.timestamp,
        }),
      });
      break;
    }
    case 'subagent.failed': {
      const key = `subagent-${payload.subagentId}`;
      const existing = next.blocks.find((b) => b.id === key) as SubagentBlock | undefined;
      if (existing === undefined) break;
      evolve({
        blocks: replaceBlock(next.blocks, {
          ...existing,
          status: 'failed',
          error: payload.error,
          endedAt: frame.timestamp,
        }),
      });
      break;
    }
    case 'compaction.started': {
      const notice: NoticeBlock = {
        kind: 'notice',
        id: nextNoticeId('compaction'),
        text: 'Compacting context…',
        tone: 'neutral',
        i18n: { key: 'notice.compacting' },
      };
      evolve({ blocks: [...next.blocks, notice] });
      break;
    }
    case 'compaction.completed': {
      const params = {
        before: payload.result.tokensBefore.toLocaleString(),
        after: payload.result.tokensAfter.toLocaleString(),
      };
      const notice: NoticeBlock = {
        kind: 'notice',
        id: nextNoticeId('compaction'),
        text: `Context compacted — ${params.before} → ${params.after} tokens`,
        tone: 'neutral',
        i18n: { key: 'notice.compacted', params },
      };
      evolve({ blocks: [...next.blocks, notice] });
      break;
    }
    case 'prompt.submitted': {
      const item: PromptItem = {
        prompt_id: payload.promptId,
        user_message_id: payload.userMessageId,
        status: payload.status,
        content: payload.content as Message['content'],
        created_at: payload.createdAt,
      };
      const queued =
        item.status === 'queued'
          ? next.queuedPromptIds.includes(item.prompt_id)
            ? next.queuedPromptIds
            : [...next.queuedPromptIds, item.prompt_id]
          : next.queuedPromptIds.filter((id) => id !== item.prompt_id);
      evolve({
        blocks: upsertPromptItemBlocks(next.blocks, item),
        queuedPromptIds: queued,
        busy: item.status === 'running' ? true : next.busy,
        activePromptId: item.status === 'running' ? item.prompt_id : next.activePromptId,
      });
      break;
    }
    case 'prompt.completed': {
      const blocks = finalizeStreaming(next.blocks, `end@${frame.seq}`).map((block) =>
        block.kind === 'user' && block.promptId === payload.promptId
          ? { ...block, promptStatus: payload.reason === 'blocked' ? ('blocked' as const) : undefined }
          : block,
      );
      const failed = payload.reason === 'failed' || payload.reason === 'blocked';
      evolve({
        blocks:
          payload.reason === undefined || payload.reason === 'completed'
            ? blocks
            : [
                ...blocks,
                {
                  kind: 'notice',
                  id: nextNoticeId('prompt'),
                  text: failed ? `Prompt ${payload.reason}` : 'Prompt finished',
                  tone: failed ? ('danger' as const) : ('neutral' as const),
                },
              ],
        busy: false,
        activePromptId:
          next.activePromptId === payload.promptId ? undefined : next.activePromptId,
        queuedPromptIds: next.queuedPromptIds.filter((id) => id !== payload.promptId),
      });
      break;
    }
    case 'prompt.steered': {
      const steered = applySteerToBlocks(next.blocks, {
        promptIds: payload.promptIds,
        activePromptId: payload.activePromptId,
        content: textOfContent(payload.content as Message['content']),
        steeredAt: payload.steeredAt,
      });
      evolve({
        blocks: steered,
        queuedPromptIds: next.queuedPromptIds.filter((id) => !payload.promptIds.includes(id)),
      });
      break;
    }
    case 'prompt.aborted': {
      const blocks = finalizeStreaming(next.blocks, `end@${frame.seq}`).map((block) =>
        block.kind === 'user' && block.promptId === payload.promptId
          ? { ...block, promptStatus: undefined }
          : block,
      );
      evolve({
        blocks: [
          ...blocks,
          {
            kind: 'notice',
            id: nextNoticeId('prompt'),
            text: 'Prompt aborted',
            tone: 'neutral' as const,
            i18n: { key: 'notice.promptAborted' },
          },
        ],
        busy: false,
        activePromptId:
          next.activePromptId === payload.promptId ? undefined : next.activePromptId,
        queuedPromptIds: next.queuedPromptIds.filter((id) => id !== payload.promptId),
      });
      break;
    }
    case 'agent.status.updated': {
      evolve({
        model: payload.model ?? next.model,
        thinkingEffort: payload.thinkingEffort ?? next.thinkingEffort,
        permissionMode: payload.permission ?? next.permissionMode,
        planMode: payload.planMode ?? next.planMode,
        swarmMode: payload.swarmMode ?? next.swarmMode,
        contextTokens: payload.contextTokens ?? next.contextTokens,
        maxContextTokens: payload.maxContextTokens ?? next.maxContextTokens,
        contextBreakdown: payload.contextBreakdown ?? next.contextBreakdown,
        usage: payload.usage ?? next.usage,
      });
      break;
    }
    case 'goal.updated': {
      evolve({ goal: payload.snapshot, goalUpdatedAt: frame.timestamp });
      break;
    }
    case 'event.session.work_changed': {
      const session =
        next.session !== undefined
          ? {
              ...next.session,
              busy: payload.busy,
              pending_interaction: payload.pending_interaction ?? next.session.pending_interaction,
            }
          : next.session;
      evolve({
        session,
        busy: payload.busy,
        pendingInteraction: payload.pending_interaction ?? 'none',
      });
      break;
    }
    case 'session.meta.updated': {
      if (next.session !== undefined && payload.title !== undefined) {
        evolve({ session: { ...next.session, title: payload.title } });
      }
      break;
    }
    case 'event.approval.requested': {
      const request: ApprovalRequest = {
        approval_id: payload.approval_id,
        session_id: payload.session_id,
        turn_id: payload.turn_id,
        tool_call_id: payload.tool_call_id,
        tool_name: payload.tool_name,
        action: payload.action,
        tool_input_display: payload.tool_input_display,
        created_at: payload.created_at,
        expires_at: payload.expires_at,
      };
      const exists = next.blocks.some((b) => b.id === `approval-${request.approval_id}`);
      evolve({
        blocks: exists
          ? next.blocks
          : [
              ...next.blocks,
              approvalBlock(
                request,
                emittingAgentId !== undefined && emittingAgentId !== 'main'
                  ? emittingAgentId
                  : undefined,
              ),
            ],
        pendingInteraction: 'approval',
      });
      break;
    }
    case 'event.approval.resolved': {
      const key = `approval-${payload.approval_id}`;
      const existing = next.blocks.find((b) => b.id === key) as ApprovalBlock | undefined;
      if (existing === undefined) break;
      const blocks = replaceBlock(next.blocks, {
        ...existing,
        resolution: {
          decision: payload.decision ?? 'resolved_elsewhere',
          resolvedAt: payload.resolved_at,
        },
      });
      evolve({
        blocks,
        pendingInteraction: derivePendingInteraction({ ...next, blocks }),
      });
      break;
    }
    case 'event.question.requested': {
      const request: QuestionRequest = {
        question_id: payload.question_id,
        session_id: payload.session_id,
        turn_id: payload.turn_id,
        tool_call_id: payload.tool_call_id,
        questions: payload.questions,
        created_at: payload.created_at,
      };
      const exists = next.blocks.some((b) => b.id === `question-${request.question_id}`);
      evolve({
        blocks: exists
          ? next.blocks
          : [
              ...next.blocks,
              questionBlock(
                request,
                emittingAgentId !== undefined && emittingAgentId !== 'main'
                  ? emittingAgentId
                  : undefined,
              ),
            ],
        pendingInteraction: 'question',
      });
      break;
    }
    case 'event.question.answered': {
      const key = `question-${payload.question_id}`;
      const existing = next.blocks.find((b) => b.id === key) as QuestionBlock | undefined;
      if (existing === undefined) break;
      const blocks = replaceBlock(next.blocks, {
        ...existing,
        outcome: { kind: 'answered', at: payload.resolved_at },
      });
      evolve({
        blocks,
        pendingInteraction: derivePendingInteraction({ ...next, blocks }),
      });
      break;
    }
    case 'event.question.dismissed': {
      const key = `question-${payload.question_id}`;
      const existing = next.blocks.find((b) => b.id === key) as QuestionBlock | undefined;
      if (existing === undefined) break;
      const blocks = replaceBlock(next.blocks, {
        ...existing,
        outcome: { kind: 'dismissed', at: payload.dismissed_at },
      });
      evolve({
        blocks,
        pendingInteraction: derivePendingInteraction({ ...next, blocks }),
      });
      break;
    }
    case 'task.started':
    case 'background.task.started': {
      const task = taskInfoToTask(payload.info, next.sessionId);
      const without = next.tasks.filter((t) => t.id !== task.id);
      evolve({ tasks: [...without, task] });
      break;
    }
    case 'task.terminated':
    case 'background.task.terminated': {
      const task = taskInfoToTask(payload.info, next.sessionId);
      const without = next.tasks.filter((t) => t.id !== task.id);
      evolve({ tasks: [...without, task] });
      break;
    }
    case 'error': {
      const notice: NoticeBlock = {
        kind: 'notice',
        id: nextNoticeId('error'),
        text: payload.message,
        tone: 'danger',
      };
      evolve({ blocks: [...next.blocks, notice] });
      break;
    }
    default:
      break;
  }

  return { state: next, gapDetected: gap };
}

/** Local echo of the user's own prompt (from the REST submit result). */
export function appendLocalUserMessage(
  state: SessionViewState,
  input: {
    userMessageId: string;
    promptId: string;
    text: string;
    createdAt: string;
    status: PromptStatus;
  },
): SessionViewState {
  const item: PromptItem = {
    prompt_id: input.promptId,
    user_message_id: input.userMessageId,
    status: input.status,
    content: [{ type: 'text', text: input.text }],
    created_at: input.createdAt,
  };
  const queuedPromptIds =
    input.status === 'queued'
      ? state.queuedPromptIds.includes(input.promptId)
        ? state.queuedPromptIds
        : [...state.queuedPromptIds, input.promptId]
      : state.queuedPromptIds.filter((id) => id !== input.promptId);
  return {
    ...state,
    version: state.version + 1,
    busy: input.status === 'running' ? true : state.busy,
    activePromptId: input.status === 'running' ? input.promptId : state.activePromptId,
    queuedPromptIds,
    blocks: upsertPromptItemBlocks(state.blocks, item),
  };
}

/** Reconcile scheduler truth from GET /sessions/:id/prompts. Returns the SAME
 * state reference when nothing changed — the refresh runs on every turn and
 * prompt frame, and a no-op reconcile must not republish. */
export function reconcilePromptList(
  state: SessionViewState,
  prompts: PromptListResponse,
): SessionViewState {
  const items = [...(prompts.active === null ? [] : [prompts.active]), ...prompts.queued];
  let blocks = state.blocks;
  for (const item of items) blocks = upsertPromptItemBlocks(blocks, item);
  const known = new Map(items.map((item) => [item.prompt_id, item.status]));
  let blocksChanged = blocks !== state.blocks;
  const mapped = blocks.map((block) => {
    if (block.kind !== 'user' || block.promptId === undefined) return block;
    const status = known.get(block.promptId);
    if (status !== undefined) {
      if (block.promptStatus === status) return block;
      blocksChanged = true;
      return { ...block, promptStatus: status };
    }
    if (block.promptStatus === 'running' || block.promptStatus === 'queued') {
      blocksChanged = true;
      return { ...block, promptStatus: undefined };
    }
    return block;
  });
  if (blocksChanged) blocks = mapped;
  const activePromptId = prompts.active?.prompt_id;
  const queuedPromptIds = prompts.queued.map((item) => item.prompt_id);
  const busy = activePromptId !== undefined ? true : state.busy && state.activePromptId === undefined;
  const queueUnchanged =
    queuedPromptIds.length === state.queuedPromptIds.length &&
    queuedPromptIds.every((id, index) => id === state.queuedPromptIds[index]);
  if (
    !blocksChanged &&
    activePromptId === state.activePromptId &&
    queueUnchanged &&
    busy === state.busy
  ) {
    return state;
  }
  return {
    ...state,
    version: state.version + 1,
    blocks,
    activePromptId,
    queuedPromptIds,
    busy,
  };
}

export interface QueuedPromptPreview {
  readonly promptId: string;
  readonly text: string;
}

/** Queue-strip rows in scheduler (drain) order. The preview text comes from
 * the prompt's user block — the local echo, a prompt.submitted frame, and the
 * reconciled upsert all carry it; a prompt whose block has not landed yet
 * previews as ''. */
export function queuedPromptPreviews(state: SessionViewState): readonly QueuedPromptPreview[] {
  return state.queuedPromptIds.map((promptId) => {
    const block = state.blocks.find(
      (candidate): candidate is UserBlock =>
        candidate.kind === 'user' && candidate.promptId === promptId,
    );
    return { promptId, text: block?.text ?? '' };
  });
}

export function advanceSessionCursor(
  state: SessionViewState,
  frame: SessionEventFrame,
): SessionViewState {
  if (frame.volatile === true || frame.seq <= state.cursor.seq) return state;
  return {
    ...state,
    version: state.version + 1,
    cursor: { seq: frame.seq, epoch: frame.epoch ?? state.cursor.epoch },
  };
}

export function incrementSubagentToolCount(
  state: SessionViewState,
  agentId: string,
  timestamp: string,
): SessionViewState {
  const key = `subagent-${agentId}`;
  const existing =
    (state.blocks.find((block) => block.id === key) as SubagentBlock | undefined) ??
    createUnknownSubagent(agentId, timestamp);
  return {
    ...state,
    version: state.version + 1,
    blocks: replaceBlock(state.blocks, { ...existing, toolCallCount: existing.toolCallCount + 1 }),
  };
}

/** Mark an approval block resolved from the local REST answer path. */
export function markApprovalResolved(
  state: SessionViewState,
  approvalId: string,
  resolution: ApprovalResolution,
): SessionViewState {
  const key = `approval-${approvalId}`;
  const existing = state.blocks.find((b) => b.id === key) as ApprovalBlock | undefined;
  if (existing === undefined) return state;
  const blocks = replaceBlock(state.blocks, { ...existing, resolution });
  return {
    ...state,
    version: state.version + 1,
    pendingInteraction: derivePendingInteraction({ ...state, blocks }),
    blocks,
  };
}

export function markQuestionOutcome(
  state: SessionViewState,
  questionId: string,
  outcome: QuestionOutcome,
): SessionViewState {
  const key = `question-${questionId}`;
  const existing = state.blocks.find((b) => b.id === key) as QuestionBlock | undefined;
  if (existing === undefined) return state;
  const blocks = replaceBlock(state.blocks, { ...existing, outcome });
  return {
    ...state,
    version: state.version + 1,
    pendingInteraction: derivePendingInteraction({ ...state, blocks }),
    blocks,
  };
}

export function setTasks(state: SessionViewState, tasks: readonly Task[]): SessionViewState {
  return { ...state, version: state.version + 1, tasks };
}

function subagentBlocksEqual(a: SubagentBlock, b: SubagentBlock): boolean {
  return (
    a.id === b.id &&
    a.subagentId === b.subagentId &&
    a.parentAgentId === b.parentAgentId &&
    a.parentToolCallId === b.parentToolCallId &&
    a.parentToolCallUuid === b.parentToolCallUuid &&
    a.parentTurnId === b.parentTurnId &&
    a.name === b.name &&
    a.label === b.label &&
    a.description === b.description &&
    a.model === b.model &&
    a.thinkingEffort === b.thinkingEffort &&
    a.status === b.status &&
    a.summary === b.summary &&
    a.error === b.error &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.toolCallCount === b.toolCallCount &&
    a.transcript === b.transcript
  );
}

/** Snapshot/resync cannot reconstruct finished child history. Preserve and
 * identity-merge events this client already observed, while letting the fresh
 * snapshot own live status and roster metadata. Cards are then reinserted by
 * parent anchor or started-at order so renamed/finalized neighbors cannot sink
 * them to the transcript tail. */
export function preserveCapturedSubagents(
  rebuilt: SessionViewState,
  previous: SessionViewState,
): SessionViewState {
  const captured = previous.blocks.filter(
    (block): block is SubagentBlock => block.kind === 'subagent',
  );
  if (captured.length === 0) return rebuilt;
  const capturedById = new Map(captured.map((block) => [block.subagentId, block]));
  const fresh = rebuilt.blocks.filter(
    (block): block is SubagentBlock => block.kind === 'subagent',
  );
  const mergedById = new Map<string, SubagentBlock>();
  for (const block of fresh) {
    const prior = capturedById.get(block.subagentId);
    if (prior === undefined) {
      mergedById.set(block.subagentId, block);
      continue;
    }
    const merged = {
      ...prior,
      ...block,
      parentAgentId: block.parentAgentId ?? prior.parentAgentId,
      parentToolCallId: block.parentToolCallId ?? prior.parentToolCallId,
      parentToolCallUuid: block.parentToolCallUuid ?? prior.parentToolCallUuid,
      parentTurnId: block.parentTurnId ?? prior.parentTurnId,
      label: block.label ?? prior.label,
      model: block.model ?? prior.model,
      thinkingEffort: block.thinkingEffort ?? prior.thinkingEffort,
      toolCallCount: Math.max(block.toolCallCount, prior.toolCallCount),
      transcript: mergeCapturedTranscript(block.transcript, prior.transcript),
      summary: block.summary ?? prior.summary,
      error: block.error ?? prior.error,
    } satisfies SubagentBlock;
    mergedById.set(block.subagentId, subagentBlocksEqual(prior, merged) ? prior : merged);
  }
  for (const prior of captured) {
    if (!mergedById.has(prior.subagentId)) mergedById.set(prior.subagentId, prior);
  }

  const blocks = insertSubagentBlocks(
    rebuilt.blocks,
    [...mergedById.values()].sort(compareSubagentTimeline),
  );
  return { ...rebuilt, version: rebuilt.version + 1, blocks };
}

export function setGoal(
  state: SessionViewState,
  goal: GoalSnapshot | null,
  updatedAt?: string,
): SessionViewState {
  return {
    ...state,
    version: state.version + 1,
    goal,
    goalUpdatedAt: updatedAt ?? state.goalUpdatedAt,
  };
}

/**
 * Merge a polled/list session record into view state. Title, usage, and other
 * metadata update; live busy / pendingInteraction / activePromptId stay with
 * the snapshot + WS + prompt-list truth so a stale list row cannot flatten a
 * running turn or hide an unresolved card.
 */
export function setSessionRecord(state: SessionViewState, session: Session): SessionViewState {
  return {
    ...state,
    version: state.version + 1,
    session,
  };
}

export function setOlderError(
  state: SessionViewState,
  error: string | undefined,
): SessionViewState {
  if (state.olderError === error && !state.loadingOlder) return state;
  return {
    ...state,
    version: state.version + 1,
    olderError: error,
    loadingOlder: false,
  };
}

export function setResyncing(state: SessionViewState, resyncing: boolean): SessionViewState {
  if (state.resyncing === resyncing) return state;
  return { ...state, version: state.version + 1, resyncing };
}

export function setResyncFailed(
  state: SessionViewState,
  failed: boolean,
  attempt: number,
): SessionViewState {
  if (state.resyncFailed === failed && state.resyncAttempt === attempt) return state;
  return {
    ...state,
    version: state.version + 1,
    resyncFailed: failed,
    resyncAttempt: attempt,
  };
}

export function setLoadError(
  state: SessionViewState,
  error: string | undefined,
): SessionViewState {
  if (state.loadError === error) return state;
  return {
    ...state,
    version: state.version + 1,
    loadError: error,
    loaded: error === undefined ? state.loaded : false,
  };
}

export function pendingApprovalCount(state: SessionViewState): number {
  return state.blocks.filter((b) => b.kind === 'approval' && b.resolution === undefined).length;
}

export function pendingQuestionCount(state: SessionViewState): number {
  return state.blocks.filter((b) => b.kind === 'question' && b.outcome === undefined).length;
}

/** Recompute the aggregate pending-interaction fact from unresolved blocks. */
export function derivePendingInteraction(state: SessionViewState): SessionPendingInteraction {
  if (pendingApprovalCount(state) > 0) return 'approval';
  if (pendingQuestionCount(state) > 0) return 'question';
  return 'none';
}

export function subagentBlocksFromState(state: SessionViewState): readonly SubagentBlock[] {
  return state.blocks.filter((block): block is SubagentBlock => block.kind === 'subagent');
}

export function rosterFromTranscriptAgents(
  agents: readonly AgentTranscriptAgent[] | undefined,
): readonly AgentRosterDescriptor[] {
  if (agents === undefined) return [];
  return agents.map((agent) => {
    const parentFromDelegator =
      agent.delegator?.kind === 'agent' ? agent.delegator.agentId : undefined;
    return {
      agentId: agent.agentId,
      parentAgentId: agent.parentAgentId ?? parentFromDelegator,
      name: agent.label ?? agent.agentId,
      label: agent.label,
      status: agent.disposedAt !== undefined ? 'completed' : undefined,
      startedAt: agent.createdAt,
      endedAt: agent.disposedAt,
    };
  });
}

export function rosterFromTranscriptResponse(
  response: AgentTranscriptResponse | undefined,
): readonly AgentRosterDescriptor[] {
  const roster = [...rosterFromTranscriptAgents(response?.agents)];
  if (response === undefined) return roster;
  const meta = response.meta?.agent;
  if (meta === undefined) return roster;
  const index = roster.findIndex((agent) => agent.agentId === response.agent_id);
  const statusFields = {
    model: meta.model,
    thinkingEffort: meta.thinkingEffort,
    contextTokens: meta.contextTokens,
    maxContextTokens: meta.maxContextTokens,
    usage: meta.usage,
    busy: agentBusyFromMeta(response),
  };
  if (index >= 0) {
    roster[index] = { ...roster[index]!, ...statusFields };
  } else {
    roster.push({ agentId: response.agent_id, name: response.agent_id, ...statusFields });
  }
  return roster;
}

export function taskItemsFromTranscriptTasks(
  tasks: readonly AgentTranscriptTask[] | undefined,
): readonly AgentTaskItem[] {
  if (tasks === undefined) return [];
  return tasks.flatMap((task) => {
    if (task.agentId === undefined || task.agentId === '') return [];
    return [
      {
        id: task.taskId,
        agentId: task.agentId,
        kind: task.kind,
        description: task.description,
        status: task.state,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        summary: task.resultSummary,
        output_preview: task.outputTail,
        detached: task.detached,
      } satisfies AgentTaskItem,
    ];
  });
}

export function taskItemsFromSessionTasks(tasks: readonly Task[]): readonly AgentTaskItem[] {
  return tasks.flatMap((task) => {
    if (task.kind !== 'subagent') return [];
    // Protocol `/tasks` has no agentId. Do not invent one from task.id.
    return [
      {
        id: task.id,
        kind: task.kind,
        description: task.description,
        status: task.status,
        model: task.model,
        thinking_effort: task.thinking_effort,
        started_at: task.started_at,
        completed_at: task.completed_at,
        output_preview: task.output_preview,
      } satisfies AgentTaskItem,
    ];
  });
}

export function liveSourcesFromSubagentBlocks(
  blocks: readonly SubagentBlock[],
): readonly AgentLiveSource[] {
  return blocks.map((block) => ({
    subagentId: block.subagentId,
    parentAgentId: block.parentAgentId,
    parentToolCallId: block.parentToolCallId,
    name: block.name,
    label: block.label,
    model: block.model,
    thinkingEffort: block.thinkingEffort,
    status: block.status,
    summary: block.summary,
    error: block.error,
    startedAt: block.startedAt,
    endedAt: block.endedAt,
    toolCallCount: block.toolCallCount,
  }));
}

/**
 * One session forest from live subagent cards + optional roster/task sources.
 * Callers (main transcript, RightRail, agent detail) must share this.
 */
export function sessionAgentForest(
  state: SessionViewState,
  roster?: readonly AgentRosterDescriptor[],
  extraTasks?: readonly AgentTaskItem[],
): AgentForest {
  return buildAgentForest(
    liveSourcesFromSubagentBlocks(subagentBlocksFromState(state)),
    roster,
    [...taskItemsFromSessionTasks(state.tasks), ...(extraTasks ?? [])],
  );
}

export function sessionAgentForestFromTranscript(
  state: SessionViewState,
  response: AgentTranscriptResponse | undefined,
): AgentForest {
  return sessionAgentForest(
    state,
    rosterFromTranscriptResponse(response),
    taskItemsFromTranscriptTasks(response?.tasks),
  );
}

export function agentTranscriptPageFromResponse(
  response: AgentTranscriptResponse,
  blocks: readonly Block[],
): AgentTranscriptPage {
  const firstTurn = response.items.find((item) => item.kind === 'turn');
  return {
    blocks: blocks as readonly AgentTimelineBlock[],
    hasMore: response.has_more,
    oldestTurnId: firstTurn?.kind === 'turn' ? firstTurn.turnId : undefined,
    seq: response.seq,
    model: response.meta?.agent?.model,
    thinkingEffort: response.meta?.agent?.thinkingEffort,
    contextTokens: response.meta?.agent?.contextTokens,
    maxContextTokens: response.meta?.agent?.maxContextTokens,
    usage: response.meta?.agent?.usage,
    busy: agentBusyFromMeta(response),
    toolCallCount: countToolBlocks(blocks),
  };
}

export function oldestTurnIdFromResponse(
  response: AgentTranscriptResponse | undefined,
): string | undefined {
  if (response === undefined) return undefined;
  const firstTurn = response.items.find((item) => item.kind === 'turn');
  return firstTurn?.kind === 'turn' ? firstTurn.turnId : undefined;
}

export { countToolBlocks };

export function agentBusyFromMeta(response: AgentTranscriptResponse | undefined): boolean | undefined {
  const kind = response?.meta?.agent?.phase?.kind;
  if (kind === undefined) return undefined;
  return (
    kind === 'running' ||
    kind === 'streaming' ||
    kind === 'tool_call' ||
    kind === 'retrying' ||
    kind === 'awaiting_approval'
  );
}

export function visibleSubagentIdsForParent(
  forest: AgentForest,
  parentAgentId: string,
): ReadonlySet<string> {
  return new Set(forest.byId[parentAgentId]?.childIds ?? []);
}

export function filterBlocksToDirectChildren(
  blocks: readonly Block[],
  forest: AgentForest,
  parentAgentId: string,
): Block[] {
  const parent = forest.byId[parentAgentId];
  const visible = parent === undefined ? undefined : new Set(parent.childIds);
  return blocks.filter((block) => {
    if (block.kind !== 'subagent') return true;
    if (visible !== undefined) return visible.has(block.subagentId);
    const hinted = forest.byId[block.subagentId]?.parentAgentId ?? block.parentAgentId;
    return hinted === undefined || hinted === parentAgentId;
  });
}

export function nodeForAgent(forest: AgentForest, agentId: string): AgentTreeNode | undefined {
  return forest.byId[agentId];
}

export { MAIN_AGENT_ID };
export type { AgentForest, AgentTreeNode };
