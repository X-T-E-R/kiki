import type {
  ApprovalRequest,
  GoalSnapshot,
  PermissionMode,
  PromptItem,
  PromptStatus,
  QuestionItem,
  QuestionRequest,
  SessionPendingInteraction,
  SessionSnapshotResponse,
  SnapshotSubagent,
  Task,
  TokenUsage,
  ToolInputDisplay,
  UsageStatus,
} from '@moonshot-ai/protocol';
import { transcriptValueEquals } from '@moonshot-ai/transcript';
import type {
  AgentState,
  AgentTranscriptSnapshot,
  TranscriptItem,
  TranscriptPrompt,
  TranscriptTask,
} from '@moonshot-ai/transcript';

import type {
  AgentTranscriptAgent,
  AgentTranscriptAttachment,
  AgentTranscriptInteraction,
  AgentTranscriptResponse,
  AgentTranscriptTask,
} from '../../transport';
import { mediaFromContentParts, type MediaRef } from '../../composer/media';
import type { I18nKey } from '../../i18n/locale';
import { MAIN_AGENT_ID } from '../agentTree';
import {
  classifyTranscriptText,
  originFromRecord,
  producerFromOrigin,
  projectMessageContent,
  splitSystemReminders,
  unwrapOrigin,
  type PromptOriginLike,
} from './classify';
import {
  bump,
  createViewState,
  type ApprovalBlock,
  type AssistantBlock,
  type Block,
  type NoticeBlock,
  type QuestionBlock,
  type SessionViewState,
  type ShellBlock,
  type SkillBlock,
  type SubagentBlock,
  type SubagentEventBlock,
  type SystemBlock,
  type SystemReminderBlock,
  type SystemVariant,
  type TodoItem,
  type ToolBlock,
  type TurnExecutionInfo,
  type TurnRetryInfo,
  type TurnTailInfo,
  type UserBlock,
} from './types';

export type AgentTranscriptProjectionSource = {
  readonly agent_id: string;
  readonly items: readonly TranscriptItem[] | AgentTranscriptResponse['items'];
  readonly interactions?: readonly AgentTranscriptInteraction[];
  readonly attachments?: readonly AgentTranscriptAttachment[];
  readonly meta?: AgentTranscriptSnapshot['meta'] | AgentTranscriptResponse['meta'];
  readonly prompts?: readonly TranscriptPrompt[];
  readonly tasks?: readonly TranscriptTask[] | readonly AgentTranscriptTask[];
};

export function agentStateToProjectionSource(
  agentId: string,
  state: AgentState | AgentTranscriptSnapshot,
): AgentTranscriptProjectionSource {
  return {
    agent_id: agentId,
    items: state.items,
    interactions: Array.isArray(state.interactions)
      ? state.interactions
      : [...state.interactions.values()],
    attachments: Array.isArray(state.attachments)
      ? state.attachments
      : [...state.attachments.values()],
    meta: state.meta,
    prompts: Array.isArray(state.prompts) ? state.prompts : [...state.prompts.values()],
    tasks: Array.isArray(state.tasks) ? state.tasks : [...state.tasks.values()],
  };
}

function reminderBlocks(
  id: string,
  createdAt: string | undefined,
  reminders: readonly string[],
  turnId?: string,
): SystemReminderBlock[] {
  return reminders.map((reminder, index) => ({
    kind: 'system-reminder',
    id: `reminder-${id}-${index}`,
    text: reminder,
    createdAt,
    turnId,
  }));
}

function classifiedTextToBlocks(input: {
  id: string;
  classified: ReturnType<typeof classifyTranscriptText>;
  createdAt: string;
  media?: readonly MediaRef[];
  promptId?: string;
  userMessageId?: string;
  promptStatus?: PromptStatus;
  turnId?: string;
  clientRequestId?: string;
}): Block[] {
  const { classified } = input;
  const blocks: Block[] = [];
  switch (classified.lane) {
    case 'you':
    case 'peer':
      if (classified.text !== '' || (input.media !== undefined && input.media.length > 0)) {
        const identity = input.userMessageId ?? input.clientRequestId ?? input.id;
        blocks.push({
          kind: 'user',
          id: `user-${identity}`,
          text: classified.text,
          media: input.media !== undefined && input.media.length > 0 ? input.media : undefined,
          createdAt: input.createdAt,
          promptId: input.promptId,
          userMessageId: input.userMessageId,
          clientRequestId: input.clientRequestId,
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
        turnId: input.turnId,
      } satisfies SkillBlock);
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
        turnId: input.turnId,
      } satisfies ShellBlock);
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
        } satisfies SystemBlock);
      }
      break;
    case 'reminder':
      break;
  }
  blocks.push(...reminderBlocks(input.id, input.createdAt, classified.reminders, input.turnId));
  return blocks;
}

function originFromTurnItem(item: unknown): PromptOriginLike | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  return unwrapOrigin((item as { origin?: PromptOriginLike }).origin);
}

function originFromFrame(frame: unknown): PromptOriginLike | undefined {
  return originFromRecord(frame);
}

function isUserVisibleOrigin(origin: PromptOriginLike | undefined): boolean {
  const kind = unwrapOrigin(origin)?.kind;
  return kind === 'user' || kind === 'peer_thread';
}

function identityFromTurnOrigin(origin: PromptOriginLike | undefined): {
  promptId?: string;
  userMessageId?: string;
} {
  const unwrapped = unwrapOrigin(origin);
  const payload =
    unwrapped !== undefined && typeof unwrapped.payload === 'object' && unwrapped.payload !== null
      ? (unwrapped.payload as Record<string, unknown>)
      : unwrapped !== undefined
        ? (unwrapped as unknown as Record<string, unknown>)
        : undefined;
  const promptId = typeof payload?.['promptId'] === 'string' ? payload['promptId'] : undefined;
  const userMessageId =
    typeof payload?.['userMessageId'] === 'string'
      ? payload['userMessageId']
      : typeof payload?.['user_message_id'] === 'string'
        ? payload['user_message_id']
        : undefined;
  return { promptId, userMessageId };
}

function turnMessageId(item: object): string | undefined {
  const message = (item as { readonly message?: { readonly messageId?: string } }).message;
  return message?.messageId;
}

function frameMessageId(frame: object): string | undefined {
  const part = (frame as { readonly part?: { readonly messageId?: string } }).part;
  return part?.messageId;
}

function isLiveStreamingFrame(
  item: { readonly turnId: string; readonly state?: string },
  step: { readonly stepId: string; readonly state?: string },
  frame: { readonly frameId: string; readonly kind: string },
  lastOpenFrameId: string | undefined,
  phase: AgentTranscriptSnapshot['meta']['agent'] extends { phase?: infer P } ? P : unknown,
): boolean {
  if (item.state !== 'running' && item.state !== 'queued') return false;
  if (step.state !== 'running') return false;
  if (frame.kind !== 'text' && frame.kind !== 'thinking') return false;
  if (lastOpenFrameId !== frame.frameId) return false;
  if (phase === undefined || typeof phase !== 'object' || phase === null) return true;

  // The v1 compatibility projector cannot always recover canonical step IDs
  // and may emit an empty string. Compatibility metadata is advisory: a
  // non-empty identifier may narrow the selected frame, but an empty one must
  // not invalidate a canonical open frame.
  const live = phase as { kind?: string; turnId?: number | string; stepId?: string; stream?: string };
  const phaseStepId = typeof live.stepId === 'string' ? live.stepId.trim() : '';
  if (phaseStepId !== '' && phaseStepId !== step.stepId) return false;
  if (live.turnId !== undefined && !sameTurnId(String(live.turnId), item.turnId)) return false;

  if (live.kind === 'running') return true;
  if (live.kind !== 'streaming') return false;
  if (live.stream === 'assistant') return frame.kind === 'text';
  if (live.stream === 'thinking') return frame.kind === 'thinking';
  return false;
}

function mediaFromAttachmentIds(
  ids: readonly string[] | undefined,
  attachmentsById: ReadonlyMap<string, AgentTranscriptAttachment> | undefined,
): readonly MediaRef[] | undefined {
  if (ids === undefined || ids.length === 0 || attachmentsById === undefined) return undefined;
  const media: MediaRef[] = [];
  for (const id of ids) {
    const attachment = attachmentsById.get(id);
    if (attachment === undefined) continue;
    const source = attachment.source;
    media.push({
      kind: attachment.mediaType.startsWith('video/')
        ? 'video'
        : attachment.mediaType.startsWith('image/')
          ? 'image'
          : 'file',
      url: source?.kind === 'url' ? source.url : undefined,
      fileId: source?.kind === 'file' || source?.kind === 'session_media' ? source.fileId : undefined,
      name: attachment.name,
      mime: attachment.mediaType,
      size: attachment.size,
    });
  }
  return media.length > 0 ? media : undefined;
}

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
            id: typeof record['id'] === 'string' ? record['id'] : `opt-${index}-${optionIndex}`,
            label: typeof record['label'] === 'string' ? record['label'] : '',
            description: typeof record['description'] === 'string' ? record['description'] : undefined,
          },
        ];
      }),
      multi_select: (item['multi_select'] ?? item['multiSelect']) === true ? true : undefined,
      allow_other: (item['allow_other'] ?? item['allowOther']) === true ? true : undefined,
    });
  }
  return items;
}

function originAgentFromInteraction(interaction: AgentTranscriptInteraction): string | undefined {
  const origin = interaction.origin;
  if (typeof origin === 'string' && origin !== '') return origin;
  if (typeof origin === 'object' && origin !== null) {
    const record = origin as Record<string, unknown>;
    if (typeof record['agentId'] === 'string') return record['agentId'];
    if (typeof record['agent_id'] === 'string') return record['agent_id'];
  }
  const request = interaction.request;
  if (typeof request === 'object' && request !== null) {
    const record = request as Record<string, unknown>;
    if (typeof record['agentId'] === 'string') return record['agentId'];
    if (typeof record['originAgentId'] === 'string') return record['originAgentId'];
  }
  return undefined;
}

