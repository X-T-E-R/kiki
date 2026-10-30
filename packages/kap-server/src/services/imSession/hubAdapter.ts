import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite } from '@kiki/agent-core-v2/_base/utils/fs';
import type { MessageMediaCapability } from '@kiki/agent-core-v2/app/bot/messageRouting';
import type { ImConnectionDetail, ImProviderKind } from '@kiki/protocol';
import {
  createSessionHub,
  SESSION_CAPABILITIES,
  splitFeishuText,
  TELEGRAM_DOWNLOAD_BYTES,
  type SessionAdapter,
  type SessionChatKind,
  type SessionCursorStore,
  type SessionHub,
  type SessionInbound,
  type SessionOutbound,
  type SessionPlatformId,
  type SessionReceipt,
  type SessionSpec,
  type SessionTarget,
} from '@nb-im/core';

import { readPrivateFile, writePrivateFile } from '../auth/privateFiles';
import { ImSendError, type ImAdapterFactory, type ImInboundEvent, type ImInboundIdentity, type ImMediaReceipt, type ImOutboundFile, type ImOutboundMedia, type ImOutboundText, type ImSessionAdapter } from './adapter';
import { segmentText } from './segment';
import { oneBotIdentityTransport } from './oneBotIdentity';
import { wechatEndpointAllowed } from './wechatLogin';

function ioCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

