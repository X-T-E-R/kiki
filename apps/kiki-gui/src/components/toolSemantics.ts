/**
 * Tool semantics — what a built-in tool call DID, in the reader's terms.
 *
 * Each describer reads one tool's real wire shapes (its arguments and the
 * text or JSON its result carries) and returns a verb, the object it acted
 * on, the outcome, and the facts worth showing on expand. ToolCard owns the
 * row, the states and the raw payload; a describer only supplies meaning, so
 * every tool speaks through one skeleton instead of growing its own card.
 *
 * Describers are pure and tolerant: a result that does not parse (an older
 * server, a streamed partial, an error string) leaves the fields it would
 * have filled empty rather than failing the row.
 */

import type { I18nKey, I18nParams, PluralBase } from '@kiki/session-core/i18n';
import type { ToolBlock } from '@kiki/session-core/session';

import type { Locale } from '../i18n';
import { roomHref } from '../components/comms/roomNames';
import type { IconName } from './icons';
import { toolRecordCopy } from './toolRecordCopy';

export type SemanticTone = 'plain' | 'warn' | 'danger' | 'accent';

/** Where a row (or one of its items) leads. `sessionId` absent = this session. */
export type SemanticLink =
  | { readonly kind: 'session'; readonly sessionId?: string; readonly agentId?: string; readonly turn?: number; readonly label: string }
  | { readonly kind: 'agent'; readonly agentId: string; readonly label: string }
  | { readonly kind: 'route'; readonly path: string; readonly label: string }
  | { readonly kind: 'external'; readonly url: string; readonly label: string };

export interface SemanticField {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  /** Hover text when the value is a shortened form (a thread title for an id). */
  readonly valueTitle?: string;
}

export interface SemanticItem {
  readonly key: string;
  readonly primary: string;
  readonly secondary?: string;
  readonly link?: SemanticLink;
}

export interface ToolSemantics {
  readonly icon: IconName;
  /** The action, imperative like every other step label ("Send to thread"). */
  readonly verb: string;
  /** What it acted on: a thread title, a query, a task id. */
  readonly object?: string;
  /** A secondary clause after the object: the message, the profile. */
  readonly note?: string;
  /** Untruncated hover text for the note. */
  readonly noteTitle?: string;
  /** The outcome word in the trailing column ("Delivered", "Timed out"). */
  readonly state?: { readonly text: string; readonly tone: SemanticTone };
  /** A count for the stats column ("3 hits"). */
  readonly count?: string;
  readonly link?: SemanticLink;
  readonly fields?: readonly SemanticField[];
  readonly items?: readonly SemanticItem[];
  /** More items exist than the result carried. */
  readonly itemsMore?: boolean;
  /** A short, already-clipped preview of the text the tool returned. */
  readonly preview?: string;
  /** Full text already loaded, kept separate from the technical record. */
  readonly previewFull?: string;
  readonly previewNotice?: string;
}