function recordString(record: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function recordNumber(record: Record<string, unknown>, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function interactionToBlock(interaction: AgentTranscriptInteraction, agentId: string): Block | undefined {
  const originAgentId = originAgentFromInteraction(interaction);
  if (interaction.interactionKind === 'approval') {
    const request =
      typeof interaction.request === 'object' && interaction.request !== null
        ? (interaction.request as Record<string, unknown>)
        : {};
    const turnId = recordNumber(request, 'turnId', 'turn_id');
    const toolCallId =
      interaction.toolCallId ?? recordString(request, 'toolCallId', 'tool_call_id') ?? interaction.interactionId;
    const createdAt = recordString(request, 'createdAt', 'created_at') ?? '';
    const expiresAt = recordString(request, 'expiresAt', 'expires_at') ?? createdAt;
    return {
      kind: 'approval',
      id: `approval-${interaction.interactionId}`,
      request: {
        approval_id: interaction.interactionId,
        session_id: recordString(request, 'sessionId', 'session_id') ?? '',
        turn_id: turnId,
        tool_call_id: toolCallId,
        tool_name: recordString(request, 'toolName', 'tool_name') ?? 'tool',
        action: recordString(request, 'action') ?? 'Approve the action',
        tool_input_display: request['display'] ?? request['toolInputDisplay'] ?? request['tool_input_display'],
        created_at: createdAt,
        expires_at: expiresAt,
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
              resolvedAt:
                typeof interaction.response === 'object' && interaction.response !== null
                  ? recordString(interaction.response as Record<string, unknown>, 'resolvedAt', 'resolved_at') ?? createdAt
                  : createdAt,
            },
      originAgentId,
      originUnknown: originAgentId === undefined && agentId === MAIN_AGENT_ID,
    } satisfies ApprovalBlock;
  }
  if (interaction.interactionKind === 'question') {
    const request =
      typeof interaction.request === 'object' && interaction.request !== null
        ? (interaction.request as Record<string, unknown>)
        : {};
    const turnId = recordNumber(request, 'turnId', 'turn_id');
    const createdAt = recordString(request, 'createdAt', 'created_at') ?? '';
    return {
      kind: 'question',
      id: `question-${interaction.interactionId}`,
      request: {
        question_id: interaction.interactionId,
        session_id: recordString(request, 'sessionId', 'session_id') ?? '',
        turn_id: turnId,
        tool_call_id: interaction.toolCallId ?? recordString(request, 'toolCallId', 'tool_call_id'),
        questions: engineQuestionItems(request['questions']),
        created_at: createdAt,
      },
      outcome:
        interaction.state === 'pending'
          ? undefined
          : interaction.state === 'answered'
            ? { kind: 'answered', at: createdAt }
            : interaction.state === 'dismissed'
              ? { kind: 'dismissed', at: createdAt }
              : { kind: 'expired' },
      originAgentId,
      originUnknown: originAgentId === undefined && agentId === MAIN_AGENT_ID,
    } satisfies QuestionBlock;
  }
  return undefined;
}

const HIDDEN_SPLICE_MARKERS = new Set(['undo', 'clear']);
const MARKER_SUMMARY_KEYS = {
  compaction: 'transcript.marker.compaction',
  hook: 'transcript.marker.hook',
  skill: 'transcript.marker.skill',
  notice: 'transcript.marker.notice',
  cron: 'transcript.marker.cron',
  cron_fired: 'transcript.marker.cron',
  goal: 'transcript.marker.goal',
  'plan.revision': 'transcript.marker.plan',
  'plan.enter': 'transcript.marker.plan',
  'plan.exit': 'transcript.marker.plan',
  swarm: 'transcript.marker.swarm',
  'swarm.enter': 'transcript.marker.swarm',
  'swarm.exit': 'transcript.marker.swarm',
} as const satisfies Record<string, I18nKey>;

function markerToBlock(item: {
  markerId: string;
  marker: string;
  at?: string;
  payload?: unknown;
}): Block | undefined {
  if (HIDDEN_SPLICE_MARKERS.has(item.marker)) return undefined;
  const summaryKey = MARKER_SUMMARY_KEYS[item.marker as keyof typeof MARKER_SUMMARY_KEYS];

  // Skill activation payloads may contain the complete loaded skill document.
  // The marker is timeline chrome, not a second copy of that document.
  if (item.marker === 'skill' && summaryKey !== undefined) {
    return {
      kind: 'notice',
      id: `agent-marker-${item.markerId}`,
      text: item.marker,
      tone: 'neutral',
      i18n: { key: summaryKey },
    };
  }

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
    return { kind: 'notice', id: `agent-marker-${item.markerId}`, text, tone: 'neutral' };
  }
  if (summaryKey === undefined) {
    return {
      kind: 'notice',
      id: `agent-marker-${item.markerId}`,
      text: item.marker,
      tone: 'neutral',
    };
  }
  return {
    kind: 'notice',
    id: `agent-marker-${item.markerId}`,
    text: item.marker,
    tone: 'neutral',
    i18n: { key: summaryKey },
  };
}

function isPromptContentPart(value: unknown): value is MessageContentPart {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'text' ||
    type === 'image' ||
    type === 'video' ||
    type === 'file' ||
    type === 'thinking' ||
    type === 'tool_use' ||
    type === 'tool_result'
  );
}

type MessageContentPart = Parameters<typeof mediaFromContentParts>[0][number];

function promptContentParts(content: unknown): MessageContentPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isPromptContentPart);
}

