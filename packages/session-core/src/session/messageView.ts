import type {
  ActivitySummary, AssistantBlock, Block, MessageAttachment, MessageBlock, MessageChannelDelivery, MessageReach,
  NoticeBlock, ToolBlock,
} from './transcript/types';

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)); } catch { return undefined; }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function attachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = record(item);
    const blobId = string(entry?.['blob_id']);
    const path = string(entry?.['path']);
    if (blobId === undefined || path === undefined) return [];
    return [{ blobId, path, title: string(entry?.['title']), mimeType: string(entry?.['mime_type']),
      size: typeof entry?.['size'] === 'number' ? entry['size'] : undefined, kind: string(entry?.['kind']) }];
  });
}

const CHANNEL_STATUS: Readonly<Record<string, MessageChannelDelivery['status']>> = {
  delivered: 'delivered', unsupported: 'unsupported', failed: 'failed', unknown: 'unknown',
};

/**
 * Receipts carry a status string; a value this build does not know is
 * `unknown`, never a quiet promotion to delivered.
 */
function channelDeliveries(value: unknown): MessageChannelDelivery[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = record(item);
    const channelId = string(entry?.['channel_id']);
    if (channelId === undefined) return [];
    const raw = string(entry?.['status']);
    const messageIds = strings(entry?.['message_ids']);
    const unsupported = strings(entry?.['unsupported']);
    return [{
      channelId,
      status: raw === undefined ? 'unknown' : CHANNEL_STATUS[raw] ?? 'unknown',
      messageIds: messageIds.length === 0 ? undefined : messageIds,
      unsupported: unsupported.length === 0 ? undefined : unsupported,
      detail: string(entry?.['detail']),
    }];
  });
}

/**
 * Which destinations actually took the message. Only `delivered` counts: a
 * channel that reported `unsupported` took none of the attachments and
 * received the notice alone, and an unknown or failed channel proves nothing —
 * neither is read as reaching this conversation.
 */
function reachOf(channels: readonly MessageChannelDelivery[]): MessageReach | 'nowhere' {
  if (channels.some((channel) => channel.channelId === 'internal' && channel.status === 'delivered')) return 'here';
  if (channels.some((channel) => channel.status === 'delivered')) return 'elsewhere';
  if (channels.some((channel) => channel.status === 'unknown')) return 'unconfirmed';
  return 'nowhere';
}

/**
 * Project a `SendMessage` call into speech — and only into speech when the
 * receipt says this conversation received it. Channel receipts decide that
 * per destination; a receipt that predates them keeps its old reading.
 */
export function projectSendMessage(tool: ToolBlock): MessageBlock | undefined {
  if (tool.toolCallId.startsWith('external:') || tool.name !== 'SendMessage') return undefined;
  const args = record(tool.args) ?? record(tool.argsText);
  const result = record(tool.output);
  const messageId = string(result?.['message_id']);
  const succeeded = tool.status === 'done' && tool.isError !== true && messageId !== undefined;
  const channels = channelDeliveries(result?.['channels']);
  const reach = channels.length === 0 ? undefined : reachOf(channels);
  const delivery = string(result?.['delivery']);
  const status: MessageBlock['status'] = tool.status === 'running' ? 'sending'
    : tool.status === 'stopped' ? 'cancelled'
      : !succeeded || reach === 'nowhere' || delivery === 'undeliverable' ? 'failed'
        : reach === 'unconfirmed' || delivery === 'pending' ? 'pending'
          : 'sent';
  const spoken = status === 'sent' || status === 'sending' || status === 'pending';
  // A refused send never produced a receipt: the call's own error text is the
  // only reason there is, and it must stay readable instead of the row alone
  // saying "not sent".
  const plainOutput = typeof tool.output === 'string' && record(tool.output) === undefined ? tool.output.trim() : undefined;
  const failureDetail = status === 'failed'
    ? string(result?.['error']) ?? (plainOutput === undefined || plainOutput === '' ? undefined : plainOutput)
    : undefined;
  const sender = record(result?.['sender']);
  const handoff = record(result?.['handoff']);
  const targetPersonaId = string(handoff?.['target_persona_id']);
  const targetSessionId = string(handoff?.['target_session_id']);
  const targetName = string(handoff?.['target_name']);
  return {
    kind: 'message', id: tool.id, toolCallId: tool.toolCallId, messageId,
    origin: 'send_message', status,
    text: spoken ? string(args?.['text']) ?? '' : '',
    to: string(args?.['to']), replyTo: string(args?.['reply_to']),
    attachments: status === 'sent' ? attachments(result?.['attachments']) : [],
    deliveredTo: status === 'sent' ? strings(result?.['delivered_to']) : [],
    channels: channels.length === 0 ? undefined : channels,
    reached: reach === undefined || reach === 'nowhere' ? undefined : reach,
    personaId: string(sender?.['persona_id']), senderName: string(sender?.['name']),
    sourceSessionId: string(sender?.['session_id']),
    handoff: status === 'sent' && targetPersonaId !== undefined && targetSessionId !== undefined && targetName !== undefined
      ? { targetPersonaId, targetSessionId, targetName, messageId: string(handoff?.['message_id']) } : undefined,
    startedAt: tool.startedAt, turnId: tool.turnId, failureDetail, sourceTool: tool,
  };
}