export interface SemanticContext {
  readonly locale?: Locale;
  readonly t: (key: I18nKey, params?: I18nParams) => string;
  readonly tp: (base: PluralBase, count: number, params?: I18nParams) => string;
  /** A session's title from what the client already knows, if anything. */
  readonly threadTitle: (sessionId: string) => string | undefined;
  /** A room's name from the room list the client already holds, if anything. */
  readonly roomName?: (roomId: string) => string | undefined;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function arr(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** One line of text, clipped with an ellipsis. */
export function clipLine(text: string, limit = 96): string {
  const line = text.replaceAll(/\s+/g, ' ').trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`;
}

/** The result as text: a plain string, a `{kind:'text'}` part, or text content parts. */
export function outputText(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  const record = rec(output);
  if (record !== undefined && record['kind'] === 'text' && typeof record['text'] === 'string') return record['text'];
  if (Array.isArray(output)) {
    const parts = output.map((part) => str(rec(part)?.['text'])).filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  return undefined;
}

/** The result as JSON (the thread, board, history and agent tools stringify theirs). */
export function outputJson(output: unknown): unknown {
  const record = rec(output);
  if (record !== undefined && record['kind'] !== 'text') return record;
  const text = outputText(output);
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** Explicit payload limits only; absence of these flags does not prove source completeness. */
export function toolPayloadIncomplete(output: unknown): boolean {
  const record = rec(outputJson(output));
  return record?.['truncated'] === true || record?.['status'] === 'partial'
    || arr(record?.['documents']).some((doc) => rec(doc)?.['truncated'] === true)
    || (outputText(output) ?? '').startsWith('The returned content is truncated and incomplete.');
}

/**
 * `key: value` lines the task tools format (`formatPlainObject`), up to the
 * first blank line or `[section]` marker. Later duplicate keys are ignored.
 */
export function plainFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.startsWith('[')) break;
    const match = /^([a-z_][A-Za-z0-9_]*): ?(.*)$/.exec(line);
    if (match !== null && !fields.has(match[1]!)) fields.set(match[1]!, match[2]!);
  }
  return fields;
}

/** Records after a count header, separated by `---` (TaskList, CronList). */
function plainRecords(text: string): Map<string, string>[] {
  const body = text.split(/\r?\n/).slice(1).join('\n');
  return body.split(/\n---\n/).map((chunk) => plainFields(chunk)).filter((fields) => fields.size > 0);
}

/** The text after a `[section]` marker, to the next marker or the end. */
function section(text: string, name: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`[${name}]`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\[[a-z_]+\]$/.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body === '' ? undefined : body;
}

/**
 * Wire enum values the engine reports (task, agent, thread, board, goal and
 * history states, roles, scopes) in the reader's language. An unknown value
 * from a newer server reads as itself with underscores opened up.
 */
const WIRE_WORDS: Record<string, I18nKey> = {
  running: 'tc.sem.wire.running',
  completed: 'tc.sem.wire.completed',
  complete: 'tc.sem.wire.completed',
  failed: 'tc.sem.wire.failed',
  errored: 'tc.sem.wire.failed',
  timed_out: 'tc.sem.wire.timed_out',
  killed: 'tc.sem.wire.killed',
  lost: 'tc.sem.wire.lost',
  interrupted: 'tc.sem.wire.interrupted',
  cancelled: 'tc.sem.wire.cancelled',
  blocked: 'tc.sem.wire.blocked',
  unknown: 'tc.sem.wire.unknown',
  untracked: 'tc.sem.wire.untracked',
  cold: 'tc.sem.wire.cold',
  idle: 'tc.sem.wire.idle',
  active: 'tc.sem.wire.active',
  in_progress: 'tc.sem.wire.in_progress',
  paused: 'tc.sem.wire.paused',
  done: 'tc.sem.wire.done',
  superseded: 'tc.sem.wire.superseded',
  user: 'tc.sem.wire.user',
  assistant: 'tc.sem.wire.assistant',
  tool: 'tc.sem.wire.tool',
  session: 'tc.sem.wire.session',
  this_session: 'tc.sem.wire.session',
  workspace: 'tc.sem.wire.workspace',
  embedded: 'tc.sem.wire.embedded',
  global: 'tc.sem.wire.global',
  process: 'tc.sem.wire.process',
  agent: 'tc.sem.wire.agent',
  question: 'tc.sem.wire.question',
  auto: 'tc.sem.wire.auto',
  fixed: 'tc.sem.wire.fixed',
};

export function wireWord(value: string | undefined, ctx: Pick<SemanticContext, 't'>): string | undefined {
  if (value === undefined) return undefined;
  const key = WIRE_WORDS[value];
  return key === undefined ? value.replaceAll('_', ' ') : ctx.t(key);
}

function previewOf(text: string | undefined, lines = 6, chars = 600): string | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const head = text.split(/\r?\n/).slice(0, lines).join('\n');
  const clipped = head.length > chars ? `${head.slice(0, chars - 1)}…` : head;
  return clipped.length < text.trimEnd().length ? `${clipped.trimEnd()}\n…` : clipped;
}

const THREAD_TOOLS = new Set(['ThreadCreate', 'ThreadList', 'ThreadRead', 'ThreadSend', 'ThreadWait']);

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 16)}…` : id;
}

/** `{host_id, workspace_id, session_id}` from the args, or the camelCase result form. */
function threadSessionId(ref: unknown): string | undefined {
  const record = rec(ref);
  return str(record?.['session_id']) ?? str(record?.['sessionId']);
}

function threadName(sessionId: string | undefined, ctx: SemanticContext, known?: string): string | undefined {
  if (sessionId === undefined) return known;
  return known ?? ctx.threadTitle(sessionId) ?? shortId(sessionId);
}

/** The thread fact: its title when the client knows it, else a shortened id; the full id on hover. */
function threadField(sessionId: string, ctx: SemanticContext): SemanticField {
  const title = ctx.threadTitle(sessionId);
  return title === undefined
    ? { label: ctx.t('tc.sem.field.thread'), value: shortId(sessionId), mono: true, valueTitle: sessionId }
    : { label: ctx.t('tc.sem.field.thread'), value: title, valueTitle: sessionId };
}

function threadLink(sessionId: string | undefined, ctx: SemanticContext, turn?: number): SemanticLink | undefined {
  return sessionId === undefined ? undefined : { kind: 'session', sessionId, turn, label: ctx.t('tc.sem.openThread') };
}

/** The room name the client already holds, else the id (a deleted room reads as deleted). */
function roomField(roomId: string, ctx: SemanticContext): SemanticField {
  const name = ctx.roomName?.(roomId);
  return name === undefined
    ? { label: ctx.t('tc.sem.field.room'), value: shortId(roomId), mono: true, valueTitle: roomId }
    : { label: ctx.t('tc.sem.field.room'), value: name, valueTitle: roomId };
}

function roomLink(roomId: string | undefined, ctx: SemanticContext): SemanticLink | undefined {
  return roomId === undefined ? undefined : { kind: 'route', path: roomHref(roomId), label: ctx.t('tc.sem.openRoom') };
}

const THREAD_ACTIVITY_KEYS: Record<string, I18nKey> = {
  terminal: 'tc.sem.thread.activity.terminal',
  attention: 'tc.sem.thread.activity.attention',
  lifecycle: 'tc.sem.thread.activity.lifecycle',
  message_undeliverable: 'tc.sem.thread.activity.undeliverable',
};

/**
 * `ThreadSend({room, content, mentions?})`. The room is the destination and the
 * receipt's `delivered` means the room recorded the line.
 *
 * Three different facts, kept apart because the wire only proves the first:
 * recorded, asked for, woken. `mentions` says who the sender REQUESTED, and a
 * bot send with no mentions wakes nobody at all (only a USER message with no
 * mentions defaults to the host; a bot send also skips the sender and any
 * muted member). The receipt carries no wake result, so the row never claims a
 * number of people were woken — it names who was asked and says plainly that
 * attention is on its way. The body is the message itself, read whole on expand.
 */
function roomSend(
  block: ToolBlock,
  ctx: SemanticContext,
  room: string,
  content: string | undefined,
  delivery: string | undefined,
): ToolSemantics {
  const { t } = ctx;
  const args = rec(block.args) ?? {};
  const result = rec(outputJson(block.output));
  const mentions = arr(args['mentions']).filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  const name = ctx.roomName?.(room);
  // No receipt yet means the room has not confirmed anything: the call is still
  // running, so the row says so rather than claiming a message was logged.
  const settled = delivery !== undefined;
  const refused = delivery === 'undeliverable';
  return {
    icon: 'room',
    verb: t('tc.sem.thread.sendRoom'),
    object: name ?? shortId(room),
    note: content === undefined ? undefined : clipLine(content, 90),
    noteTitle: content,
    state: !settled
      ? { text: t('tc.sem.thread.roomSending'), tone: 'plain' }
      : refused
        ? { text: t('tc.sem.thread.undeliverable'), tone: 'danger' }
        : mentions.length === 0
          ? { text: t('tc.sem.thread.roomLoggedSilent'), tone: 'plain' }
          : { text: ctx.tp('tc.sem.thread.roomLoggedAsked', mentions.length), tone: 'plain' },
    link: roomLink(room, ctx),
    fields: [
      roomField(room, ctx),
      // What the send asked for, which is all the wire can prove about
      // attention; a refused send never claims anyone was asked.
      ...(refused ? [] : [{
        label: t('tc.sem.field.mentions'),
        value: mentions.length === 0 ? t('tc.sem.thread.roomNoMention') : mentions.join(', '),
      }]),
      ...(str(result?.['messageId']) === undefined ? [] : [{ label: t('tc.sem.field.messageId'), value: str(result?.['messageId'])!, mono: true }]),
    ],
    preview: content === undefined ? undefined : previewOf(content, 24, 4000),
    previewFull: content,
  };
}

function describeThread(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const { t, tp } = ctx;
  const args = rec(block.args) ?? {};
  const result = rec(outputJson(block.output));
  switch (block.name) {
    case 'ThreadCreate': {
      const id = str(result?.['id']);
      const prompt = str(args['prompt']);
      const title = str(result?.['title']) ?? str(args['title']) ?? (prompt === undefined ? undefined : clipLine(prompt, 80));
      return {
        icon: 'thread',
        verb: t('tc.sem.thread.create'),
        object: threadName(id, ctx, title),
        note: result?.['prompt_started'] === true ? t('tc.sem.thread.started') : undefined,
        link: threadLink(id, ctx),
        fields: [
          ...(id === undefined ? [] : [threadField(id, ctx)]),
          ...(str(result?.['profile']) === undefined ? [] : [{ label: t('tc.sem.field.profile'), value: str(result?.['profile'])! }]),
          ...(str(result?.['cwd'] ?? args['cwd']) === undefined ? [] : [{ label: t('tc.sem.field.cwd'), value: str(result?.['cwd'] ?? args['cwd'])!, mono: true }]),
        ],
        preview: prompt === undefined ? undefined : previewOf(prompt),
      };
    }
    case 'ThreadList': {
      const threads = arr(result?.['threads']).map(rec).filter((item): item is Rec => item !== undefined);
      return {
        icon: 'thread',
        verb: t('tc.sem.thread.list'),
        count: result === undefined ? undefined : tp('tc.sem.threads', threads.length),
        items: threads.map((thread, index) => {
          const id = threadSessionId(thread['ref']);
          return {
            key: id ?? String(index),
            primary: threadName(id, ctx, str(thread['title'])) ?? t('tc.sem.untitled'),
            secondary: wireWord(str(thread['state']), ctx),
            link: threadLink(id, ctx),
          };
        }),
        itemsMore: str(result?.['nextCursor']) !== undefined,
      };
    }
    case 'ThreadRead': {
      const id = threadSessionId(args['thread']) ?? threadSessionId(result?.['thread']);
      const turns = arr(result?.['turns']).map(rec).filter((item): item is Rec => item !== undefined);
      return {
        icon: 'thread',
        verb: t('tc.sem.thread.read'),
        object: threadName(id, ctx),
        count: result === undefined ? undefined : tp('tc.sem.turns', turns.length),
        link: threadLink(id, ctx),
        items: turns.map((turn, index) => {
          const turnId = num(turn['turnId']);
          const input = str(turn['input']);
          const output = str(turn['output']);
          return {
            key: String(turnId ?? index),
            primary: input === undefined ? t('tc.sem.noText') : clipLine(input, 120),
            secondary: [turnId === undefined ? undefined : t('tc.sem.turnN', { n: turnId }), wireWord(str(turn['reason']), ctx), output === undefined ? undefined : clipLine(output, 80)]
              .filter((part): part is string => part !== undefined).join(' · '),
            link: turnId === undefined ? undefined : threadLink(id, ctx, turnId),
          };
        }),
        itemsMore: str(result?.['nextCursor']) !== undefined,
      };
    }
    case 'ThreadSend': {
      const content = str(args['content']);
      const delivery = str(result?.['delivery']);
      // A room send and a peer send are different destinations, so they get
      // different rows: a room has no thread to name, no queue to wait in, and
      // `delivered` only means the room recorded the line.
      const room = str(args['room']);
      if (room !== undefined) return roomSend(block, ctx, room, content, delivery);
      const id = threadSessionId(args['thread']);
      return {
        icon: 'thread',
        verb: t('tc.sem.thread.send'),
        object: threadName(id, ctx),
        note: content === undefined ? undefined : clipLine(content, 90),
        noteTitle: content,
        state: delivery === 'delivered'
          ? { text: t('agentMessage.delivered'), tone: 'plain' }
          : delivery === 'pending'
            ? { text: t('agentMessage.pending'), tone: 'warn' }
            : delivery === 'undeliverable'
              ? { text: t('tc.sem.thread.undeliverable'), tone: 'danger' }
              : undefined,
        link: threadLink(id, ctx),
        fields: [
          ...(id === undefined ? [] : [threadField(id, ctx)]),
          ...(result?.['deduplicated'] === true ? [{ label: t('tc.sem.field.delivery'), value: t('agentMessage.deduplicated') }] : []),
        ],
        preview: content === undefined ? undefined : previewOf(content, 12, 1200),
      };
    }
    case 'ThreadWait': {
      const requested = arr(args['threads']).map((item) => threadSessionId(rec(item)?.['thread'])).filter((id): id is string => id !== undefined);
      const waited = arr(result?.['threads']).map(rec).filter((item): item is Rec => item !== undefined);
      const items: SemanticItem[] = [];
      for (const entry of waited) {
        const id = threadSessionId(entry['thread']);
        for (const activity of arr(entry['activities']).map(rec)) {
          if (activity === undefined) continue;
          const kind = str(activity['kind']) ?? '';
          const turnId = num(activity['turnId']);
          items.push({
            key: `${id ?? '?'}-${String(num(activity['seq']) ?? items.length)}`,
            primary: threadName(id, ctx) ?? t('tc.sem.untitled'),
            secondary: [THREAD_ACTIVITY_KEYS[kind] === undefined ? kind : t(THREAD_ACTIVITY_KEYS[kind]), wireWord(str(activity['reason']), ctx)]
              .filter((part): part is string => part !== undefined && part !== '').join(' · '),
            link: threadLink(id, ctx, turnId),
          });
        }
      }
      const single = requested.length === 1 ? requested[0] : undefined;
      return {
        icon: 'thread',
        verb: t('tc.sem.thread.wait'),
        object: single === undefined
          ? requested.length === 0 ? undefined : tp('tc.sem.threads', requested.length)
          : threadName(single, ctx),
        state: result === undefined
          ? undefined
          : result['timedOut'] === true
            ? { text: t('tc.sem.timedOut'), tone: 'warn' }
            : { text: tp('tc.sem.activities', items.length), tone: 'plain' },
        link: threadLink(single, ctx),
        items,
      };
    }
  }
  return { icon: 'thread', verb: block.name };
}

const AGENT_STATUS_TONE: Record<string, SemanticTone> = {
  completed: 'plain',
  running: 'plain',
  queued: 'warn',
  failed: 'danger',
  errored: 'danger',
  interrupted: 'warn',
  cancelled: 'warn',
};

function describeAgent(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const { t, tp } = ctx;
  const args = rec(block.args) ?? {};
  const text = outputText(block.output);
  switch (block.name) {
    case 'AgentRun': {
      const fields = text === undefined ? new Map<string, string>() : plainFields(text);
      const agentId = fields.get('agent_id') ?? block.agentRefs?.[0]?.agentId;
      const status = fields.get('status');
      const resume = str(args['resume']);
      const summary = text === undefined ? undefined : text.split(/\n\[summary\]\n/)[1];
      return {
        icon: 'agent',
        verb: t(resume === undefined ? 'tc.sem.agent.run' : 'tc.sem.agent.resume'),
        object: str(args['description']) ?? str(args['name']) ?? resume,
        note: fields.get('actual_profile') ?? str(args['profile']),
        state: status === undefined ? undefined : { text: wireWord(status, ctx)!, tone: AGENT_STATUS_TONE[status] ?? 'plain' },
        link: agentId === undefined ? undefined : { kind: 'agent', agentId, label: t('tc.sem.openAgent') },
        fields: [
          ...(agentId === undefined ? [] : [{ label: t('tc.sem.field.agent'), value: agentId, mono: true }]),
          ...(fields.get('task_id') === undefined ? [] : [{ label: t('tc.sem.field.task'), value: fields.get('task_id')!, mono: true }]),
          ...(str(args['model_alias']) === undefined ? [] : [{ label: t('tc.sem.field.model'), value: str(args['model_alias'])! }]),
        ],
        preview: previewOf(summary ?? str(args['prompt']), 8, 900),
      };
    }
    case 'AgentList': {
      const result = rec(outputJson(block.output));
      const agents = arr(result?.['agents']).map(rec).filter((item): item is Rec => item !== undefined);
      return {
        icon: 'agent',
        verb: t('tc.sem.agent.list'),
        count: result === undefined ? undefined : tp('tc.sem.agents', agents.length),
        items: agents.map((agent, index) => {
          const agentId = str(agent['agent_id']);
          return {
            key: agentId ?? String(index),
            primary: str(agent['name']) ?? agentId ?? '?',
            secondary: [str(agent['profile']), wireWord(str(agent['status']), ctx)].filter((part): part is string => part !== undefined).join(' · '),
            link: agentId === undefined ? undefined : { kind: 'agent', agentId, label: t('tc.sem.openAgent') },
          };
        }),
        itemsMore: num(result?.['omitted']) !== undefined && num(result?.['omitted'])! > 0,
      };
    }
    case 'AgentSend':
    case 'AgentNotify': {
      const result = rec(outputJson(block.output));
      const target = rec(result?.['target']);
      const agentId = str(target?.['agent_id']) ?? block.agentRefs?.[0]?.agentId;
      const message = str(args['message']);
      const status = str(result?.['status']);
      return {
        icon: 'agent',
        verb: t(block.name === 'AgentSend' ? 'tc.sem.agent.send' : 'tc.sem.agent.notify'),
        object: block.name === 'AgentSend' ? str(target?.['task_name']) ?? str(args['target']) : undefined,
        note: message === undefined ? undefined : clipLine(message, 90),
        noteTitle: message,
        state: status === 'delivered'
          ? { text: t('agentMessage.delivered'), tone: 'plain' }
          : status === 'queued'
            ? { text: t('agentMessage.pending'), tone: 'warn' }
            : undefined,
        link: agentId === undefined || block.name !== 'AgentSend' ? undefined : { kind: 'agent', agentId, label: t('tc.sem.openAgent') },
        preview: message === undefined ? undefined : previewOf(message, 12, 1200),
      };
    }
  }
  return { icon: 'agent', verb: block.name };
}

const TASK_STATUS_TONE: Record<string, SemanticTone> = {
  running: 'plain',
  completed: 'plain',
  failed: 'danger',
  lost: 'danger',
  killed: 'warn',
  timed_out: 'warn',
  cancelled: 'warn',
};

function taskState(status: string | undefined, ctx: SemanticContext): ToolSemantics['state'] {
  return status === undefined ? undefined : { text: wireWord(status, ctx)!, tone: TASK_STATUS_TONE[status] ?? 'plain' };
}

function taskFields(fields: Map<string, string>, ctx: SemanticContext): SemanticField[] {
  const { t } = ctx;
  const out: SemanticField[] = [];
  const push = (key: string, label: I18nKey, mono = false, wire = false) => {
    const value = fields.get(key);
    if (value !== undefined && value !== '') out.push({ label: t(label), value: wire ? wireWord(value, ctx)! : value, mono });
  };
  push('task_id', 'tc.sem.field.task', true);
  push('kind', 'tc.sem.field.kind', false, true);
  push('exit_code', 'tc.sem.field.exitCode', true);
  push('terminal_reason', 'tc.sem.field.reason');
  push('reason', 'tc.sem.field.reason');
  push('output_path', 'tc.sem.field.outputPath', true);
  return out;
}

function taskItems(text: string, ctx: SemanticContext): SemanticItem[] {
  return plainRecords(text).map((fields, index) => ({
    key: fields.get('task_id') ?? String(index),
    primary: fields.get('description') ?? fields.get('task_id') ?? '?',
    secondary: [fields.get('task_id'), wireWord(fields.get('status'), ctx)].filter((part): part is string => part !== undefined).join(' · '),
    link: fields.get('agent_id') === undefined ? undefined : { kind: 'agent' as const, agentId: fields.get('agent_id')!, label: ctx.t('tc.sem.openAgent') },
  }));
}

function describeTask(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const { t, tp } = ctx;
  const args = rec(block.args) ?? {};
  const text = outputText(block.output);
  const fields = text === undefined ? new Map<string, string>() : plainFields(text);
  const taskId = str(args['task_id']) ?? fields.get('task_id');
  switch (block.name) {
    case 'TaskList': {
      const header = text === undefined ? undefined : /^(?:active_)?background_tasks: (\d+)/.exec(text);
      const total = header === null || header === undefined ? undefined : Number(header[1]);
      return {
        icon: 'task',
        verb: t(args['active_only'] === false ? 'tc.sem.task.listAll' : 'tc.sem.task.list'),
        count: total === undefined ? undefined : tp('tc.sem.tasks', total),
        items: text === undefined || total === 0 ? [] : taskItems(text.split(/\nhas_more: /)[0]!, ctx),
        itemsMore: text !== undefined && /\nhas_more: true/.test(text),
      };
    }
    case 'TaskOutput':
      return {
        icon: 'task',
        verb: t('tc.sem.task.output'),
        object: fields.get('description') ?? taskId,
        note: fields.get('description') === undefined ? undefined : taskId,
        state: taskState(fields.get('status'), ctx),
        fields: taskFields(fields, ctx),
        preview: previewOf(text === undefined ? undefined : section(text, 'output'), 10, 1200),
      };
    case 'TaskStop':
      return {
        icon: 'stop',
        verb: t('tc.sem.task.stop'),
        object: taskId,
        note: str(args['reason']),
        state: taskState(fields.get('status'), ctx),
        fields: taskFields(fields, ctx),
      };
    case 'TaskWait': {
      const waitStatus = fields.get('wait_status');
      const finished = text === undefined ? undefined : section(text, 'finished');
      const finishedFields = finished === undefined ? new Map<string, string>() : plainFields(finished);
      const timeout = num(args['timeout']);
      return {
        icon: 'clock',
        verb: t('tc.sem.task.wait'),
        object: finishedFields.get('description') ?? taskId ?? (timeout === undefined ? undefined : t('tc.sem.task.anyTask')),
        note: finishedFields.get('description') === undefined ? undefined : fields.get('task_id'),
        state: waitStatus === 'completed'
          ? taskState(finishedFields.get('status') ?? 'completed', ctx)
          : waitStatus === 'timed_out'
            ? { text: t('tc.sem.timedOut'), tone: 'warn' }
            : waitStatus === 'interrupted'
              ? { text: t('tc.sem.interrupted'), tone: 'warn' }
              : waitStatus === 'no_tasks'
                ? { text: t('tc.sem.task.none'), tone: 'plain' }
                : undefined,
        fields: taskFields(finishedFields.size > 0 ? finishedFields : fields, ctx),
        items: text === undefined ? [] : [
          ...(section(text, 'still_running') === undefined ? [] : taskItems(section(text, 'still_running')!, ctx)),
        ],
        preview: previewOf(text === undefined ? undefined : section(text, 'output'), 10, 1200),
      };
    }
  }
  return { icon: 'task', verb: block.name };
}

function historyLink(record: Rec, ctx: SemanticContext): SemanticLink | undefined {
  const turn = num(record['turn']);
  const sessionId = str(record['session_id']);
  if (turn === undefined && sessionId === undefined) return undefined;
  const agentId = str(record['agent_id']);
  return {
    kind: 'session',
    sessionId,
    agentId: agentId === 'main' ? undefined : agentId,
    turn,
    label: turn === undefined ? ctx.t('tc.sem.openThread') : ctx.t('tc.sem.jumpTurn', { n: turn }),
  };
}

function historyState(result: Rec | undefined, ctx: SemanticContext): ToolSemantics['state'] {
  const status = str(result?.['status']);
  if (status === 'partial') return { text: ctx.t('tc.sem.history.partial'), tone: 'warn' };
  if (status === 'no_match') return { text: ctx.t('tc.sem.history.noMatch'), tone: 'plain' };
  const error = rec(result?.['error']);
  if (error !== undefined) return { text: str(error['code']) ?? ctx.t('transcript.failedAria'), tone: 'danger' };
  return undefined;
}

function describeHistory(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const { t, tp } = ctx;
  const args = rec(block.args) ?? {};
  const result = rec(outputJson(block.output));
  const scope = str(args['scope']) ?? str(result?.['scope_used']);
  switch (block.name) {
    case 'HistorySearch': {
      const hits = arr(result?.['hits']).map(rec).filter((item): item is Rec => item !== undefined);
      return {
        icon: 'search',
        verb: t('tc.sem.history.search'),
        object: str(args['query']),
        note: wireWord(scope, ctx),
        count: result === undefined || result['error'] !== undefined ? undefined : tp('tc.sem.hits', hits.length),
        state: historyState(result, ctx),
        items: hits.map((hit, index) => ({
          key: str(hit['ref']) ?? `${String(num(hit['turn']))}-${String(index)}`,
          primary: clipLine(str(hit['snippet']) ?? '', 140),
          secondary: [
            num(hit['turn']) === undefined ? undefined : t('tc.sem.turnN', { n: num(hit['turn'])! }),
            wireWord(str(hit['role']), ctx),
            str(hit['session_id']) === undefined ? undefined : threadName(str(hit['session_id']), ctx),
          ].filter((part): part is string => part !== undefined).join(' · '),
          link: historyLink(hit, ctx),
        })),
        itemsMore: result?.['has_more'] === true,
      };
    }
    case 'HistoryRead': {
      const blocks = arr(result?.['blocks']).map(rec).filter((item): item is Rec => item !== undefined);
      const turn = num(args['turn']) ?? num(result?.['turn']) ?? num(blocks[0]?.['turn']);
      const stepId = str(args['step_id']) ?? str(result?.['step_id']);
      const text = str(result?.['text']) ?? blocks.map((item) => str(item['text'])).filter((part): part is string => part !== undefined).join('\n\n');
      const target = { ...args, ...result, turn };
      return {
        icon: 'read',
        verb: t('tc.sem.history.read'),
        object: stepId ?? (turn === undefined ? str(args['ref']) === undefined ? undefined : t('tc.sem.history.ref') : t('tc.sem.turnN', { n: turn })),
        note: str(args['session_id']) === undefined ? undefined : threadName(str(args['session_id']), ctx),
        state: historyState(result, ctx),
        link: historyLink(target, ctx),
        preview: previewOf(text, 10, 1200),
      };
    }
    case 'HistoryList': {
      const kind = str(args['kind']) ?? str(result?.['kind']) ?? 'turns';
      if (kind === 'agents') {
        const agents = arr(result?.['agents']).map(rec).filter((item): item is Rec => item !== undefined);
        return {
          icon: 'search',
          verb: t('tc.sem.history.listAgents'),
          count: result === undefined ? undefined : tp('tc.sem.agents', agents.length),
          items: agents.map((agent, index) => ({
            key: str(agent['agent_id']) ?? String(index),
            primary: str(agent['name']) ?? str(agent['agent_id']) ?? '?',
            secondary: num(agent['turn_count']) === undefined ? undefined : tp('tc.sem.turns', num(agent['turn_count'])!),
          })),
          itemsMore: result?.['has_more'] === true,
        };
      }
      const turns = arr(result?.['turns']).map(rec).filter((item): item is Rec => item !== undefined);
      const sessionId = str(args['session_id']);
      return {
        icon: 'search',
        verb: t('tc.sem.history.listTurns'),
        object: sessionId === undefined ? undefined : threadName(sessionId, ctx),
        count: result === undefined ? undefined : tp('tc.sem.turns', turns.length),
        items: turns.map((turn, index) => ({
          key: str(turn['ref']) ?? String(num(turn['turn']) ?? index),
          primary: clipLine(str(turn['prompt_excerpt']) ?? t('tc.sem.noText'), 120),
          secondary: [
            num(turn['turn']) === undefined ? undefined : t('tc.sem.turnN', { n: num(turn['turn'])! }),
            num(turn['tool_count']) === undefined ? undefined : tp('tc.sem.toolCalls', num(turn['tool_count'])!),
          ].filter((part): part is string => part !== undefined).join(' · '),
          link: historyLink({ ...turn, session_id: sessionId, agent_id: args['agent_id'] }, ctx),
        })),
        itemsMore: result?.['has_more'] === true,
      };
    }
  }
  return { icon: 'search', verb: block.name };
}

function boardCardItem(card: Rec, index: number, ctx: SemanticContext): SemanticItem {
  return {
    key: str(card['id']) ?? String(index),
    primary: str(card['title']) ?? str(card['id']) ?? '?',
    secondary: [str(card['priority']), wireWord(str(card['status']), ctx), str(card['category'])]
      .filter((part): part is string => part !== undefined).join(' · '),
  };
}

function describeBoard(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const { t, tp } = ctx;
  const args = rec(block.args) ?? {};
  const result = rec(outputJson(block.output));
  const value = result?.['value'];
  const error = rec(result?.['error']);
  const action = str(args['action']);
  const link: SemanticLink = { kind: 'route', path: '/board', label: t('tc.sem.openBoard') };
  const errorState = error === undefined ? undefined : { text: str(error['code']) ?? t('transcript.failedAria'), tone: 'danger' as const };
  if (block.name === 'BoardWrite') {
    const card = rec(value);
    const patch = rec(args['patch']);
    const title = str(card?.['title']) ?? str(args['title']) ?? str(patch?.['title']) ?? str(args['id']);
    return {
      icon: 'board',
      verb: t(action === 'update' ? 'tc.sem.board.update' : 'tc.sem.board.create'),
      object: title,
      note: wireWord(str(card?.['status']) ?? str(patch?.['status']), ctx),
      state: errorState,
      link,
      fields: [
        ...(str(card?.['id']) === undefined ? [] : [{ label: t('tc.sem.field.card'), value: str(card?.['id'])!, mono: true }]),
        ...(str(card?.['priority'] ?? args['priority']) === undefined ? [] : [{ label: t('tc.sem.field.priority'), value: str(card?.['priority'] ?? args['priority'])! }]),
        ...(str(rec(card?.['storage'])?.['kind']) === undefined ? [] : [{ label: t('tc.sem.field.scope'), value: wireWord(str(rec(card?.['storage'])?.['kind']), ctx)! }]),
        ...(num(card?.['revision']) === undefined ? [] : [{ label: t('tc.sem.field.revision'), value: String(num(card?.['revision'])) }]),
      ],
      preview: previewOf(str(args['description']) ?? str(patch?.['description'])),
    };
  }
  const page = rec(value);
  const cards = arr(page?.['cards']).map(rec).filter((item): item is Rec => item !== undefined);
  if (action === 'show') {
    return {
      icon: 'board',
      verb: t('tc.sem.board.show'),
      object: str(page?.['title']) ?? str(args['id']),
      note: wireWord(str(page?.['status']), ctx),
      state: errorState,
      link,
      preview: previewOf(str(page?.['description'])),
    };
  }
  if (action === 'preview') {
    return {
      icon: 'board',
      verb: t('tc.sem.board.preview'),
      object: str(page?.['tasksDirectory']) ?? str(page?.['root']),
      note: wireWord(str(page?.['mode']), ctx),
      state: errorState,
      link,
    };
  }
  const overview = Array.isArray(value) ? value.map(rec).filter((item): item is Rec => item !== undefined) : [];
  const overviewCards = overview.flatMap((entry) => arr(rec(rec(entry['result'])?.['value'])?.['cards']).map(rec).filter((item): item is Rec => item !== undefined));
  const all = action === 'overview' ? overviewCards : cards;
  return {
    icon: 'board',
    verb: t(action === 'overview' ? 'tc.sem.board.overview' : 'tc.sem.board.list'),
    object: wireWord(str(args['status']), ctx),
    count: result === undefined || error !== undefined ? undefined : tp('tc.sem.cards', all.length),
    state: errorState,
    link,
    items: all.map((card, index) => boardCardItem(card, index, ctx)),
    itemsMore: str(page?.['nextCursor']) !== undefined,
  };
}

function describeCron(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const { t, tp } = ctx;
  const args = rec(block.args) ?? {};
  const text = outputText(block.output) ?? '';
  const action = block.name === 'CronCreate' ? 'create' : block.name === 'CronList' ? 'list' : block.name === 'CronDelete' ? 'delete' : str(args['action']);
  const link: SemanticLink = { kind: 'route', path: '/cron', label: t('tc.sem.openCron') };
  if (action === 'list') {
    const header = /^cron_jobs: (\d+)/.exec(text);
    return {
      icon: 'clock',
      verb: t('tc.sem.cron.list'),
      count: header === null ? undefined : tp('tc.sem.cronJobs', Number(header[1])),
      link,
      items: header === null || header[1] === '0' ? [] : plainRecords(text).map((fields, index) => {
        let prompt = fields.get('prompt');
        try { prompt = prompt === undefined ? undefined : String(JSON.parse(prompt)); } catch { /* keep raw */ }
        return {
          key: fields.get('id') ?? String(index),
          primary: prompt === undefined ? fields.get('id') ?? '?' : clipLine(prompt, 100),
          secondary: [fields.get('humanSchedule') ?? fields.get('cron'), fields.get('recurring') === 'false' ? t('tc.sem.cron.once') : undefined]
            .filter((part): part is string => part !== undefined).join(' · '),
        };
      }),
    };
  }
  if (action === 'delete') {
    return {
      icon: 'clock',
      verb: t('tc.sem.cron.delete'),
      object: str(args['id']),
      state: text.startsWith('No cron job') ? { text: t('tc.sem.notFound'), tone: 'warn' } : undefined,
      link,
    };
  }
  const fields = plainFields(text);
  const prompt = str(args['prompt']);
  return {
    icon: 'clock',
    verb: t('tc.sem.cron.create'),
    object: fields.get('humanSchedule') ?? str(args['cron']),
    note: prompt === undefined ? undefined : clipLine(prompt, 80),
    noteTitle: prompt,
    link,
    fields: [
      ...(fields.get('id') === undefined ? [] : [{ label: t('tc.sem.field.job'), value: fields.get('id')!, mono: true }]),
      ...(fields.get('cron') === undefined ? [] : [{ label: t('tc.sem.field.cron'), value: fields.get('cron')!, mono: true }]),
      ...(fields.get('nextFireAt') === undefined || fields.get('nextFireAt') === 'null' ? [] : [{ label: t('tc.sem.field.nextRun'), value: fields.get('nextFireAt')! }]),
    ],
    preview: previewOf(prompt),
  };
}

const GOAL_ACTION_BY_TOOL: Record<string, string> = {
  CreateGoal: 'create',
  GetGoal: 'get',
  SetGoalBudget: 'set_budget',
  UpdateGoal: 'update',
};

function describeGoal(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const { t } = ctx;
  const args = rec(block.args) ?? {};
  const action = GOAL_ACTION_BY_TOOL[block.name] ?? str(args['action']) ?? 'get';
  const text = outputText(block.output);
  const goal = rec(rec(outputJson(block.output))?.['goal']);
  const firstLine = text === undefined ? undefined : clipLine(text.split(/\r?\n/, 1)[0] ?? '', 90);
  const fields: SemanticField[] = goal === undefined ? [] : [
    ...(str(goal['status']) === undefined ? [] : [{ label: t('tc.sem.field.status'), value: wireWord(str(goal['status']), ctx)! }]),
    ...(num(goal['turnsUsed']) === undefined ? [] : [{ label: t('tc.sem.field.turnsUsed'), value: String(num(goal['turnsUsed'])) }]),
    ...(str(goal['completionCriterion']) === undefined ? [] : [{ label: t('tc.sem.field.criterion'), value: str(goal['completionCriterion'])! }]),
  ];
  switch (action) {
    case 'create':
      return {
        icon: 'goal',
        verb: t('tc.sem.goal.create'),
        object: str(goal?.['objective']) ?? str(args['objective']),
        fields,
      };
    case 'set_budget': {
      const value = num(args['value']);
      return {
        icon: 'goal',
        verb: t('tc.sem.goal.budget'),
        object: value === undefined ? undefined : `${String(value)} ${str(args['unit']) ?? ''}`.trim(),
        note: text !== undefined && text.includes('not set') ? firstLine : undefined,
      };
    }
    case 'update':
      return {
        icon: 'goal',
        verb: t('tc.sem.goal.update'),
        object: wireWord(str(args['status']), ctx),
        note: firstLine,
        noteTitle: text,
      };
    default:
      return {
        icon: 'goal',
        verb: t('tc.sem.goal.get'),
        object: str(goal?.['objective']) ?? (goal === undefined && text !== undefined && /"goal":\s*null/.test(text) ? t('tc.sem.goal.none') : undefined),
        note: wireWord(str(goal?.['status']), ctx),
        fields,
      };
  }
}

function describeTodo(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const { t, tp } = ctx;
  const args = rec(block.args) ?? {};
  const todos = Array.isArray(args['todos']) ? arr(args['todos']).map(rec).filter((item): item is Rec => item !== undefined) : undefined;
  const text = outputText(block.output) ?? '';
  const read = todos === undefined
    ? [...text.matchAll(/^ {2}\[(pending|in_progress|done)\] (.+)$/gm)].map((match) => ({ status: match[1]!, title: match[2]! }))
    : todos.map((todo) => ({ status: str(todo['status']) ?? 'pending', title: str(todo['title']) ?? '' }));
  const done = read.filter((item) => item.status === 'done').length;
  const active = read.find((item) => item.status === 'in_progress');
  const notes = rec(args['notes']);
  const noteSections = ['goal', 'directives', 'decided', 'rejected', 'evidence', 'files', 'next', 'open'] as const;
  const noteFields: SemanticField[] = noteSections.flatMap((key) => {
    const value = notes?.[key];
    if (typeof value !== 'string') return [];
    return [{ label: t(`agentPanel.notes.${key}`), value: value.trim() === ''
      ? toolRecordCopy('notesCleared', ctx.locale) : clipLine(value, 160) }];
  });
  if (args['notes'] === null) noteFields.push({ label: t('agentPanel.notes'), value: toolRecordCopy('notesCleared', ctx.locale) });
  const notesChanged = noteFields.length > 0;
  const noteLabels = noteFields.map((field) => field.label).join(' · ');
  const notesTruncated = noteSections.some((key) => {
    const value = notes?.[key];
    return typeof value === 'string' && value.replaceAll(/\s+/g, ' ').trim().length > 160;
  });
  const verb = todos === undefined
    ? notesChanged ? t('tc.sem.todo.notes') : t('tc.sem.todo.read')
    : todos.length === 0 ? t('tc.sem.todo.clear') : t('tc.sem.todo.update');
  const fields = [...noteFields];
  if (read.length === 0 && todos === undefined && text.startsWith('Todo list is empty')) {
    fields.push({ label: t('tc.sem.field.status'), value: tp('tc.todoItems', 0) });
  }
  return {
    icon: 'plan',
    verb,
    object: active?.title,
    count: read.length === 0 ? undefined : t('tc.sem.todo.progress', { done, total: read.length }),
    items: read.map((item, index) => ({
      key: `${String(index)}-${item.title}`,
      primary: item.title,
      secondary: item.status === 'in_progress' ? t('tc.sem.todo.inProgress') : item.status === 'done' ? t('tc.sem.todo.done') : undefined,
    })),
    note: notesChanged ? clipLine(noteLabels) : undefined,
    noteTitle: notesChanged ? noteLabels : undefined,
    fields: fields.length > 0 ? fields : undefined,
    previewNotice: notesTruncated ? toolRecordCopy('notesSummaryTruncated', ctx.locale) : undefined,
  };
}

/** `SelectTools` names: the args while streaming, the `Loaded:` line once it lands. */
export function selectedToolNames(block: Pick<ToolBlock, 'args' | 'output'>): { loaded: string[]; already: string[]; unknown: string[] } {
  const text = outputText(block.output) ?? '';
  const list = (label: string) => {
    const match = new RegExp(`^${label}: (.+)$`, 'm').exec(text);
    return match === null ? [] : match[1]!.split(',').map((name) => name.trim()).filter((name) => name !== '');
  };
  const unknown = [...text.matchAll(/^Unknown tool: ([^.\s]+)/gm)].map((match) => match[1]!);
  const loaded = list('Loaded');
  const already = list('Already available');
  if (loaded.length === 0 && already.length === 0 && unknown.length === 0) {
    const names = arr(rec(block.args)?.['names']).filter((name): name is string => typeof name === 'string');
    return { loaded: names, already: [], unknown: [] };
  }
  return { loaded, already, unknown };
}

function describeSelectTools(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const { t } = ctx;
  const { loaded, already, unknown } = selectedToolNames(block);
  const names = [...loaded, ...already];
  return {
    icon: 'tool',
    verb: t('tc.sem.select'),
    object: names.length === 0 ? undefined : names.join(t('tc.sem.listSep')),
    state: unknown.length === 0 ? undefined : { text: t('tc.sem.select.unknown', { names: unknown.join(t('tc.sem.listSep')) }), tone: 'warn' },
  };
}

function webQuery(args: Rec): string | undefined {
  const query = args['query'];
  if (typeof query === 'string') return str(query);
  const list = arr(query).filter((item): item is string => typeof item === 'string');
  return list.length === 0 ? undefined : list.join(' · ');
}

function webState(value: string | undefined, ctx: SemanticContext, knownEmpty = false): ToolSemantics['state'] {
  if (value === undefined || (value === 'empty' && !knownEmpty)) return undefined;
  const labels = { queued: 'queued', succeeded: 'succeeded', empty: 'empty', partial: 'partial' } as const;
  const label = labels[value as keyof typeof labels];
  return {
    text: label === undefined ? wireWord(value, ctx)! : toolRecordCopy(label, ctx.locale),
    tone: ['partial', 'failed', 'timed_out', 'cancelled'].includes(value) ? 'warn' : 'plain',
  };
}

function webWarnings(envelope: Rec): string | undefined {
  const output = rec(envelope['output']);
  const hints = [envelope['hints'], output?.['hints'], ...arr(envelope['documents']).map((doc) => rec(doc)?.['warnings']),
    ...arr(envelope['lane_outcomes'] ?? output?.['lane_outcomes']).map((lane) => rec(lane)?.['warnings'])];
  const messages = hints.flatMap(arr).map((hint) => str(rec(hint)?.['message']) ?? str(hint)).filter((hint): hint is string => hint !== undefined);
  const error = str(rec(envelope['error'])?.['message']);
  return [...new Set([...messages, ...(error === undefined ? [] : [error])])].join('\n') || undefined;
}

function webPreview(body: string | undefined, notice?: string): Pick<ToolSemantics, 'preview' | 'previewFull' | 'previewNotice'> {
  const preview = previewOf(body, 8, 900);
  return { preview, previewFull: body, previewNotice: notice };
}

function unknownWebPreview(block: ToolBlock, ctx: SemanticContext): Pick<ToolSemantics, 'preview' | 'previewFull' | 'previewNotice'> {
  let text = outputText(block.output);
  if (text === undefined && block.output !== undefined) {
    try { text = JSON.stringify(block.output, null, 2); } catch {
      const value = block.output;
      text = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol'
        ? String(value)
        : Object.prototype.toString.call(value);
    }
  }
  return webPreview(text, toolRecordCopy(block.output === undefined ? 'notLoaded' : 'unavailable', ctx.locale));
}

function webResultItems(values: readonly unknown[]): SemanticItem[] {
  return values.flatMap((value, index) => {
    const result = rec(value);
    const url = str(result?.['url']);
    if (url === undefined) return [];
    return [{
      key: `${index}-${url}`,
      primary: str(result?.['title']) ?? url,
      secondary: str(result?.['snippet']) ?? str(result?.['site_name']) ?? url,
      link: /^https?:\/\//i.test(url) ? { kind: 'external' as const, url, label: url } : undefined,
    }];
  });
}

function webJob(envelope: Rec | undefined, args: Rec, ctx: SemanticContext): Partial<ToolSemantics> | undefined {
  if (envelope === undefined) return undefined;
  const action = str(envelope['action']) ?? str(args['action']);
  if (envelope['execution'] !== 'async' && !['get', 'read', 'cancel'].includes(action ?? '')) return undefined;
  const job = rec(envelope['job']);
  const state = webState(str(envelope['state']) ?? str(job?.['state']) ?? str(envelope['status']), ctx);
  if (state === undefined) return undefined;
  const fields: SemanticField[] = [];
  const add = (label: Parameters<typeof toolRecordCopy>[0], value: string | undefined) => {
    if (value !== undefined) fields.push({ label: toolRecordCopy(label, ctx.locale), value });
  };
  add('job', str(envelope['job_id']) ?? str(job?.['job_id']) ?? str(args['job_id']));
  add('status', state.text);
  if (action === 'get' || action === 'read' || action === 'cancel') add('action', toolRecordCopy(action, ctx.locale));
  if (typeof envelope['cancel_requested'] === 'boolean') add('cancelRequested', toolRecordCopy(envelope['cancel_requested'] ? 'yes' : 'no', ctx.locale));
  const poll = num(envelope['poll_after_ms']);
  add('poll', poll === undefined ? undefined : String(poll));
  const artifact = rec(envelope['artifact']);
  add('artifact', artifact === undefined ? undefined : `${str(artifact['media_type']) ?? 'application/json'} · ${num(artifact['byte_length']) ?? '?'} bytes`);
  let notice = webWarnings(envelope);
  if (action === 'read') {
    const chunks = arr(envelope['chunks']);
    add('chunks', String(chunks.length));
    const ranges = chunks.map((chunk) => {
      const value = rec(chunk);
      return `#${num(value?.['index']) ?? '?'} · offset ${num(value?.['offset']) ?? '?'} · ${num(value?.['byte_length']) ?? '?'} bytes`;
    }).join('\n');
    notice = [toolRecordCopy('encodedChunks', ctx.locale), str(envelope['next_cursor']) === undefined ? undefined : toolRecordCopy('moreChunks', ctx.locale), notice].filter(Boolean).join('\n');
    return { object: str(envelope['job_id']) ?? str(args['job_id']), state, fields, ...webPreview(ranges, notice) };
  }
  return { object: str(envelope['job_id']) ?? str(job?.['job_id']) ?? str(args['job_id']), state, fields, previewNotice: notice };
}

function describeWebSearch(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const { t, tp } = ctx;
  const args = rec(block.args) ?? {};
  const envelope = rec(outputJson(block.output));
  const action = str(args['action']) ?? str(envelope?.['action']);
  const base: ToolSemantics = {
    icon: 'web',
    verb: t(action === undefined || action === 'run' ? 'tc.sem.web.search' : 'tc.sem.web.job'),
    object: webQuery(args) ?? str(args['job_id']),
    note: str(args['lane']) ?? str(args['preset']),
  };
  const job = webJob(envelope, args, ctx);
  if (job !== undefined) return { ...base, ...job };
  const output = rec(envelope?.['output']);
  const results = output?.['results'] ?? envelope?.['results'];
  const status = str(envelope?.['status']) ?? str(output?.['status']);
  const warnings = envelope === undefined ? undefined : webWarnings(envelope);
  if (Array.isArray(results)) {
    const items = webResultItems(results);
    const parsed = items.length === results.length;
    const preview = parsed
      ? webPreview(undefined, warnings ?? (items.length === 0 ? toolRecordCopy('empty', ctx.locale) : undefined))
      : unknownWebPreview(block, ctx);
    return { ...base, state: webState(status, ctx, parsed && items.length === 0), items,
      count: block.status === 'done' && parsed ? tp('tc.sem.results', items.length) : undefined,
      ...preview,
    };
  }
  if (output?.['channel'] === 'typed') {
    const data = rec(output['data']);
    const items = webResultItems([...arr(data?.['sources']), ...arr(data?.['results'])]);
    const content = str(data?.['answer']) ?? str(data?.['content']);
    const body = content ?? (output['data'] === undefined ? undefined : JSON.stringify(output['data'], null, 2));
    return { ...base, state: webState(status, ctx), items,
      fields: [{ label: toolRecordCopy('schema', ctx.locale), value: str(output['schema_id']) ?? 'typed' }],
      ...webPreview(body, warnings),
    };
  }
  const text = outputText(block.output) ?? '';
  if (envelope === undefined && /^Schema: .+\nSource lane: /m.test(text)) {
    const content = /\n(?:Content|Data):\n([\s\S]*)/.exec(text)?.[1];
    const items = webResultItems([...text.matchAll(/^- (?:([^\n]+): )?(https?:\/\/\S+)$/gm)].map((match) => ({ title: match[1], url: match[2] })));
    return { ...base, items, ...webPreview(content ?? text) };
  }
  const legacy = text.split(/\n---\n\n/).map((chunk) => {
    const field = (name: string) => new RegExp(`^${name}: (.+)$`, 'm').exec(chunk)?.[1];
    return { title: field('Title'), url: field('URL'), snippet: field('Snippet') ?? field('Site') };
  });
  const items = envelope === undefined ? webResultItems(legacy) : [];
  if (items.length > 0 || text.startsWith('No search results found.')) {
    return { ...base, items, count: block.status === 'done' ? tp('tc.sem.results', items.length) : undefined,
      previewNotice: items.length === 0 ? toolRecordCopy('empty', ctx.locale) : undefined };
  }
  return { ...base, state: webState(status, ctx), ...unknownWebPreview(block, ctx) };
}

const FETCH_FAILURE_KEYS: Record<string, I18nKey> = {
  failed: 'tc.sem.web.fetchFailed',
  'timed out': 'tc.sem.timedOut',
  cancelled: 'tc.sem.wire.cancelled',
};

function describeFetch(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const { t } = ctx;
  const args = rec(block.args) ?? {};
  const source = rec(args['source']);
  const envelope = rec(outputJson(block.output));
  const action = str(args['action']) ?? str(envelope?.['action']);
  const url = str(args['url']) ?? str(source?.['url']) ?? str(source?.['path']);
  const base: ToolSemantics = {
    icon: 'web',
    verb: action === 'get' || action === 'read' || action === 'cancel' ? toolRecordCopy(action, ctx.locale) : t('tc.sem.web.fetch'),
    object: url ?? str(args['job_id']),
  };
  const job = webJob(envelope, args, ctx);
  if (job !== undefined) return { ...base, ...job };
  const fields: SemanticField[] = url === undefined ? [] : [{ label: toolRecordCopy('source', ctx.locale), value: url }];
  if (Array.isArray(envelope?.['documents'])) {
    const documents = envelope['documents'].map(rec).filter((doc): doc is Rec => doc !== undefined);
    const warnings = webWarnings(envelope);
    const incomplete = envelope['status'] === 'partial' || documents.some((doc) => doc['truncated'] === true);
    const completeness = toolRecordCopy(incomplete ? 'payloadTruncated' : warnings === undefined ? 'returned' : 'warningCompleteness', ctx.locale);
    const body = documents.map((doc) => str(doc['content']) === undefined ? undefined
      : [documents.length > 1 ? str(doc['title']) ?? str(doc['final_url']) ?? str(doc['url']) : undefined, str(doc['content'])].filter(Boolean).join('\n\n')).filter(Boolean).join('\n\n---\n\n');
    const doc = documents[0];
    const origin = str(doc?.['final_url']) ?? str(doc?.['url']) ?? url;
    const contentType = str(doc?.['content_type']) ?? str(doc?.['media_type']);
    const parsed = documents.length === envelope['documents'].length && documents.every((document) => typeof document['content'] === 'string');
    const knownEmpty = parsed && body === '' && envelope['status'] === 'empty';
    const preview = parsed && (body !== '' || knownEmpty)
      ? webPreview(body, [warnings, knownEmpty ? toolRecordCopy('empty', ctx.locale) : undefined].filter(Boolean).join('\n') || undefined)
      : unknownWebPreview(block, ctx);
    return { ...base, object: origin, state: webState(str(envelope['status']), ctx, knownEmpty),
      fields: [origin === undefined ? undefined : { label: toolRecordCopy('source', ctx.locale), value: origin },
        contentType === undefined ? undefined : { label: toolRecordCopy('contentType', ctx.locale), value: contentType },
        { label: toolRecordCopy('completeness', ctx.locale), value: completeness }].filter((field): field is SemanticField => field !== undefined),
      ...preview,
    };
  }
  const text = outputText(block.output);
  const failure = text === undefined ? undefined : /^Fetch (failed|timed out|cancelled):/.exec(text);
  const compact = text !== undefined && /^(?:Fetched https?:\/\/|The returned content is |The returned content has )/.test(text);
  if (envelope === undefined && compact) {
    const body = text.split(/\r?\n\r?\n/).slice(1).join('\n\n');
    fields.push({ label: toolRecordCopy('completeness', ctx.locale), value: text.split(/\r?\n\r?\n/, 1)[0]! });
    return { ...base, fields, ...webPreview(body || text) };
  }
  return { ...base, fields,
    state: failure === null || failure === undefined ? webState(str(envelope?.['status']), ctx) : { text: t(FETCH_FAILURE_KEYS[failure[1]!]!), tone: 'warn' },
    ...unknownWebPreview(block, ctx),
  };
}

function describeQuestion(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const { t, tp } = ctx;
  const args = rec(block.args) ?? {};
  const questions = arr(args['questions']).map(rec).filter((item): item is Rec => item !== undefined);
  const result = rec(outputJson(block.output));
  const answers = rec(result?.['answers']);
  const text = outputText(block.output) ?? '';
  const background = text.startsWith('task_id: ');
  const answered = answers === undefined ? 0 : Object.keys(answers).length;
  return {
    icon: 'ask',
    verb: t('tc.sem.ask'),
    object: str(questions[0]?.['question']),
    note: questions.length > 1 ? tp('tc.sem.questions', questions.length) : undefined,
    state: background
      ? { text: t('tc.sem.ask.waiting'), tone: 'accent' }
      : result === undefined
        ? undefined
        : answered === 0
          ? { text: t('tc.sem.ask.dismissed'), tone: 'warn' }
          : { text: t('tc.sem.ask.answered'), tone: 'plain' },
    items: answers === undefined ? [] : Object.entries(answers).map(([question, answer]) => ({
      key: question,
      primary: typeof answer === 'string' ? answer : Array.isArray(answer) ? answer.join(', ') : JSON.stringify(answer),
      secondary: question,
    })),
  };
}

function describePlan(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const { t } = ctx;
  const text = outputText(block.output) ?? '';
  if (block.name === 'EnterPlanMode') {
    return { icon: 'plan', verb: t('tc.sem.plan.enter'), object: /^Plan file: (.+)$/m.exec(text)?.[1] };
  }
  const path = /^Plan saved to: (.+)$/m.exec(text)?.[1] ?? (block.display?.kind === 'plan_review' ? block.display.path : undefined);
  const plan = text.split(/\n## Approved Plan:\n/)[1];
  return {
    icon: 'plan',
    verb: t('tc.sem.plan.exit'),
    object: path,
    state: text.startsWith('Exited plan mode') ? { text: t('tc.sem.plan.approved'), tone: 'plain' } : undefined,
    preview: previewOf(plan, 10, 1200),
  };
}

function describeSkill(block: ToolBlock, ctx: SemanticContext): ToolSemantics {
  const args = rec(block.args) ?? {};
  return {
    icon: 'skill',
    verb: ctx.t('tc.sem.skill'),
    object: str(args['skill']) ?? str(args['path']) ?? (block.display?.kind === 'skill_call' ? block.display.skill_name : undefined),
    note: str(args['args']),
    preview: previewOf(outputText(block.output), 6, 600),
  };
}

const DESCRIBERS: Record<string, (block: ToolBlock, ctx: SemanticContext) => ToolSemantics> = {
  AgentRun: describeAgent,
  AgentList: describeAgent,
  AgentSend: describeAgent,
  AgentNotify: describeAgent,
  TaskList: describeTask,
  TaskOutput: describeTask,
  TaskStop: describeTask,
  TaskWait: describeTask,
  HistorySearch: describeHistory,
  HistoryRead: describeHistory,
  HistoryList: describeHistory,
  BoardRead: describeBoard,
  BoardWrite: describeBoard,
  Cron: describeCron,
  CronCreate: describeCron,
  CronList: describeCron,
  CronDelete: describeCron,
  Goal: describeGoal,
  CreateGoal: describeGoal,
  GetGoal: describeGoal,
  SetGoalBudget: describeGoal,
  UpdateGoal: describeGoal,
  TodoList: describeTodo,
  SelectTools: describeSelectTools,
  WebSearch: describeWebSearch,
  FetchURL: describeFetch,
  AskUserQuestion: describeQuestion,
  EnterPlanMode: describePlan,
  ExitPlanMode: describePlan,
  Skill: describeSkill,
};

/** Tools that have a semantic describer (the rest keep the generic row). */
export function hasToolSemantics(name: string): boolean {
  return THREAD_TOOLS.has(name) || name in DESCRIBERS;
}

/** The semantic reading of a built-in tool call, or undefined for any other tool. */
export function describeTool(block: ToolBlock, ctx: SemanticContext): ToolSemantics | undefined {
  if (THREAD_TOOLS.has(block.name)) return describeThread(block, ctx);
  const describer = DESCRIBERS[block.name];
  return describer === undefined ? undefined : describer(block, ctx);
}