function spawnInstructionFromToolArgs(args: unknown, agentId: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const prompt = record['prompt'] ?? record['instruction'];
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

function mapTaskState(state: string): SubagentBlock['status'] {
  if (state === 'running') return 'running';
  if (state === 'failed' || state === 'lost' || state === 'timed_out') return 'failed';
  if (state === 'killed' || state === 'cancelled') return 'cancelled';
  if (state === 'completed') return 'completed';
  if (state === 'suspended') return 'suspended';
  return 'unknown';
}

function presentText(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

export function snapshotSubagentAgentId(subagent: SnapshotSubagent): string {
  return presentText(subagent.agent_id) ?? subagent.id;
}

function mapSnapshotSubagentStatus(subagent: SnapshotSubagent): SubagentBlock['status'] {
  if (subagent.subagent_phase === 'suspended') return 'suspended';
  return mapTaskState(subagent.status);
}

function overlaySubagentBlock(block: SubagentBlock, snapshot: SnapshotSubagent): SubagentBlock {
  const snapshotCount = snapshot.tool_call_count;
  const snapshotName =
    presentText(snapshot.label) ?? presentText(snapshot.description) ?? presentText(snapshot.profile);
  return {
    ...block,
    label: block.label ?? presentText(snapshot.label),
    name: block.name !== block.subagentId ? block.name : snapshotName ?? block.name,
    model: block.model ?? presentText(snapshot.model),
    thinkingEffort: block.thinkingEffort ?? presentText(snapshot.thinking_effort),
    status: block.status === 'unknown' ? mapSnapshotSubagentStatus(snapshot) : block.status,
    description: block.description ?? presentText(snapshot.description),
    parentToolCallId: block.parentToolCallId ?? presentText(snapshot.parent_tool_call_id),
    parentAgentId: block.parentAgentId ?? presentText(snapshot.parent_agent_id),
    startedAt: block.startedAt ?? presentText(snapshot.started_at),
    endedAt: block.endedAt ?? presentText(snapshot.completed_at),
    summary: block.summary ?? presentText(snapshot.output_preview),
    toolCallCount:
      snapshotCount === undefined ? block.toolCallCount : Math.max(block.toolCallCount, snapshotCount),
  };
}

export function overlaySnapshotSubagentFields(
  blocks: readonly Block[],
  snapshotSubagents: readonly SnapshotSubagent[] | undefined,
): Block[] {
  if (snapshotSubagents === undefined || snapshotSubagents.length === 0) return blocks as Block[];
  const byId = new Map<string, SnapshotSubagent>();
  for (const subagent of snapshotSubagents) {
    const id = snapshotSubagentAgentId(subagent);
    if (id !== '') byId.set(id, subagent);
  }
  if (byId.size === 0) return [...blocks];
  return blocks.map((block) => {
    if (block.kind !== 'subagent') return block;
    const snapshot = byId.get(block.subagentId);
    return snapshot === undefined ? block : overlaySubagentBlock(block, snapshot);
  });
}

function timestampMs(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function blockTimelineMs(block: Block): number | undefined {
  switch (block.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'system':
    case 'system-reminder':
    case 'skill':
      return timestampMs(block.createdAt);
    case 'tool':
      return block.startedAt !== undefined && block.startedAt > 0 ? block.startedAt : undefined;
    case 'subagent':
      return timestampMs(block.startedAt);
    case 'subagent-event':
      return timestampMs(block.at);
    case 'approval':
      return timestampMs(block.request.created_at);
    case 'question':
      return timestampMs(block.request.created_at);
    case 'shell':
      return block.startedAt !== undefined && block.startedAt > 0 ? block.startedAt : undefined;
    case 'notice':
      return undefined;
  }
}

function normalizeTurnId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return `t${value}`;
  if (typeof value !== 'string' || value === '') return undefined;
  return value.startsWith('t') ? value : `t${value}`;
}

function sameTurnId(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return normalizeTurnId(left) === normalizeTurnId(right);
}

function blockTurnId(block: Block): string | undefined {
  switch (block.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'system':
    case 'system-reminder':
    case 'skill':
    case 'tool':
    case 'shell':
      return block.turnId;
    case 'subagent':
      return block.parentTurnId;
    case 'subagent-event':
      return block.turnId;
    case 'approval':
      return normalizeTurnId(block.request.turn_id);
    case 'question':
      return normalizeTurnId(block.request.turn_id);
    case 'notice':
      return undefined;
  }
}

function compareTimelineIds(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function insertAtPreviousPosition(
  blocks: Block[],
  block: Block,
  previous: readonly Block[],
): boolean {
  const previousIndex = previous.findIndex((candidate) => candidate.id === block.id);
  if (previousIndex < 0) return false;
  for (let index = previousIndex - 1; index >= 0; index -= 1) {
    const anchorId = previous[index]?.id;
    if (anchorId === undefined) continue;
    const anchor = blocks.findLastIndex((candidate) => candidate.id === anchorId);
    if (anchor >= 0) {
      blocks.splice(anchor + 1, 0, block);
      return true;
    }
  }
  for (let index = previousIndex + 1; index < previous.length; index += 1) {
    const anchorId = previous[index]?.id;
    if (anchorId === undefined) continue;
    const anchor = blocks.findIndex((candidate) => candidate.id === anchorId);
    if (anchor >= 0) {
      blocks.splice(anchor, 0, block);
      return true;
    }
  }
  return false;
}

function insertByTimeline(blocks: Block[], block: Block): void {
  const at = blockTimelineMs(block);
  if (at !== undefined) {
    const insertionIndex = blocks.findIndex((candidate) => {
      const candidateAt = blockTimelineMs(candidate);
      if (candidateAt === undefined) return false;
      if (candidateAt !== at) return candidateAt > at;
      return compareTimelineIds(candidate.id, block.id) > 0;
    });
    if (insertionIndex >= 0) {
      blocks.splice(insertionIndex, 0, block);
      return;
    }
  }
  blocks.push(block);
}

type RawSubagentEvent = {
  readonly id: string;
  readonly subagentId: string;
  readonly event: SubagentEventBlock['event'];
  readonly at: string | undefined;
  readonly turnId?: string;
  readonly anchorToolCallId?: string;
};

function resumeTargetsFromToolArgs(args: unknown): readonly string[] {
  if (typeof args !== 'object' || args === null) return [];
  const record = args as Record<string, unknown>;
  const targets: string[] = [];
  // Plain AgentRun carries a single `resume` ref; AgentSwarm carries a
  // `resume_agent_ids` map keyed by agent id.
  const single = record['resume'];
  if (typeof single === 'string' && single.trim() !== '') targets.push(single.trim());
  const resumeMap = record['resume_agent_ids'];
  if (typeof resumeMap === 'object' && resumeMap !== null) {
    targets.push(
      ...Object.keys(resumeMap as Record<string, unknown>).filter((key) => key !== ''),
    );
  }
  return targets;
}

function resolveKnownAgentId(
  raw: string,
  byAgent: ReadonlyMap<string, SubagentBlock>,
  agentIdsWithTasks: ReadonlySet<string>,
  nameToAgentId: ReadonlyMap<string, string>,
): string | undefined {
  return byAgent.has(raw) || agentIdsWithTasks.has(raw) ? raw : nameToAgentId.get(raw);
}

function sendTargetFromToolArgs(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const target = (args as Record<string, unknown>)['target'];
  return typeof target === 'string' && target.trim() !== '' ? target.trim() : undefined;
}

function terminalEventForStatus(
  status: SubagentBlock['status'],
): Extract<SubagentEventBlock['event'], 'completed' | 'failed' | 'cancelled'> | undefined {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
  return undefined;
}

function subagentBlocksFromSnapshot(
  response: AgentTranscriptProjectionSource,
  parentAgentId: string,
): { blocks: SubagentBlock[]; events: SubagentEventBlock[] } {
  const tasks = response.tasks ?? [];
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  // One agent can run several times (resume re-prompts spawn a fresh task each
  // run): keep the full per-agent task list so lifecycle history is not
  // flattened into a single task. The card itself still reflects the latest run.
  const tasksByAgent = new Map<string, NonNullable<typeof response.tasks>[number][]>();
  for (const task of tasks) {
    if (task.kind !== 'subagent' || task.agentId === undefined || task.agentId === '') continue;
    const list = tasksByAgent.get(task.agentId);
    if (list === undefined) tasksByAgent.set(task.agentId, [task]);
    else list.push(task);
  }
  const taskByAgent = new Map(
    [...tasksByAgent.entries()].map(([agentId, list]) => [agentId, list[list.length - 1]!] as const),
  );
  const tasksByAgentKeySet: ReadonlySet<string> = new Set(tasksByAgent.keys());
  // The roster is GLOBAL (unpaginated) while `items` are a page window. The
  // earliest run of an agent — the only one a "spawned" entry may describe —
  // comes from the roster; whether it may RENDER depends on its taskref being
  // admitted into the accumulated page below.
  const earliestTaskIdByAgent = new Map(
    [...tasksByAgent.entries()].map(([agentId, list]) => {
      // An unknown clock proves nothing: a run without startedAt must not lose
      // "first" to a later timed resume. Only a candidate KNOWN to be earlier
      // than a KNOWN incumbent replaces it; otherwise roster order stands.
      let earliest = list[0]!;
      for (const task of list) {
        const at = timestampMs(task.startedAt);
        const earliestAt = timestampMs(earliest.startedAt);
        if (at !== undefined && earliestAt !== undefined && at < earliestAt) earliest = task;
      }
      return [agentId, earliest.taskId] as const;
    }),
  );
  // Runs admitted into the current page window (taskref items). Terminal
  // entries are emitted for admitted runs only — the global roster must not
  // leak off-page history into this page.
  const admittedTaskIds = new Set<string>();
  const nameToAgentId = new Map(
    tasks.flatMap((task) =>
      task.agentId === undefined || task.name === undefined
        ? []
        : [[task.name, task.agentId] as const],
    ),
  );
  const byAgent = new Map<string, SubagentBlock>();
  const rawEvents: RawSubagentEvent[] = [];
  const spawnMarked = new Set<string>();
  let previousTurnId: string | undefined;
  for (const item of response.items) {
    if (item.kind === 'taskref') {
      const task = taskById.get(item.taskId);
      if (task?.kind !== 'subagent' || task.agentId === undefined || task.agentId === '') continue;
      const existing = byAgent.get(task.agentId);
      const startedAt = item.at ?? task.startedAt ?? existing?.startedAt;
      byAgent.set(task.agentId, {
        kind: 'subagent',
        id: `subagent-${task.agentId}`,
        subagentId: task.agentId,
        parentAgentId,
        parentToolCallId: existing?.parentToolCallId,
        parentTurnId:
          existing?.parentTurnId ?? (timestampMs(startedAt) === undefined ? previousTurnId : undefined),
        name: task.name ?? task.subagentName ?? task.agentId,
        description: existing?.description ?? task.description,
        instruction: existing?.instruction,
        model: existing?.model,
        thinkingEffort: existing?.thinkingEffort,
        status: mapTaskState(task.state),
        summary: task.resultSummary ?? (task.outputTail === '' ? existing?.summary : task.outputTail),
        error: task.error ?? existing?.error,
        usage: task.usage ?? existing?.usage,
        startedAt,
        endedAt: task.endedAt ?? existing?.endedAt,
        toolCallCount: existing?.toolCallCount ?? 0,
        transcript: [],
      });
      admittedTaskIds.add(task.taskId);
      // "spawned" describes only the agent's globally-first run: a taskref for
      // a later resume run on a fresh page window must not mint a fake spawn.
      if (!spawnMarked.has(task.agentId) && earliestTaskIdByAgent.get(task.agentId) === task.taskId) {
        spawnMarked.add(task.agentId);
        rawEvents.push({
          id: `subagent-event-${task.agentId}-spawned-${task.taskId}`,
          subagentId: task.agentId,
          event: 'spawned',
          at: startedAt,
          turnId: previousTurnId,
        });
      }
      continue;
    }
    if (item.kind !== 'turn') continue;
    previousTurnId = item.turnId;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind !== 'tool') continue;
        const frameAt = frame.startedAt ?? step.startedAt ?? item.startedAt;
        const resumedTargets = new Set<string>();
        for (const raw of resumeTargetsFromToolArgs(frame.input)) {
          const targetId = resolveKnownAgentId(raw, byAgent, tasksByAgentKeySet, nameToAgentId);
          if (targetId === undefined || resumedTargets.has(targetId)) continue;
          resumedTargets.add(targetId);
          rawEvents.push({
            id: `subagent-event-${targetId}-resume-${frame.toolCallId}`,
            subagentId: targetId,
            event: 'resumed',
            at: frameAt,
            turnId: item.turnId,
            anchorToolCallId: frame.toolCallId,
          });
        }
        if (frame.name === 'AgentSend') {
          const target = sendTargetFromToolArgs(frame.input);
          const targetId =
            target === undefined
              ? undefined
              : resolveKnownAgentId(target, byAgent, tasksByAgentKeySet, nameToAgentId);
          if (targetId !== undefined) {
            rawEvents.push({
              id: `subagent-event-${targetId}-send-${frame.toolCallId}`,
              subagentId: targetId,
              event: 'sent',
              at: frameAt,
              turnId: item.turnId,
              anchorToolCallId: frame.toolCallId,
            });
          }
        }
        if (frame.agentRefs === undefined) continue;
        for (const ref of frame.agentRefs) {
          const existing = byAgent.get(ref.agentId);
          const task = taskByAgent.get(ref.agentId);
          const instruction = spawnInstructionFromToolArgs(frame.input, ref.agentId);
          byAgent.set(ref.agentId, {
            kind: 'subagent',
            id: `subagent-${ref.agentId}`,
            subagentId: ref.agentId,
            parentAgentId,
            parentToolCallId: frame.toolCallId,
            parentTurnId: item.turnId,
            name: task?.name ?? task?.subagentName ?? existing?.name ?? ref.agentId,
            description: existing?.description ?? task?.description ?? instruction,
            instruction: instruction ?? existing?.instruction,
            model: existing?.model,
            thinkingEffort: existing?.thinkingEffort,
            status:
              existing?.status ??
              (task === undefined
                ? frame.state === 'running'
                  ? 'running'
                  : 'unknown'
                : mapTaskState(task.state)),
            summary:
              existing?.summary ??
              task?.resultSummary ??
              (task?.outputTail === '' ? undefined : task?.outputTail),
            error: existing?.error ?? task?.error,
            usage: existing?.usage ?? task?.usage,
            startedAt: existing?.startedAt ?? task?.startedAt ?? frame.startedAt,
            endedAt: existing?.endedAt ?? task?.endedAt,
            toolCallCount: existing?.toolCallCount ?? 0,
            transcript: [],
          });
        }
      }
    }
  }
  // Terminal entries are per run (task), not per agent: a child resumed for a
  // second run keeps both completions in the timeline instead of collapsing
  // them into one. Only runs admitted into this page window (taskref items)
  // qualify — the global task roster must not leak off-page history in.
  const terminalMarked = new Set<string>();
  for (const [agentId, agentTasks] of tasksByAgent) {
    for (const task of agentTasks) {
      if (!admittedTaskIds.has(task.taskId)) continue;
      const terminal = terminalEventForStatus(mapTaskState(task.state));
      if (terminal === undefined) continue;
      terminalMarked.add(agentId);
      rawEvents.push({
        id: `subagent-event-${agentId}-${terminal}-${task.taskId}`,
        subagentId: agentId,
        event: terminal,
        at: task.endedAt,
      });
    }
  }
  // Fallback for agents known only through tool frames (no task on the roster):
  // still surface their terminal state once.
  for (const block of byAgent.values()) {
    if (terminalMarked.has(block.subagentId)) continue;
    const terminal = terminalEventForStatus(block.status);
    if (terminal === undefined) continue;
    rawEvents.push({
      id: `subagent-event-${block.subagentId}-${terminal}`,
      subagentId: block.subagentId,
      event: terminal,
      at: block.endedAt,
    });
  }
  const events: SubagentEventBlock[] = rawEvents.map((raw) => {
    const owner = byAgent.get(raw.subagentId);
    return {
      kind: 'subagent-event',
      id: raw.id,
      subagentId: raw.subagentId,
      parentAgentId,
      name: owner?.name ?? raw.subagentId,
      event: raw.event,
      status: owner?.status ?? 'unknown',
      at: raw.at,
      turnId: raw.turnId,
      anchorToolCallId: raw.anchorToolCallId,
    };
  });
  return { blocks: [...byAgent.values()], events };
}

