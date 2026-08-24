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
  Task,
  TokenUsage,
  ToolInputDisplay,
  UsageStatus,
} from '@moonshot-ai/protocol';
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
} from '../../lib/client';
import { mediaFromContentParts, type MediaRef } from '../../lib/media';
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
  type SteerBlock,
  type SubagentBlock,
  type SystemBlock,
  type SystemReminderBlock,
  type SystemVariant,
  type TodoItem,
  type ToolBlock,
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
  blocks.push(...reminderBlocks(input.id, input.createdAt, classified.reminders));
  return blocks;
}

function originFromTurnItem(item: unknown): PromptOriginLike | undefined {
  return originFromRecord(item);
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
  step: { readonly stepId: string; readonly state?: string; readonly frames: readonly { readonly frameId: string; readonly kind: string }[] },
  frame: { readonly frameId: string; readonly kind: string },
  phase: AgentTranscriptSnapshot['meta']['agent'] extends { phase?: infer P } ? P : unknown,
): boolean {
  if (item.state !== 'running' && item.state !== 'queued') return false;
  if (step.state !== 'running') return false;
  if (frame.kind !== 'text' && frame.kind !== 'thinking') return false;
  const lastOpen = [...step.frames].reverse().find((candidate) => candidate.kind === frame.kind);
  if (lastOpen?.frameId !== frame.frameId) return false;
  if (phase === undefined || typeof phase !== 'object' || phase === null) return true;
  const live = phase as { kind?: string; turnId?: number; stepId?: string; stream?: string };
  if (live.kind !== 'streaming') return false;
  if (live.stepId !== undefined && live.stepId !== step.stepId) return false;
  if (typeof live.turnId === 'number' && `t${live.turnId}` !== item.turnId) return false;
  if (live.stream === 'assistant') return frame.kind === 'text';
  if (live.stream === 'thinking') return frame.kind === 'thinking';
  return false;
}

function mediaFromAttachmentIds(
  ids: readonly string[] | undefined,
  attachments: readonly AgentTranscriptAttachment[] | undefined,
): readonly MediaRef[] | undefined {
  if (ids === undefined || ids.length === 0 || attachments === undefined) return undefined;
  const byId = new Map(attachments.map((attachment) => [attachment.attachmentId, attachment]));
  const media: MediaRef[] = [];
  for (const id of ids) {
    const attachment = byId.get(id);
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

function interactionToBlock(interaction: AgentTranscriptInteraction, agentId: string): Block | undefined {
  const originAgentId = originAgentFromInteraction(interaction);
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
      originAgentId,
      originUnknown: originAgentId === undefined && agentId === MAIN_AGENT_ID,
    } satisfies ApprovalBlock;
  }
  if (interaction.interactionKind === 'question') {
    const request = (interaction.request ?? {}) as { turnId?: number; questions?: unknown };
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
  const summaryKey = MARKER_SUMMARY_KEYS[item.marker as keyof typeof MARKER_SUMMARY_KEYS];
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

function spawnNameFromToolArgs(args: unknown, agentId: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const named = record['subagentType'] ?? record['name'] ?? record['subagentName'];
  if (typeof named === 'string' && named.trim() !== '') return named.trim();
  void agentId;
  return undefined;
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
  if (state === 'killed') return 'cancelled';
  if (state === 'completed') return 'completed';
  return 'unknown';
}

function subagentBlocksFromSnapshot(
  response: AgentTranscriptProjectionSource,
  parentAgentId: string,
): SubagentBlock[] {
  const tasks = response.tasks ?? [];
  const byAgent = new Map<string, SubagentBlock>();
  for (const task of tasks) {
    if (task.kind !== 'subagent' || task.agentId === undefined || task.agentId === '') continue;
    byAgent.set(task.agentId, {
      kind: 'subagent',
      id: `subagent-${task.agentId}`,
      subagentId: task.agentId,
      parentAgentId,
      parentToolCallId: undefined,
      name: task.description ?? task.agentId,
      description: task.description,
      model: undefined,
      thinkingEffort: undefined,
      status: mapTaskState(task.state),
      summary: task.resultSummary ?? (task.outputTail === '' ? undefined : task.outputTail),
      error: task.error,
      usage: task.usage,
      startedAt: task.startedAt ?? '',
      endedAt: task.endedAt,
      toolCallCount: 0,
      transcript: [],
    });
  }
  for (const item of response.items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind !== 'tool' || frame.agentRefs === undefined) continue;
        for (const ref of frame.agentRefs) {
          const existing = byAgent.get(ref.agentId);
          const instruction = spawnInstructionFromToolArgs(frame.input, ref.agentId);
          byAgent.set(ref.agentId, {
            kind: 'subagent',
            id: `subagent-${ref.agentId}`,
            subagentId: ref.agentId,
            parentAgentId,
            parentToolCallId: frame.toolCallId,
            parentTurnId: item.turnId,
            name: spawnNameFromToolArgs(frame.input, ref.agentId) ?? existing?.name ?? ref.agentId,
            description: existing?.description ?? instruction,
            instruction: instruction ?? existing?.instruction,
            model: existing?.model,
            thinkingEffort: existing?.thinkingEffort,
            status: existing?.status ?? (frame.state === 'running' ? 'running' : 'unknown'),
            summary: existing?.summary,
            error: existing?.error,
            usage: existing?.usage,
            startedAt: existing?.startedAt || step.startedAt || item.startedAt || '',
            endedAt: existing?.endedAt,
            toolCallCount: existing?.toolCallCount ?? 0,
            transcript: [],
          });
        }
      }
    }
  }
  return [...byAgent.values()];
}

