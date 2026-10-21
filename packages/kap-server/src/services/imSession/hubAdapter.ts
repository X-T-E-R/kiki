import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ImProviderKind } from '@kiki/protocol';
import {
  createSessionHub,
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
} from '@nb-im/core';

import type { ImAdapterFactory, ImInboundEvent, ImInboundIdentity, ImOutboundFile, ImOutboundText, ImSessionAdapter } from './adapter';

export function fileCursorStore(homeDir: string): SessionCursorStore {
  const file = join(homeDir, 'im-session-cursors.json');
  let chain = Promise.resolve();
  const read = async (): Promise<Record<string, string>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return {};
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') values[key] = value;
      return values;
    } catch {
      return {};
    }
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
        await writeFile(file, JSON.stringify(values), 'utf8');
      });
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

export function sessionSpec(kind: ImProviderKind, instanceId: string, credential: string): SessionSpec {
  if (kind === 'telegram') return { platform: 'telegram', instance_id: instanceId, token: credential.trim() };
  if (kind === 'feishu_app') {
    const [appId, appSecret] = credential.split('\n');
    return { platform: 'feishu_app', instance_id: instanceId, app_id: appId?.trim() ?? '', app_secret: appSecret?.trim() ?? '' };
  }
  if (kind === 'wechat_bridge') {
    const [token, account] = credential.split('\n');
    const accountId = account?.trim() ?? '';
    return { platform: 'personal_wechat', instance_id: instanceId, token: token?.trim() ?? '', ...(accountId.length > 0 ? { account_id: accountId } : {}) };
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

export function hubSessionFactories(hub: SessionHub): ImAdapterFactory[] {
  const kinds: readonly ImProviderKind[] = ['telegram', 'feishu_app', 'onebot_v11', 'wechat_bridge'];
  return kinds.map((providerKind) => ({
    providerKind,
    create: (input) => new HubSessionAdapter(hub.acquire(sessionSpec(providerKind, input.instanceId, input.credential))),
  }));
}

export function loadHubFactories(homeDir: string): ImAdapterFactory[] {
  return hubSessionFactories(createSessionHub({ store: fileCursorStore(homeDir) }));
}

export class HubSessionAdapter implements ImSessionAdapter {
  readonly canonicalInstanceId: string;
  readonly providerKind: ImProviderKind;
  readonly textLimit: number | undefined;
  readonly maxInboundBytes: number;
  readonly supportsEdit: boolean;
  readonly supportsButtons: boolean;
  readonly supportsFile: boolean;
  private ack: string | undefined;
  private readonly contexts = new Map<string, { reply_context?: string; chat_kind?: SessionChatKind }>();

  constructor(private readonly session: SessionAdapter) {
    this.canonicalInstanceId = session.instance_id;
    this.providerKind = providerKindOf(session.platform);
    this.textLimit = session.limits.text_characters ?? undefined;
    this.maxInboundBytes = session.platform === 'telegram' ? TELEGRAM_DOWNLOAD_BYTES : session.limits.file_bytes ?? 50 * 1024 * 1024;
    const editable = session.platform === 'telegram' || session.platform === 'feishu_app';
    this.supportsEdit = editable;
    this.supportsButtons = editable;
    this.supportsFile = session.platform !== 'qq_onebot_v11';
  }

  describeConflict(): Promise<'webhook' | 'none'> {
    return Promise.resolve('none');
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
    return { accountId };
  }

  stop(): Promise<void> {
    return this.session.stop();
  }

  async sendText(message: ImOutboundText): Promise<{ messageId: string }> {
    const target = this.target(message.identity);
    const buttons = message.buttons?.map((button) => ({ data: button.id, label: button.label }));
    if (this.session.platform === 'feishu_app') {
      const parts = splitFeishuText(message.text);
      if (parts.length > 1) {
        const first = await this.session.send({ type: 'text', target, text: parts[0] ?? '', ...(buttons !== undefined && buttons.length > 0 ? { buttons } : {}) });
        const rest = await this.session.send({ type: 'text_parts', target, parts: parts.slice(1) });
        if (rest.status !== 'accepted') throw receiptError(rest);
        return { messageId: acceptedId(first) };
      }
    }
    const sent = await this.session.send({ type: 'text', target, text: message.text, ...(buttons !== undefined && buttons.length > 0 ? { buttons } : {}) });
    return { messageId: acceptedId(sent) };
  }

  async editText(message: ImOutboundText & { readonly messageId: string }): Promise<{ messageId: string; edited: boolean }> {
    const sent = await this.session.send({ type: 'edit_text', target: this.target(message.identity), message_id: message.messageId, text: message.text });
    if (sent.error_kind === 'unsupported') return { messageId: message.messageId, edited: false };
    return { messageId: acceptedId(sent), edited: true };
  }

  async sendFile(message: ImOutboundFile): Promise<{ messageId: string; deliveredAs: 'file' | 'image' | 'voice' }> {
    const kind = message.asVoice ? 'voice' : message.asImage ? 'image' : 'file';
    const sent = await this.session.send({
      type: 'media',
      target: this.target(message.identity),
      media: { kind, filename: message.name, mime: message.mediaType, bytes: message.bytes },
    });
    if (message.asVoice && sent.error_kind === 'bad_format') throw new Error('bad_format');
    if (sent.error_kind === 'unsupported') throw new Error('unsupported_file');
    const deliveredAs = message.asVoice && this.acceptsVoice(message.mediaType) ? 'voice' : message.asImage ? 'image' : 'file';
    return { messageId: acceptedId(sent), deliveredAs };
  }

  answerCallback(_callbackQueryId: string): Promise<void> {
    this.ack = 'ok';
    return Promise.resolve();
  }

  private toEvent(event: SessionInbound): ImInboundEvent {
    const identity: ImInboundIdentity = {
      chatId: event.identity.chat_id,
      senderId: event.identity.sender_id,
      topicId: event.identity.topic_id,
    };
    const key = contextKey(identity);
    const previous = this.contexts.get(key);
    const replyContext = event.reply_context ?? previous?.reply_context;
    const chatKind = event.identity.chat_kind ?? previous?.chat_kind;
    if (replyContext !== undefined || chatKind !== undefined) {
      this.contexts.set(key, { ...(replyContext === undefined ? {} : { reply_context: replyContext }), ...(chatKind === undefined ? {} : { chat_kind: chatKind }) });
    }
    const payload = event.payload;
    if (payload.type === 'text') return { eventId: event.event_key, identity, kind: 'text', text: payload.text, preview: payload.text.slice(0, 80) };
    if (payload.type === 'callback') return { eventId: event.event_key, identity, kind: 'callback', callbackData: payload.data, callbackQueryId: payload.callback_id };
    if (payload.type === 'media_unavailable') return { eventId: event.event_key, identity, kind: payload.kind === 'voice' ? 'audio' : payload.kind, tooLarge: true, text: '' };
    const kind = payload.media.kind === 'voice' ? 'audio' as const : payload.media.kind;
    return {
      eventId: event.event_key, identity, kind, text: payload.caption ?? '', ...(payload.caption === undefined ? {} : { preview: payload.caption.slice(0, 80) }),
      media: { name: payload.media.filename, mediaType: payload.media.mime, bytes: payload.media.bytes },
    };
  }

  private target(identity: ImInboundIdentity): Extract<SessionOutbound, { type: 'text' }>['target'] {
    const saved = this.contexts.get(contextKey(identity));
    return {
      chat_id: identity.chatId,
      ...(identity.topicId === '0' ? {} : { topic_id: identity.topicId }),
      ...(saved?.reply_context === undefined ? {} : { reply_context: saved.reply_context }),
      ...(saved?.chat_kind === undefined ? {} : { chat_kind: saved.chat_kind }),
    };
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

function contextKey(identity: ImInboundIdentity): string {
  return `${identity.chatId}\u0000${identity.senderId}\u0000${identity.topicId}`;
}

function acceptedId(receipt: SessionReceipt): string {
  if (receipt.status !== 'accepted') throw receiptError(receipt);
  const id = receipt.message_ids[0];
  if (id === undefined || id.length === 0) throw new Error('missing_message_id');
  return id;
}

function receiptError(receipt: SessionReceipt): Error {
  return new Error(receipt.diagnostic_code ?? receipt.error_kind ?? 'send_failed');
}