function compareSubagentTimeline(left: SubagentBlock, right: SubagentBlock): number {
  const leftAt = blockTimelineMs(left);
  const rightAt = blockTimelineMs(right);
  if (leftAt !== undefined && rightAt !== undefined && leftAt !== rightAt) return leftAt - rightAt;
  if (leftAt !== undefined) return -1;
  if (rightAt !== undefined) return 1;
  return compareTimelineIds(left.id, right.id);
}

function nearestParentTurn(
  blocks: readonly Block[],
  subagent: SubagentBlock,
  beforeIndex?: number,
): string | undefined {
  if (subagent.parentTurnId !== undefined) return subagent.parentTurnId;
  if (beforeIndex !== undefined) {
    for (let index = beforeIndex - 1; index >= 0; index -= 1) {
      const turnId = blocks[index] === undefined ? undefined : blockTurnId(blocks[index]!);
      if (turnId !== undefined) return turnId;
    }
  }
  const startedAt = blockTimelineMs(subagent);
  if (startedAt === undefined) return undefined;
  let nearest: { turnId: string; at: number } | undefined;
  for (const candidate of blocks) {
    const turnId = blockTurnId(candidate);
    if (turnId === undefined) continue;
    const at = blockTimelineMs(candidate);
    if (at === undefined || at > startedAt) continue;
    if (nearest === undefined || at >= nearest.at) nearest = { turnId, at };
  }
  return nearest?.turnId;
}

function insertSubagentByTimeline(blocks: Block[], block: SubagentBlock): void {
  if (block.parentTurnId !== undefined) {
    let anchor = -1;
    for (let index = 0; index < blocks.length; index += 1) {
      if (sameTurnId(blockTurnId(blocks[index]!), block.parentTurnId)) anchor = index;
    }
    if (anchor >= 0) {
      while (
        blocks[anchor + 1]?.kind === 'subagent' &&
        sameTurnId((blocks[anchor + 1] as SubagentBlock).parentTurnId, block.parentTurnId) &&
        compareSubagentTimeline(blocks[anchor + 1] as SubagentBlock, block) <= 0
      ) {
        anchor += 1;
      }
      blocks.splice(anchor + 1, 0, block);
      return;
    }
  }
  insertByTimeline(blocks, block);
}

function insertSubagentBlocks(
  source: readonly Block[],
  subagents: readonly SubagentBlock[],
  previous: readonly Block[],
): Block[] {
  if (subagents.length === 0) return source.filter((block) => block.kind !== 'subagent');
  const sorted = [...subagents].sort(compareSubagentTimeline);
  const byParentTool = new Map<string, SubagentBlock[]>();
  for (const subagent of sorted) {
    const aliases = new Set(
      [subagent.parentToolCallId, subagent.parentToolCallUuid].filter(
        (alias): alias is string => alias !== undefined && alias !== '',
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
    blocks.push(candidate);
    const toolCallId =
      candidate.kind === 'tool'
        ? candidate.toolCallId
        : candidate.kind === 'shell'
          ? candidate.commandId
          : undefined;
    if (toolCallId === undefined) continue;
    const anchored = byParentTool.get(toolCallId);
    if (anchored === undefined) continue;
    for (const subagent of anchored) {
      if (inserted.has(subagent.subagentId)) continue;
      const parentTurnId = nearestParentTurn(source, subagent, index);
      blocks.push(parentTurnId === undefined ? subagent : { ...subagent, parentTurnId });
      inserted.add(subagent.subagentId);
    }
  }

  for (const subagent of sorted) {
    if (inserted.has(subagent.subagentId)) continue;
    const parentTurnId = nearestParentTurn(blocks, subagent);
    const placed = parentTurnId === undefined ? subagent : { ...subagent, parentTurnId };
    if (parentTurnId === undefined && insertAtPreviousPosition(blocks, placed, previous)) continue;
    insertSubagentByTimeline(blocks, placed);
  }
  return blocks;
}

/**
 * Lifecycle compact entries land by their own event timestamp (in-place
 * accounting); a timestamp-less event keeps its previous position when the
 * last publish already placed it, else sinks to the live edge. sent/resumed
 * entries carry the tool call that triggered them: while that ToolBlock is on
 * the page the entry anchors immediately after it — the timeline tiebreak
 * (`subagent-event-…` < `tool-…`) would otherwise park the effect in front of
 * its cause and split the surrounding tool run. Only a paged-out anchor falls
 * back to timeline placement.
 */
function insertSubagentEventBlocks(
  source: readonly Block[],
  events: readonly SubagentEventBlock[],
  previous: readonly Block[],
): Block[] {
  const blocks: Block[] = source.filter((block) => block.kind !== 'subagent-event');
  for (const event of events) {
    const anchorId = event.anchorToolCallId;
    if (anchorId !== undefined) {
      const toolIndex = blocks.findIndex(
        (candidate) =>
          (candidate.kind === 'tool' && candidate.toolCallId === anchorId) ||
          (candidate.kind === 'shell' && candidate.commandId === anchorId),
      );
      if (toolIndex >= 0) {
        // One tool can derive several entries (e.g. a multi-target resume):
        // stack them after the anchor in their derivation order.
        let at = toolIndex + 1;
        while (
          blocks[at]?.kind === 'subagent-event' &&
          (blocks[at] as SubagentEventBlock).anchorToolCallId === anchorId
        ) {
          at += 1;
        }
        blocks.splice(at, 0, event);
        continue;
      }
    }
    if (blockTimelineMs(event) === undefined && insertAtPreviousPosition(blocks, event, previous)) {
      continue;
    }
    insertByTimeline(blocks, event);
  }
  return blocks;
}

type ProjectedInteraction = {
  readonly block: ApprovalBlock | QuestionBlock;
  readonly toolCallId?: string;
  readonly turnId?: string;
  readonly frameId?: string;
};

function interactionPlacement(
  interaction: AgentTranscriptInteraction,
  block: ApprovalBlock | QuestionBlock,
): ProjectedInteraction {
  const anchor =
    typeof interaction.anchor === 'object' && interaction.anchor !== null
      ? (interaction.anchor as Record<string, unknown>)
      : undefined;
  const origin =
    typeof interaction.origin === 'object' && interaction.origin !== null
      ? (interaction.origin as Record<string, unknown>)
      : undefined;
  const request =
    typeof interaction.request === 'object' && interaction.request !== null
      ? (interaction.request as Record<string, unknown>)
      : undefined;
  const anchorKind = anchor === undefined ? undefined : recordString(anchor, 'kind');
  const directToolCallId =
    interaction.toolCallId === undefined || interaction.toolCallId === ''
      ? undefined
      : interaction.toolCallId;
  const toolCallId =
    directToolCallId ??
    (anchorKind === 'tool_call' && anchor !== undefined ? recordString(anchor, 'toolCallId', 'tool_call_id') : undefined) ??
    (request === undefined ? undefined : recordString(request, 'toolCallId', 'tool_call_id')) ??
    block.request.tool_call_id;
  const rawTurnId =
    (anchorKind === 'turn' || anchorKind === 'step' || anchorKind === 'frame') && anchor !== undefined
      ? anchor['turnId'] ?? anchor['turn_id']
      : undefined;
  const turnId =
    normalizeTurnId(rawTurnId) ??
    normalizeTurnId(origin?.['turnId'] ?? origin?.['turn_id']) ??
    normalizeTurnId(request?.['turnId'] ?? request?.['turn_id']) ??
    normalizeTurnId(block.request.turn_id);
  const frameId =
    anchorKind === 'frame' && anchor !== undefined
      ? recordString(anchor, 'frameId', 'frame_id')
      : undefined;
  return { block, toolCallId, turnId, frameId };
}

function compareProjectedInteraction(left: ProjectedInteraction, right: ProjectedInteraction): number {
  const leftAt = blockTimelineMs(left.block);
  const rightAt = blockTimelineMs(right.block);
  if (leftAt !== undefined && rightAt !== undefined && leftAt !== rightAt) return leftAt - rightAt;
  if (leftAt !== undefined) return -1;
  if (rightAt !== undefined) return 1;
  return compareTimelineIds(left.block.id, right.block.id);
}

function insertAfterAnchor(blocks: Block[], anchor: number, block: ApprovalBlock | QuestionBlock): void {
  let index = anchor + 1;
  while (blocks[index]?.kind === 'approval' || blocks[index]?.kind === 'question') index += 1;
  blocks.splice(index, 0, block);
}

function insertInteractionBlocks(
  source: readonly Block[],
  interactions: readonly AgentTranscriptInteraction[],
  agentId: string,
  previous: readonly Block[],
): Block[] {
  const blocks = source.filter((block) => block.kind !== 'approval' && block.kind !== 'question');
  // Resolution upserts (`interaction.upsert` with a terminal state) replace
  // the interaction record in the store wholesale and arrive WITHOUT the
  // request payload — rebuilds would fall back to placeholder tool/action
  // text. Carry the pending card's request forward when the upsert omits it.
  const previousById = new Map(previous.map((block) => [block.id, block]));
  const projected = interactions
    .flatMap((interaction): ProjectedInteraction[] => {
      let block = interactionToBlock(interaction, agentId);
      if (
        (block?.kind === 'approval' || block?.kind === 'question') &&
        (interaction.request === undefined || interaction.request === null)
      ) {
        const prior = previousById.get(block.id);
        if (prior?.kind === block.kind) block = { ...block, request: prior.request } as typeof block;
      }
      return block?.kind === 'approval' || block?.kind === 'question'
        ? [interactionPlacement(interaction, block)]
        : [];
    })
    .sort(compareProjectedInteraction);

  for (const interaction of projected) {
    if (blocks.some((candidate) => candidate.id === interaction.block.id)) continue;
    if (interaction.frameId !== undefined) {
      const anchor = blocks.findLastIndex(
        (candidate) => candidate.id === `agent-frame-${interaction.frameId}`,
      );
      if (anchor >= 0) {
        insertAfterAnchor(blocks, anchor, interaction.block);
        continue;
      }
    }
    if (interaction.toolCallId !== undefined) {
      const anchor = blocks.findLastIndex(
        (candidate) =>
          (candidate.kind === 'tool' && candidate.toolCallId === interaction.toolCallId) ||
          (candidate.kind === 'shell' && candidate.commandId === interaction.toolCallId),
      );
      if (anchor >= 0) {
        insertAfterAnchor(blocks, anchor, interaction.block);
        continue;
      }
    }
    if (interaction.turnId !== undefined) {
      const anchor = blocks.findLastIndex((candidate) =>
        sameTurnId(blockTurnId(candidate), interaction.turnId),
      );
      if (anchor >= 0) {
        insertAfterAnchor(blocks, anchor, interaction.block);
        continue;
      }
    }
    if (insertAtPreviousPosition(blocks, interaction.block, previous)) continue;
    insertByTimeline(blocks, interaction.block);
  }
  return blocks;
}

function isPromptIdentity(block: Block, promptId: string, userMessageId?: string): boolean {
  if (block.kind !== 'user') return false;
  return (
    block.promptId === promptId ||
    block.userMessageId === promptId ||
    (userMessageId !== undefined && block.userMessageId === userMessageId)
  );
}

function sameMedia(
  left: readonly MediaRef[] | undefined,
  right: readonly MediaRef[] | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      item.kind === other.kind &&
      item.url === other.url &&
      item.path === other.path &&
      item.name === other.name &&
      item.mime === other.mime &&
      item.size === other.size &&
      item.fileId === other.fileId
    );
  });
}