function insertSubagentBlocks(source: readonly Block[], subagents: readonly SubagentBlock[]): Block[] {
  if (subagents.length === 0) return source.filter((block) => block.kind !== 'subagent');
  const byParentTool = new Map<string, SubagentBlock[]>();
  for (const subagent of subagents) {
    if (subagent.parentToolCallId === undefined) continue;
    const siblings = byParentTool.get(subagent.parentToolCallId) ?? [];
    siblings.push(subagent);
    byParentTool.set(subagent.parentToolCallId, siblings);
  }
  const inserted = new Set<string>();
  const blocks: Block[] = [];
  for (const candidate of source) {
    if (candidate.kind === 'subagent') continue;
    blocks.push(candidate);
    if (candidate.kind === 'tool') {
      const anchored = byParentTool.get(candidate.toolCallId);
      if (anchored !== undefined) {
        for (const subagent of anchored) {
          if (inserted.has(subagent.subagentId)) continue;
          blocks.push(subagent);
          inserted.add(subagent.subagentId);
        }
      }
    }
  }
  for (const subagent of subagents) {
    if (!inserted.has(subagent.subagentId)) blocks.push(subagent);
  }
  return blocks;
}

function isPromptIdentity(block: Block, promptId: string, userMessageId?: string): boolean {
  if (block.kind === 'user' || block.kind === 'steer') {
    return block.promptId === promptId || (userMessageId !== undefined && block.userMessageId === userMessageId);
  }
  return false;
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
    const nextStatus = isRegeneratingJournalUser(existing, {
      promptId: item.prompt_id,
      userMessageId: item.user_message_id,
      status: item.status,
    })
      ? undefined
      : item.status;
    if (existing.promptStatus === nextStatus && existing.text === text) return blocks;
    const next = blocks.slice();
    next[stableIndex] = { ...existing, text, promptStatus: nextStatus, media: nextMedia };
    return next;
  }
  const additions = classifiedTextToBlocks({
    id: item.user_message_id,
    classified: classifyTranscriptText({ text, role: 'user', origin: { kind: 'user' } }),
    createdAt: item.created_at,
    media,
    promptId: item.prompt_id,
    userMessageId: item.user_message_id,
    promptStatus: item.status,
  });
  return additions.length === 0 ? blocks : [...blocks, ...additions];
}