export type MessageViewNode = Block | ActivitySummary;

export interface MessageViewOptions {
  /** Complete turn ids from the transcript, not inferred from a settled text frame. */
  readonly completedTurnIds?: readonly string[];
  /**
   * Turns the transcript reports as failed, for the cases its own blocks do
   * not carry: a failed turn never speaks its partial text as the reply.
   */
  readonly failedTurnIds?: readonly string[];
  readonly personaName?: string;
}

/** A turn that did not complete: its partial text stays in the process. */
function failedTurn(block: Block): string | undefined {
  if (block.kind === 'user') return block.promptOutcome?.status === 'failed' ? block.turnId : undefined;
  if (block.kind === 'notice' && block.i18n?.key === 'notice.turnFailedDetail') return block.turnId;
  return undefined;
}

/** The promoted reply as speech: the turn's own text, its frame, and no call identity. */
function replySpeech(block: AssistantBlock, turn: string): MessageBlock {
  const at = block.createdAt === undefined ? Number.NaN : Date.parse(block.createdAt);
  return {
    kind: 'message', id: `ordinary-final-${block.id}`, origin: 'ordinary_final', status: 'sent',
    text: block.text, attachments: [], deliveredTo: [],
    startedAt: Number.isNaN(at) ? undefined : at,
    turnId: turn, sourceBlock: block,
  };
}

function turnId(block: Block): string | undefined {
  if (block.kind === 'subagent') return block.parentTurnId;
  if (block.kind === 'question' || block.kind === 'approval') {
    return block.request.turn_id === undefined ? undefined : `t${block.request.turn_id}`;
  }
  return block.turnId;
}

function activity(members: readonly Block[], turn: string | undefined): ActivitySummary {
  const counts = { tools: 0, reads: 0, commands: 0, thinking: 0, subagents: 0, memories: 0 };
  const subagents = new Set<string>();
  let failed = 0;
  let running = false;
  let durationMs: number | undefined;
  for (const block of members) {
    if (block.kind === 'tool') {
      counts.tools += 1;
      const external = block.toolCallId.startsWith('external:');
      if (external ? block.display?.kind === 'file_io' && block.display.operation === 'read' : block.name === 'Read') counts.reads += 1;
      if (external ? block.display?.kind === 'command' : block.name === 'Bash') counts.commands += 1;
      if (!external && block.name === 'MemoryWrite' && block.status === 'done' && block.isError !== true) counts.memories += 1;
      if (block.status === 'error' || block.isError === true) failed += 1;
      if (block.status === 'running') running = true;
      if (block.durationSource === 'frame' && block.durationMs !== undefined) durationMs = (durationMs ?? 0) + block.durationMs;
      for (const ref of block.agentRefs ?? []) subagents.add(ref.agentId);
    } else if (block.kind === 'shell') {
      counts.commands += 1;
      if (!block.done) running = true;
      if (block.isError === true) failed += 1;
    } else if (block.kind === 'thinking') {
      counts.thinking += 1;
      if (block.streaming) running = true;
    } else if (block.kind === 'assistant') {
      if (block.streaming) running = true;
    } else if (block.kind === 'subagent') {
      subagents.add(block.subagentId);
      if (block.status === 'running') running = true;
      if (block.status === 'failed') failed += 1;
    } else if (block.kind === 'subagent-event') {
      subagents.add(block.subagentId);
    }
  }
  counts.subagents = subagents.size;
  return { kind: 'activity-summary', id: `activity-${members[0]!.id}`, turnId: turn,
    members, counts, running, failed, durationMs };
}

/**
 * Message mode as speech: what the Bot said to you. A finished turn's final
 * ordinary reply is speech even when the model never called `SendMessage`;
 * everything else stays inspectable activity behind its summary.
 */