function upsertPromptItemBlocks(
  blocks: readonly Block[],
  item: PromptItem,
  mediaOverride?: readonly MediaRef[],
): readonly Block[] {
  const projection = projectMessageContent(item.content);
  const text = projection.text;
  const media = mediaOverride ?? projection.media;
  const nextMedia = media.length === 0 ? undefined : media;
  const stableIndex = blocks.findIndex(
    (block): block is UserBlock =>
      block.kind === 'user' &&
      (block.userMessageId === item.user_message_id || block.promptId === item.prompt_id),
  );
  if (stableIndex >= 0) {
    const existing = blocks[stableIndex] as UserBlock;
    const nextStatus = isRegeneratingJournalUser(existing, {
      promptId: item.prompt_id,
      userMessageId: item.user_message_id,
      status: item.status,
    })
      ? undefined
      : item.status;
    if (
      existing.promptStatus === nextStatus &&
      existing.text === text &&
      sameMedia(existing.media, nextMedia)
    ) {
      return blocks;
    }
    const next = blocks.slice();
    next[stableIndex] = { ...existing, text, promptStatus: nextStatus, media: nextMedia };
    return next;
  }
  const split = splitSystemReminders(text);
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
  const additions = classifiedTextToBlocks({
    id: item.user_message_id,
    classified: classifyTranscriptText({ text, role: 'user', origin: { kind: 'user' } }),
    createdAt: item.created_at,
    media,
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

function stampPromptIdentity(
  blocks: readonly Block[],
  prompt: TranscriptPrompt,
  promptStatus: PromptStatus | undefined,
): Block[] {
  const next = [...blocks];
  const matchIndex = next.findIndex((block) => isPromptIdentity(block, prompt.promptId, prompt.userMessageId));
  if (matchIndex >= 0) {
    const existing = next[matchIndex]!;
    if (existing.kind !== 'user') return next;
    const userMessageId = existing.userMessageId ?? prompt.userMessageId;
    if (existing.userMessageId === userMessageId && existing.promptStatus === promptStatus) return next;
    const identity = userMessageId ?? existing.id.replace(/^user-/, '');
    next[matchIndex] = {
      ...existing,
      id: `user-${identity}`,
      promptId: existing.promptId ?? prompt.promptId,
      userMessageId,
      promptStatus,
    };
    return next;
  }
  const index = next.findLastIndex(
    (block): block is UserBlock =>
      block.kind === 'user' &&
      block.turnId !== undefined &&
      block.promptId === undefined &&
      block.userMessageId === undefined,
  );
  if (index < 0) return next;
  const existing = next[index] as UserBlock;
  const identity = prompt.userMessageId ?? existing.userMessageId ?? existing.id.replace(/^user-/, '');
  next[index] = {
    ...existing,
    id: `user-${identity}`,
    promptId: prompt.promptId,
    userMessageId: prompt.userMessageId ?? existing.userMessageId,
    promptStatus,
  };
  return next;
}

function stampRunningPromptIdentity(blocks: readonly Block[], prompt: TranscriptPrompt): Block[] {
  return stampPromptIdentity(blocks, prompt, 'running');
}

function keepPreviousUser(
  next: readonly Block[],
  previousUser: UserBlock | undefined,
  previous: readonly Block[],
): Block[] {
  if (previousUser === undefined) return [...next];
  if (next.some((block) => block.id === previousUser.id || (block.kind === 'user' && isPromptIdentity(block, previousUser.promptId ?? '', previousUser.userMessageId)))) {
    return [...next];
  }
  const merged = [...next];
  if (insertAtPreviousPosition(merged, previousUser, previous)) return merged;
  insertByTimeline(merged, previousUser);
  return merged;
}

function settleCompletedPrompts(blocks: readonly Block[], prompts: readonly TranscriptPrompt[]): Block[] {
  let next = [...blocks];
  for (const prompt of prompts) {
    if (prompt.status === 'completed') next = settleCompletedPrompt(next, prompt);
  }
  return next;
}

function settleCompletedPrompt(blocks: readonly Block[], prompt: TranscriptPrompt): Block[] {
  let next = stampPromptIdentity(blocks, prompt, undefined);
  const matches = next.filter(
    (block): block is UserBlock =>
      block.kind === 'user' && isPromptIdentity(block, prompt.promptId, prompt.userMessageId),
  );
  if (matches.length > 1) {
    const keep = matches.find((block) => block.turnId !== undefined) ?? matches[0]!;
    next = next.filter((block) => block.kind !== 'user' || !isPromptIdentity(block, prompt.promptId, prompt.userMessageId) || block.id === keep.id);
  }
  return next.map((block) =>
    block.kind === 'user' && isPromptIdentity(block, prompt.promptId, prompt.userMessageId)
      ? { ...block, promptStatus: undefined }
      : block,
  );
}

function isRegeneratingJournalUser(
  existing: Pick<UserBlock, 'userMessageId' | 'promptId' | 'promptStatus'> | undefined,
  prompt: { readonly promptId: string; readonly userMessageId?: string; readonly status: string },
): boolean {
  return (
    existing !== undefined &&
    existing.userMessageId !== undefined &&
    existing.userMessageId === prompt.userMessageId &&
    existing.promptId !== undefined &&
    existing.promptId !== prompt.promptId
  );
}

function mergeTranscriptPromptBlocks(
  blocks: Block[],
  prompts: readonly TranscriptPrompt[],
  previous: readonly Block[] = [],
): Block[] {
  let next = blocks;
  for (const prompt of prompts) {
    if (prompt.status === 'completed') {
      next = settleCompletedPrompt(next, prompt);
      continue;
    }
    if (prompt.status === 'aborted' || prompt.status === 'failed') {
      next = next.map((block) =>
        block.kind === 'user' && isPromptIdentity(block, prompt.promptId, prompt.userMessageId)
          ? { ...block, promptStatus: undefined }
          : block,
      );
      const noticeId = `notice-aborted-${prompt.promptId}`;
      if (!next.some((block) => block.id === noticeId)) {
        next = [
          ...next,
          {
            kind: 'notice',
            id: noticeId,
            text: 'Prompt aborted',
            tone: 'neutral',
            i18n: { key: 'notice.promptAborted' },
          },
        ];
      }
      continue;
    }
    if (prompt.status !== 'queued' && prompt.status !== 'blocked' && prompt.status !== 'running') {
      continue;
    }
    const parts = promptContentParts(prompt.content);
    const projection = projectMessageContent(parts);
    if (prompt.status === 'running') {
      const previousUser = previous.find(
        (block): block is UserBlock =>
          block.kind === 'user' && isPromptIdentity(block, prompt.promptId, prompt.userMessageId),
      );
      if (isRegeneratingJournalUser(previousUser, prompt)) {
        next = keepPreviousUser(next, previousUser, previous);
        next = stampPromptIdentity(next, prompt, undefined);
        continue;
      }
      next = stampRunningPromptIdentity(next, prompt);
      if (parts.length === 0) continue;
    }
    if (prompt.steeredAt !== undefined) continue;
    if (parts.length === 0 && prompt.userMessageId === undefined) continue;
    const item: PromptItem = {
      prompt_id: prompt.promptId,
      user_message_id: prompt.userMessageId ?? prompt.promptId,
      status: prompt.status,
      content: parts.length > 0 ? parts : [{ type: 'text', text: projection.text }],
      created_at: prompt.createdAt,
    };
    next = [...upsertPromptItemBlocks(next, item, projection.media.length > 0 ? projection.media : undefined)];
  }
  return next;
}

export function retainPendingPromptBlocks(previous: readonly Block[], next: Block[]): Block[] {
  const known = new Set<string>();
  for (const block of next) {
    if (block.kind !== 'user') continue;
    if (block.promptId !== undefined) known.add(`p:${block.promptId}`);
    if (block.userMessageId !== undefined) known.add(`u:${block.userMessageId}`);
  }
  const abortedPromptIds = new Set(
    next
      .filter((block) => block.kind === 'notice' && block.id.startsWith('notice-aborted-'))
      .map((block) => block.id.slice('notice-aborted-'.length)),
  );
  const extras: Block[] = [];
  for (const block of previous) {
    if (block.kind !== 'user') continue;
    const abortedPromptId = block.promptId;
    const aborted = abortedPromptId !== undefined && abortedPromptIds.has(abortedPromptId);
    if (aborted) {
      if (!next.some((candidate) => candidate.kind === 'user' && isPromptIdentity(candidate, abortedPromptId, block.userMessageId))) {
        extras.push({ ...block, promptStatus: undefined });
      }
      continue;
    }
    if (block.promptStatus !== 'queued' && block.promptStatus !== 'blocked' && block.promptStatus !== 'running') {
      continue;
    }
    if (block.promptId !== undefined && known.has(`p:${block.promptId}`)) continue;
    if (block.userMessageId !== undefined && known.has(`u:${block.userMessageId}`)) continue;
    if (block.promptId !== undefined || block.userMessageId !== undefined) extras.push(block);
  }
  if (extras.length === 0) return next;
  const merged = [...next];
  for (const block of extras) {
    if (insertAtPreviousPosition(merged, block, previous)) continue;
    insertByTimeline(merged, block);
  }
  return merged;
}

export function stabilizeProjectedBlocks(
  previous: readonly Block[],
  next: readonly Block[],
): readonly Block[] {
  if (previous.length === 0 || next.length === 0) return next;
  let previousById: ReadonlyMap<string, Block> | undefined;
  let allStable = previous.length === next.length;
  const stable = next.map((block, index) => {
    let candidate = previous[index];
    if (candidate?.id !== block.id) {
      allStable = false;
      previousById ??= new Map(previous.map((item) => [item.id, item]));
      candidate = previousById.get(block.id);
    }
    if (candidate !== undefined && transcriptValueEquals(candidate, block)) return candidate;
    allStable = false;
    return block;
  });
  return allStable ? previous : stable;
}

/**
 * Defensive read of the supplemental `executor.turn.metadata` projection
 * (`TranscriptTurn.execution`). The contract type lands in
 * `packages/transcript`; until then the field arrives untyped, and a malformed
 * payload must degrade to "no badge" instead of breaking the projection.
 * Accepts camelCase (transcript model) and snake_case (REST passthrough).
 */
export function turnExecutionFromItem(item: object): TurnExecutionInfo | undefined {
  const raw = (item as { readonly execution?: unknown }).execution;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const executorId = record['executorId'] ?? record['executor_id'];
  const protocol = record['protocol'];
  if (typeof executorId !== 'string' || executorId === '') return undefined;
  if (typeof protocol !== 'string' || protocol === '') return undefined;
  const resumeMode = record['resumeMode'] ?? record['resume_mode'];
  const losses = Array.isArray(record['losses'])
    ? record['losses'].filter((code): code is string => typeof code === 'string')
    : [];
  return {
    executorId,
    protocol,
    resumeMode: typeof resumeMode === 'string' ? resumeMode : undefined,
    fidelity: record['fidelity'] === 'degraded' ? 'degraded' : 'full',
    losses,
  };
}

function sameTurnExecution(
  left: TurnExecutionInfo | undefined,
  right: TurnExecutionInfo,
): boolean {
  return (
    left !== undefined &&
    left.executorId === right.executorId &&
    left.protocol === right.protocol &&
    left.resumeMode === right.resumeMode &&
    left.fidelity === right.fidelity &&
    left.losses.length === right.losses.length &&
    left.losses.every((code, index) => code === right.losses[index])
  );
}

function turnTailFromItem(item: {
  readonly turnId: string;
  readonly state?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly steps: readonly { readonly timing?: { readonly llmFirstTokenLatencyMs?: number }; readonly usage?: { readonly output: number } }[];
}): TurnTailInfo | undefined {
  if (item.state !== 'completed' && item.state !== 'failed' && item.state !== 'cancelled') return undefined;
  if (item.endedAt === undefined) return undefined;
  const timing = item.steps.find((step) => step.timing?.llmFirstTokenLatencyMs !== undefined)?.timing;
  const output = item.steps.reduce((sum, step) => sum + (step.usage?.output ?? 0), 0);
  return {
    turnId: item.turnId,
    endedAt: item.endedAt,
    durationMs: item.durationMs,
    ttftMs: timing?.llmFirstTokenLatencyMs,
    usage:
      item.usage === undefined
        ? undefined
        : {
            inputOther: item.usage.inputTokens ?? 0,
            output: item.usage.outputTokens ?? 0,
            inputCacheRead: 0,
            inputCacheCreation: 0,
          },
    tokensPerSecond:
      item.durationMs !== undefined && item.durationMs > 0 && output > 0
        ? (output / item.durationMs) * 1000
        : undefined,
  };
}

function turnRetryFromItem(
  item:
    | {
        readonly state?: string;
        readonly steps: readonly {
          readonly state?: string;
          readonly retry?: {
            readonly failedAttempt: number;
            readonly maxAttempts: number;
            readonly delayMs: number;
            readonly errorName?: string;
            readonly statusCode?: number;
          };
        }[];
      }
    | undefined,
): TurnRetryInfo | undefined {
  if (item === undefined || item.state !== 'running') return undefined;
  const step = item.steps.at(-1);
  if (step?.state !== 'running' || step.retry === undefined) return undefined;
  return {
    failedAttempt: step.retry.failedAttempt,
    maxAttempts: step.retry.maxAttempts,
    delayMs: step.retry.delayMs,
    errorName: step.retry.errorName,
    statusCode: step.retry.statusCode,
  };
}

const terminalTurnProjectionCache = new WeakMap<object, Map<string, readonly Block[]>>();

function isTerminalTurn(item: object): boolean {
  const state = (item as { readonly state?: unknown }).state;
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function turnHasAttachments(item: {
  readonly attachmentIds?: readonly string[];
  readonly steps: readonly { readonly frames: readonly object[] }[];
}): boolean {
  if (item.attachmentIds !== undefined && item.attachmentIds.length > 0) return true;
  for (const step of item.steps) {
    for (const frame of step.frames) {
      const attachmentIds = (frame as { readonly attachmentIds?: readonly string[] }).attachmentIds;
      if (attachmentIds !== undefined && attachmentIds.length > 0) return true;
    }
  }
  return false;
}

function turnHasTaskBackedFrame(item: {
  readonly steps: readonly { readonly frames: readonly object[] }[];
}): boolean {
  return item.steps.some((step) =>
    step.frames.some((frame) => {
      const candidate = frame as { readonly kind?: unknown; readonly taskId?: unknown };
      return candidate.kind === 'tool' && typeof candidate.taskId === 'string' && candidate.taskId !== '';
    }),
  );
}

function cacheTerminalTurnBlocks(
  item: object,
  agentId: string,
  blocks: readonly Block[],
): void {
  const existing = terminalTurnProjectionCache.get(item);
  if (existing !== undefined) {
    existing.set(agentId, blocks);
    return;
  }
  terminalTurnProjectionCache.set(item, new Map([[agentId, blocks]]));
}

export function agentTranscriptToBlocks(
  response: AgentTranscriptProjectionSource | AgentTranscriptResponse,
  previous: readonly Block[] = [],
): Block[] {
  const blocks: Block[] = [];
  const deferredTaskBlocks: Block[] = [];
  const subagentPromptAsUser = response.agent_id !== MAIN_AGENT_ID;
  const phase = response.meta?.agent?.phase;
  const prompts = response.prompts ?? [];
  const tasks = response.tasks ?? [];
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const shellFrameTaskIds = new Set<string>();
  for (const item of response.items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind !== 'tool') continue;
        const taskId = (frame as typeof frame & { readonly taskId?: string }).taskId;
        if (taskId !== undefined && taskById.get(taskId)?.kind === 'shell') shellFrameTaskIds.add(taskId);
      }
    }
  }
  const attachments = response.attachments ?? [];
  const attachmentsById =
    attachments.length === 0
      ? undefined
      : new Map(attachments.map((attachment) => [attachment.attachmentId, attachment]));
  for (const item of response.items) {
    if (item.kind === 'marker') {
      const marker = markerToBlock(item);
      if (marker !== undefined) blocks.push(marker);
      continue;
    }
    if (item.kind === 'taskref') {
      const task = taskById.get(item.taskId);
      if (task === undefined || task.kind === 'subagent') continue;
      if (task.kind === 'shell') {
        if (shellFrameTaskIds.has(task.taskId)) continue;
        deferredTaskBlocks.push({
          kind: 'shell',
          id: `shell-${task.taskId}`,
          commandId: task.taskId,
          output: task.outputTail === '' ? (task.description ?? task.taskId) : task.outputTail,
          done: task.state !== 'running',
          isError:
            task.state === 'failed' ||
            task.state === 'timed_out' ||
            task.state === 'killed' ||
            task.state === 'lost',
          startedAt: timestampMs(item.at ?? task.startedAt),
        });
        continue;
      }
      blocks.push({
        kind: 'notice',
        id: `agent-taskref-${item.refId}`,
        text: task.description ?? task.taskId,
        tone: task.state === 'failed' ? 'danger' : 'neutral',
      });
      continue;
    }
    if (item.kind !== 'turn') continue;
    const terminal = isTerminalTurn(item);
    const cacheableTerminal = terminal && !turnHasAttachments(item) && !turnHasTaskBackedFrame(item);
    if (cacheableTerminal) {
      const cached = terminalTurnProjectionCache.get(item)?.get(response.agent_id);
      if (cached !== undefined) {
        blocks.push(...cached);
        continue;
      }
    }
    const blockStart = blocks.length;
    const origin = originFromTurnItem(item);
    const identity = identityFromTurnOrigin(origin);
    const turnUserMessageId = turnMessageId(item) ?? identity.userMessageId;
    let projectedTurnPrompt = false;
    if (item.prompt !== undefined && item.prompt.trim() !== '') {
      const promptBlocks = classifiedTextToBlocks({
        id: turnUserMessageId ?? `agent-turn-${item.turnId}-prompt`,
        classified: classifyTranscriptText({
          text: item.prompt,
          role: 'user',
          origin,
          subagentPromptAsUser,
        }),
        createdAt: item.startedAt ?? '',
        turnId: item.turnId,
        promptId: identity.promptId,
        userMessageId: turnUserMessageId,
        media: mediaFromAttachmentIds(
          (item as { attachmentIds?: readonly string[] }).attachmentIds,
          attachmentsById,
        ),
      });
      projectedTurnPrompt = promptBlocks.some((block) => block.kind === 'user');
      blocks.push(...promptBlocks);
    }
    const lastAssistantFrameId = item.steps
      .flatMap((step) => step.frames)
      .findLast((frame) => frame.kind === 'text' && frame.role === 'assistant')?.frameId;
    for (const step of item.steps) {
      let lastTextFrameId: string | undefined;
      let lastThinkingFrameId: string | undefined;
      for (let index = step.frames.length - 1; index >= 0; index -= 1) {
        const candidate = step.frames[index]!;
        if (lastTextFrameId === undefined && candidate.kind === 'text') {
          lastTextFrameId = candidate.frameId;
        }
        if (lastThinkingFrameId === undefined && candidate.kind === 'thinking') {
          lastThinkingFrameId = candidate.frameId;
        }
        if (lastTextFrameId !== undefined && lastThinkingFrameId !== undefined) break;
      }
      for (const frame of step.frames) {
        switch (frame.kind) {
          case 'text':
            if (frame.role === 'user') {
              const frameOrigin = originFromFrame(frame);
              const turnOrigin = originFromTurnItem(item);
              const taskOrigin = frame.taskId !== undefined ? { kind: 'task', taskId: frame.taskId } : undefined;
              const origin = frameOrigin ?? taskOrigin ?? (isUserVisibleOrigin(turnOrigin) ? turnOrigin : undefined);
              const userMessageId = frameMessageId(frame);
              if (
                projectedTurnPrompt &&
                userMessageId !== undefined &&
                turnUserMessageId !== undefined &&
                userMessageId === turnUserMessageId
              ) {
                break;
              }
              blocks.push(
                ...classifiedTextToBlocks({
                  id: userMessageId ?? `agent-frame-${frame.frameId}`,
                  classified: classifyTranscriptText({
                    text: frame.text,
                    role: 'user',
                    origin,
                    id: frame.frameId,
                    subagentPromptAsUser,
                  }),
                  createdAt: step.startedAt ?? item.startedAt ?? '',
                  turnId: item.turnId,
                  userMessageId,
                  media: mediaFromAttachmentIds(
                    (frame as { attachmentIds?: readonly string[] }).attachmentIds,
                    attachmentsById,
                  ),
                }),
              );
              break;
            }
            {
              const messageId = frameMessageId(frame) ?? turnMessageId(item);
              blocks.push({
                kind: 'assistant',
                id: `agent-frame-${frame.frameId}`,
                text: frame.text,
                streaming: isLiveStreamingFrame(item, step, frame, lastTextFrameId, phase),
                stopped:
                  'state' in item && item.state === 'cancelled' && frame.frameId === lastAssistantFrameId,
                createdAt: step.endedAt ?? item.endedAt,
                turnId: item.turnId,
                messageId,
                media: mediaFromAttachmentIds(
                  (frame as { attachmentIds?: readonly string[] }).attachmentIds,
                  attachmentsById,
                ),
              });
            }
            break;
          case 'thinking':
            blocks.push({
              kind: 'thinking',
              id: `agent-frame-${frame.frameId}`,
              text: frame.text,
              streaming: isLiveStreamingFrame(item, step, frame, lastThinkingFrameId, phase),
              createdAt: step.endedAt ?? item.endedAt,
              turnId: item.turnId,
            });
            break;
          case 'tool': {
            const startedAt = timestampMs(frame.startedAt);
            const endedAt = timestampMs(frame.endedAt);
            const toolFrame = frame as typeof frame & { view?: string; taskId?: string };
            const task = toolFrame.taskId === undefined ? undefined : taskById.get(toolFrame.taskId);
            const shellTask = task?.kind === 'shell' ? task : undefined;
            const isShell =
              toolFrame.name === 'Bash' ||
              toolFrame.view === 'shell' ||
              (toolFrame.taskId !== undefined && toolFrame.name.toLowerCase().includes('shell'));
            if (
              isShell &&
              (shellTask !== undefined ||
                frame.output !== undefined ||
                frame.inputText !== undefined ||
                typeof frame.input === 'object')
            ) {
              const command =
                typeof (frame.input as { command?: unknown } | undefined)?.command === 'string'
                  ? `$ ${(frame.input as { command: string }).command}`
                  : frame.inputText ?? '';
              const frameOutput =
                typeof frame.output === 'string'
                  ? frame.output
                  : typeof frame.output === 'object' && frame.output !== null && 'stdout' in (frame.output as object)
                    ? String((frame.output as { stdout?: unknown }).stdout ?? '')
                    : frame.error ?? command;
              const output =
                shellTask?.outputTail === '' || shellTask?.outputTail === undefined
                  ? frameOutput
                  : shellTask.outputTail;
              blocks.push({
                kind: 'shell',
                id: `shell-${frame.toolCallId}`,
                commandId: frame.toolCallId,
                output: output === '' ? command : output,
                done: shellTask === undefined ? frame.state !== 'running' : shellTask.state !== 'running',
                isError:
                  shellTask === undefined
                    ? frame.state === 'error'
                    : shellTask.state === 'failed' ||
                      shellTask.state === 'timed_out' ||
                      shellTask.state === 'killed' ||
                      shellTask.state === 'lost',
                startedAt: timestampMs(shellTask?.startedAt) ?? startedAt,
                turnId: item.turnId,
              });
              break;
            }
            blocks.push({
              kind: 'tool',
              id: `tool-${frame.toolCallId}`,
              toolCallId: frame.toolCallId,
              name: frame.name,
              argsText: frame.inputText ?? '',
              args: frame.input,
              display: frame.display as ToolInputDisplay | undefined,
              description: undefined,
              status: frame.state === 'error' ? 'error' : frame.state === 'interrupted' ? 'stopped' : frame.state,
              output: frame.output ?? frame.error,
              isError: frame.state === 'error',
              startedAt,
              durationMs:
                startedAt !== undefined && endedAt !== undefined
                  ? Math.max(0, endedAt - startedAt)
                  : item.durationMs,
              durationSource:
                startedAt !== undefined && endedAt !== undefined
                  ? 'frame'
                  : item.durationMs === undefined
                    ? undefined
                    : 'turn',
              progressText: frame.progress?.text,
              agentRefs: frame.agentRefs,
              turnId: item.turnId,
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
    if (cacheableTerminal) {
      cacheTerminalTurnBlocks(item, response.agent_id, blocks.slice(blockStart));
    }
  }
  const withTaskBlocks = [...mergeTranscriptPromptBlocks(blocks, prompts, previous)];
  for (const block of deferredTaskBlocks) {
    if (
      blockTimelineMs(block) === undefined &&
      insertAtPreviousPosition(withTaskBlocks, block, previous)
    ) {
      continue;
    }
    insertByTimeline(withTaskBlocks, block);
  }
  const projectedSubagents = subagentBlocksFromSnapshot(response, response.agent_id);
  const withSubagents = insertSubagentBlocks(withTaskBlocks, projectedSubagents.blocks, previous);
  const withSubagentEvents = insertSubagentEventBlocks(withSubagents, projectedSubagents.events, previous);
  return insertInteractionBlocks(
    withSubagentEvents,
    response.interactions ?? [],
    response.agent_id,
    previous,
  );
}

export function latestFinalAssistantBlockId(blocks: readonly Block[]): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind === 'assistant' && !block.streaming) return block.id;
  }
  return undefined;
}

export function assistantMessageIdFromBlockId(blockId: string): string | undefined {
  if (blockId.startsWith('assistant-live-') || blockId.startsWith('agent-frame-')) return undefined;
  const match = /^assistant-(.+)-(?:\d+|media)$/.exec(blockId);
  return match?.[1];
}

export function assistantMessageIdFromBlock(block: AssistantBlock): string | undefined {
  return block.messageId ?? assistantMessageIdFromBlockId(block.id);
}

function isPromptContentArray(content: unknown): content is PromptItem['content'] {
  return Array.isArray(content);
}

export function appendLocalUserMessage(
  state: SessionViewState,
  input: {
    userMessageId: string;
    promptId: string;
    text: string;
    createdAt: string;
    status: PromptStatus;
    media?: readonly MediaRef[];
    clientRequestId?: string;
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
  let blocks = upsertPromptItemBlocks(state.blocks, item, input.media);
  if (input.clientRequestId !== undefined) {
    blocks = blocks.map((block) =>
      block.kind === 'user' && (block.userMessageId === input.userMessageId || block.promptId === input.promptId)
        ? { ...block, clientRequestId: input.clientRequestId, id: `user-${input.userMessageId}` }
        : block,
    );
  }
  return bump(state, {
    busy: input.status === 'running' ? true : state.busy,
    activePromptId: input.status === 'running' ? input.promptId : state.activePromptId,
    queuedPromptIds,
    blocks: [...blocks],
  });
}

function projectGoalSnapshot(goal: {
  readonly objective: string;
  readonly status: GoalSnapshot['status'];
  readonly completionCriterion?: string;
  readonly budgetUsed?: number;
  readonly budgetLimit?: number;
}): GoalSnapshot {
  const tokenBudget = goal.budgetLimit ?? null;
  const tokensUsed = goal.budgetUsed ?? 0;
  return {
    goalId: 'transcript',
    objective: goal.objective,
    completionCriterion: goal.completionCriterion,
    status: goal.status,
    turnsUsed: 0,
    tokensUsed,
    wallClockMs: 0,
    budget: {
      tokenBudget,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - tokensUsed),
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: tokenBudget !== null && tokensUsed >= tokenBudget,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: tokenBudget !== null && tokensUsed > tokenBudget,
    },
  };
}

function mapTranscriptPermission(permission: 'manual' | 'yolo' | 'auto' | undefined): PermissionMode | undefined {
  if (permission === 'manual' || permission === 'yolo' || permission === 'auto') return permission;
  return undefined;
}

function projectTokenUsage(usage: {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}): TokenUsage {
  return {
    inputOther: usage.inputOther,
    output: usage.output,
    inputCacheRead: usage.inputCacheRead,
    inputCacheCreation: usage.inputCacheCreation,
  };
}

function projectUsageStatus(
  usage:
    | {
        readonly byModel?: Record<string, TokenUsage>;
        readonly currentTurn?: TokenUsage;
        readonly total?: TokenUsage;
      }
    | undefined,
): UsageStatus | undefined {
  if (usage === undefined) return undefined;
  let byModel: Record<string, TokenUsage> | undefined;
  if (usage.byModel !== undefined) {
    const mapped: Record<string, TokenUsage> = {};
    for (const [model, value] of Object.entries(usage.byModel)) mapped[model] = projectTokenUsage(value);
    byModel = mapped;
  }
  return {
    byModel,
    currentTurn: usage.currentTurn === undefined ? undefined : projectTokenUsage(usage.currentTurn),
    total: usage.total === undefined ? undefined : projectTokenUsage(usage.total),
  };
}

function transcriptTaskToSessionTask(task: TranscriptTask | AgentTranscriptTask): Task {
  const kind = task.kind === 'subagent' ? 'subagent' : task.kind === 'shell' ? 'bash' : 'tool';
  const status =
    task.state === 'running'
      ? 'running'
      : task.state === 'failed' || task.state === 'lost' || task.state === 'timed_out'
        ? 'failed'
        : task.state === 'killed'
          ? 'cancelled'
          : 'completed';
  return {
    id: task.taskId,
    session_id: '',
    kind,
    description: task.description ?? '',
    status,
    created_at: task.startedAt ?? '',
    started_at: task.startedAt,
    completed_at: task.endedAt,
    output_preview: task.outputTail,
    agent_id: task.agentId,
  };
}

export function projectAgentTranscriptView(
  previous: SessionViewState,
  agentId: string,
  snapshot: AgentState | AgentTranscriptSnapshot,
  options: { readonly retainPendingPrompts?: boolean } = {},
): SessionViewState {
  const source = agentStateToProjectionSource(agentId, snapshot);
  const projected = agentTranscriptToBlocks(source, previous.blocks);
  const retained =
    options.retainPendingPrompts === false
      ? projected
      : retainPendingPromptBlocks(previous.blocks, projected);
  const prompts = Array.isArray(snapshot.prompts) ? snapshot.prompts : [...snapshot.prompts.values()];
  const blocks = settleCompletedPrompts(retained, prompts);
  const withSnapshotFields = overlaySnapshotSubagentFields(blocks, previous.snapshotSubagents);
  const stableBlocks = stabilizeProjectedBlocks(previous.blocks, withSnapshotFields);
  let firstTurn: Extract<TranscriptItem, { kind: 'turn' }> | undefined;
  let lastTurn: Extract<TranscriptItem, { kind: 'turn' }> | undefined;
  // External-executor provenance per turn; entries reuse the previous object
  // when unchanged so badge props stay referentially stable across publishes.
  const previousExecutions = previous.turnExecutions;
  const turnExecutions: Record<string, TurnExecutionInfo> = {};
  let runningTurn: Extract<TranscriptItem, { kind: 'turn' }> | undefined;
  for (const item of snapshot.items) {
    if (item.kind !== 'turn') continue;
    firstTurn ??= item;
    lastTurn = item;
    if (item.state === 'running') runningTurn = item;
    const execution = turnExecutionFromItem(item);
    if (execution === undefined) continue;
    turnExecutions[item.turnId] = sameTurnExecution(previousExecutions[item.turnId], execution)
      ? previousExecutions[item.turnId]!
      : execution;
  }
  const parsedTurnStartedAt =
    runningTurn?.startedAt === undefined ? Number.NaN : Date.parse(runningTurn.startedAt);
  const meta = snapshot.meta.agent;
  const queuedPromptIds: string[] = [];
  let running: TranscriptPrompt | undefined;
  for (const prompt of prompts) {
    if (prompt.status === 'queued') queuedPromptIds.push(prompt.promptId);
    if (running === undefined && prompt.status === 'running') running = prompt;
  }
  const interactions = Array.isArray(snapshot.interactions)
    ? snapshot.interactions
    : [...snapshot.interactions.values()];
  const todos = Array.isArray(snapshot.todos) ? snapshot.todos : [...snapshot.todos.values()];
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [...snapshot.tasks.values()];
  let pendingInteraction: SessionPendingInteraction = 'none';
  for (const interaction of interactions) {
    if (interaction.state !== 'pending') continue;
    if (interaction.interactionKind === 'approval') {
      pendingInteraction = 'approval';
      break;
    }
    if (interaction.interactionKind === 'question') pendingInteraction = 'question';
  }
  const goal = snapshot.meta.goal;
  const turnTail = lastTurn === undefined ? undefined : turnTailFromItem(lastTurn);
  return {
    ...previous,
    version: previous.version + 1,
    blocks: stableBlocks,
    loaded: true,
    loadError: undefined,
    busy: agentBusyFromMeta(source) === true,
    turnStartedAt: Number.isNaN(parsedTurnStartedAt) ? undefined : parsedTurnStartedAt,
    model: meta?.model,
    thinkingEffort: meta?.thinkingEffort,
    contextTokens: meta?.contextTokens,
    maxContextTokens: meta?.maxContextTokens,
    usage: projectUsageStatus(meta?.usage),
    permissionMode: mapTranscriptPermission(meta?.permission),
    planMode: snapshot.meta.modes?.plan !== undefined,
    swarmMode: snapshot.meta.modes?.swarm !== undefined,
    queuedPromptIds,
    activePromptId: running?.promptId,
    pendingInteraction,
    todos: todos.at(-1)?.items ?? [],
    tasks: tasks.map(transcriptTaskToSessionTask),
    goal: goal === undefined ? null : projectGoalSnapshot(goal),
    hasMoreHistory: snapshot.hasMoreOlder === true,
    oldestMessageId: firstTurn?.turnId,
    turnExecutions,
    turnTail: turnTail ?? previous.turnTail,
    turnRetry: turnRetryFromItem(lastTurn),
  };
}

type KikiSessionSnapshot = SessionSnapshotResponse & {
  readonly context_tokens?: number;
  readonly max_context_tokens?: number;
};

function sessionCursorFromSnapshot(
  snapshot: KikiSessionSnapshot,
  previous?: SessionViewState,
): SessionViewState['cursor'] {
  const next = { seq: snapshot.as_of_seq, epoch: snapshot.epoch };
  if (previous === undefined) return next;
  if (previous.cursor.epoch !== undefined && snapshot.epoch !== previous.cursor.epoch) return next;
  if (previous.cursor.seq > snapshot.as_of_seq) return previous.cursor;
  return next;
}

export function applyTranscriptShell(
  sessionId: string,
  snapshot: KikiSessionSnapshot,
  previous?: SessionViewState,
): SessionViewState {
  const base = previous ?? createViewState(sessionId);
  return {
    ...base,
    version: base.version + 1,
    session: snapshot.session,
    cursor: sessionCursorFromSnapshot(snapshot, previous),
    busy: snapshot.session.main_turn_active ?? (snapshot.in_flight_turn !== null),
    model: snapshot.session.agent_config.model !== '' ? snapshot.session.agent_config.model : base.model,
    profile: snapshot.session.agent_config.profile ?? base.profile,
    permissionMode: snapshot.session.agent_config.permission_mode ?? base.permissionMode,
    planMode: snapshot.session.agent_config.plan_mode ?? base.planMode,
    swarmMode: snapshot.session.agent_config.swarm_mode ?? base.swarmMode,
    contextTokens: snapshot.context_tokens ?? base.contextTokens,
    maxContextTokens: snapshot.max_context_tokens ?? base.maxContextTokens,
    snapshotSubagents: snapshot.subagents ?? base.snapshotSubagents,
    loaded: true,
    loadError: undefined,
    resyncFailed: false,
    resyncAttempt: 0,
  };
}

function transcriptItemId(item: TranscriptItem): string {
  if (item.kind === 'turn') return item.turnId;
  if (item.kind === 'marker') return item.markerId;
  return item.refId;
}

export function prependOlderTranscriptSnapshot(
  current: AgentTranscriptSnapshot,
  older: Pick<AgentTranscriptSnapshot, 'items' | 'attachments'> & { readonly hasMore?: boolean; readonly has_more?: boolean },
): AgentTranscriptSnapshot {
  const existingIds = new Set(current.items.map(transcriptItemId));
  const prepended = older.items.filter((item) => !existingIds.has(transcriptItemId(item)));
  const existingAttachments = new Set(current.attachments.map((attachment) => attachment.attachmentId));
  const olderAttachments = older.attachments.filter(
    (attachment) => !existingAttachments.has(attachment.attachmentId),
  );
  return {
    ...current,
    items: [...prepended, ...current.items],
    attachments: [...olderAttachments, ...current.attachments],
    hasMoreOlder: older.hasMore ?? older.has_more ?? current.hasMoreOlder,
  };
}

export function agentBusyFromMeta(
  response: AgentTranscriptProjectionSource | AgentTranscriptResponse | undefined,
): boolean | undefined {
  if (response === undefined) return undefined;
  const kind = response.meta?.agent?.phase?.kind;
  if (
    kind === 'running' ||
    kind === 'streaming' ||
    kind === 'tool_call' ||
    kind === 'retrying' ||
    kind === 'awaiting_approval'
  ) {
    return true;
  }
  if (kind === 'idle' || kind === 'ended' || kind === 'interrupted') return false;
  if (response.meta?.activity === 'turn') return true;
  if (response.meta?.activity === 'idle' || response.meta?.activity === 'disposing') return false;
  if (response.prompts?.some((prompt) => prompt.status === 'running')) return true;
  if (response.interactions?.some((interaction) => interaction.state === 'pending')) return true;
  for (const item of response.items) {
    if (item.kind !== 'turn') continue;
    const itemState = 'state' in item ? item.state : undefined;
    if (itemState === 'running' || itemState === 'queued') return true;
    for (const step of item.steps) {
      const stepState = 'state' in step ? step.state : undefined;
      if (stepState === 'running') return true;
      if (step.frames.some((frame) => frame.kind === 'tool' && frame.state === 'running')) return true;
    }
  }
  return undefined;
}

export { isPromptContentArray };
