import type { ImProviderKind } from '@kiki/protocol';
import type { MessageMediaCapability } from '@kiki/agent-core-v2/app/bot/messageRouting';

import {
  acceptsTelegramVoice,
  ImSendError,
  type ImAdapterFactory,
  type ImInboundEvent,
  type ImInboundIdentity,
  type ImMediaReceipt,
  type ImOutboundFile,
  type ImOutboundMedia,
  type ImOutboundText,
  type ImSessionAdapter,
} from './adapter';
import { mimeAllowed } from './hubAdapter';
import { segmentText } from './segment';

export class FakeImAdapter implements ImSessionAdapter {
  readonly sent: ImOutboundText[] = [];
  readonly edits: (ImOutboundText & { readonly messageId: string })[] = [];
  readonly files: (ImOutboundFile & { readonly deliveredAs: 'file' | 'image' | 'voice' })[] = [];
  readonly callbacks: string[] = [];
  started = 0;
  stopped = 0;
  conflict: 'webhook' | 'none' = 'none';
  failFile = false;
  failEdit = false;
  emptyMessageId = false;
  tooLongOnReply = false;
  splitOverride: ((text: string) => readonly string[]) | undefined;
  supportsEdit = true;
  supportsButtons = true;
  supportsFile = true;
  badVoiceFormat = false;
  textLimit: number | undefined = 4096;
  maxInboundBytes = 20 * 1024 * 1024;
  voice = true;
  private listener: ((event: ImInboundEvent) => Promise<void>) | undefined;
  private sequence = 0;

  constructor(readonly providerKind: ImProviderKind, readonly accountId: string) {}

  get mediaCapabilities(): readonly MessageMediaCapability[] {
    const file = this.supportsFile ? [{ kind: 'file' }, { kind: 'audio', mimeTypes: ['audio/*'] }, { kind: 'video', mimeTypes: ['video/*'] }] : [];
    const voice = this.supportsFile && this.voice && !this.badVoiceFormat
      ? [{ kind: 'voice', mimeTypes: ['audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/mp3'] }]
      : [];
    return [...file, { kind: 'image', mimeTypes: ['image/*'] }, ...voice];
  }

  async sendMedia(message: ImOutboundMedia): Promise<ImMediaReceipt> {
    const capability = this.mediaCapabilities.find((item) => item.kind === message.kind);
    if (capability === undefined || !mimeAllowed(capability, message.mediaType)) return { status: 'unsupported', unsupported: [message.kind] };
    try {
      const sent = await this.sendFile({
        identity: message.identity, name: message.name, mediaType: message.mediaType, bytes: message.bytes,
        asVoice: message.kind === 'voice', asImage: message.kind === 'image',
      });
      return { status: 'delivered', messageIds: [sent.messageId] };
    } catch (error) {
      return error instanceof ImSendError ? { status: error.outcome, messageIds: error.acceptedIds, detail: error.message } : { status: 'unknown', detail: 'send_failed' };
    }
  }

  acceptsVoice(mediaType: string): boolean {
    return (this.voice || this.badVoiceFormat) && acceptsTelegramVoice(mediaType);
  }

  splitText(text: string): readonly string[] {
    return this.splitOverride?.(text) ?? segmentText(text, this.textLimit);
  }

  describeConflict(): Promise<'webhook' | 'none'> {
    return Promise.resolve(this.conflict);
  }

  start(listener: (event: ImInboundEvent) => Promise<void>): Promise<{ accountId: string; conflict?: 'webhook' }> {
    this.started += 1;
    this.listener = listener;
    return Promise.resolve(this.conflict === 'webhook' ? { accountId: this.accountId, conflict: 'webhook' } : { accountId: this.accountId });
  }

  stop(): Promise<void> {
    this.stopped += 1;
    this.listener = undefined;
    return Promise.resolve();
  }

  emit(event: ImInboundEvent): Promise<void> {
    if (this.listener === undefined) return Promise.reject(new Error('not_listening'));
    return this.listener(event);
  }

  sendText(message: ImOutboundText): Promise<{ messageId: string; messageIds: readonly string[] }> {
    if (this.tooLongOnReply && message.code === 'reply') return Promise.reject(new Error('too_long'));
    const messageId = this.emptyMessageId ? '' : `m${++this.sequence}`;
    this.sent.push(message);
    return Promise.resolve({ messageId, messageIds: messageId.length > 0 ? [messageId] : [] });
  }

  async sendTextParts(message: { identity: ImInboundIdentity; parts: readonly string[]; code: string }): Promise<{ messageId: string; messageIds: readonly string[] }> {
    const ids: string[] = [];
    for (let index = 0; index < message.parts.length; index += 1) {
      try {
        const sent = await this.sendText({ identity: message.identity, text: message.parts[index] ?? '', code: message.code });
        ids.push(...(sent.messageIds.length > 0 ? sent.messageIds : []));
      } catch (error) {
        const tooLong = error instanceof Error && error.message === 'too_long';
        throw new ImSendError(tooLong ? 'too_long' : error instanceof Error ? error.message : 'send_failed', ids, index);
      }
    }
    return { messageId: ids[0] ?? '', messageIds: ids };
  }

  editText(message: ImOutboundText & { messageId: string }): Promise<{ messageId: string; edited: boolean }> {
    this.edits.push(message);
    return Promise.resolve({ messageId: message.messageId, edited: !this.failEdit });
  }

  sendFile(message: ImOutboundFile): Promise<{ messageId: string; deliveredAs: 'file' | 'image' | 'voice' }> {
    if (message.asVoice && this.badVoiceFormat) return Promise.reject(new Error('bad_format'));
    if (!this.supportsFile && !message.asImage && !message.asVoice) return Promise.reject(new Error('unsupported_file'));
    if (this.failFile) return Promise.reject(new Error('file_failed'));
    const deliveredAs = message.asVoice && this.acceptsVoice(message.mediaType) ? 'voice' : message.asImage ? 'image' : 'file';
    const messageId = `f${++this.sequence}`;
    this.files.push({ ...message, deliveredAs });
    return Promise.resolve({ messageId, deliveredAs });
  }

  answerCallback(callbackQueryId: string): Promise<void> {
    this.callbacks.push(callbackQueryId);
    return Promise.resolve();
  }
}

export function fakeAdapterFactory(adapter: FakeImAdapter): ImAdapterFactory {
  return { providerKind: adapter.providerKind, mediaCapabilities: () => adapter.mediaCapabilities, create: () => adapter };
}