export function projectMessageView(blocks: readonly Block[], options: MessageViewOptions = {}): MessageViewNode[] {
  const nodes: MessageViewNode[] = [];
  let pending: Block[] = [];
  let pendingTurn: string | undefined;
  const completed = new Set(options.completedTurnIds ?? []);
  const turns: string[] = [];
  const seen = new Set<string>();
  const sent = new Set<string>();
  const failed = new Set<string>(options.failedTurnIds ?? []);
  const failureShown = new Set<string>();
  const replies = new Map<string, AssistantBlock>();
  for (const block of blocks) {
    const turn = turnId(block);
    const failedHere = failedTurn(block);
    if (failedHere !== undefined) failed.add(failedHere);
    if (block.kind === 'user' && block.promptOutcome?.status === 'failed' && block.turnId !== undefined) {
      failureShown.add(block.turnId);
    }
    // A turn that already wrote its own failure line keeps that one line.
    if (block.kind === 'notice' && block.i18n?.key === 'notice.turnFailedDetail' && block.turnId !== undefined) {
      failureShown.add(block.turnId);
    }
    if (turn !== undefined && !seen.has(turn)) {
      seen.add(turn);
      turns.push(turn);
    }
    const message = block.kind === 'message' ? block : block.kind === 'tool' ? projectSendMessage(block) : undefined;
    // The turn spoke through its own call even when the words did not land
    // here, and even when no channel has confirmed them yet: the promotion
    // below must not speak a second copy as this conversation's reply.
    if (message !== undefined && message.origin === 'send_message' && message.turnId !== undefined
      && (message.status === 'sent' || message.status === 'pending')) {
      sent.add(message.turnId);
    }
    if (block.kind === 'assistant' && block.text.trim() !== '' && block.turnId !== undefined) replies.set(block.turnId, block);
  }
  // A reply that keeps streaming, one the reader stopped, and one from a turn
  // that failed are not speech yet. Only this turn's own delivery decides: two
  // turns may legitimately say the same words, so nothing is inferred across
  // turns.
  const promoted = new Map<string, MessageBlock>();
  const speechIds = new Set<string>();
  for (const turn of turns) {
    const reply = replies.get(turn);
    if (reply === undefined || !completed.has(turn) || sent.has(turn) || failed.has(turn)) continue;
    if (reply.streaming || reply.stopped === true) continue;
    promoted.set(turn, replySpeech(reply, turn));
    speechIds.add(reply.id);
  }
  /** What a finished turn leaves on the page: its speech, or the reason there is none. */
  const endTurn = (turn: string | undefined) => {
    if (turn === undefined || !completed.has(turn)) return;
    const reply = promoted.get(turn);
    if (reply !== undefined) {
      nodes.push(reply);
      return;
    }
    // A failed turn says so once. Its own bubble carries the reason and the
    // retry when the prompt is on the page; otherwise this line is the only
    // place the reader learns the turn failed — never as speech, a cancel or
    // "did not reply".
    if (failed.has(turn)) {
      if (!failureShown.has(turn)) {
        nodes.push({ kind: 'notice', id: `message-turn-failed-${turn}`, turnId: turn,
          text: '轮次失败', tone: 'danger',
          i18n: { key: 'notice.turnFailedDetail', params: { detail: '' } },
          reasonCodes: ['message.turn_failed'] } satisfies NoticeBlock);
      }
      return;
    }
    if (sent.has(turn) || replies.get(turn) === undefined) return;
    nodes.push({ kind: 'notice', id: `message-no-reply-${turn}`, turnId: turn,
      text: `${options.personaName ?? ''} 没有回复 · 查看过程`.trim(), tone: 'neutral',
      i18n: { key: 'message.noReply', params: { name: options.personaName ?? '' } },
      reasonCodes: ['message.no_reply'] } satisfies NoticeBlock);
  };
  const flush = () => {
    if (pending.length > 0) nodes.push(activity(pending, pendingTurn));
    pending = [];
    pendingTurn = undefined;
  };
  let lastTurn: string | undefined;
  for (const original of blocks) {
    const block = original.kind === 'tool' ? projectSendMessage(original) ?? original : original;
    const turn = turnId(block);
    if (turn !== undefined && lastTurn !== undefined && turn !== lastTurn) {
      flush();
      endTurn(lastTurn);
    }
    if (turn !== undefined) lastTurn = turn;
    // The reply is speech now, not a step of the work that produced it.
    if (speechIds.has(block.id)) continue;
    const visible = block.kind === 'user' || block.kind === 'message' || block.kind === 'question'
      || block.kind === 'approval' || (block.kind === 'notice' && (block.tone === 'danger'
        || block.reasonCodes?.some((reason) => /cancel|stop|fail|delivery/.test(reason)) === true));
    if (visible) {
      flush();
      nodes.push(block);
    } else {
      if (pending.length > 0 && pendingTurn !== turn) flush();
      pendingTurn = turn;
      pending.push(block);
    }
  }
  flush();
  endTurn(lastTurn);
  return nodes;
}

/** A local greeting never enters model history until the composer explicitly replies to it. */
export function personaGreeting(persona: { readonly id: string; readonly name: string; readonly greeting?: string }): MessageBlock | undefined {
  if (persona.greeting === undefined || persona.greeting.trim() === '') return undefined;
  return { kind: 'message', id: `persona-greeting-${persona.id}`, messageId: `persona-greeting-${persona.id}`,
    origin: 'persona_greeting', status: 'sent', text: persona.greeting, attachments: [], deliveredTo: ['user'],
    personaId: persona.id, senderName: persona.name };
}