export function fileCursorStore(homeDir: string): SessionCursorStore {
  const file = join(homeDir, 'im-session-cursors.json');
  let chain = Promise.resolve();
  const read = async (): Promise<Record<string, string>> => {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (ioCode(error) === 'ENOENT') return {};
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { throw new Error('cursor_file_invalid'); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('cursor_file_invalid');
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') values[key] = value;
    return values;
  };
  return {
    async load(scope) {
      return (await read())[scope];
    },
    save(scope, cursor) {
      const run = chain.then(async () => {
        const values = await read();
        values[scope] = cursor;
        await mkdir(homeDir, { recursive: true });
        await atomicWrite(file, JSON.stringify(values));
      });
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

const replyWrites = new Map<string, Promise<void>>();

function enqueueReplyWrite(file: string, job: () => Promise<void>): Promise<void> {
  const previous = replyWrites.get(file) ?? Promise.resolve();
  const run = previous.then(job, job);
  const settled = run.then(() => undefined, () => undefined);
  replyWrites.set(file, settled);
  return run;
}

async function loadReplyMap(file: string): Promise<Record<string, string>> {
  let raw: Buffer;
  try { raw = await readPrivateFile(file); } catch (error) {
    if (ioCode(error) === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')) as unknown; } catch { throw new Error('im_session_reply_unreadable'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('im_session_reply_unreadable');
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') values[key] = value;
  return values;
}

export function sessionSpec(kind: ImProviderKind, instanceId: string, credential: string): SessionSpec {
  if (kind === 'telegram') return { platform: 'telegram', instance_id: instanceId, token: credential.trim() };
  if (kind === 'feishu_app') {
    const [appId, appSecret] = credential.split('\n');
    return { platform: 'feishu_app', instance_id: instanceId, app_id: appId?.trim() ?? '', app_secret: appSecret?.trim() ?? '' };
  }
  if (kind === 'wechat_bridge') {
    const [token, account, base] = credential.split('\n');
    const accountId = account?.trim() ?? '';
    const baseUrl = base?.trim() ?? '';
    return {
      platform: 'personal_wechat',
      instance_id: instanceId,
      token: token?.trim() ?? '',
      ...(accountId.length > 0 ? { account_id: accountId } : {}),
      ...(baseUrl.length > 0 && wechatEndpointAllowed(baseUrl) ? { base_url: baseUrl } : {}),
    };
  }
  if (kind === 'discord') return { platform: kind, instance_id: instanceId, bot_token: credential.trim() };
  if (kind === 'slack') {
    const [botToken, appToken] = credential.split('\n');
    return { platform: kind, instance_id: instanceId, bot_token: botToken?.trim() ?? '', app_token: appToken?.trim() ?? '' };
  }
  if (kind === 'matrix') {
    const [homeserver, accessToken] = credential.split('\n');
    return { platform: kind, instance_id: instanceId, homeserver: homeserver?.trim() ?? '', access_token: accessToken?.trim() ?? '' };
  }
  return oneBotSpec(instanceId, credential);
}

export function sessionAccountHint(kind: ImProviderKind, credential: string): { ok: boolean; accountId?: string } {
  if (kind === 'telegram') return { ok: false };
  try {
    const spec = sessionSpec(kind, 'im_check', credential);
    if (spec.platform === 'feishu_app') return spec.app_id.length > 0 && spec.app_secret.length > 0 ? { ok: true, accountId: spec.app_id } : { ok: false };
    if (spec.platform === 'personal_wechat') return spec.token.length > 0 ? { ok: true, ...(spec.account_id === undefined ? {} : { accountId: spec.account_id }) } : { ok: false };
    if (spec.platform !== 'qq_onebot_v11') return { ok: false };
    const url = new URL(spec.endpoint);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return { ok: false };
    const port = url.port.length > 0 ? url.port : url.protocol === 'wss:' ? '443' : '80';
    return { ok: true, accountId: `${url.hostname}:${port}` };
  } catch {
    return { ok: false };
  }
}

export async function checkRealtimeSessionAccount(kind: 'discord' | 'slack' | 'matrix', credential: string, fetcher: typeof fetch = fetch): Promise<{ ok: boolean; accountId?: string; detail?: string }> {
  try {
    const spec = sessionSpec(kind, 'im_check', credential);
    let url: string;
    let authorization: string;
    if (spec.platform === 'discord') {
      url = 'https://discord.com/api/v10/users/@me';
      authorization = `Bot ${spec.bot_token}`;
    } else if (spec.platform === 'slack') {
      if (!spec.app_token.startsWith('xapp-')) return { ok: false, detail: 'slack_app_token_required' };
      url = 'https://slack.com/api/auth.test';
      authorization = `Bearer ${spec.bot_token}`;
    } else if (spec.platform === 'matrix') {
      const base = new URL(spec.homeserver);
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return { ok: false, detail: 'matrix_homeserver_https_required' };
      url = `${base.href.replace(/\/$/u, '')}/_matrix/client/v3/account/whoami`;
      authorization = `Bearer ${spec.access_token}`;
    } else return { ok: false, detail: 'unsupported_platform' };
    const response = await fetcher(url, { method: kind === 'slack' ? 'POST' : 'GET', headers: { authorization }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return { ok: false, detail: response.status === 401 || response.status === 403 ? 'unauthorized' : 'connection_failed' };
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, detail: 'invalid_response' };
    const data = body as Record<string, unknown>;
    if (kind === 'slack' && data['ok'] !== true) return { ok: false, detail: 'unauthorized' };
    const accountId = kind === 'discord' ? data['id'] : data['user_id'];
    return typeof accountId === 'string' && accountId.length > 0 ? { ok: true, accountId } : { ok: false, detail: 'invalid_response' };
  } catch { return { ok: false, detail: 'connection_failed' }; }
}

export function hubSessionFactories(hub: SessionHub, homeDir: string): ImAdapterFactory[] {
  const kinds: readonly ImProviderKind[] = ['telegram', 'feishu_app', 'onebot_v11', 'wechat_bridge', 'discord', 'slack', 'matrix'];
  const sources = new WeakMap<SessionAdapter, ReturnType<typeof oneBotIdentityTransport>>();
  return kinds.map((providerKind) => ({
    providerKind,
    minSendIntervalMs: providerKind === 'telegram' || providerKind === 'slack' ? 1000 : 250,
    mediaCapabilities: (input) => providerKind === 'onebot_v11' ? [{ kind: 'image', mimeTypes: ['image/*'] }, { kind: 'voice', mimeTypes: ['audio/*'], rendering: 'native_voice' }] : new HubSessionAdapter(hub.acquire(sessionSpec(providerKind, input.instanceId, input.credential))).mediaCapabilities,
    create: (input) => {
      const spec = sessionSpec(providerKind, input.instanceId, input.credential);
      if (spec.platform !== 'qq_onebot_v11') return new HubSessionAdapter(hub.acquire(spec), homeDir);
      const identity = oneBotIdentityTransport(spec.transport);
      const session = hub.acquire({ ...spec, transport: identity.transport });
      if (!sources.has(session)) sources.set(session, identity);
      return new HubSessionAdapter(session, homeDir, sources.get(session));
    },
  }));
}

export function loadHubFactories(homeDir: string): ImAdapterFactory[] {
  return hubSessionFactories(createSessionHub({ store: fileCursorStore(homeDir) }), homeDir);
}

export class HubSessionAdapter implements ImSessionAdapter {
  readonly canonicalInstanceId: string;
  readonly listenerRealm: string;
  readonly providerKind: ImProviderKind;
  readonly textLimit: number | undefined;
  readonly maxInboundBytes: number;
  readonly supportsEdit: boolean;
  readonly supportsButtons: boolean;
  readonly supportsFile: boolean;
  readonly mediaCapabilities: readonly MessageMediaCapability[];
  private ack: string | undefined;
  private readonly contexts = new Map<string, { reply_context?: string; chat_kind?: SessionChatKind }>();
  private readonly replies = new Map<string, string>();
  private readonly replyBaseline = new Map<string, string>();
  private readonly replyDirty = new Set<string>();
  private replyError: unknown = undefined;
  private readonly replyReady: Promise<void>;

  constructor(private readonly session: SessionAdapter, private readonly homeDir?: string, private readonly source?: ReturnType<typeof oneBotIdentityTransport>) {
    this.canonicalInstanceId = session.instance_id;
    this.providerKind = providerKindOf(session.platform);
    this.listenerRealm = session.platform === 'qq_onebot_v11' ? 'qq-onebot' : session.platform === 'personal_wechat' ? 'wechat' : session.platform === 'feishu_app' ? 'feishu' : session.platform;
    this.textLimit = session.limits.text_characters ?? undefined;
    this.maxInboundBytes = session.platform === 'telegram' ? TELEGRAM_DOWNLOAD_BYTES : session.limits.file_bytes ?? 50 * 1024 * 1024;
    const capability = realtimeCapability(session.platform);
    const editable = session.platform === 'telegram' || session.platform === 'feishu_app';
    this.supportsEdit = capability?.edit_text ?? editable;
    this.supportsButtons = capability?.callbacks ?? editable;
    this.supportsFile = session.platform !== 'qq_onebot_v11';
    this.mediaCapabilities = hubMediaCapabilities(session, this.supportsFile);
    this.replyReady = homeDir === undefined ? Promise.resolve() : this.readReplies().then(() => undefined, (error: unknown) => { this.replyError = error; });
  }

  get listenerAccountId(): string | undefined {
    return this.source?.accountId;
  }

  describeConflict(): Promise<'webhook' | 'none'> {
    return Promise.resolve('none');
  }

  connectionPhase(): 'idle' | 'starting' | 'running' | 'reconnecting' | 'conflict' | 'auth_expired' | 'stopped' {
    return this.session.state;
  }

  connectionDetail(): ImConnectionDetail | undefined {
    return this.session.connection_detail;
  }

  splitText(text: string): string[] {
    if (this.session.platform === 'feishu_app') return splitFeishuText(text);
    return segmentText(text, this.textLimit);
  }

  acceptsVoice(mediaType: string): boolean {
    const allowed = this.session.limits.voice_mime;
    if (allowed === null || allowed.length === 0) return false;
    const mime = mediaType.toLowerCase();
    return allowed.some((item) => item.toLowerCase() === mime);
  }

  async start(listener: (event: ImInboundEvent) => Promise<void>): Promise<{ accountId: string; conflict?: 'webhook'; failed?: 'auth' }> {
    await this.session.start({
      admit: async (event) => {
        this.ack = undefined;
        try {
          await this.capture(event);
          await listener(this.toEvent(event));
        } catch {
          return { decision: 'defer' };
        }
        const ack = this.ack;
        this.ack = undefined;
        if (event.payload.type === 'callback' && ack !== undefined) return { decision: 'accepted', callback_ack: ack };
        return { decision: 'accepted' };
      },
    });
    const accountId = this.session.account.account_id;
    if (this.session.state === 'conflict') return { accountId, conflict: 'webhook' };
    if (this.session.state === 'auth_expired') return { accountId, failed: 'auth' };
    if (this.session.state !== 'stopped') await this.source?.ready;
    return { accountId };
  }

  stop(): Promise<void> {
    return this.session.stop();
  }

  async sendText(message: ImOutboundText): Promise<{ messageId: string; messageIds: readonly string[] }> {
    await this.useReplies();
    const buttons = message.buttons?.map((button) => ({ data: button.id, label: button.label }));
    const sent = await this.dispatch({
      type: 'text',
      target: this.target(message.identity),
      text: message.text,
      ...(buttons !== undefined && buttons.length > 0 ? { buttons } : {}),
    }, message.identity, message.signal);
    return acceptedDelivery(sent);
  }

  async sendTextParts(message: { identity: ImInboundIdentity; parts: readonly string[]; code: string; signal?: AbortSignal }): Promise<{ messageId: string; messageIds: readonly string[] }> {
    await this.useReplies();
    const sent = await this.dispatch({ type: 'text_parts', target: this.target(message.identity), parts: message.parts }, message.identity, message.signal);
    return acceptedDelivery(sent);
  }

  async editText(message: ImOutboundText & { readonly messageId: string }): Promise<{ messageId: string; edited: boolean }> {
    await this.useReplies();
    const sent = await this.dispatch({ type: 'edit_text', target: this.target(message.identity), message_id: message.messageId, text: message.text }, message.identity, message.signal);
    if (sent.error_kind === 'unsupported') return { messageId: message.messageId, edited: false };
    const accepted = acceptedDelivery(sent);
    return { messageId: accepted.messageId.length > 0 ? accepted.messageId : message.messageId, edited: true };
  }

  async sendFile(message: ImOutboundFile): Promise<{ messageId: string; deliveredAs: 'file' | 'image' | 'voice' }> {
    await this.useReplies();
    const kind = message.asVoice ? 'voice' : message.asImage ? 'image' : 'file';
    const sent = await this.dispatch({
      type: 'media',
      target: this.target(message.identity),
      media: { kind, filename: message.name, mime: message.mediaType, bytes: message.bytes },
    }, message.identity, message.signal);
    if (message.asVoice && sent.error_kind === 'bad_format') throw new Error('bad_format');
    if (sent.error_kind === 'unsupported') throw new Error('unsupported_file');
    const accepted = acceptedDelivery(sent);
    const deliveredAs = message.asVoice && this.acceptsVoice(message.mediaType) ? 'voice' : message.asImage ? 'image' : 'file';
    return { messageId: accepted.messageId, deliveredAs };
  }

  answerCallback(_callbackQueryId: string): Promise<void> {
    this.ack = 'ok';
    return Promise.resolve();
  }

  async sendMedia(message: ImOutboundMedia): Promise<ImMediaReceipt> {
    const capability = this.mediaCapabilities.find((item) => item.kind === message.kind);
    if (capability === undefined || !mimeAllowed(capability, message.mediaType) || (capability.maxBytes !== undefined && message.bytes.byteLength > capability.maxBytes)) {
      return { status: 'unsupported', unsupported: [message.kind] };
    }
    if (!isSessionMediaKind(message.kind)) return { status: 'unsupported', unsupported: [message.kind] };
    await this.useReplies();
    try {
      const sent = await this.dispatch({
        type: 'media', target: this.target(message.identity),
        media: { kind: message.kind, filename: message.name, mime: message.mediaType, bytes: message.bytes },
      }, message.identity, message.signal);
      return {
        status: sent.status === 'accepted' ? 'delivered' : sent.error_kind === 'unsupported' ? 'unsupported' : sent.status === 'unknown' ? 'unknown' : 'failed',
        messageIds: sent.message_ids,
        unsupported: sent.error_kind === 'unsupported' ? [message.kind] : undefined,
        detail: sent.diagnostic_code ?? sent.error_kind,
      };
    } catch {
      return { status: 'unknown', detail: 'Send outcome is unknown; do not resend automatically.' };
    }
  }

  private async capture(event: SessionInbound): Promise<void> {
    await this.useReplies();
    const identity = { chatId: event.identity.chat_id, senderId: event.identity.sender_id, topicId: event.identity.topic_id };
    const key = contextKey(identity);
    const previous = this.contexts.get(key);
    const replyContext = event.reply_context ?? previous?.reply_context;
    const chatKind = event.identity.chat_kind ?? previous?.chat_kind;
    if (replyContext !== undefined || chatKind !== undefined) {
      this.contexts.set(key, { ...(replyContext === undefined ? {} : { reply_context: replyContext }), ...(chatKind === undefined ? {} : { chat_kind: chatKind }) });
    }
    if (this.homeDir !== undefined && event.reply_context !== undefined) {
      const key = replyKey(this.session.instance_id, identity);
      this.replies.set(key, event.reply_context);
      this.replyDirty.add(key);
      await this.writeReplies();
    }
  }

  private toEvent(event: SessionInbound): ImInboundEvent {
    const identity: ImInboundIdentity = {
      chatId: event.identity.chat_id,
      senderId: event.identity.sender_id,
      topicId: event.identity.topic_id,
      chatTitle: event.identity.chat_title,
      senderName: event.identity.sender_name,
      topicTitle: event.identity.topic_title,
    };
    const chatKind = event.identity.chat_kind ?? this.contexts.get(contextKey(identity))?.chat_kind;
    const base = {
      eventId: event.event_key,
      sourceMessageId: event.source_message_id ?? (event.identity.platform === 'telegram' ? undefined : event.platform_event_id),
      identity: { ...identity, chatKind },
      operation: event.operation,
      timestamp: event.timestamp,
      mentioned: event.mentioned,
      mentionIds: event.mention_ids,
      replyToMessageId: event.reply_to_message_id,
      quotedText: event.quoted_text,
      isSelf: event.is_self,
    };
    const payload = event.payload;
    if (payload.type === 'text') return { ...base, kind: 'text', text: payload.text, preview: payload.text.slice(0, 80) };
    if (payload.type === 'callback') return { ...base, kind: 'callback', callbackData: payload.data, callbackQueryId: payload.callback_id };
    if (payload.type === 'media_unavailable') return { ...base, kind: payload.kind === 'voice' ? 'audio' : payload.kind, tooLarge: true, text: '' };
    const kind = payload.media.kind === 'voice' ? 'audio' as const : payload.media.kind;
    return {
      ...base, kind, text: payload.caption ?? '', preview: payload.caption?.slice(0, 80),
      media: { name: payload.media.filename, mediaType: payload.media.mime, bytes: payload.media.bytes },
    };
  }

  private target(identity: ImInboundIdentity): SessionTarget {
    const saved = this.contexts.get(contextKey(identity));
    const reply = this.replies.get(replyKey(this.session.instance_id, identity)) ?? saved?.reply_context;
    const chatKind = identity.chatKind ?? saved?.chat_kind;
    return {
      chat_id: identity.chatId,
      ...(identity.topicId === '0' ? {} : { topic_id: identity.topicId }),
      ...(reply === undefined || reply.length === 0 ? {} : { reply_context: reply }),
      ...(chatKind === undefined ? {} : { chat_kind: chatKind }),
    };
  }

  private async dispatch(message: SessionOutbound, identity: ImInboundIdentity, signal?: AbortSignal): Promise<SessionReceipt> {
    signal?.throwIfAborted();
    const had = 'target' in message && typeof message.target.reply_context === 'string' && message.target.reply_context.length > 0;
    const sent = await this.session.send(message, signal);
    if (sent.diagnostic_code === 'wechat_auth') throw new Error('wechat_auth');
    if (sent.status === 'failed' && sent.diagnostic_code === 'wechat_rejected' && had) {
      await this.forgetReply(identity);
      signal?.throwIfAborted();
      const retried = await this.session.send(withoutReply(message), signal);
      if (retried.diagnostic_code === 'wechat_auth') throw new Error('wechat_auth');
      return retried;
    }
    return sent;
  }

  private async forgetReply(identity: ImInboundIdentity): Promise<void> {
    await this.useReplies();
    const dropped = replyKey(this.session.instance_id, identity);
    this.replies.delete(dropped);
    this.replyDirty.add(dropped);
    const key = contextKey(identity);
    const saved = this.contexts.get(key);
    if (saved !== undefined) {
      if (saved.chat_kind === undefined) this.contexts.delete(key);
      else this.contexts.set(key, { chat_kind: saved.chat_kind });
    }
    if (this.homeDir !== undefined) await this.writeReplies();
  }

  private async useReplies(): Promise<void> {
    await this.replyReady;
    if (this.replyError !== undefined) throw this.replyError instanceof Error ? this.replyError : new Error('im_session_reply_unreadable');
  }

  private async readReplies(): Promise<void> {
    if (this.homeDir === undefined) return;
    const loaded = await loadReplyMap(join(this.homeDir, 'im-session-reply.json'));
    this.replies.clear();
    this.replyBaseline.clear();
    this.replyDirty.clear();
    for (const [key, value] of Object.entries(loaded)) {
      this.replies.set(key, value);
      this.replyBaseline.set(key, value);
    }
  }

  private async writeReplies(): Promise<void> {
    if (this.homeDir === undefined) return;
    await this.useReplies();
    const file = join(this.homeDir, 'im-session-reply.json');
    await enqueueReplyWrite(file, async () => {
      const dirty = [...this.replyDirty];
      const current = await loadReplyMap(file);
      const merged: Record<string, string> = { ...current };
      for (const key of dirty) {
        const value = this.replies.get(key);
        if (value === undefined) delete merged[key];
        else merged[key] = value;
      }
      await writePrivateFile(file, JSON.stringify(merged));
      for (const key of dirty) {
        const value = this.replies.get(key);
        if (value === undefined) this.replyBaseline.delete(key);
        else this.replyBaseline.set(key, value);
        this.replyDirty.delete(key);
      }
    });
  }
}

function oneBotSpec(instanceId: string, credential: string): SessionSpec {
  const trimmed = credential.trim();
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return { platform: 'qq_onebot_v11', instance_id: instanceId, mode: 'forward', endpoint: trimmed };
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('onebot_endpoint_rejected');
  const body = parsed as Record<string, unknown>;
  const endpoint = typeof body['endpoint'] === 'string' ? body['endpoint'] : '';
  const access = typeof body['access_token'] === 'string' ? body['access_token'] : undefined;
  const port = typeof body['listen_port'] === 'number' ? body['listen_port'] : undefined;
  return {
    platform: 'qq_onebot_v11', instance_id: instanceId, mode: body['mode'] === 'reverse' ? 'reverse' : 'forward', endpoint,
    ...(access === undefined ? {} : { access_token: access }), ...(port === undefined ? {} : { listen_port: port }),
  };
}

function providerKindOf(platform: SessionPlatformId): ImProviderKind {
  if (platform === 'qq_onebot_v11') return 'onebot_v11';
  if (platform === 'personal_wechat') return 'wechat_bridge';
  return platform;
}

function contextKey(identity: { chatId: string; senderId: string; topicId: string }): string {
  return `${identity.chatId}\u0000${identity.senderId}\u0000${identity.topicId}`;
}

function replyKey(instanceId: string, identity: { chatId: string; senderId: string; topicId: string }): string {
  return `${instanceId}\u0000${identity.chatId}\u0000${identity.senderId}\u0000${identity.topicId}`;
}

function withoutReply(message: SessionOutbound): SessionOutbound {
  if (!('target' in message)) return message;
  const { reply_context: _drop, ...target } = message.target;
  return { ...message, target };
}

function acceptedDelivery(receipt: SessionReceipt): { messageId: string; messageIds: readonly string[] } {
  if (receipt.status !== 'accepted') {
    const tooLong = receipt.error_kind === 'too_long' || (receipt.diagnostic_code !== undefined && receipt.diagnostic_code.includes('too_long'));
    throw new ImSendError(tooLong ? 'too_long' : receipt.diagnostic_code ?? receipt.error_kind ?? 'send_failed', receipt.message_ids, receipt.failed_part, receipt.status === 'unknown' ? 'unknown' : 'failed');
  }
  const ids = receipt.message_ids.filter((id) => id.length > 0);
  return { messageId: ids[0] ?? '', messageIds: ids };
}

function hubMediaCapabilities(session: SessionAdapter, supportsFile: boolean): readonly MessageMediaCapability[] {
  const declared = realtimeCapability(session.platform);
  if (declared !== undefined) return declared.outbound.filter((kind) => kind !== 'text').map((kind) => ({
    kind,
    mimeTypes: kind === 'file' ? undefined : [`${kind}/*`],
    maxBytes: (kind === 'image' ? session.limits.image_bytes : session.limits.file_bytes) ?? undefined,
    rendering: kind === 'audio' ? declared.audio_rendering : undefined,
  }));
  const image: MessageMediaCapability = { kind: 'image', mimeTypes: ['image/*'], maxBytes: session.limits.image_bytes ?? undefined };
  if (!supportsFile) return [image, { kind: 'voice', mimeTypes: ['audio/*'], rendering: 'native_voice' }];
  const fileBytes = session.limits.file_bytes ?? undefined;
  const voiceMime = session.limits.voice_mime;
  return [
    { kind: 'file', maxBytes: fileBytes }, image,
    ...(voiceMime === null || voiceMime.length === 0 ? [] : [{ kind: 'voice', mimeTypes: voiceMime.map((mime) => mime.toLowerCase()), maxBytes: fileBytes, rendering: 'native_voice' }]),
  ];
}

function realtimeCapability(platform: SessionPlatformId) {
  return platform === 'discord' || platform === 'slack' || platform === 'matrix' ? SESSION_CAPABILITIES[platform] : undefined;
}

function isSessionMediaKind(kind: string): kind is 'file' | 'image' | 'audio' | 'voice' | 'video' {
  return kind === 'file' || kind === 'image' || kind === 'audio' || kind === 'voice' || kind === 'video';
}

export function mimeAllowed(capability: MessageMediaCapability, mediaType: string): boolean {
  if (capability.mimeTypes === undefined) return true;
  const actual = mediaType.toLowerCase();
  return capability.mimeTypes.some((mime) => mime === actual || (mime.endsWith('/*') && actual.startsWith(mime.slice(0, -1))));
}