function stampPromptIdentity(
  blocks: readonly Block[],
  prompt: TranscriptPrompt,
  promptStatus: PromptStatus | undefined,
): Block[] {
  const next = [...blocks];
  const matchIndex = next.findIndex(
    (block) =>
      (block.kind === 'user' || block.kind === 'steer') &&
      (block.promptId === prompt.promptId ||
        (prompt.userMessageId !== undefined && block.userMessageId === prompt.userMessageId)),
  );
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
    if (prompt.status === 'completed' && prompt.steeredAt === undefined) {
      next = stampPromptIdentity(next, prompt, undefined).map((block) =>
        block.kind === 'user' && isPromptIdentity(block, prompt.promptId, prompt.userMessageId)
          ? { ...block, promptStatus: undefined }
          : block,
      );
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
    if (
      prompt.status !== 'queued' &&
      prompt.status !== 'blocked' &&
      prompt.status !== 'running' &&
      prompt.steeredAt === undefined
    ) {
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
        next = stampPromptIdentity(next, prompt, undefined);
        continue;
      }
      next = stampRunningPromptIdentity(next, prompt);
      if (parts.length === 0 && prompt.steeredAt === undefined) continue;
    }
    if (parts.length === 0 && prompt.userMessageId === undefined) continue;
    if (prompt.steeredAt !== undefined) {
      const steer: SteerBlock = {
        kind: 'steer',
        id: `steer-${prompt.promptId}`,
        text: projection.text,
        media: projection.media.length > 0 ? projection.media : undefined,
        createdAt: prompt.steeredAt || prompt.createdAt,
        promptId: prompt.promptId,
        userMessageId: prompt.userMessageId,
        activePromptId: prompt.promptId,
      };
      if (!next.some((block) => block.kind === 'steer' && block.promptId === prompt.promptId)) {
        next = [...next.filter((block) => !(block.kind === 'user' && isPromptIdentity(block, prompt.promptId, prompt.userMessageId))), steer];
      }
      continue;
    }
    if (prompt.status !== 'queued' && prompt.status !== 'blocked' && prompt.status !== 'running') continue;
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
    if (block.kind !== 'user' && block.kind !== 'steer') continue;
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
    if (block.kind === 'steer') {
      if (block.promptId !== undefined && known.has(`p:${block.promptId}`)) continue;
      if (block.userMessageId !== undefined && known.has(`u:${block.userMessageId}`)) continue;
      if (block.promptId !== undefined || block.userMessageId !== undefined) extras.push(block);
      continue;
    }
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
  return extras.length === 0 ? next : [...next, ...extras];
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

export function agentTranscriptToBlocks(
  response: AgentTranscriptProjectionSource | AgentTranscriptResponse,
  previous: readonly Block[] = [],
): Block[] {
  const blocks: Block[] = [];
  const subagentPromptAsUser = response.agent_id !== MAIN_AGENT_ID;
  const phase = response.meta?.agent?.phase;
  const prompts = response.prompts ?? [];
  const attachments = response.attachments ?? [];
  for (const item of response.items) {
    if (item.kind === 'marker') {
      const marker = markerToBlock(item);
      if (marker !== undefined) blocks.push(marker);
      continue;
    }
    if (item.kind === 'taskref') {
      blocks.push({
        kind: 'notice',
        id: `agent-taskref-${item.refId}`,
        text: item.taskId,
        tone: 'neutral',
      });
      continue;
    }
    if (item.kind !== 'turn') continue;
    if (item.prompt !== undefined && item.prompt.trim() !== '') {
      const origin = originFromTurnItem(item) ?? { kind: 'task', taskId: response.agent_id };
      const identity = identityFromTurnOrigin(origin);
      const userMessageId = turnMessageId(item) ?? identity.userMessageId;
      blocks.push(
        ...classifiedTextToBlocks({
          id: userMessageId ?? `agent-turn-${item.turnId}-prompt`,
          classified: classifyTranscriptText({
            text: item.prompt,
            role: 'user',
            origin,
            subagentPromptAsUser,
          }),
          createdAt: item.startedAt ?? '',
          turnId: item.turnId,
          promptId: identity.promptId,
          userMessageId,
          media: mediaFromAttachmentIds(
            (item as { attachmentIds?: readonly string[] }).attachmentIds,
            attachments,
          ),
        }),
      );
    }
    const openingText = splitSystemReminders(item.prompt ?? '').text;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        switch (frame.kind) {
          case 'text':
            if (frame.role === 'user' && openingText !== '' && frame.text === item.prompt) break;
            if (frame.role === 'user') {
              const frameOrigin = originFromFrame(frame);
              const turnOrigin = originFromTurnItem(item);
              const taskOrigin = frame.taskId !== undefined ? { kind: 'task', taskId: frame.taskId } : undefined;
              const origin = frameOrigin ?? taskOrigin ?? (isUserVisibleOrigin(turnOrigin) ? turnOrigin : undefined);
              const userMessageId = frameMessageId(frame);
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
                    attachments,
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
                streaming: isLiveStreamingFrame(item, step, frame, phase),
                createdAt: step.endedAt ?? item.endedAt,
                turnId: item.turnId,
                messageId,
                media: mediaFromAttachmentIds(
                  (frame as { attachmentIds?: readonly string[] }).attachmentIds,
                  attachments,
                ),
              });
            }
            break;
          case 'thinking':
            blocks.push({
              kind: 'thinking',
              id: `agent-frame-${frame.frameId}`,
              text: frame.text,
              streaming: isLiveStreamingFrame(item, step, frame, phase),
              createdAt: step.endedAt ?? item.endedAt,
              turnId: item.turnId,
            });
            break;
          case 'tool': {
            const startedAt = new Date(step.startedAt ?? item.startedAt ?? '').getTime();
            const endedAt = new Date(step.endedAt ?? item.endedAt ?? '').getTime();
            const toolFrame = frame as typeof frame & { view?: string; taskId?: string };
            const isShell = toolFrame.name === 'Bash' || toolFrame.view === 'shell' || toolFrame.taskId !== undefined && toolFrame.name.toLowerCase().includes('shell');
            if (isShell && (frame.output !== undefined || frame.inputText !== undefined || typeof frame.input === 'object')) {
              const command =
                typeof (frame.input as { command?: unknown } | undefined)?.command === 'string'
                  ? `$ ${(frame.input as { command: string }).command}`
                  : frame.inputText ?? '';
              const output =
                typeof frame.output === 'string'
                  ? frame.output
                  : typeof frame.output === 'object' && frame.output !== null && 'stdout' in (frame.output as object)
                    ? String((frame.output as { stdout?: unknown }).stdout ?? '')
                    : frame.error ?? command;
              blocks.push({
                kind: 'shell',
                id: `shell-${frame.toolCallId}`,
                commandId: frame.toolCallId,
                output: output === '' ? command : output,
                done: frame.state !== 'running',
                isError: frame.state === 'error',
              });
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
              status: frame.state === 'error' ? 'error' : frame.state,
              output: frame.output ?? frame.error,
              isError: frame.state === 'error',
              startedAt: Number.isNaN(startedAt) ? 0 : startedAt,
              durationMs:
                Number.isNaN(startedAt) || Number.isNaN(endedAt) ? item.durationMs : Math.max(0, endedAt - startedAt),
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
    if (block !== undefined && !blocks.some((existing) => existing.id === block.id)) blocks.push(block);
  }
  const withPrompts = mergeTranscriptPromptBlocks(blocks, prompts, previous);
  return insertSubagentBlocks(withPrompts, subagentBlocksFromSnapshot(response, response.agent_id));
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
  const blocks =
    options.retainPendingPrompts === false
      ? projected
      : retainPendingPromptBlocks(previous.blocks, projected);
  const firstTurn = snapshot.items.find((item) => item.kind === 'turn');
  const lastTurn = [...snapshot.items].reverse().find((item) => item.kind === 'turn');
  const meta = snapshot.meta.agent;
  const prompts = Array.isArray(snapshot.prompts) ? snapshot.prompts : [...snapshot.prompts.values()];
  const queuedPromptIds = prompts.filter((prompt) => prompt.status === 'queued').map((prompt) => prompt.promptId);
  const running = prompts.find((prompt) => prompt.status === 'running');
  const interactions = Array.isArray(snapshot.interactions)
    ? snapshot.interactions
    : [...snapshot.interactions.values()];
  const todos = Array.isArray(snapshot.todos) ? snapshot.todos : [...snapshot.todos.values()];
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [...snapshot.tasks.values()];
  const pendingInteraction: SessionPendingInteraction = interactions.some(
    (interaction) => interaction.interactionKind === 'approval' && interaction.state === 'pending',
  )
    ? 'approval'
    : interactions.some((interaction) => interaction.interactionKind === 'question' && interaction.state === 'pending')
      ? 'question'
      : 'none';
  const goal = snapshot.meta.goal;
  const turnTail = lastTurn?.kind === 'turn' ? turnTailFromItem(lastTurn) : undefined;
  return {
    ...previous,
    version: previous.version + 1,
    blocks,
    loaded: true,
    loadError: undefined,
    busy: agentBusyFromMeta({ agent_id: agentId, items: [], has_more: false, meta: snapshot.meta }) === true,
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
    oldestMessageId: firstTurn?.kind === 'turn' ? firstTurn.turnId : undefined,
    turnTail: turnTail ?? previous.turnTail,
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
    busy: snapshot.session.busy,
    model: snapshot.session.agent_config.model !== '' ? snapshot.session.agent_config.model : base.model,
    profile: snapshot.session.agent_config.profile ?? base.profile,
    permissionMode: snapshot.session.agent_config.permission_mode ?? base.permissionMode,
    planMode: snapshot.session.agent_config.plan_mode ?? base.planMode,
    swarmMode: snapshot.session.agent_config.swarm_mode ?? base.swarmMode,
    contextTokens: snapshot.context_tokens ?? base.contextTokens,
    maxContextTokens: snapshot.max_context_tokens ?? base.maxContextTokens,
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

export { isPromptContentArray };
