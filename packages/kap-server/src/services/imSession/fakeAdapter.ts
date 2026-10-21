import type { ImProviderKind } from '@kiki/protocol';

import {
  acceptsTelegramVoice,
  type ImAdapterFactory,
  type ImInboundEvent,
  type ImOutboundFile,
  type ImOutboundText,
  type ImSessionAdapter,
} from './adapter';
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
  return { providerKind: adapter.providerKind, create: () => adapter };
}
