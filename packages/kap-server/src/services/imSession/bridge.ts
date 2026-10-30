import { createHash, randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { imSessionAdmitted, imProviderKindSchema, type ImBinding, type ImBusyDelivery, type ImBindingTestResult, type ImCatalog, type ImCheckResult, type ImConfirmRequest, type ImDiscovery, type ImInstanceView, type ImPasteResult, type ImPolicy, type ImProviderKind, type ImSessionSnapshot, type ImStranger, type MessageContent } from '@kiki/protocol';
import {
  internalMessageChannel,
  routeUserMessage,
  type MessageChannelBinding,
  type MessageChannelReceipt,
  type MessageMediaCapability,
  type SendMessageReceipt,
  type UserMessageChannel,
  type UserMessageInput,
} from '@kiki/agent-core-v2/app/bot/messageRouting';

import { ImSendError, type ImAdapterFactory, type ImInboundEvent, type ImInboundIdentity, type ImSessionAdapter } from './adapter';
import { parseImPaste } from './paste';
import type { ImAnswerResult, ImPendingQuestion, ImQuestionAnswer, ImSessionBridgeOptions, ImSessionPorts } from './ports';
import { segmentText } from './segment';
import { ImHistoryJournal } from './history';
import { withImDeadline } from './deadline';
import { joinDeliveries } from '../../lib/joinDeliveries';
import type { ImHistoryQuery } from '@kiki/agent-core-v2/app/bot/imMessageHistory';
import type { ImGroupPolicy, ImMessageMetadata } from '@kiki/protocol';

interface BindingRecord {
  id: string;
  providerInstanceId: string;
  providerKind: ImProviderKind;
  accountId: string;
  identity: ImInboundIdentity;
  sessionId: string;
  personaId?: string;
  enabled: boolean;
  sessionEnabled?: boolean;
  inputEnabled?: boolean;
  outputEnabled?: boolean;
  pendingReanchor?: boolean;
  bindingScope?: 'sender' | 'topic' | 'chat';
  groupPolicy?: ImGroupPolicy;
  busy: ImBusyDelivery;
  reply: 'final' | 'edit';
  mobileInteractions: boolean;
  interactionFailure?: 'feishu_thread_context_missing' | 'wechat_group_unsupported';
}

interface DiscoveryRecord {
  id: string;
  providerInstanceId: string;
  providerKind: ImProviderKind;
  accountId: string;
  identity: ImInboundIdentity;
  preview: string;
  at: number;
}

interface InstanceMeta {
  id: string;
  providerKind: ImProviderKind;
  label?: string;
  listening: boolean;
  virtual: boolean;
  accountId?: string;
  conflict?: 'webhook' | 'account_in_use';
  busy?: ImBusyDelivery;
  reply?: 'final' | 'edit';
  persona?: string;
}

interface TicketRecord {
  id: string;
  sessionId: string;
  interactionId: string;
  bindingId: string;
  senderKey: string;
  expiresAt: number;
  consumed: boolean;
  action: 'approve' | 'reject' | 'host_yes' | 'host_no' | 'single' | 'toggle' | 'multi_done' | 'other';
  questionKey?: string;
  questionIndex?: number;
  optionId?: string;
  group?: string;
}

interface StrangerRecord {
  providerInstanceId: string;
  identity: ImInboundIdentity;
  preview: string;
  count: number;
}

interface ReplyLedger {
  messageIds: string[];
  fileSent: boolean;
  lastText: string;
  failedText?: string;
  tooLongNotice?: string;
  undelivered?: boolean;
  deliveredText?: string;
}

interface OpenReply {
  bindingId: string;
  identity?: ImInboundIdentity;
  promptId: string;
  turnId?: number;
  messageIds: string[];
  lastText: string;
  deliveredText?: string;
  failedText?: string;
  tooLongNotice?: string;
  fileSent: boolean;
  undelivered?: boolean;
  open: boolean;
}

interface OutboxButton {
  id: string;
  label: string;
}

interface OutboxRecord {
  key: string;
  bindingId: string;
  senderKey: string;
  sessionId: string;
  interactionId: string;
  questionIndex?: number;
  kind: 'approval' | 'host_key' | 'question' | 'desktop_ssh';
  expiresAt: number;
  text: string;
  code: string;
  buttons: OutboxButton[];
  delivery: 'pending' | 'sending' | 'sent' | 'unknown';
}

interface Stored {
  policy: { allowed: boolean; defaultEnabled: boolean; allowChannelBorrowing?: boolean };
  notificationBindings?: { sessionId: string; channelId: string; enabled: boolean }[];
  messageReceipts?: Record<string, { channels: Record<string, MessageChannelReceipt> }>;
  instances: InstanceMeta[];
  discoveries: DiscoveryRecord[];
  bindings: BindingRecord[];
  strangers: StrangerRecord[];
  seen: string[];
  tickets: TicketRecord[];
  selections: Record<string, string[]>;
  awaiting: Record<string, { interactionId: string; questionKey: string; questionIndex?: number; expiresAt: number; sessionId: string }>;
  voiceFallbacks: number;
  cursors: Record<string, number>;
  notices: string[];
  questionAnswers: Record<string, Record<string, string | true>>;
  answeredQuestions: Record<string, string[]>;
  replies: OpenReply[];
  outbox: OutboxRecord[];
  internalOff?: string[];
}

interface Poller {
  tokenHash: string;
  ownerId: string;
  instances: Set<string>;
  listenerKey?: string;
  adapter: ImSessionAdapter;
}

const COPY = {
  en: {
    queued: 'Queued.',
    expired: 'Expired.',
    resolved: 'Already answered.',
    noTurn: 'No turn is in progress.',
    desktopSsh: 'This sign-in stays on the desktop SSH screen.',
    crossSession: 'That action belongs to another conversation.',
    rejected: 'That file was not saved.',
    switched: 'Target updated.',
    bindingTest: 'Kiki binding test: this is a test message.',
    allow: 'Allow',
    refuse: 'Refuse',
    done: 'Done',
    other: 'Other',
    trust: 'Trust',
    numbers: 'Send the number of a choice.',
    fileUnsupported: 'This platform cannot take that file.',
    mediaUnsupported: (kinds: string) => `This channel cannot take: ${kinds}. Those attachments were not sent here.`,
    tooLong: 'This platform rejected the message as too long and cannot take a file.',
    unknown: 'That action is not pending.',
    wechatAuth: 'This WeChat connection needs a new scan.',
    status: (busy: boolean, pending: string, queue: number) => `Busy: ${busy ? 'yes' : 'no'}. Waiting: ${pending}. Queue: ${queue}.`,
  },
  zh: {
    queued: '已排队。',
    expired: '已过期。',
    resolved: '已经处理过。',
    noTurn: '没有进行中的回合。',
    desktopSsh: '这次登录留在桌面的 SSH 界面。',
    crossSession: '这个操作属于另一个会话。',
    rejected: '没有收下这个文件。',
    switched: '已切换目标。',
    bindingTest: 'Kiki 绑定测试：这是一条测试消息。',
    allow: '同意',
    refuse: '拒绝',
    done: '完成',
    other: '其他',
    trust: '信任',
    numbers: '发送选项的数字。',
    fileUnsupported: '这个平台收不了这个文件。',
    mediaUnsupported: (kinds: string) => `这条信道收不了：${kinds}。这些附件没有在这里投递。`,
    tooLong: '这个平台认为消息过长，而且不能接收文件。',
    unknown: '没有这项待处理。',
    wechatAuth: '这个微信连接需要重新扫码。',
    status: (busy: boolean, pending: string, queue: number) => `忙：${busy ? '是' : '否'}。等待：${pending}。队列：${queue}。`,
  },
} as const;

function kindOf(providerId: string): ImProviderKind | undefined {
  const result = imProviderKindSchema.safeParse(providerId);
  return result.success ? result.data : undefined;
}

function matchesBinding(binding: BindingRecord, identity: ImInboundIdentity): boolean {
  if (binding.bindingScope === undefined || binding.bindingScope === 'sender' || (binding.bindingScope === 'topic' && binding.identity.topicId === '0')) return sameIdentity(binding.identity, identity);
  if (binding.identity.chatKind !== 'group' || identity.chatKind !== 'group' || binding.identity.chatId !== identity.chatId) return false;
  if (binding.bindingScope === 'chat') return true;
  return binding.identity.topicId === identity.topicId;
}

function assertGroupScope(scope: 'sender' | 'topic' | 'chat', identity: ImInboundIdentity): void {
  if (scope === 'sender') return;
  if (identity.chatKind !== 'group') throw new Error('group_binding_scope_required');
  if (scope === 'topic' && identity.topicId === '0') throw new Error('topic_scope_unavailable');
}

function overlapsBinding(left: BindingRecord, right: BindingRecord): boolean {
  return matchesBinding(left, right.identity) || matchesBinding(right, left.identity);
}

function sameIdentity(left: ImInboundIdentity, right: ImInboundIdentity): boolean {
  return left.chatId === right.chatId && left.senderId === right.senderId && left.topicId === right.topicId;
}

function senderKey(instanceId: string, identity: ImInboundIdentity): string {
  return `${instanceId}:${identity.chatId}:${identity.senderId}:${identity.topicId}`;
}

export class ImIdentityAlreadyBoundError extends Error {
  constructor(readonly details: Readonly<Record<string, unknown>>) {
    super('im_identity_already_bound');
  }
}

export class ImSessionBridge {
  private readonly ports: ImSessionPorts;
  private readonly factories: readonly ImAdapterFactory[];
  private readonly locale: () => 'en' | 'zh';
  private readonly editIntervalMs: number;
  private readonly now: () => number;
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  private state: Stored = emptyState();
  private readonly pollers = new Map<string, Poller>();
  private readonly pending = new Map<string, { poller: Poller; originId: string }>();
  private readonly failures = new Map<string, { phase: 'auth_expired' | 'stopped'; detail?: ImInstanceView['connection_detail'] }>();
  private closed = false;
  private readonly jobs = new Set<Promise<void>>();
  private readonly wechatLogin: ImSessionBridgeOptions['wechatLogin'];
  private readonly liveReplies = new Set<string>();
  private readonly projections = new Map<string, Promise<void>>();
  private readonly deliveryController = new AbortController();
  private syncFlight?: Promise<void>;
  private syncDirty = false;
  private ready: Promise<void>;
  private readonly history?: ImHistoryJournal;

  constructor(options: ImSessionBridgeOptions) {
    this.ports = options.ports;
    this.factories = options.factories;
    const locale = options.locale;
    this.locale = typeof locale === 'function' ? locale : () => locale ?? 'en';
    this.editIntervalMs = options.editIntervalMs ?? 2_000;
    this.now = options.now ?? (() => Date.now());
    this.wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.wechatLogin = options.wechatLogin;
    this.history = options.ports.history === undefined ? undefined : new ImHistoryJournal(options.ports.history);
    this.ready = this.restore();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  async snapshot(): Promise<ImSessionSnapshot> {
    await this.ready;
    await this.markOrphans();
    return {
      policy: { allowed: this.state.policy.allowed, default_enabled: this.state.policy.defaultEnabled, allow_channel_borrowing: this.state.policy.allowChannelBorrowing ?? false },
      instances: this.instanceViews(),
      discoveries: this.state.discoveries.map(toDiscovery),
      bindings: this.state.bindings.map(toBinding),
      strangers: this.state.strangers.map(toStranger),
      voice_fallbacks: this.state.voiceFallbacks,
    };
  }

  async catalog(): Promise<ImCatalog> {
    const [personas, sessions] = await Promise.all([this.ports.sessions.listPersonas(), this.ports.sessions.listSessions()]);
    return {
      personas: personas.map((persona) => ({ id: persona.id, name: persona.name, ...(persona.homeSessionId === undefined ? {} : { home_session_id: persona.homeSessionId }) })),
      sessions: sessions.map((session) => ({ id: session.id, title: session.title, ...(session.personaId === undefined ? {} : { persona_id: session.personaId }) })),
    };
  }

  async internalChannelEnabled(_sessionId: string): Promise<boolean> {
    await this.ready;
    return true;
  }

  async setInternalChannel(_sessionId: string, enabled: boolean): Promise<boolean> {
    await this.ready;
    if (!enabled) throw new Error('unsupported_internal_channel_disable');
    return true;
  }

  async setNotificationChannel(sessionId: string, channelId: string, enabled: boolean): Promise<readonly MessageChannelBinding[]> {
    await this.ready;
    if (!await this.ports.sessions.owns(sessionId)) throw new Error('unknown_session');
    if (!this.ports.notifications?.channels(sessionId).some((channel) => channel.id === `notify:${channelId}`)) throw new Error('unknown_notification_channel');
    const bindings = this.state.notificationBindings ??= [];
    const existing = bindings.find((binding) => binding.sessionId === sessionId && binding.channelId === channelId);
    if (existing === undefined) bindings.push({ sessionId, channelId, enabled });
    else existing.enabled = enabled;
    await this.persist();
    return this.channelViews(sessionId);
  }

  async removeNotificationChannel(sessionId: string, channelId: string): Promise<readonly MessageChannelBinding[]> {
    await this.ready;
    this.state.notificationBindings = (this.state.notificationBindings ?? []).filter((binding) => binding.sessionId !== sessionId || binding.channelId !== channelId);
    await this.persist();
    return this.channelViews(sessionId);
  }

  async channelViews(sessionId: string): Promise<readonly MessageChannelBinding[]> {
    await this.ready;
    return this.outputChannels(sessionId).map(({ id, kind, bound, enabled, capabilities }) => ({ id, kind, bound, enabled, capabilities }));
  }

  private outputChannels(sessionId: string): UserMessageChannel[] {
    const channels: UserMessageChannel[] = [internalMessageChannel()];
    for (const binding of this.state.bindings) {
      const adapter = this.adapterFor(binding.providerInstanceId);
      channels.push({
        id: `im:${binding.id}`, kind: 'im', bound: binding.sessionId === sessionId,
        enabled: this.admittedOutbound(binding), capabilities: this.bindingCapabilities(binding),
        send: (channelInput, skipped) => adapter === undefined
          ? Promise.resolve({ status: 'failed', detail: 'channel_not_connected' })
          : this.sendToIm(binding, adapter, channelInput, skipped),
      });
    }
    for (const channel of this.ports.notifications?.channels(sessionId) ?? []) {
      const binding = this.state.notificationBindings?.find((item) => item.sessionId === sessionId && `notify:${item.channelId}` === channel.id);
      channels.push({ ...channel, bound: binding !== undefined, enabled: channel.enabled && (binding?.enabled ?? true) });
    }
    for (const binding of this.state.notificationBindings ?? []) {
      if (binding.sessionId !== sessionId || channels.some((channel) => channel.id === `notify:${binding.channelId}`)) continue;
      channels.push({ id: `notify:${binding.channelId}`, kind: 'notify', bound: true, enabled: false, capabilities: [],
        send: async () => ({ status: 'failed', detail: 'channel_not_available' }),
      });
    }
    return channels;
  }

  async readMessageHistory(sessionId: string, query: ImHistoryQuery) {
    await this.ready;
    query.signal?.throwIfAborted();
    if (this.closed || !this.state.policy.allowed) throw new Error('history_not_available');
    const candidates = this.state.bindings.filter((binding) => binding.sessionId === sessionId && this.admittedInbound(binding) && this.adapterFor(binding.providerInstanceId) !== undefined);
    const binding = query.channel === undefined ? candidates.length === 1 ? candidates[0] : undefined : candidates.find((binding) => `im:${binding.id}` === query.channel);
    if (binding === undefined) throw new Error(query.channel === undefined && candidates.length > 1 ? 'history_channel_required: choose one bound IM channel' : 'history_channel_not_admitted');
    const adapter = this.adapterFor(binding.providerInstanceId)!;
    const senderScoped = binding.bindingScope === undefined || binding.bindingScope === 'sender';
    const topicId = query.topicId ?? binding.identity.topicId;
    if (binding.bindingScope !== 'chat' && topicId !== binding.identity.topicId) throw new Error('history_topic_not_admitted');
    if (senderScoped && query.senderId !== undefined && query.senderId !== binding.identity.senderId) throw new Error('history_sender_not_admitted');
    if (query.source === 'platform') {
      if (query.messageId !== undefined) return { status: 'unsupported' as const, detail: 'The platform history API does not provide an exact-message lookup; use the local received original.' };
      if (senderScoped) return { status: 'unsupported' as const, detail: 'Platform history requires an explicit chat/topic binding; sender-only bindings retain local sender-isolated reads.' };
      if (adapter.readHistory === undefined) return { status: 'unsupported' as const };
      if (query.keyword !== undefined || query.senderId !== undefined || query.before !== undefined) throw new Error('platform_history_filters_unsupported: use the local journal for filtered reads');
      const request = { chatId: binding.identity.chatId, topicId, cursor: query.cursor, limit: query.limit ?? 20 };
      const page = await adapter.readHistory(request);
      query.signal?.throwIfAborted();
      if (this.closed || !this.admittedInbound(binding) || this.adapterFor(binding.providerInstanceId) !== adapter) throw new Error('history_channel_withdrawn');
      if (page.status === 'ok' && page.messages.some((row) => row.identity.chatId !== request.chatId || row.identity.topicId !== request.topicId)) throw new Error('history_scope_mismatch');
      return page;
    }
    if (this.history === undefined) return { status: 'unsupported' as const, detail: 'Local IM history storage is unavailable.' };
    const room = ImHistoryJournal.room(binding.providerKind, binding.accountId, binding.identity.chatId, topicId);
    const page = await this.history.read(room, query, senderScoped ? binding.identity.senderId : undefined);
    if (this.closed || !this.admittedInbound(binding) || !this.state.bindings.includes(binding)) throw new Error('history_channel_withdrawn');
    return page;
  }

  private readonly messageQueues = new Map<string, Promise<SendMessageReceipt>>();

  sendUserMessage(input: UserMessageInput): Promise<SendMessageReceipt> {
    const previous = this.messageQueues.get(input.sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await this.ready;
      const key = JSON.stringify([input.sessionId, input.toolCallId]);
      const stored = this.state.messageReceipts ??= {};
      const record = stored[key] ??= { channels: {} };
      const channels = this.outputChannels(input.sessionId).map((channel): UserMessageChannel => ({
        ...channel,
        send: async (message, skipped) => {
          const previous = record.channels[channel.id];
          if (previous !== undefined) return previous;
          record.channels[channel.id] = { channelId: channel.id, status: 'unknown', detail: 'send_in_progress_or_interrupted' };
          await this.persist();
          let receipt: Omit<MessageChannelReceipt, 'channelId'>;
          try { receipt = await channel.send(message, skipped); }
          catch { receipt = { status: 'unknown', detail: 'send_outcome_unknown' }; }
          record.channels[channel.id] = { ...receipt, channelId: channel.id };
          await this.persist();
          return receipt;
        },
      }));
      return routeUserMessage(input, channels, { allowChannelBorrowing: this.state.policy.allowChannelBorrowing === true });
    });
    const queued: Promise<SendMessageReceipt> = operation.finally(() => {
      if (this.messageQueues.get(input.sessionId) === queued) this.messageQueues.delete(input.sessionId);
    });
    this.messageQueues.set(input.sessionId, queued);
    return queued;
  }

  async testBinding(id: string): Promise<ImBindingTestResult> {
    await this.ready;
    const binding = this.only(this.state.bindings, id);
    if (binding === undefined) throw new Error('unknown_binding');
    if (!this.admittedOutbound(binding)) return { binding_id: id, status: 'failed', message_ids: [], detail: 'binding_disabled' };
    const adapter = this.adapterFor(binding.providerInstanceId);
    if (adapter === undefined) return { binding_id: id, status: 'failed', message_ids: [], detail: 'channel_not_connected' };
    const sent = await this.sendToIm(binding, adapter, {
      sessionId: binding.sessionId, toolCallId: `binding-test:${id}`, attachments: [],
      text: this.copy('bindingTest'),
    }, []);
    return { binding_id: id, status: sent.status === 'unsupported' ? 'failed' : sent.status, message_ids: [...(sent.messageIds ?? [])], detail: sent.detail };
  }

  private bindingCapabilities(binding: BindingRecord): readonly MessageMediaCapability[] {
    const adapter = this.adapterFor(binding.providerInstanceId);
    if (adapter !== undefined) return mediaCapabilitiesOf(adapter);
    const credential = this.ports.credentials.read(binding.providerInstanceId);
    if (credential === undefined) return [];
    try {
      return this.factories.find((factory) => factory.providerKind === binding.providerKind)?.mediaCapabilities?.({ instanceId: binding.providerInstanceId, credential }) ?? [];
    } catch { return []; }
  }

  private readonly sends = new WeakMap<ImSessionAdapter, { controller: AbortController; targets: Map<string, { tail: Promise<unknown>; at?: number }> }>();

  private pacedSend<T>(adapter: ImSessionAdapter, identity: ImInboundIdentity, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let owned = this.sends.get(adapter);
    if (owned === undefined) {
      owned = { controller: new AbortController(), targets: new Map() };
      this.sends.set(adapter, owned);
    }
    const combined = AbortSignal.any([this.deliveryController.signal, owned.controller.signal, ...(signal === undefined ? [] : [signal])]);
    const key = JSON.stringify([identity.chatId, identity.topicId]);
    let target = owned.targets.get(key);
    if (target === undefined) {
      target = { tail: Promise.resolve() };
      owned.targets.set(key, target);
    }
    const current = target;
    const interval = this.factories.find((factory) => factory.providerKind === adapter.providerKind)?.minSendIntervalMs ?? 0;
    const previous = current.tail;
    const bindings = this.state.bindings.filter((binding) => sameIdentity(binding.identity, identity) && this.adapterFor(binding.providerInstanceId) === adapter);
    let dispatched = false;
    const run = withImDeadline(combined, 60_000, (deadline) => previous.catch(() => undefined).then(async () => {
      deadline.throwIfAborted();
      const remaining = current.at === undefined ? 0 : Math.max(0, current.at + interval - this.now());
      if (remaining > 0) {
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(deadline.reason);
          deadline.addEventListener('abort', aborted, { once: true });
          void this.wait(remaining, deadline).then(resolve, reject).finally(() => deadline.removeEventListener('abort', aborted));
          if (deadline.aborted) aborted();
        });
      }
      deadline.throwIfAborted();
      if (bindings.length > 0 && !bindings.some((binding) => this.state.bindings.includes(binding) && this.admittedOutbound(binding) && this.adapterFor(binding.providerInstanceId) === adapter)) throw new ImSendError('im_send_cancelled');
      current.at = this.now();
      dispatched = true;
      return work(deadline);
    })).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AbortError') throw new ImSendError(dispatched ? 'im_send_outcome_unknown' : 'im_send_cancelled', [], undefined, dispatched ? 'unknown' : 'failed');
      throw error;
    });
    current.tail = run;
    return run;
  }

  private stopAdapter(adapter: ImSessionAdapter): Promise<void> {
    this.sends.get(adapter)?.controller.abort();
    return adapter.stop();
  }

  private async sendToIm(binding: BindingRecord, adapter: ImSessionAdapter, input: UserMessageInput, skipped: readonly string[]): Promise<Omit<MessageChannelReceipt, 'channelId'>> {
    if (input.replyTo !== undefined && adapter.supportsReply !== true) return { status: 'unsupported', unsupported: ['reply'], detail: 'reply_unsupported' };
    if ((input.mentionIds?.length ?? 0) > 0 && adapter.supportsMentions !== true) return { status: 'unsupported', unsupported: ['mentions'], detail: 'mentions_unsupported' };
    const messageIds: string[] = [];
    const unsupported = [...skipped];
    let delivered = false;
    let failure: 'failed' | 'unknown' | 'partial' | undefined;
    let detail: string | undefined;
    const text = [input.text, skipped.length > 0 ? COPY[this.locale()].mediaUnsupported(skipped.join(', ')) : ''].filter((part) => part.length > 0).join('\n\n');
    if (text.length > 0) {
      try {
        const sent = await this.pacedSend(adapter, binding.identity, (signal) => adapter.sendTextParts({ identity: binding.identity, parts: adapter.splitText(text), code: 'send_message', replyToMessageId: input.replyTo, mentionIds: input.mentionIds, signal }), input.signal);
        delivered = input.text.length > 0;
        messageIds.push(...sent.messageIds.filter((id) => id.length > 0));
      } catch (error) {
        failure = error instanceof ImSendError ? error.outcome : 'unknown';
        if (error instanceof ImSendError) {
          messageIds.push(...error.acceptedIds);
          delivered = input.text.length > 0 && error.acceptedIds.some((id) => id.length > 0);
        }
        detail = error instanceof ImSendError ? error.message : 'Send outcome is unknown; do not resend automatically.';
      }
    }
    for (const attachment of input.attachments) {
      const kind = attachment.kind ?? 'file';
      let read: Awaited<ReturnType<NonNullable<ImSessionPorts['sessions']['readAttachment']>>>;
      try {
        read = await this.ports.sessions.readAttachment?.({ sessionId: input.sessionId, blobId: attachment.blobId });
      } catch {
        failure ??= 'failed';
        detail ??= 'attachment_unavailable';
        continue;
      }
      if (read === undefined) {
        failure ??= 'failed';
        detail ??= 'attachment_unavailable';
        continue;
      }
      try {
        const receipt = adapter.sendMedia === undefined
          ? { status: 'unsupported' as const, unsupported: [kind] }
          : await this.pacedSend(adapter, binding.identity, (signal) => adapter.sendMedia!({ identity: binding.identity, name: attachment.title ?? (basename(attachment.path) || read!.name), mediaType: attachment.mimeType ?? read!.mediaType ?? 'application/octet-stream', bytes: read!.bytes, kind, signal }), input.signal);
        if (receipt.messageIds !== undefined) messageIds.push(...receipt.messageIds.filter((id) => id.length > 0));
        delivered ||= receipt.messageIds?.some((id) => id.length > 0) === true;
        if (receipt.status === 'delivered') delivered = true;
        else if (receipt.status === 'unsupported') unsupported.push(...(receipt.unsupported ?? [kind]));
        else {
          if (failure !== 'unknown') failure = receipt.status;
          detail = receipt.detail ?? detail;
        }
      } catch {
        failure = 'unknown';
        detail = 'Send outcome is unknown; do not resend automatically.';
      }
    }
    const newlyUnsupported = [...new Set(unsupported.filter((kind) => !skipped.includes(kind)))];
    if (newlyUnsupported.length > 0) {
      try {
        const sent = await this.pacedSend(adapter, binding.identity, (signal) => adapter.sendText({ identity: binding.identity, text: COPY[this.locale()].mediaUnsupported(newlyUnsupported.join(', ')), code: 'media_unsupported', signal }), input.signal);
        messageIds.push(...(sent.messageIds ?? [sent.messageId]).filter((id) => id.length > 0));
      } catch (error) {
        if (failure !== 'unknown') failure = error instanceof ImSendError ? error.outcome : 'unknown';
        detail = 'Unsupported attachments were not sent; the channel notice could not be confirmed.';
      }
    }
    const status = failure === 'failed' && delivered ? 'partial' : failure ??
      (unsupported.length > 0 ? delivered ? 'partial' : 'unsupported' : 'delivered');
    await this.rememberSent(binding, messageIds);
    return { status, messageIds, unsupported: unsupported.length > 0 ? [...new Set(unsupported)] : undefined, detail };
  }

  private async rememberSent(binding: BindingRecord, ids: readonly string[]): Promise<void> {
    if (this.history === undefined || binding.identity.chatKind !== 'group' || ids.length === 0) return;
    try { await this.history.rememberSent(ImHistoryJournal.room(binding.providerKind, binding.accountId, binding.identity.chatId, binding.identity.topicId), ids); }
    catch { this.ports.logger.info({ instance_id: binding.providerInstanceId, failed: true }, 'im sent-history observation failed'); }
  }

  async reconcileAdapters(changedKinds: readonly ImProviderKind[]): Promise<void> {
    await this.ready;
    const changed = new Set(changedKinds);
    const ids = [...new Set([...this.pollers.values(), ...[...this.pending.values()].map((attempt) => attempt.poller)].filter((poller) => changed.has(poller.adapter.providerKind)).flatMap((poller) => [...poller.instances]))];
    for (const poller of this.pollers.values()) if (changed.has(poller.adapter.providerKind)) this.sends.get(poller.adapter)?.controller.abort();
    const sessions = new Set(this.state.bindings.filter((binding) => ids.includes(binding.providerInstanceId)).map((binding) => binding.sessionId));
    await Promise.allSettled([...sessions].flatMap((id) => { const queue = this.messageQueues.get(id); return queue === undefined ? [] : [queue]; }));
    await this.enqueueLifecycle(async () => { for (const id of ids) await this.releaseOne(id); });
    if (this.state.policy.allowed) { await this.ensureListening(); await this.resumeReplies(); }
    await this.persist();
  }

  async setPolicy(policy: ImPolicy): Promise<ImSessionSnapshot> {
    await this.ready;
    this.state.policy = { allowed: policy.allowed, defaultEnabled: policy.default_enabled, allowChannelBorrowing: policy.allow_channel_borrowing ?? false };
    if (!policy.allowed) await this.stopAll();
    else await this.ensureListening();
    await this.persist();
    if (policy.allowed) await this.resumeReplies();
    return this.snapshot();
  }

  async paste(input: { instanceId?: string; text: string }): Promise<ImPasteResult> {
    await this.ready;
    const parsed = parseImPaste(input.text);
    if (parsed.providerKind === undefined || parsed.credential === undefined) throw new Error('paste_unrecognized');
    let instanceId = input.instanceId;
    if (instanceId === undefined) {
      if (this.ports.credentials.create === undefined) throw new Error('instance_required');
      const created = await this.ports.credentials.create({ providerKind: parsed.providerKind, credential: parsed.credential });
      instanceId = created.instanceId;
      this.state.instances.push({ id: instanceId, providerKind: parsed.providerKind, label: created.label, listening: false, virtual: true });
    } else {
      await this.ports.credentials.write(instanceId, parsed.credential);
      const meta = this.meta(instanceId, parsed.providerKind);
      meta.providerKind = parsed.providerKind;
    }
    const meta = this.meta(instanceId, parsed.providerKind);
    if (parsed.busy !== undefined) meta.busy = parsed.busy;
    if (parsed.reply !== undefined) meta.reply = parsed.reply;
    if (parsed.persona !== undefined) meta.persona = parsed.persona;
    this.ports.logger.info({ provider_kind: parsed.providerKind, instance_id: instanceId, ignored: parsed.ignoredKeys.length }, 'im paste stored');
    await this.persist();
    return { provider_instance_id: instanceId, provider_kind: parsed.providerKind, ignored_keys: [...parsed.ignoredKeys], chat_hint_ignored: parsed.chatHintIgnored };
  }

  async setListening(instanceId: string, listening: boolean): Promise<ImSessionSnapshot> {
    await this.ready;
    const meta = this.requireMeta(instanceId);
    meta.listening = listening;
    if (!listening) await this.release(instanceId);
    else await this.ensureOne(instanceId);
    await this.persist();
    if (listening) await this.resumeReplies(instanceId);
    return this.snapshot();
  }

  async check(instanceId: string): Promise<ImCheckResult> {
    await this.ready;
    const result = await this.ports.credentials.check(instanceId);
    const meta = this.requireMeta(instanceId);
    await this.enqueueLifecycle(async () => {
      const tokenHash = this.credentialHash(instanceId);
      if ([...this.pollers.values(), ...[...this.pending.values()].map((attempt) => attempt.poller)].some((poller) => (poller.instances.has(instanceId) || poller.ownerId === instanceId) && poller.tokenHash !== tokenHash)) await this.releaseOne(instanceId);
    });
    if (result.conflict === 'webhook') {
      meta.conflict = 'webhook';
      await this.release(instanceId);
      await this.persist();
      return { ok: false, conflict: 'webhook', ...(result.detail === undefined ? {} : { detail: result.detail }) };
    }
    meta.conflict = undefined;
    if (result.accountId !== undefined && meta.accountId !== undefined && meta.accountId !== result.accountId) {
      for (const binding of this.state.bindings) if (binding.providerInstanceId === instanceId) binding.enabled = false;
    }
    if (result.accountId !== undefined) meta.accountId = result.accountId;
    await this.persist();
    return { ok: result.ok, ...(result.accountId === undefined ? {} : { account_id: result.accountId }), ...(result.detail === undefined ? {} : { detail: result.detail }) };
  }

  confirm(discoveryId: string, request: ImConfirmRequest): Promise<ImSessionSnapshot> {
    return this.mutateBindings(async () => {
      const discovery = this.only(this.state.discoveries, discoveryId);
      if (discovery === undefined) throw new Error('unknown_discovery');
      if (discovery.providerKind === 'wechat_bridge' && (discovery.identity.chatKind === 'group' || discovery.identity.topicId !== '0')) throw new Error('unsupported_wechat_group');
      const meta = this.requireMeta(discovery.providerInstanceId);
      const resolved = await this.resolveTarget(request.target);
      const scope = request.binding_scope ?? 'sender';
      assertGroupScope(scope, discovery.identity);
      const factory = this.factories.find((item) => item.providerKind === discovery.providerKind);
      if (factory?.inbound === false && request.input_enabled === true) throw new Error('input_unsupported');
      if (factory?.outbound === false && request.output_enabled === true) throw new Error('output_unsupported');
      const candidate = { identity: discovery.identity, bindingScope: scope } as BindingRecord;
      const existing = this.state.bindings.find((item) => item.providerInstanceId === discovery.providerInstanceId && item.accountId === discovery.accountId && (item.bindingScope ?? 'sender') === scope && matchesBinding(candidate, item.identity));
      if (existing !== undefined && existing.sessionId !== resolved.sessionId && !request.rebind) throw this.identityConflict(existing, resolved.sessionId);
      const binding: BindingRecord = existing === undefined ? {
        id: this.next('b'), providerInstanceId: discovery.providerInstanceId, providerKind: discovery.providerKind,
        accountId: discovery.accountId, identity: discovery.identity, sessionId: resolved.sessionId, personaId: resolved.personaId,
        enabled: true, busy: request.busy ?? meta.busy ?? 'immediate', reply: request.reply ?? meta.reply ?? 'final', mobileInteractions: request.mobile_interactions ?? true,
      } : { ...existing, identity: discovery.identity, sessionId: resolved.sessionId, personaId: resolved.personaId,
        busy: request.busy ?? existing.busy ?? meta.busy ?? 'immediate', reply: request.reply ?? meta.reply ?? existing.reply,
        mobileInteractions: request.mobile_interactions ?? existing.mobileInteractions,
      };
      binding.pendingReanchor = false;
      binding.bindingScope = scope;
      binding.groupPolicy = request.group_policy ?? binding.groupPolicy ?? (scope === 'sender' ? undefined : { wake: 'mention_or_reply' });
      binding.inputEnabled = factory?.inbound === false ? false : request.input_enabled ?? binding.inputEnabled;
      binding.outputEnabled = factory?.outbound === false ? false : request.output_enabled ?? binding.outputEnabled;
      const previousBindings = [...this.state.bindings];
      const previousInputs = previousBindings.map((item) => [item, item.inputEnabled] as const);
      const previousDiscoveries = this.state.discoveries;
      const previousReplies = this.state.replies.map((item) => [item, item.open] as const);
      try {
        this.claimInput(binding, request.rebind === true);
        if (existing === undefined) this.state.bindings.push(binding);
        else {
          if (existing.sessionId !== binding.sessionId) this.expireReplies(existing.id);
          this.state.bindings[this.state.bindings.indexOf(existing)] = binding;
        }
        this.state.discoveries = this.state.discoveries.filter((item) => item.id !== discoveryId);
        await this.persist();
      } catch (error) {
        this.state.bindings = previousBindings;
        for (const [item, enabled] of previousInputs) item.inputEnabled = enabled;
        this.state.discoveries = previousDiscoveries;
        for (const [item, open] of previousReplies) item.open = open;
        throw error;
      }
      if (request.also_home && resolved.personaId !== undefined) await this.ports.sessions.setHome?.(resolved.personaId, resolved.sessionId);
      return this.snapshot();
    });
  }

  private bindingMutation: Promise<unknown> = Promise.resolve();

  private mutateBindings<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.bindingMutation.catch(() => undefined).then(async () => {
      await this.ready;
      return operation();
    });
    this.bindingMutation = run;
    return run;
  }

  private async resolveTarget(target: ImConfirmRequest['target']): Promise<{ sessionId: string; personaId?: string }> {
    if (target.kind === 'persona') {
      const home = await this.ports.sessions.ensureHome(target.persona_id);
      if (home.homeSessionId === undefined || home.homeSessionId.length === 0) throw new Error('home_session_missing');
      return { sessionId: home.homeSessionId, personaId: target.persona_id };
    }
    if (!await this.ports.sessions.owns(target.session_id)) throw new Error('unknown_session');
    return { sessionId: target.session_id };
  }

  private identityConflict(binding: BindingRecord, sessionId: string): ImIdentityAlreadyBoundError {
    return new ImIdentityAlreadyBoundError({ existing_binding_id: binding.id, previous_session_id: binding.sessionId,
      target_session_id: sessionId, variant_key: { provider_instance_id: binding.providerInstanceId, account_id: binding.accountId,
        chat_id: binding.identity.chatId, topic_id: binding.identity.topicId, sender_id: binding.identity.senderId }, overlapping_bindings: [] });
  }

  private claimInput(candidate: BindingRecord, rebind: boolean): void {
    if (!this.admittedInbound(candidate)) return;
    const conflicts = this.state.bindings.filter((item) => item.id !== candidate.id && item.providerInstanceId === candidate.providerInstanceId && item.accountId === candidate.accountId && overlapsBinding(item, candidate) && this.admittedInbound(item));
    if (!rebind && conflicts.length > 0) throw this.identityConflict(conflicts[0]!, candidate.sessionId);
    for (const binding of conflicts) binding.inputEnabled = false;
  }

  async dismiss(discoveryId: string): Promise<ImSessionSnapshot> {
    await this.ready;
    if (this.only(this.state.discoveries, discoveryId) === undefined) throw new Error('unknown_discovery');
    this.state.discoveries = this.state.discoveries.filter((item) => item.id !== discoveryId);
    await this.persist();
    return this.snapshot();
  }

  updateBinding(id: string, patch: { bindingScope?: 'sender' | 'topic' | 'chat'; groupPolicy?: ImGroupPolicy; enabled?: boolean; sessionEnabled?: boolean | null; inputEnabled?: boolean | null; outputEnabled?: boolean | null; rebind?: boolean; busy?: ImBusyDelivery; reply?: 'final' | 'edit'; mobileInteractions?: boolean; sessionId?: string; target?: ImConfirmRequest['target'] }): Promise<ImSessionSnapshot> {
    return this.mutateBindings(async () => {
      const binding = this.only(this.state.bindings, id);
      if (binding === undefined) throw new Error('unknown_binding');
      const target = patch.target ?? (patch.sessionId === undefined ? undefined : { kind: 'session' as const, session_id: patch.sessionId });
      const resolved = target === undefined ? undefined : await this.resolveTarget(target);
      if (resolved !== undefined && binding.sessionId !== resolved.sessionId && !patch.rebind) throw this.identityConflict(binding, resolved.sessionId);
      const next = { ...binding };
      if (patch.bindingScope !== undefined) {
        assertGroupScope(patch.bindingScope, binding.identity);
        next.bindingScope = patch.bindingScope;
        if (patch.bindingScope !== 'sender') next.groupPolicy ??= { wake: 'mention_or_reply' };
      }
      const factory = this.factories.find((item) => item.providerKind === binding.providerKind);
      if (factory?.inbound === false && patch.inputEnabled === true) throw new Error('input_unsupported');
      if (factory?.outbound === false && patch.outputEnabled === true) throw new Error('output_unsupported');
      if (patch.groupPolicy !== undefined) next.groupPolicy = patch.groupPolicy;
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.sessionEnabled === null) delete next.sessionEnabled;
      else if (patch.sessionEnabled !== undefined) next.sessionEnabled = patch.sessionEnabled;
      if (patch.inputEnabled === null) delete next.inputEnabled;
      else if (patch.inputEnabled !== undefined) next.inputEnabled = patch.inputEnabled;
      if (patch.outputEnabled === null) delete next.outputEnabled;
      else if (patch.outputEnabled !== undefined) next.outputEnabled = patch.outputEnabled;
      if (patch.busy !== undefined) next.busy = patch.busy;
      if (patch.reply !== undefined) next.reply = patch.reply;
      if (patch.mobileInteractions !== undefined) next.mobileInteractions = patch.mobileInteractions;
      if (resolved !== undefined) {
        next.sessionId = resolved.sessionId;
        next.personaId = resolved.personaId;
        next.pendingReanchor = false;
      }
      const previousBindings = [...this.state.bindings];
      const previousInputs = previousBindings.map((item) => [item, item.inputEnabled] as const);
      const previousReplies = this.state.replies.map((item) => [item, item.open] as const);
      try {
        this.claimInput(next, patch.rebind === true);
        const index = this.state.bindings.indexOf(binding);
        if (binding.sessionId !== next.sessionId || binding.bindingScope !== next.bindingScope) this.expireReplies(binding.id);
        this.state.bindings[index] = next;
        await this.persist();
      } catch (error) {
        this.state.bindings = previousBindings;
        for (const [item, enabled] of previousInputs) item.inputEnabled = enabled;
        for (const [item, open] of previousReplies) item.open = open;
        throw error;
      }
      await this.resumeReplies(next.providerInstanceId);
      return this.snapshot();
    });
  }

  async removeBinding(id: string): Promise<ImSessionSnapshot> {
    await this.ready;
    if (this.only(this.state.bindings, id) === undefined) throw new Error('unknown_binding');
    this.state.bindings = this.state.bindings.filter((item) => item.id !== id);
    await this.persist();
    return this.snapshot();
  }

  suppressChannel(input: { providerInstanceId: string; scene: 'work_complete' | 'question_pending'; target: Record<string, unknown> }): boolean {
    const chat = input.target['chat_id'];
    if (typeof chat !== 'string' && typeof chat !== 'number') return false;
    return this.state.bindings.some((binding) => binding.providerInstanceId === input.providerInstanceId && binding.identity.chatId === String(chat) && this.admittedOutbound(binding) && (input.scene === 'work_complete' || binding.mobileInteractions));
  }

  syncInteractions(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.syncFlight !== undefined) {
      this.syncDirty = true;
      return this.syncFlight;
    }
    const run = (async () => {
      await this.ready;
      const errors: unknown[] = [];
      do {
        this.syncDirty = false;
        if (this.closed) break;
        const reads = new Map<string, ReturnType<ImSessionPorts['sessions']['listInteractions']>>();
        const bindings = this.state.bindings.filter((binding) => this.admittedOutbound(binding) && binding.mobileInteractions);
        await Promise.all(bindings.map(async (binding) => {
          try {
            let read = reads.get(binding.sessionId);
            if (read === undefined) {
              read = withImDeadline(this.deliveryController.signal, 10_000,
                (signal) => this.ports.sessions.listInteractions(binding.sessionId, signal));
              reads.set(binding.sessionId, read);
            }
            const pending = await read;
            if (!this.closed) await this.projectInteractions(binding, pending.approvals, pending.questions);
          } catch (error) {
            if (!this.closed) errors.push(error);
          }
        }));
      } while (this.syncDirty && !this.closed);
      if (errors.length > 0) throw errors[0];
    })();
    this.syncFlight = run;
    void run.then(() => { this.syncFlight = undefined; }, () => { this.syncFlight = undefined; });
    return run;
  }

  async startWechatQr(): Promise<{ login_id: string; image: string }> {
    await this.ready;
    if (this.wechatLogin === undefined) throw new Error('wechat_login_unavailable');
    return this.wechatLogin.start();
  }

  async pollWechatQr(id: string, verifyCode?: string): Promise<{ status: string; provider_instance_id?: string; account_id?: string }> {
    await this.ready;
    if (this.wechatLogin === undefined) throw new Error('wechat_login_unavailable');
    return this.wechatLogin.poll(id, verifyCode);
  }

  async cancelWechatQr(id: string): Promise<Record<string, never>> {
    await this.ready;
    if (this.wechatLogin !== undefined) await this.wechatLogin.cancel(id);
    return {};
  }

  async close(): Promise<void> {
    this.closed = true;
    this.syncDirty = false;
    this.deliveryController.abort();
    await this.ready;
    await this.stopAll();
    await joinDeliveries([...this.jobs, ...this.projections.values(), ...(this.syncFlight === undefined ? [] : [this.syncFlight])]);
    await this.persistenceQueue;
  }

  private async restore(): Promise<void> {
    const raw = await this.ports.load();
    if (raw === undefined || raw === '') return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) this.state = { ...emptyState(), ...(parsed as Stored) };
    if (!Array.isArray(this.state.replies)) this.state.replies = [];
    if (!Array.isArray(this.state.outbox)) this.state.outbox = [];
    let recovered = false;
    for (const job of this.state.outbox) if (job.delivery === 'sending') { job.delivery = 'unknown'; recovered = true; }
    if (recovered) await this.persist();
    if (typeof this.state.questionAnswers !== 'object' || this.state.questionAnswers === null) this.state.questionAnswers = {};
    if (typeof this.state.answeredQuestions !== 'object' || this.state.answeredQuestions === null) this.state.answeredQuestions = {};
    await this.markOrphans();
  }

  private persistenceQueue: Promise<void> = Promise.resolve();

  private persist(): Promise<void> {
    const operation = this.persistenceQueue.catch(() => undefined).then(() => this.ports.save(JSON.stringify(this.state)));
    this.persistenceQueue = operation;
    return operation;
  }

  private copy(key: keyof typeof COPY.en): string {
    return COPY[this.locale()][key] as string;
  }

  private baseAdmitted(binding: BindingRecord): boolean {
    const accountId = this.state.instances.find((instance) => instance.id === binding.providerInstanceId)?.accountId;
    return (!binding.providerKind.startsWith('plugin:') || this.factories.some((factory) => factory.providerKind === binding.providerKind)) && (accountId === undefined || accountId === binding.accountId) && !binding.pendingReanchor && binding.enabled && imSessionAdmitted({ allowed: this.state.policy.allowed, defaultEnabled: this.state.policy.defaultEnabled, sessionEnabled: binding.sessionEnabled });
  }

  private admittedInbound(binding: BindingRecord): boolean {
    return this.baseAdmitted(binding) && binding.inputEnabled !== false && this.factories.find((factory) => factory.providerKind === binding.providerKind)?.inbound !== false;
  }

  private admittedOutbound(binding: BindingRecord): boolean {
    return this.baseAdmitted(binding) && binding.outputEnabled !== false && this.factories.find((factory) => factory.providerKind === binding.providerKind)?.outbound !== false;
  }

  private async markOrphans(): Promise<void> {
    const ids = [...new Set(this.state.bindings.map((binding) => binding.sessionId).filter((id) => typeof id === 'string' && id.length > 0))];
    const owned = new Set((await Promise.all(ids.map(async (id) => await this.ports.sessions.owns(id) ? id : undefined))).filter((id) => id !== undefined));
    for (const binding of this.state.bindings) if (!owned.has(binding.sessionId)) binding.pendingReanchor = true;
    const variants = new Map<string, BindingRecord[]>();
    for (const binding of this.state.bindings) {
      if (!this.admittedInbound(binding)) continue;
      const key = JSON.stringify([binding.providerInstanceId, binding.accountId, binding.identity.chatId, binding.identity.topicId, binding.identity.senderId]);
      const matches = variants.get(key) ?? [];
      matches.push(binding);
      variants.set(key, matches);
    }
    for (const matches of variants.values()) if (matches.length > 1) for (const binding of matches) binding.pendingReanchor = true;
  }

  private next(prefix: string): string {
    const used = new Set<string>([
      ...this.state.bindings.map((item) => item.id),
      ...this.state.discoveries.map((item) => item.id),
      ...this.state.tickets.map((item) => item.id),
    ]);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = `${prefix}${randomBytes(8).toString('hex')}`;
      if (!used.has(id)) return id;
    }
    throw new Error('id_exhausted');
  }

  private only<T extends { id: string }>(items: readonly T[], id: string): T | undefined {
    const matches = items.filter((item) => item.id === id);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private meta(instanceId: string, providerKind: ImProviderKind): InstanceMeta {
    const found = this.state.instances.find((item) => item.id === instanceId);
    if (found !== undefined) return found;
    const listed = this.ports.credentials.list().find((item) => item.id === instanceId);
    const kind = listed === undefined ? providerKind : kindOf(listed.providerId) ?? providerKind;
    const created: InstanceMeta = { id: instanceId, providerKind: kind, label: listed?.label, listening: false, virtual: listed === undefined };
    this.state.instances.push(created);
    return created;
  }

  private requireMeta(instanceId: string): InstanceMeta {
    const found = this.state.instances.find((item) => item.id === instanceId);
    if (found !== undefined) return found;
    const listed = this.ports.credentials.list().find((item) => item.id === instanceId);
    const kind = listed === undefined ? undefined : kindOf(listed.providerId);
    if (kind === undefined) throw new Error('unknown_instance');
    return this.meta(instanceId, kind);
  }

  private instanceViews(): ImInstanceView[] {
    const listed = new Map(this.ports.credentials.list().map((item) => [item.id, item]));
    const ids = new Set<string>([...listed.keys(), ...this.state.instances.map((item) => item.id)]);
    const views: ImInstanceView[] = [];
    for (const id of ids) {
      const remote = listed.get(id);
      const kind = this.state.instances.find((item) => item.id === id)?.providerKind ?? (remote === undefined ? undefined : kindOf(remote.providerId));
      if (kind === undefined) continue;
      const meta = this.meta(id, kind);
      if (remote?.label !== undefined) meta.label = remote.label;
      const poller = [...this.pollers.values()].find((item) => item.instances.has(id));
      const attempt = [...this.pending.values()].find((item) => item.poller.instances.has(id));
      const phase = this.linkPhase(poller?.adapter ?? attempt?.poller.adapter) ?? this.failures.get(id)?.phase ?? (attempt === undefined ? undefined : 'starting');
      const active = poller !== undefined && phase !== 'stopped' && phase !== 'auth_expired' && this.adapterPhase(poller.adapter) !== 'conflict';
      const view: ImInstanceView = {
        id,
        provider_kind: kind,
        ...(meta.label === undefined ? {} : { label: meta.label }),
        listening: meta.listening && this.factories.find((factory) => factory.providerKind === kind)?.inbound !== false,
        inbound: this.factories.find((factory) => factory.providerKind === kind)?.inbound,
        outbound: this.factories.find((factory) => factory.providerKind === kind)?.outbound,
        configured: remote?.configured === true || this.ports.credentials.read(id) !== undefined,
        ...(meta.accountId === undefined ? {} : { account_id: meta.accountId }),
        ...(meta.conflict === undefined ? {} : { conflict: meta.conflict }),
        adapter: !active ? (this.factories.some((factory) => factory.providerKind === kind) ? 'stopped' : 'missing') : poller.ownerId === id ? 'running' : 'shared',
        connection: phase,
        connection_detail: (poller?.adapter ?? attempt?.poller.adapter)?.connectionDetail?.() ?? this.failures.get(id)?.detail,
        inbound_diagnostics: (poller?.adapter ?? attempt?.poller.adapter)?.inboundDiagnostics?.().map((entry) => ({ ...entry })),
      };
      views.push(view);
    }
    return views;
  }

  private async ensureListening(): Promise<void> {
    for (const meta of this.state.instances) if (meta.listening) await this.ensureOne(meta.id);
  }

  private join(poller: Poller, instanceId: string): void {
    this.failures.delete(instanceId);
    poller.instances.add(instanceId);
    this.retarget(instanceId, poller.ownerId);
    this.requireMeta(instanceId).accountId = this.requireMeta(poller.ownerId).accountId;
  }

  private credentialHash(instanceId: string): string | undefined {
    const credential = this.ports.credentials.read(instanceId);
    if (credential === undefined || credential.length === 0) return undefined;
    const kind = this.state.instances.find((item) => item.id === instanceId)?.providerKind ?? kindOf(this.ports.credentials.list().find((item) => item.id === instanceId)?.providerId ?? '');
    if (kind === undefined) return undefined;
    return createHash('sha256').update(`${kind}\u0000${credential}`).digest('hex');
  }

  private reanchor(poller: Poller): void {
    if (this.credentialHash(poller.ownerId) === poller.tokenHash) return;
    const owner = [...poller.instances].find((id) => this.credentialHash(id) === poller.tokenHash);
    if (owner === undefined || owner === poller.ownerId) return;
    this.retarget(poller.ownerId, owner);
    poller.ownerId = owner;
  }

  private lifecycle: Promise<void> = Promise.resolve();

  private enqueueLifecycle(work: () => Promise<void>): Promise<void> {
    const run = this.lifecycle.then(work, work);
    this.lifecycle = run.then(() => undefined, () => undefined);
    return run;
  }

  private ensureOne(instanceId: string): Promise<void> {
    return this.enqueueLifecycle(() => this.startOne(instanceId));
  }

  private async startOne(instanceId: string): Promise<void> {
    if (this.closed || !this.state.policy.allowed) return;
    const meta = this.requireMeta(instanceId);
    if (!meta.listening || meta.conflict === 'webhook') return;
    const credential = this.ports.credentials.read(instanceId);
    const tokenHash = this.credentialHash(instanceId);
    const attached = [...this.pollers.values(), ...[...this.pending.values()].map((attempt) => attempt.poller)].some((poller) => (poller.instances.has(instanceId) || poller.ownerId === instanceId) && poller.tokenHash !== tokenHash);
    if (attached) await this.releaseOne(instanceId);
    if (credential === undefined || tokenHash === undefined) return;
    let previous: Poller | undefined;
    const existing = this.pollers.get(tokenHash);
    if (existing !== undefined) {
      const phase = this.adapterPhase(existing.adapter);
      if (phase !== 'stopped' && phase !== 'auth_expired' && phase !== 'conflict') {
        this.join(existing, instanceId);
        return;
      }
      previous = existing;
      this.reanchor(previous);
      for (const [key, value] of this.pollers) if (value === previous) this.pollers.delete(key);
      for (const id of previous.instances) this.failures.set(id, { phase: phase === 'auth_expired' ? 'auth_expired' : 'stopped', detail: previous.adapter.connectionDetail?.() });
      await this.stopAdapter(previous.adapter);
    }
    const queued = this.pending.get(tokenHash);
    if (queued !== undefined) {
      this.join(queued.poller, instanceId);
      return;
    }
    const factory = this.factories.find((item) => item.providerKind === meta.providerKind);
    if (factory === undefined) return;
    const savedOwner = this.state.bindings.find((binding) => binding.providerKind === meta.providerKind && this.ports.credentials.read(binding.providerInstanceId) === credential)?.providerInstanceId;
    const ownerId = previous?.ownerId ?? savedOwner ?? instanceId;
    let adapter: ImSessionAdapter;
    try {
      adapter = factory.create({ instanceId: ownerId, credential });
    } catch {
      this.failures.set(instanceId, { phase: 'stopped' });
      return;
    }
    const acquired = adapter.canonicalInstanceId ?? ownerId;
    const canonical = this.credentialHash(acquired) === tokenHash ? acquired : ownerId;
    const shared = [...this.pollers.values()].find((item) => item.tokenHash === tokenHash && (item.adapter === adapter || item.ownerId === canonical));
    if (shared !== undefined) {
      this.join(shared, instanceId);
      this.pollers.set(tokenHash, shared);
      return;
    }
    const sharedPending = [...this.pending.values()].find((item) => item.poller.tokenHash === tokenHash && (item.poller.adapter === adapter || item.poller.ownerId === canonical));
    if (sharedPending !== undefined) {
      this.join(sharedPending.poller, instanceId);
      this.pending.set(tokenHash, sharedPending);
      return;
    }
    if (await adapter.describeConflict() === 'webhook') {
      meta.conflict = 'webhook';
      return;
    }
    if (this.closed || !this.state.policy.allowed || !meta.listening) {
      await adapter.stop();
      return;
    }
    const instances = new Set([instanceId, ...[...(previous?.instances ?? [])].filter((id) => this.credentialHash(id) === tokenHash && this.state.instances.some((item) => item.id === id && item.listening))]);
    for (const id of instances) this.failures.delete(id);
    const poller: Poller = { tokenHash, ownerId: canonical, instances, adapter };
    this.pending.set(tokenHash, { poller, originId: instanceId });
    this.retarget(instanceId, canonical);
    let started: Promise<{ accountId: string; conflict?: 'webhook'; failed?: 'auth' }>;
    try {
      started = Promise.resolve(adapter.start(async (event) => {
        if (!this.published(poller)) throw new Error('im_not_ready');
        if (poller.listenerKey !== undefined && adapter.listenerAccountId !== undefined && poller.listenerKey !== JSON.stringify([adapter.listenerRealm ?? adapter.providerKind, adapter.listenerAccountId])) {
          void this.enqueueLifecycle(async () => {
            const instances = [...poller.instances];
            for (const id of instances) {
              await this.releaseOne(id);
              this.failures.set(id, { phase: 'stopped' });
            }
          });
          throw new Error('im_listener_account_changed');
        }
        await this.ingest(poller.ownerId, event);
      }, { offset: this.state.cursors[poller.ownerId] }));
    } catch {
      this.forgetPending(poller);
      this.failures.set(instanceId, { phase: 'stopped', detail: adapter.connectionDetail?.() });
      await adapter.stop();
      return;
    }
    const apply = this.finishStart(poller, started);
    this.jobs.add(apply);
    void apply.finally(() => { this.jobs.delete(apply); });
    const gate = await new Promise<'ready' | 'later'>((resolve) => {
      const timer = setTimeout(() => resolve('later'), 0);
      timer.unref();
      void started.then(() => resolve('ready'), () => resolve('ready'));
    });
    if (gate === 'ready') await apply;
    else this.ports.logger.info({ instance_id: instanceId, provider_kind: meta.providerKind, connection: this.linkPhase(adapter) ?? 'starting' }, 'im session connecting');
  }

  private published(poller: Poller): boolean {
    if (this.closed || !this.state.policy.allowed || ![...poller.instances].some((id) => this.state.instances.some((meta) => meta.id === id && meta.listening))) return false;
    for (const item of this.pollers.values()) if (item === poller) return true;
    return false;
  }

  private forgetPending(poller: Poller): void {
    for (const [key, attempt] of this.pending) if (attempt.poller === poller) this.pending.delete(key);
  }

  private linkPhase(adapter: ImSessionAdapter | undefined): ImInstanceView['connection'] {
    const phase = this.adapterPhase(adapter);
    return phase === 'starting' || phase === 'reconnecting' || phase === 'auth_expired' || phase === 'stopped' ? phase : undefined;
  }

  private adapterPhase(adapter: ImSessionAdapter | undefined): ReturnType<NonNullable<ImSessionAdapter['connectionPhase']>> | undefined {
    return adapter?.connectionPhase?.();
  }

  private async finishStart(poller: Poller, started: Promise<{ accountId: string; conflict?: 'webhook'; failed?: 'auth' }>): Promise<void> {
    let result: { accountId: string; conflict?: 'webhook'; failed?: 'auth' };
    try {
      result = await started;
    } catch {
      const current = [...this.pending.values()].find((item) => item.poller === poller);
      if (current === undefined) return;
      this.forgetPending(poller);
      for (const id of poller.instances) this.failures.set(id, { phase: 'stopped', detail: poller.adapter.connectionDetail?.() });
      await this.persist();
      await this.stopAdapter(poller.adapter).catch(() => undefined);
      return;
    }
    const current = [...this.pending.values()].find((item) => item.poller === poller);
    if (current === undefined) return;
    const phase = this.adapterPhase(poller.adapter);
    if (result.conflict === 'webhook' || result.failed === 'auth' || phase === 'stopped' || phase === 'auth_expired') {
      for (const id of poller.instances) {
        if (result.conflict === 'webhook') this.markOrigin(id, { conflict: 'webhook' });
        else this.failures.set(id, { phase: result.failed === 'auth' || phase === 'auth_expired' ? 'auth_expired' : 'stopped', detail: poller.adapter.connectionDetail?.() });
      }
      this.forgetPending(poller);
      await this.persist();
      await this.stopAdapter(poller.adapter).catch(() => undefined);
      return;
    }
    if (this.factories.find((factory) => factory.providerKind === poller.adapter.providerKind)?.inbound !== false) {
      const realm = poller.adapter.listenerRealm ?? poller.adapter.providerKind;
      const listenerKey = JSON.stringify([realm, poller.adapter.listenerAccountId ?? result.accountId]);
      const occupied = [...this.pollers.values()].some((other) => other !== poller && other.listenerKey === listenerKey && this.published(other) && !['stopped', 'auth_expired', 'conflict'].includes(this.adapterPhase(other.adapter) ?? 'running'));
      if (occupied) {
        this.forgetPending(poller);
        for (const id of poller.instances) {
          const meta = this.requireMeta(id);
          meta.accountId = result.accountId;
          meta.conflict = 'account_in_use';
          this.failures.set(id, { phase: 'stopped' });
        }
        await this.stopAdapter(poller.adapter).catch(() => undefined);
        await this.persist();
        return;
      }
      poller.listenerKey = listenerKey;
    }
    const keys = [...this.pending.keys()].filter((key) => this.pending.get(key)?.poller === poller);
    this.forgetPending(poller);
    for (const key of keys) this.pollers.set(key, poller);
    for (const id of poller.instances) {
      const meta = this.state.instances.find((item) => item.id === id);
      if (meta === undefined) continue;
      meta.accountId = result.accountId;
      meta.conflict = undefined;
    }
    for (const binding of this.state.bindings) if (binding.providerInstanceId === poller.ownerId && binding.accountId !== result.accountId) binding.enabled = false;
    const owner = this.requireMeta(poller.ownerId);
    for (const [index, identity] of (poller.adapter.targets ?? []).entries()) this.noteDiscovery(owner, result.accountId, { eventId: `target:${index}`, identity, kind: 'text', preview: identity.chatTitle ?? identity.chatId });
    await this.persist();
    this.ports.logger.info({ instance_id: current.originId, provider_kind: poller.adapter.providerKind, connection: 'running' }, 'im session connected');
    for (const id of poller.instances) {
      if (!this.published(poller)) return;
      await this.resumeReplies(id);
    }
  }

  private markOrigin(instanceId: string, patch: { listening?: false; conflict?: 'webhook' }): void {
    const meta = this.state.instances.find((item) => item.id === instanceId);
    if (meta === undefined) return;
    if (patch.listening === false) meta.listening = false;
    if (patch.conflict === 'webhook') meta.conflict = 'webhook';
  }

  private retarget(from: string, to: string): void {
    if (from === to) return;
    for (const binding of this.state.bindings) if (binding.providerInstanceId === from) binding.providerInstanceId = to;
    for (const discovery of this.state.discoveries) if (discovery.providerInstanceId === from) discovery.providerInstanceId = to;
    for (const stranger of this.state.strangers) if (stranger.providerInstanceId === from) stranger.providerInstanceId = to;
    const key = (value: string): string => value.startsWith(`${from}:`) ? `${to}:${value.slice(from.length + 1)}` : value;
    for (const ticket of this.state.tickets) ticket.senderKey = key(ticket.senderKey);
    for (const job of this.state.outbox) job.senderKey = key(job.senderKey);
    this.state.seen = this.state.seen.map(key);
    for (const [who, answered] of Object.entries(this.state.answeredQuestions)) {
      const next = key(who);
      if (next === who) continue;
      this.state.answeredQuestions[next] = [...new Set([...(this.state.answeredQuestions[next] ?? []), ...answered])];
      delete this.state.answeredQuestions[who];
    }
    for (const [who, waiting] of Object.entries(this.state.awaiting)) {
      const next = key(who);
      if (next === who) continue;
      this.state.awaiting[next] = waiting;
      delete this.state.awaiting[who];
    }
    const cursor = this.state.cursors[from];
    if (cursor !== undefined) {
      this.state.cursors[to] = Math.max(cursor, this.state.cursors[to] ?? 0);
      delete this.state.cursors[from];
    }
  }

  private release(instanceId: string): Promise<void> {
    return this.enqueueLifecycle(() => this.releaseOne(instanceId));
  }

  private async releaseOne(instanceId: string): Promise<void> {
    this.failures.delete(instanceId);
    const waiting = new Set<Poller>();
    for (const attempt of this.pending.values()) {
      if (waiting.has(attempt.poller) || (!attempt.poller.instances.has(instanceId) && attempt.poller.ownerId !== instanceId)) continue;
      waiting.add(attempt.poller);
      attempt.poller.instances.delete(instanceId);
      this.reanchor(attempt.poller);
      if (attempt.poller.instances.size > 0) continue;
      this.forgetPending(attempt.poller);
      await attempt.poller.adapter.stop();
    }
    const seen = new Set<Poller>();
    for (const poller of this.pollers.values()) {
      if (seen.has(poller) || (!poller.instances.has(instanceId) && poller.ownerId !== instanceId)) continue;
      seen.add(poller);
      poller.instances.delete(instanceId);
      this.reanchor(poller);
      if (poller.instances.size > 0) continue;
      for (const [key, item] of this.pollers) if (item === poller) this.pollers.delete(key);
      await this.stopAdapter(poller.adapter);
    }
  }

  private stopAll(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      const pollers = new Set([...this.pollers.values(), ...[...this.pending.values()].map((attempt) => attempt.poller)]);
      const failures: unknown[] = [];
      for (const poller of pollers) {
        try {
          await this.stopAdapter(poller.adapter);
          this.forgetPending(poller);
          for (const [key, current] of this.pollers) if (current === poller) this.pollers.delete(key);
          for (const id of poller.instances) this.failures.delete(id);
        } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'IM listeners could not all be stopped');
    });
  }

  private adapterFor(instanceId: string): ImSessionAdapter | undefined {
    const adapter = [...this.pollers.values()].find((item) => (item.ownerId === instanceId || item.instances.has(instanceId)) && this.published(item))?.adapter;
    const phase = this.adapterPhase(adapter);
    return phase === 'auth_expired' || phase === 'conflict' || phase === 'stopped' ? undefined : adapter;
  }

  private async ingest(instanceId: string, event: ImInboundEvent): Promise<void> {
    if (!this.state.policy.allowed) return;
    const key = `${instanceId}:${event.eventId}`;
    if (this.state.seen.includes(key)) return;
    const meta = this.requireMeta(instanceId);
    if (this.factories.find((factory) => factory.providerKind === meta.providerKind)?.inbound === false) throw new Error('input_unsupported');
    const accountId = meta.accountId ?? instanceId;
    this.rememberChatKind(instanceId, event);
    try {
      if (event.kind === 'callback') await this.onCallback(instanceId, event);
      else await this.onMessage(instanceId, accountId, event);
      this.state.seen.push(key);
      if (event.cursor !== undefined) this.state.cursors[instanceId] = event.cursor + 1;
      this.ports.logger.info({ provider_kind: meta.providerKind, instance_id: instanceId, event_id: event.eventId }, 'im session event');
      await this.persist();
    } catch (error) {
      this.ports.logger.info({ provider_kind: meta.providerKind, instance_id: instanceId, event_id: event.eventId, failed: true }, 'im session event');
      throw error;
    }
  }

  private async onMessage(instanceId: string, accountId: string, event: ImInboundEvent): Promise<void> {
    const meta = this.requireMeta(instanceId);
    if (meta.providerKind === 'wechat_bridge' && (event.identity.chatKind === 'group' || event.identity.topicId !== '0')) {
      this.noteDiscovery(meta, accountId, event);
      return;
    }
    const matches = this.state.bindings.filter((item) => item.providerInstanceId === instanceId && item.accountId === accountId && matchesBinding(item, event.identity));
    const binding = matches.find((item) => this.admittedInbound(item)) ?? matches[0];
    const adapter = this.adapterFor(instanceId);
    if (binding !== undefined && !this.admittedInbound(binding)) {
      this.noteDiscovery(meta, accountId, event);
      return;
    }
    if (binding === undefined) {
      const chatBound = this.state.bindings.some((item) => item.providerInstanceId === instanceId && item.identity.chatId === event.identity.chatId && item.identity.topicId === event.identity.topicId);
      if (chatBound) this.noteStranger(instanceId, event);
      else this.noteDiscovery(meta, accountId, event);
      return;
    }
    const im: ImMessageMetadata = { provider_kind: meta.providerKind, provider_instance_id: instanceId, account_id: accountId,
      identity: wireIdentity(event.identity), source_message_id: event.sourceMessageId, mentioned: event.mentioned,
      mention_ids: event.mentionIds === undefined ? undefined : [...event.mentionIds], reply_to_message_id: event.replyToMessageId,
      is_self: event.isSelf, timestamp: event.timestamp };
    const room = event.identity.chatKind === 'group' && this.history !== undefined ? ImHistoryJournal.room(meta.providerKind, accountId, event.identity.chatId, event.identity.topicId) : undefined;
    const parts = event.kind === 'message' ? event.parts : [{ kind: event.kind, text: event.text, media: event.media, tooLarge: event.tooLarge }];
    if (parts === undefined || parts.length === 0) throw new Error('IM complete message needs its admitted parts');
    const partText = (part: (typeof parts)[number]) => event.kind === 'message' && part.kind !== 'text' && part.media === undefined && part.tooLarge !== true && (part.text?.trim().length ?? 0) > 0
      ? `[Unavailable external ${part.kind}: ${part.text}]` : part.text ?? '';
    const originalText = parts.map(partText).filter((value) => value.length > 0).join('\n');
    if ((event.operation !== undefined && event.operation !== 'create') || event.isSelf === true) {
      if (event.operation !== undefined && event.operation !== 'create' && event.sourceMessageId === undefined) throw new Error('IM edit/retract needs its real sourceMessageId');
      if (room !== undefined) await this.history!.record(room, { eventId: event.eventId, receivedAt: this.now(), metadata: im, operation: event.operation ?? 'create', isSelf: event.isSelf, timestamp: event.timestamp, text: originalText, sessionId: binding.sessionId });
      return;
    }
    const text = originalText.trim();
    const textOnly = event.kind === 'text' || (event.kind === 'message' && parts.every((part) => part.kind === 'text'));
    const interactionOwner = event.identity.senderId === binding.identity.senderId;
    if (textOnly && /^\/\S/u.test(text)) {
      if (adapter !== undefined) {
        if (interactionOwner) await this.onCommand(binding, text, adapter);
        else await this.send(adapter, event.identity, this.locale() === 'zh' ? '仅绑定者可使用此命令。' : 'Only the binding owner can use this command.', 'command_denied');
      }
      return;
    }
    if (interactionOwner && textOnly && text.startsWith(':')) {
      await this.onCommand(binding, text, adapter);
      return;
    }
    const waiting = this.state.awaiting[senderKey(instanceId, event.identity)];
    if (waiting !== undefined && textOnly) {
      if (this.now() > waiting.expiresAt || waiting.sessionId !== binding.sessionId) {
        delete this.state.awaiting[senderKey(instanceId, event.identity)];
        if (adapter !== undefined) await this.send(adapter, event.identity, this.copy('expired'), 'expired');
        return;
      }
      await this.ask(binding.sessionId, waiting.interactionId, { kind: 'other', questionKey: waiting.questionKey, ...(waiting.questionIndex === undefined ? {} : { questionIndex: waiting.questionIndex }), text, method: 'number_key' });
      if (waiting.questionIndex !== undefined) this.markQuestion(binding, waiting.interactionId, waiting.questionIndex);
      delete this.state.awaiting[senderKey(instanceId, event.identity)];
      return;
    }
    if (interactionOwner && textOnly && await this.answerNumbers(binding, text)) return;
    if (parts.some((part) => part.tooLarge === true || (adapter !== undefined && part.media !== undefined && part.media.bytes.byteLength > adapter.maxInboundBytes))) {
      if (adapter !== undefined) await this.send(adapter, event.identity, this.copy('rejected'), 'rejected');
      return;
    }
    const preparedInput = room === undefined || event.kind !== 'message' ? undefined : await this.history!.readPrepared(room, event.eventId, binding.sessionId);
    const content: MessageContent[] = [...preparedInput?.current ?? []];
    for (const part of preparedInput?.current === undefined ? parts : []) {
      const partBody = event.kind === 'message' ? partText(part) : text;
      if (part.media !== undefined && adapter !== undefined) {
        const audio = part.kind === 'audio';
        const asAudio = audio && (adapter.providerKind === 'discord' || adapter.providerKind === 'slack' || adapter.providerKind === 'matrix' || adapter.acceptsVoice(part.media.mediaType));
        if (audio && !asAudio) this.state.voiceFallbacks += 1;
        const saved = await this.ports.sessions.saveMedia({
          sessionId: binding.sessionId,
          kind: asAudio ? 'audio' : part.kind === 'image' ? 'image' : part.kind === 'video' ? 'video' : 'file',
          name: part.media.name,
          mediaType: part.media.mediaType,
          bytes: part.media.bytes,
          text: partBody === '' ? undefined : partBody,
        });
        if (!this.admittedInbound(binding) || !this.state.bindings.includes(binding) || this.adapterFor(instanceId) !== adapter) throw new Error('IM adapter was withdrawn while preparing input');
        content.push(...saved);
      } else if (partBody !== '') content.push({ type: 'text', text: partBody });
    }
    if (content.length === 0) return;
    let background: Awaited<ReturnType<ImHistoryJournal['background']>> | undefined;
    let quoted = event.quotedText?.trim().slice(0, 16_384);
    let currentParts = content.length;
    if (room !== undefined) {
      const row = await this.history!.record(room, { eventId: event.eventId, receivedAt: this.now(), metadata: im, operation: 'create', isSelf: event.isSelf, timestamp: event.timestamp, text: originalText, sessionId: binding.sessionId,
        content: content.filter((part) => part.type !== 'text'), media: parts.flatMap((part) => part.media === undefined ? [] : [{ kind: part.kind, name: part.media.name, mediaType: part.media.mediaType }]) });
      if (row.eventId !== event.eventId) return;
      const original = event.sourceMessageId === undefined ? undefined : await this.history!.find(room, event.sourceMessageId);
      if (event.kind !== 'message' && original?.sessionId === binding.sessionId) {
        content.splice(0);
        if (original.text.length > 0) content.push({ type: 'text', text: original.text });
        content.push(...original.content ?? []);
        currentParts = content.length;
      }
      const policy = binding.groupPolicy ?? { wake: 'always' as const };
      const reply = event.replyToMessageId === undefined ? undefined : await this.history!.find(room, event.replyToMessageId);
      if (!quoted && reply?.operation !== 'retract' && reply?.text && reply.sessionId === binding.sessionId) quoted = reply.text.slice(0, 16_384);
      const ownReply = event.replyToMessageId !== undefined && await this.history!.isSent(room, event.replyToMessageId);
      const wake = policy.wake !== 'manual' && (policy.wake === 'always' || (policy.prefixes ?? []).some((prefix) => text.startsWith(prefix)) || event.mentioned === true || reply?.isSelf === true || ownReply);
      if (!wake) return;
      background = await this.history!.background(room, `${binding.id}:${binding.sessionId}`, row, binding.bindingScope === undefined || binding.bindingScope === 'sender' ? binding.identity.senderId : undefined);
      im.context = { order: 'chronological', coverage: background.coverage, truncated: background.truncated,
        messages: background.entries.map((row) => ({ sequence: row.sequence, source_message_id: row.metadata.source_message_id, identity: row.metadata.identity,
          text: row.text, operation: row.operation, is_self: row.isSelf, timestamp: row.timestamp ?? row.receivedAt, mention_ids: row.metadata.mention_ids,
          reply_to_message_id: row.metadata.reply_to_message_id, media: row.media?.map((item) => ({ kind: item.kind, name: item.name, media_type: item.mediaType, available: false })) })) };
      let slots = 4;
      for (const row of background.entries) {
        if (slots === 0 || row.sessionId !== binding.sessionId || row.operation === 'retract') continue;
        const images = await this.ports.sessions.historyMedia?.(binding.sessionId, (row.content ?? []).slice(0, slots)) ?? [];
        if (images.length === 0) continue;
        content.push({ type: 'text', text: `Untrusted external background images from message ${JSON.stringify(row.metadata.source_message_id ?? null)} (not the current message):` }, ...images.slice(0, slots));
        slots -= Math.min(slots, images.length);
        const context = im.context.messages.find((item) => item.sequence === row.sequence);
        for (const media of context?.media ?? []) if (media.kind === 'image') media.available = true;
      }
      const prepared = await this.history!.prepare(room, row, { sessionId: binding.sessionId, current: event.kind === 'message' ? content.slice(0, currentParts) : undefined, images: content.slice(currentParts), context: im.context, snapshot: background.snapshot });
      im.context = prepared.context;
      content.splice(0, content.length, ...prepared.current ?? content.slice(0, currentParts), ...prepared.images);
      background = { ...background, snapshot: prepared.snapshot };
    }
    if (quoted && !im.context?.messages.some((item) => item.source_message_id === event.replyToMessageId && item.text === quoted)) {
      content.unshift({ type: 'text', text: `Referenced IM message ${JSON.stringify(event.replyToMessageId ?? null)} (quoted text, not the current message):\n${quoted}\nCurrent message follows:` });
    }
    if (!this.admittedInbound(binding) || !this.state.bindings.includes(binding) || this.adapterFor(instanceId) !== adapter) return;
    const promptId = `im:${instanceId}:${event.eventId}`;
    const submitted = await this.ports.sessions.submit({ sessionId: binding.sessionId, promptId, content, delivery: binding.busy, im });
    if (room !== undefined && background !== undefined) await this.history!.consume(room, `${binding.id}:${binding.sessionId}`, background.snapshot);
    if (submitted.duplicate) return;
    const delivery = submitted.deliveryState === 'queued' && binding.busy !== 'queue'
      ? await this.ports.sessions.steer(binding.sessionId, submitted.promptId) : submitted.deliveryState;
    if (delivery === 'queued' && adapter !== undefined) await this.send(adapter, event.identity, this.copy('queued'), 'queued');
    if (adapter !== undefined) this.watchReply(binding, submitted.promptId, submitted.turnId, adapter, event.identity);
  }

  private async onCommand(binding: BindingRecord, text: string, adapter: ImSessionAdapter | undefined): Promise<void> {
    if (adapter === undefined) return;
    const [name, arg] = text.split(/\s+/u);
    if (name === '/help') {
      const help = this.locale() === 'zh'
        ? '/help — 显示可用命令\n/status — 查看会话状态\n/abort — 停止当前回合\n/target — 查看绑定目标（切换需在 Kiki 确认）'
        : '/help — Available commands\n/status — Session status\n/abort — Stop the current turn\n/target — View binding targets (confirm changes in Kiki)';
      await this.send(adapter, binding.identity, help, 'help');
      return;
    }
    if (name === ':status' || name === '/status') {
      const activity = await this.ports.sessions.activity(binding.sessionId);
      await this.send(adapter, binding.identity, COPY[this.locale()].status(activity.busy, activity.pending, activity.queueLength), 'status');
      return;
    }
    if (name === ':abort' || name === '/abort') {
      const activity = await this.ports.sessions.activity(binding.sessionId);
      const aborted = await this.ports.sessions.abort(binding.sessionId, activity.activePromptId, activity.activeTurnId);
      if (!aborted) await this.send(adapter, binding.identity, this.copy('noTurn'), 'no_turn');
      return;
    }
    if (name === ':target' || name === '/target') {
      const targets = this.state.bindings.filter((item) => item.providerInstanceId === binding.providerInstanceId && item.identity.senderId === binding.identity.senderId);
      if (arg === undefined) {
        const lines = targets.map((item, index) => `${index + 1}. ${item.sessionId}`);
        await this.send(adapter, binding.identity, lines.join('\n'), 'targets');
        return;
      }
      const index = Number(arg);
      const target = targets[index - 1];
      if (!Number.isInteger(index) || target === undefined) {
        await this.send(adapter, binding.identity, this.locale() === 'zh' ? '没有该目标。发送 /target 查看列表。' : 'No such target. Send /target to list bindings.', 'target_unknown');
        return;
      }
      await this.send(adapter, binding.identity, target.sessionId === binding.sessionId
        ? this.copy('switched')
        : this.locale() === 'zh' ? '请在 Kiki 中确认信道转绑，当前归属没有改变。' : 'Confirm channel reassignment in Kiki. The current binding has not changed.', 'target_confirmation_required');
      return;
    }
    if (name?.startsWith('/')) await this.send(adapter, binding.identity, this.locale() === 'zh' ? `未知命令 ${name}。发送 /help 查看可用命令；若想发送正文，请去掉开头的 /。` : `Unknown command ${name}. Send /help for available commands, or remove the leading / to send it as text.`, 'unknown_command');
  }

  private async answerNumbers(binding: BindingRecord, text: string): Promise<boolean> {
    const pending = await this.ports.sessions.listInteractions(binding.sessionId);
    const question = pending.questions.find((item) => !this.questionAnswered(binding, item));
    if (question === undefined) return false;
    const numeric = /^[0-9]+(?:\s+[0-9]+)*$/u.test(text);
    if (numeric) {
      const numbers = text.split(/\s+/u).map((item) => Number(item));
      const options = numbers.map((number) => question.options[number - 1]);
      const valid = options.length > 0 && options.every((item) => item !== undefined) && (!question.multi ? numbers.length === 1 : true);
      if (valid) {
        const response: ImQuestionAnswer = question.multi
          ? { kind: 'multi', questionKey: question.questionKey, questionIndex: question.questionIndex, optionIds: options.map((item) => item!.id), method: 'number_key' }
          : { kind: 'single', questionKey: question.questionKey, questionIndex: question.questionIndex, optionIds: [options[0]!.id], method: 'number_key' };
        await this.ask(binding.sessionId, question.id, response);
        this.markQuestion(binding, question.id, question.questionIndex);
        return true;
      }
    }
    if (!numeric && question.allowOther && text.length > 0) {
      await this.ask(binding.sessionId, question.id, { kind: 'other', questionKey: question.questionKey, questionIndex: question.questionIndex, text, method: 'number_key' });
      this.markQuestion(binding, question.id, question.questionIndex);
      return true;
    }
    const kind = this.adapterFor(binding.providerInstanceId)?.providerKind;
    return (kind === 'onebot_v11' || kind === 'wechat_bridge') && text.length > 0;
  }

  private questionAnswered(binding: BindingRecord, question: { id: string; questionIndex: number }): boolean {
    const key = senderKey(binding.providerInstanceId, binding.identity);
    const token = `${question.id}:${question.questionIndex}`;
    if ((this.state.answeredQuestions[key] ?? []).includes(token)) return true;
    return this.state.tickets.some((ticket) => ticket.bindingId === binding.id && ticket.senderKey === key && this.sameQuestion(ticket, question) && ticket.consumed && ticket.action !== 'toggle');
  }

  private markQuestion(binding: BindingRecord, interactionId: string, questionIndex: number): void {
    const key = senderKey(binding.providerInstanceId, binding.identity);
    const token = `${interactionId}:${questionIndex}`;
    const list = this.state.answeredQuestions[key] ?? [];
    if (!list.includes(token)) this.state.answeredQuestions[key] = [...list, token];
  }

  private async ask(sessionId: string, interactionId: string, response: ImQuestionAnswer): Promise<ImAnswerResult> {
    const previous = this.state.questionAnswers[interactionId];
    const result = await this.ports.sessions.answerQuestion({ sessionId, interactionId, response, ...(previous === undefined ? {} : { previous }) });
    if (typeof result === 'object') {
      if (result.result === 'partial') this.state.questionAnswers[interactionId] = { ...result.answers };
      else delete this.state.questionAnswers[interactionId];
    }
    return result;
  }

  private noteDiscovery(meta: InstanceMeta, accountId: string, event: ImInboundEvent): void {
    const preview = event.preview ?? event.text?.slice(0, 80) ?? '';
    const found = this.state.discoveries.find((item) => item.providerInstanceId === meta.id && sameIdentity(item.identity, event.identity));
    if (found !== undefined) {
      found.preview = preview;
      found.at = this.now();
      if (event.identity.chatKind !== undefined) found.identity = { ...found.identity, chatKind: event.identity.chatKind };
      return;
    }
    this.state.discoveries.push({ id: this.next('d'), providerInstanceId: meta.id, providerKind: meta.providerKind, accountId, identity: event.identity, preview, at: this.now() });
  }

  private noteStranger(instanceId: string, event: ImInboundEvent): void {
    const found = this.state.strangers.find((item) => item.providerInstanceId === instanceId && sameIdentity(item.identity, event.identity));
    if (found !== undefined) {
      found.count += 1;
      found.preview = event.preview ?? event.text?.slice(0, 80) ?? found.preview;
      return;
    }
    this.state.strangers.push({ providerInstanceId: instanceId, identity: event.identity, preview: event.preview ?? event.text?.slice(0, 80) ?? '', count: 1 });
  }

  private pendingReply(text: string, ledger: ReplyLedger, done: boolean): boolean {
    if (text.length === 0 || text === ledger.lastText) return false;
    return done || text !== ledger.failedText;
  }

  private watchReply(binding: BindingRecord, promptId: string, turnId: number | undefined, adapter: ImSessionAdapter, replyIdentity?: ImInboundIdentity): void {
    const sessionId = binding.sessionId;
    const live = `${binding.id}:${promptId}`;
    if (this.liveReplies.has(live)) return;
    this.liveReplies.add(live);
    const stored = this.state.replies.find((item) => item.bindingId === binding.id && item.promptId === promptId);
    const ledger: ReplyLedger = {
      messageIds: [...(stored?.messageIds ?? [])],
      fileSent: stored?.fileSent ?? false,
      lastText: stored?.lastText ?? '',
      ...(stored?.deliveredText === undefined ? {} : { deliveredText: stored.deliveredText }),
      ...(stored?.failedText === undefined ? {} : { failedText: stored.failedText }),
      ...(stored?.tooLongNotice === undefined ? {} : { tooLongNotice: stored.tooLongNotice }),
      ...(stored?.undelivered === undefined ? {} : { undelivered: stored.undelivered }),
    };
    const job = (async () => {
      try {
        while (!this.closed && this.state.policy.allowed) {
          await this.wait(this.editIntervalMs);
          const active = this.only(this.state.bindings, binding.id);
          if (active === undefined || active.sessionId !== sessionId || !this.admittedOutbound(active)) return;
          const current = { ...active, identity: replyIdentity ?? stored?.identity ?? active.identity };
          const visible = await this.ports.sessions.readVisible(sessionId, promptId, turnId);
          if (this.closed || this.only(this.state.bindings, binding.id)?.sessionId !== sessionId) return;
          const before = `${ledger.lastText}\n${ledger.deliveredText ?? ''}\n${ledger.messageIds.join('\n')}`;
          if (current.reply === 'edit' && this.pendingReply(visible.text, ledger, visible.done)) await this.publishText(adapter, current.identity, visible.text, ledger, true, visible.done);
          if (`${ledger.lastText}\n${ledger.deliveredText ?? ''}\n${ledger.messageIds.join('\n')}` !== before) {
            this.rememberReply(current, promptId, turnId, ledger, true);
            await this.persist();
          }
          if (!visible.done) continue;
          if (current.reply === 'final' && visible.text.length > 0) await this.publishText(adapter, current.identity, visible.text, ledger, false, true);
          else if (current.reply === 'edit' && this.pendingReply(visible.text, ledger, true)) await this.publishText(adapter, current.identity, visible.text, ledger, true, true);
          await this.publishMedia(adapter, current.identity, visible.media);
          await this.rememberSent(current, ledger.messageIds);
          this.rememberReply(current, promptId, turnId, ledger, false);
          await this.persist();
          return;
        }
      } catch (error) {
        if (error instanceof ImSendError && error.outcome !== 'failed') {
          this.rememberReply(binding, promptId, turnId, ledger, false);
          await this.persist();
        }
        if (error instanceof Error && error.message === 'wechat_auth') {
          await this.send(adapter, binding.identity, this.copy('wechatAuth'), 'wechat_auth').catch(() => undefined);
        }
        this.ports.logger.info({ instance_id: binding.providerInstanceId, failed: true }, 'im reply failed');
      }
    })();
    this.jobs.add(job);
    const clear = (): void => { this.jobs.delete(job); this.liveReplies.delete(live); };
    void job.then(clear, clear);
  }

  private rememberReply(binding: BindingRecord, promptId: string, turnId: number | undefined, ledger: ReplyLedger, open: boolean): void {
    const next: OpenReply = {
      bindingId: binding.id,
      identity: binding.identity,
      promptId,
      ...(turnId === undefined ? {} : { turnId }),
      messageIds: [...ledger.messageIds],
      lastText: ledger.lastText,
      ...(ledger.deliveredText === undefined ? {} : { deliveredText: ledger.deliveredText }),
      ...(ledger.failedText === undefined ? {} : { failedText: ledger.failedText }),
      ...(ledger.tooLongNotice === undefined ? {} : { tooLongNotice: ledger.tooLongNotice }),
      fileSent: ledger.fileSent,
      ...(ledger.undelivered === undefined ? {} : { undelivered: ledger.undelivered }),
      open,
    };
    const index = this.state.replies.findIndex((item) => item.bindingId === binding.id && item.promptId === promptId);
    if (index < 0) this.state.replies.push(next);
    else this.state.replies[index] = next;
  }

  private expireReplies(bindingId: string): void {
    for (const reply of this.state.replies) if (reply.bindingId === bindingId) reply.open = false;
  }

  private async resumeReplies(instanceId?: string): Promise<void> {
    for (const reply of this.state.replies) {
      if (!reply.open) continue;
      const binding = this.only(this.state.bindings, reply.bindingId);
      if (binding === undefined || !this.admittedOutbound(binding)) continue;
      if (instanceId !== undefined && binding.providerInstanceId !== instanceId) continue;
      const adapter = this.adapterFor(binding.providerInstanceId);
      if (adapter === undefined) continue;
      this.watchReply(binding, reply.promptId, reply.turnId, adapter);
    }
  }

  private async publishText(adapter: ImSessionAdapter, identity: ImInboundIdentity, text: string, ledger: ReplyLedger, edit: boolean, final: boolean): Promise<void> {
    if (adapter.providerKind === 'feishu_app') {
      await this.publishFeishu(adapter, identity, text, ledger, edit);
      return;
    }
    if (adapter.providerKind === 'onebot_v11' && adapter.textLimit === undefined) {
      await this.publishQq(adapter, identity, text, ledger);
      return;
    }
    const parts = segmentText(text, adapter.textLimit);
    if (parts.length === 0) return;
    const head = parts[0]!;
    if (ledger.messageIds.length === 0) {
      const sent = await this.sendReply(adapter, identity, head, ledger, text);
      if (sent === undefined) return;
      ledger.messageIds.push(sent.messageId);
    } else if (edit) await this.editOrSend(adapter, identity, ledger, 0, head);
    if (parts.length > 4 && final && !ledger.fileSent) {
      try {
        await this.pacedSend(adapter, identity, (signal) => adapter.sendFile({ identity, name: 'reply.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode(text), asVoice: false, asImage: false, signal }));
        ledger.fileSent = true;
      } catch (error) {
        if (error instanceof ImSendError && error.outcome !== 'failed') throw error;
        for (let index = 1; index < parts.length; index += 1) {
          if (ledger.messageIds.length <= index) {
            const sent = await this.sendReply(adapter, identity, parts[index]!, ledger, text);
            if (sent === undefined) return;
            ledger.messageIds.push(sent.messageId);
          } else if (edit) await this.editOrSend(adapter, identity, ledger, index, parts[index]!);
        }
      }
    } else if (parts.length > 1 && parts.length <= 4 && final) {
      for (let index = 1; index < parts.length; index += 1) {
        if (ledger.messageIds.length <= index) {
          const sent = await this.sendReply(adapter, identity, parts[index]!, ledger, text);
          if (sent === undefined) return;
          ledger.messageIds.push(sent.messageId);
        } else if (edit) await this.editOrSend(adapter, identity, ledger, index, parts[index]!);
      }
    }
    if (ledger.undelivered === true) return;
    ledger.lastText = text;
  }

  private async publishFeishu(adapter: ImSessionAdapter, identity: ImInboundIdentity, text: string, ledger: ReplyLedger, edit: boolean): Promise<void> {
    const parts = [...adapter.splitText(text)];
    if (parts.length === 0) return;
    const next: string[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const existing = ledger.messageIds[index];
      try {
        if (existing !== undefined && existing.length > 0) {
          if (!edit) {
            next.push(existing);
            continue;
          }
          const edited = await this.pacedSend(adapter, identity, (signal) => adapter.editText({ identity, messageId: existing, text: part, code: 'reply', signal }));
          if (!edited.edited) {
            const sent = await this.pacedSend(adapter, identity, (signal) => adapter.sendText({ identity, text: part, code: 'reply', signal }));
            const accepted = deliveryIds(sent);
            if (accepted.length === 0) {
              ledger.messageIds = next;
              return;
            }
            next.push(...accepted);
          } else next.push(edited.messageId.length > 0 ? edited.messageId : existing);
          continue;
        }
        const sent = await this.pacedSend(adapter, identity, (signal) => adapter.sendText({ identity, text: part, code: 'reply', signal }));
        const accepted = deliveryIds(sent);
        if (accepted.length === 0) {
          ledger.messageIds = next;
          return;
        }
        next.push(...accepted);
      } catch (error) {
        const extra = error instanceof ImSendError ? error.acceptedIds.filter((id) => id.length > 0) : [];
        const failedPart = error instanceof ImSendError && error.failedPart !== undefined ? error.failedPart : extra.length;
        ledger.messageIds = [...next, ...extra.slice(0, failedPart)];
        if (error instanceof ImSendError && error.outcome !== 'failed') throw error;
        return;
      }
    }
    if (edit && ledger.messageIds.length > parts.length) {
      for (let index = parts.length; index < ledger.messageIds.length; index += 1) {
        const existing = ledger.messageIds[index];
        if (existing === undefined || existing.length === 0) continue;
        try {
          const edited = await this.pacedSend(adapter, identity, (signal) => adapter.editText({ identity, messageId: existing, text: ' ', code: 'reply', signal }));
          if (!edited.edited) return;
        } catch (error) {
          if (error instanceof ImSendError && error.outcome !== 'failed') throw error;
          return;
        }
      }
    }
    ledger.messageIds = next;
    ledger.lastText = text;
  }

  private async sendReply(adapter: ImSessionAdapter, identity: ImInboundIdentity, part: string, ledger: ReplyLedger, full: string): Promise<{ messageId: string } | undefined> {
    try {
      return await this.pacedSend(adapter, identity, (signal) => adapter.sendText({ identity, text: part, code: 'reply', signal }));
    } catch (error) {
      if (await this.noteTooLong(adapter, identity, full, ledger, error)) return undefined;
      throw error;
    }
  }

  private async noteTooLong(adapter: ImSessionAdapter, identity: ImInboundIdentity, text: string, ledger: ReplyLedger, error: unknown): Promise<boolean> {
    if (!(error instanceof Error) || error.message !== 'too_long') return false;
    if (adapter.providerKind === 'wechat_bridge' && adapter.supportsFile) {
      try {
        await this.pacedSend(adapter, identity, (signal) => adapter.sendFile({ identity, name: 'reply.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode(text), asVoice: false, asImage: false, signal }));
        ledger.fileSent = true;
        ledger.undelivered = false;
        ledger.failedText = undefined;
        ledger.lastText = text;
      } catch (error) {
        if (error instanceof ImSendError && error.outcome !== 'failed') throw error;
        ledger.fileSent = false;
        ledger.undelivered = true;
        ledger.failedText = text;
      }
      return true;
    }
    if (adapter.providerKind === 'onebot_v11' && !adapter.supportsFile) {
      if (ledger.tooLongNotice !== text) {
        ledger.tooLongNotice = text;
        await this.send(adapter, identity, this.copy('tooLong'), 'too_long');
      }
      ledger.undelivered = true;
      ledger.failedText = text;
      return true;
    }
    return false;
  }

  private async publishQq(adapter: ImSessionAdapter, identity: ImInboundIdentity, text: string, ledger: ReplyLedger): Promise<void> {
    if (text.length === 0) return;
    const delivered = ledger.deliveredText ?? '';
    if (delivered.length > 0 && !text.startsWith(delivered)) ledger.deliveredText = '';
    const base = ledger.deliveredText ?? '';
    const pending = text.slice(base.length);
    if (pending.length === 0) {
      ledger.undelivered = false;
      ledger.failedText = undefined;
      ledger.lastText = text;
      return;
    }
    let knownTooLong = base.length === 0 && ledger.failedText === text;
    if (base.length === 0 && !knownTooLong) {
      try {
        const sent = await this.pacedSend(adapter, identity, (signal) => adapter.sendText({ identity, text, code: 'reply', signal }));
        this.keepIds(ledger, deliveryIds(sent));
        ledger.deliveredText = text;
        ledger.undelivered = false;
        ledger.failedText = undefined;
        ledger.lastText = text;
        return;
      } catch (error) {
        if (!isTooLong(error)) throw error;
        knownTooLong = true;
      }
    }
    const outcome = await this.segmentQqRemainder(adapter, identity, pending, knownTooLong);
    ledger.deliveredText = base + outcome.delivered;
    this.keepIds(ledger, outcome.ids);
    if (outcome.complete && ledger.deliveredText === text) {
      ledger.undelivered = false;
      ledger.failedText = undefined;
      ledger.lastText = text;
      return;
    }
    if (outcome.unsplittable && ledger.tooLongNotice !== text) {
      ledger.tooLongNotice = text;
      await this.send(adapter, identity, this.copy('tooLong'), 'too_long');
    }
    ledger.undelivered = true;
    ledger.failedText = text;
  }

  private async segmentQqRemainder(adapter: ImSessionAdapter, identity: ImInboundIdentity, pending: string, knownTooLong: boolean): Promise<{ delivered: string; ids: string[]; complete: boolean; unsplittable: boolean }> {
    let rest = pending;
    let delivered = '';
    const ids: string[] = [];
    let shrink = knownTooLong;
    while (rest.length > 0) {
      const probe = await this.fittedQqPrefix(adapter, identity, rest, shrink);
      shrink = false;
      if (probe.kind === 'unsplittable') return { delivered, ids, complete: false, unsplittable: true };
      if (probe.kind === 'failed') return { delivered, ids, complete: false, unsplittable: false };
      delivered += probe.text;
      ids.push(...probe.ids);
      rest = rest.slice(probe.text.length);
      if (rest.length === 0) break;
      const parts = chunksOf(rest, codePoints(probe.text).length);
      try {
        const sent = await this.pacedSend(adapter, identity, (signal) => adapter.sendTextParts({ identity, parts, code: 'reply', signal }));
        ids.push(...deliveryIds(sent));
        delivered += parts.join('');
        rest = '';
      } catch (error) {
        if (!(error instanceof ImSendError) || error.outcome !== 'failed') throw error;
        const failedPart = error.failedPart ?? 0;
        const acceptedText = parts.slice(0, failedPart).join('');
        delivered += acceptedText;
        ids.push(...error.acceptedIds.filter((id) => id.length > 0));
        rest = rest.slice(acceptedText.length);
        if (error.message !== 'too_long') return { delivered, ids, complete: false, unsplittable: false };
        shrink = failedPart === 0;
        if (rest.length === 0) return { delivered, ids, complete: false, unsplittable: true };
      }
    }
    return { delivered, ids, complete: rest.length === 0, unsplittable: false };
  }

  private async fittedQqPrefix(adapter: ImSessionAdapter, identity: ImInboundIdentity, rest: string, knownTooLong: boolean): Promise<{ kind: 'accepted'; text: string; ids: string[] } | { kind: 'failed' } | { kind: 'unsplittable' }> {
    let candidate = knownTooLong ? halfPrefix(rest) : rest;
    if (candidate === undefined) return { kind: 'unsplittable' };
    while (true) {
      try {
        const part = candidate;
        const sent = await this.pacedSend(adapter, identity, (signal) => adapter.sendTextParts({ identity, parts: [part], code: 'reply', signal }));
        return { kind: 'accepted', text: candidate, ids: deliveryIds(sent) };
      } catch (error) {
        if (error instanceof ImSendError && error.outcome !== 'failed') throw error;
        if (error instanceof ImSendError && error.message !== 'too_long') return { kind: 'failed' };
        if (!isTooLong(error)) throw error;
        const next = halfPrefix(candidate);
        if (next === undefined) return { kind: 'unsplittable' };
        candidate = next;
      }
    }
  }

  private keepIds(ledger: ReplyLedger, ids: readonly string[]): void {
    for (const id of ids) if (id.length > 0 && !ledger.messageIds.includes(id)) ledger.messageIds.push(id);
  }

  private async editOrSend(adapter: ImSessionAdapter, identity: ImInboundIdentity, ledger: ReplyLedger, index: number, text: string): Promise<void> {
    const messageId = ledger.messageIds[index];
    if (messageId === undefined) return;
    if (!adapter.supportsEdit || messageId.length === 0) {
      const sent = await this.sendReply(adapter, identity, text, ledger, text);
      if (sent === undefined) return;
      ledger.messageIds[index] = sent.messageId;
      return;
    }
    const edited = await this.pacedSend(adapter, identity, (signal) => adapter.editText({ identity, messageId, text, code: 'reply', signal }));
    if (!edited.edited) ledger.messageIds[index] = (await this.pacedSend(adapter, identity, (signal) => adapter.sendText({ identity, text, code: 'reply', signal }))).messageId;
  }

  private async publishMedia(adapter: ImSessionAdapter, identity: ImInboundIdentity, media: readonly { kind: 'image' | 'file' | 'audio'; name: string; mediaType: string; bytes: Uint8Array }[]): Promise<void> {
    for (const item of media) {
      const asVoice = item.kind === 'audio' && adapter.acceptsVoice(item.mediaType);
      const asImage = item.kind === 'image';
      if (!asVoice && !asImage && !adapter.supportsFile) {
        if (item.kind === 'audio') this.state.voiceFallbacks += 1;
        await this.send(adapter, identity, this.copy('fileUnsupported'), 'file_unsupported');
        continue;
      }
      let counted = false;
      let sent: { deliveredAs: 'file' | 'image' | 'voice' };
      try {
        sent = await this.pacedSend(adapter, identity, (signal) => adapter.sendFile({ identity, name: item.name, mediaType: item.mediaType, bytes: item.bytes, asVoice, asImage, signal }));
      } catch (error) {
        if (asVoice && error instanceof Error && error.message === 'bad_format') {
          counted = true;
          this.state.voiceFallbacks += 1;
          if (!adapter.supportsFile) {
            await this.send(adapter, identity, this.copy('fileUnsupported'), 'file_unsupported');
            continue;
          }
          sent = await this.pacedSend(adapter, identity, (signal) => adapter.sendFile({ identity, name: item.name, mediaType: item.mediaType, bytes: item.bytes, asVoice: false, asImage: false, signal }));
        } else if (error instanceof Error && error.message === 'unsupported_file') {
          await this.send(adapter, identity, this.copy('fileUnsupported'), 'file_unsupported');
          continue;
        } else throw error;
      }
      if (item.kind === 'audio' && !counted && sent.deliveredAs !== 'voice') this.state.voiceFallbacks += 1;
    }
  }

  private async send(adapter: ImSessionAdapter, identity: ImInboundIdentity, text: string, code: string, buttons?: readonly { id: string; label: string }[]): Promise<void> {
    if (this.closed) return;
    const bindings = this.state.bindings.filter((binding) => sameIdentity(binding.identity, identity) && this.adapterFor(binding.providerInstanceId) === adapter);
    if (bindings.length > 0 && !bindings.some((binding) => this.admittedOutbound(binding))) return;
    await this.pacedSend(adapter, identity, (signal) => adapter.sendText({ identity,
      text: buttons !== undefined && buttons.length > 0 && !adapter.supportsButtons ? [text, ...buttons.map((button) => button.label), this.copy('numbers')].join('\n') : text,
      code, buttons: adapter.supportsButtons ? buttons : undefined, signal,
    }));
  }

  private enqueueProjection(bindingId: string, work: () => Promise<void>): Promise<void> {
    const run = (this.projections.get(bindingId) ?? Promise.resolve()).then(work, work);
    this.projections.set(bindingId, run);
    const clear = (): void => { if (this.projections.get(bindingId) === run) this.projections.delete(bindingId); };
    void run.then(clear, clear);
    return run;
  }

  private async projectInteractions(binding: BindingRecord, approvals: readonly { id: string; expiresAt: number; toolName: string; action: string; ssh?: 'login' | 'host_key' }[], questions: readonly ImPendingQuestion[]): Promise<void> {
    if (this.closed) return;
    await this.enqueueProjection(binding.id, () => this.deliverInteractions(binding, approvals, questions));
  }

  private async deliverInteractions(binding: BindingRecord, approvals: readonly { id: string; expiresAt: number; toolName: string; action: string; ssh?: 'login' | 'host_key' }[], questions: readonly ImPendingQuestion[]): Promise<void> {
    const adapter = this.adapterFor(binding.providerInstanceId);
    const current = (): boolean => !this.closed && this.state.bindings.includes(binding) && this.admittedOutbound(binding) && binding.mobileInteractions && this.adapterFor(binding.providerInstanceId) === adapter;
    if (adapter === undefined || !current()) return;
    const jobs: OutboxRecord[] = [];
    let changed = this.retireOutbox(binding, approvals, questions);
    if (binding.interactionFailure !== undefined) {
      if (changed) await this.persist();
      return;
    }
    for (const approval of approvals) changed = this.stageApproval(binding, approval, jobs) || changed;
    for (const question of questions) changed = this.stageQuestion(binding, question, jobs) || changed;
    if (changed) await this.persist();
    for (const job of jobs) {
      if (!current()) return;
      job.delivery = 'sending';
      try { await this.persist(); } catch (error) { job.delivery = 'pending'; throw error; }
      if (!current()) {
        job.delivery = 'pending';
        await this.persist();
        return;
      }
      try {
        await this.send(adapter, binding.identity, job.text, job.code, job.buttons.length > 0 ? job.buttons : undefined);
      } catch (error) {
        job.delivery = error instanceof ImSendError && (error.outcome === 'unknown' || error.outcome === 'partial') ? 'unknown' : 'pending';
        await this.persist();
        if (!(error instanceof ImSendError)) throw error;
        const code = error.message;
        if (!((binding.providerKind === 'feishu_app' && code === 'feishu_thread_context_missing') || (binding.providerKind === 'wechat_bridge' && code === 'wechat_group_unsupported'))) throw error;
        binding.interactionFailure = code;
        this.ports.logger.info({ binding_id: binding.id, instance_id: binding.providerInstanceId, diagnostic_code: code }, 'im interaction delivery blocked');
        await this.persist();
        return;
      }
      job.delivery = 'sent';
      if (job.kind === 'desktop_ssh' && !this.state.notices.includes(job.key)) this.state.notices.push(job.key);
      await this.persist();
    }
  }

  private retireOutbox(binding: BindingRecord, approvals: readonly { id: string }[], questions: readonly ImPendingQuestion[]): boolean {
    const approvalIds = new Set(approvals.map((item) => item.id));
    const questionKeys = new Set(questions.filter((item) => !this.questionAnswered(binding, item)).map((item) => `${item.id}:${item.questionIndex}`));
    const next = this.state.outbox.filter((item) => {
      if (item.bindingId !== binding.id) return true;
      if (item.kind === 'question') return questionKeys.has(`${item.interactionId}:${item.questionIndex ?? 0}`);
      return approvalIds.has(item.interactionId);
    });
    if (next.length === this.state.outbox.length) return false;
    this.state.outbox = next;
    return true;
  }

  private stageApproval(binding: BindingRecord, approval: { id: string; expiresAt: number; toolName: string; action: string; ssh?: 'login' | 'host_key' }, jobs: OutboxRecord[]): boolean {
    const key = JSON.stringify(['interaction', binding.sessionId, approval.id]);
    const existing = this.state.outbox.find((item) => item.sessionId === binding.sessionId && item.interactionId === approval.id && item.kind !== 'question');
    if (existing !== undefined) {
      if (existing.delivery === 'pending' && existing.bindingId === binding.id && existing.senderKey === senderKey(binding.providerInstanceId, binding.identity)) jobs.push(existing);
      return false;
    }
    if (approval.ssh === 'login' ? this.state.notices.includes(key) || this.state.notices.includes(approval.id) : this.state.tickets.some((ticket) => ticket.sessionId === binding.sessionId && ticket.interactionId === approval.id)) return false;
    const who = senderKey(binding.providerInstanceId, binding.identity);
    if (approval.ssh === 'login') {
      this.state.outbox.push({ key, bindingId: binding.id, senderKey: who, sessionId: binding.sessionId, interactionId: approval.id, kind: 'desktop_ssh', expiresAt: approval.expiresAt, text: this.copy('desktopSsh'), code: 'desktop_ssh', buttons: [], delivery: 'pending' });
    } else if (approval.ssh === 'host_key') {
      const yes = this.ticket(binding, approval.id, approval.expiresAt, 'host_yes');
      const no = this.ticket(binding, approval.id, approval.expiresAt, 'host_no');
      this.state.outbox.push({ key, bindingId: binding.id, senderKey: who, sessionId: binding.sessionId, interactionId: approval.id, kind: 'host_key', expiresAt: approval.expiresAt, text: approval.toolName, code: 'host_key', buttons: [{ id: yes, label: this.copy('trust') }, { id: no, label: this.copy('refuse') }], delivery: 'pending' });
    } else {
      const allow = this.ticket(binding, approval.id, approval.expiresAt, 'approve');
      const refuse = this.ticket(binding, approval.id, approval.expiresAt, 'reject');
      this.state.outbox.push({ key, bindingId: binding.id, senderKey: who, sessionId: binding.sessionId, interactionId: approval.id, kind: 'approval', expiresAt: approval.expiresAt, text: `${approval.toolName} ${approval.action}`, code: 'approval', buttons: [{ id: allow, label: this.copy('allow') }, { id: refuse, label: this.copy('refuse') }], delivery: 'pending' });
    }
    const staged = this.state.outbox[this.state.outbox.length - 1];
    if (staged !== undefined) jobs.push(staged);
    return true;
  }

  private stageQuestion(binding: BindingRecord, question: ImPendingQuestion, jobs: OutboxRecord[]): boolean {
    if (this.questionAnswered(binding, question)) return false;
    const key = JSON.stringify(['question', binding.sessionId, question.id, question.questionIndex]);
    const existing = this.state.outbox.find((item) => item.sessionId === binding.sessionId && item.kind === 'question' && item.interactionId === question.id && (item.questionIndex ?? 0) === question.questionIndex);
    if (existing !== undefined) {
      if (existing.delivery === 'pending' && existing.bindingId === binding.id && existing.senderKey === senderKey(binding.providerInstanceId, binding.identity)) jobs.push(existing);
      return false;
    }
    if (this.state.tickets.some((ticket) => ticket.sessionId === binding.sessionId && this.sameQuestion(ticket, question))) return false;
    const group = `${question.id}:${question.questionIndex}`;
    const buttons = question.options.map((option, index) => ({ id: this.ticket(binding, question.id, question.expiresAt, question.multi ? 'toggle' : 'single', question.questionKey, option.id, group, question.questionIndex), label: `${index + 1}. ${option.label}` }));
    if (question.multi) buttons.push({ id: this.ticket(binding, question.id, question.expiresAt, 'multi_done', question.questionKey, undefined, group, question.questionIndex), label: this.copy('done') });
    if (question.allowOther) buttons.push({ id: this.ticket(binding, question.id, question.expiresAt, 'other', question.questionKey, undefined, undefined, question.questionIndex), label: this.copy('other') });
    this.state.outbox.push({ key, bindingId: binding.id, senderKey: senderKey(binding.providerInstanceId, binding.identity), sessionId: binding.sessionId, interactionId: question.id, ...(question.questionIndex === undefined ? {} : { questionIndex: question.questionIndex }), kind: 'question', expiresAt: question.expiresAt, text: question.questionKey, code: 'question', buttons, delivery: 'pending' });
    const staged = this.state.outbox[this.state.outbox.length - 1];
    if (staged !== undefined) jobs.push(staged);
    return true;
  }

  private ticket(binding: BindingRecord, interactionId: string, expiresAt: number, action: TicketRecord['action'], questionKey?: string, optionId?: string, group?: string, questionIndex?: number): string {
    const id = this.next('t');
    this.state.tickets.push({ id, sessionId: binding.sessionId, interactionId, bindingId: binding.id, senderKey: senderKey(binding.providerInstanceId, binding.identity), expiresAt, consumed: false, action, questionKey, ...(questionIndex === undefined ? {} : { questionIndex }), optionId, group });
    return id;
  }

  private sameQuestion(ticket: TicketRecord, question: { id: string; questionIndex: number }): boolean {
    return ticket.interactionId === question.id && ticket.questionIndex === question.questionIndex;
  }

  private rememberChatKind(instanceId: string, event: ImInboundEvent): void {
    const accountId = this.requireMeta(instanceId).accountId ?? instanceId;
    const binding = this.state.bindings.find((item) => item.providerInstanceId === instanceId && item.accountId === accountId && sameIdentity(item.identity, event.identity));
    if (binding?.interactionFailure === 'feishu_thread_context_missing') delete binding.interactionFailure;
    if (event.identity.chatKind === undefined) return;
    if (binding !== undefined) binding.identity = { ...binding.identity, chatKind: event.identity.chatKind };
    const discovery = this.state.discoveries.find((item) => item.providerInstanceId === instanceId && item.accountId === accountId && sameIdentity(item.identity, event.identity));
    if (discovery !== undefined) discovery.identity = { ...discovery.identity, chatKind: event.identity.chatKind };
  }

  private async onCallback(instanceId: string, event: ImInboundEvent): Promise<void> {
    const adapter = this.adapterFor(instanceId);
    const tickets = this.state.tickets.filter((item) => item.id === event.callbackData);
    const ticket = tickets.length === 1 ? tickets[0] : undefined;
    const accountId = this.requireMeta(instanceId).accountId ?? instanceId;
    const binding = this.state.bindings.find((item) => item.providerInstanceId === instanceId && item.accountId === accountId && sameIdentity(item.identity, event.identity));
    if (event.callbackQueryId !== undefined && adapter !== undefined) await adapter.answerCallback(event.callbackQueryId);
    if (binding !== undefined && !this.admittedInbound(binding)) return;
    if (ticket === undefined || binding === undefined || adapter === undefined) {
      if (ticket === undefined && binding !== undefined && adapter !== undefined) await this.send(adapter, event.identity, this.copy('unknown'), 'unknown');
      return;
    }
    if (ticket.senderKey !== senderKey(instanceId, event.identity) || ticket.bindingId !== binding.id || ticket.sessionId !== binding.sessionId) {
      await this.send(adapter, event.identity, this.copy('crossSession'), 'cross_session');
      return;
    }
    if (this.now() > ticket.expiresAt) {
      await this.send(adapter, event.identity, this.copy('expired'), 'expired');
      return;
    }
    if (ticket.consumed && ticket.action !== 'toggle') {
      await this.send(adapter, event.identity, this.copy('resolved'), 'resolved');
      return;
    }
    if (ticket.action === 'approve' || ticket.action === 'reject') {
      const result = await this.ports.sessions.decideApproval({ sessionId: ticket.sessionId, interactionId: ticket.interactionId, decision: ticket.action === 'approve' ? 'approved' : 'rejected' });
      ticket.consumed = true;
      if (result === 'expired') await this.send(adapter, event.identity, this.copy('expired'), 'expired');
      else if (result === 'resolved') await this.send(adapter, event.identity, this.copy('resolved'), 'resolved');
      return;
    }
    if (ticket.action === 'host_yes' || ticket.action === 'host_no') {
      const result = await this.ports.sessions.decideHostKey({ sessionId: ticket.sessionId, interactionId: ticket.interactionId, decision: ticket.action === 'host_yes' ? 'approved' : 'rejected' });
      ticket.consumed = true;
      if (result === 'expired') await this.send(adapter, event.identity, this.copy('expired'), 'expired');
      else if (result === 'resolved') await this.send(adapter, event.identity, this.copy('resolved'), 'resolved');
      return;
    }
    if (ticket.action === 'single' && ticket.optionId !== undefined) {
      await this.ask(ticket.sessionId, ticket.interactionId, { kind: 'single', questionKey: ticket.questionKey, ...(ticket.questionIndex === undefined ? {} : { questionIndex: ticket.questionIndex }), optionIds: [ticket.optionId], method: 'number_key' });
      ticket.consumed = true;
      if (ticket.questionIndex !== undefined) this.markQuestion(binding, ticket.interactionId, ticket.questionIndex);
      return;
    }
    if (ticket.action === 'toggle' && ticket.group !== undefined && ticket.optionId !== undefined) {
      const selected = new Set(this.state.selections[ticket.group] ?? []);
      if (selected.has(ticket.optionId)) selected.delete(ticket.optionId);
      else selected.add(ticket.optionId);
      this.state.selections[ticket.group] = [...selected];
      return;
    }
    if (ticket.action === 'multi_done' && ticket.group !== undefined) {
      const optionIds = this.state.selections[ticket.group] ?? [];
      if (optionIds.length === 0) return;
      await this.ask(ticket.sessionId, ticket.interactionId, { kind: 'multi', questionKey: ticket.questionKey, ...(ticket.questionIndex === undefined ? {} : { questionIndex: ticket.questionIndex }), optionIds, method: 'number_key' });
      ticket.consumed = true;
      if (ticket.questionIndex !== undefined) this.markQuestion(binding, ticket.interactionId, ticket.questionIndex);
      return;
    }
    if (ticket.action === 'other' && ticket.questionKey !== undefined) {
      this.state.awaiting[senderKey(instanceId, event.identity)] = { interactionId: ticket.interactionId, questionKey: ticket.questionKey, ...(ticket.questionIndex === undefined ? {} : { questionIndex: ticket.questionIndex }), expiresAt: ticket.expiresAt, sessionId: ticket.sessionId };
      ticket.consumed = true;
    }
  }
}

function emptyState(): Stored {
  return { policy: { allowed: true, defaultEnabled: true }, instances: [], discoveries: [], bindings: [], strangers: [], seen: [], tickets: [], selections: {}, awaiting: {}, voiceFallbacks: 0, cursors: {}, notices: [], questionAnswers: {}, answeredQuestions: {}, replies: [], outbox: [] };
}

function mediaCapabilitiesOf(adapter: ImSessionAdapter): readonly MessageMediaCapability[] {
  return adapter.sendMedia === undefined ? [] : adapter.mediaCapabilities ?? [];
}
function toDiscovery(record: DiscoveryRecord): ImDiscovery {
  return { id: record.id, provider_instance_id: record.providerInstanceId, provider_kind: record.providerKind, account_id: record.accountId, identity: wireIdentity(record.identity), preview: record.preview, at: new Date(record.at).toISOString() };
}

function toBinding(record: BindingRecord): ImBinding {
  return {
    id: record.id,
    provider_instance_id: record.providerInstanceId,
    provider_kind: record.providerKind,
    account_id: record.accountId,
    identity: wireIdentity(record.identity),
    session_id: record.sessionId,
    persona_id: record.personaId,
    pending_reanchor: record.pendingReanchor,
    binding_scope: record.bindingScope,
    group_policy: record.groupPolicy,
    enabled: record.enabled,
    session_enabled: record.sessionEnabled,
    input_enabled: record.inputEnabled,
    output_enabled: record.outputEnabled,
    busy: record.busy,
    reply: record.reply,
    mobile_interactions: record.mobileInteractions,
  };
}

function toStranger(record: StrangerRecord): ImStranger {
  return { provider_instance_id: record.providerInstanceId, identity: wireIdentity(record.identity), preview: record.preview, count: record.count };
}

function deliveryIds(sent: { messageId: string; messageIds?: readonly string[] }): string[] {
  const ids = sent.messageIds ?? (sent.messageId.length > 0 ? [sent.messageId] : []);
  return ids.filter((id) => id.length > 0);
}

function isTooLong(error: unknown): boolean {
  return error instanceof Error && error.message === 'too_long';
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

function halfPrefix(text: string): string | undefined {
  const units = codePoints(text);
  if (units.length < 2) return undefined;
  return units.slice(0, Math.floor(units.length / 2)).join('');
}

function chunksOf(text: string, unitWidth: number): string[] {
  const units = codePoints(text);
  const width = unitWidth < 1 ? units.length : unitWidth;
  const parts: string[] = [];
  for (let index = 0; index < units.length; index += width) parts.push(units.slice(index, index + width).join(''));
  return parts;
}

function wireIdentity(identity: ImInboundIdentity): ImDiscovery['identity'] {
  return {
    chat_id: identity.chatId,
    sender_id: identity.senderId,
    topic_id: identity.topicId,
    chat_kind: identity.chatKind,
    ...(identity.chatTitle === undefined ? {} : { chat_title: identity.chatTitle }),
    ...(identity.senderName === undefined ? {} : { sender_name: identity.senderName }),
    ...(identity.topicTitle === undefined ? {} : { topic_title: identity.topicTitle }),
  };
}
