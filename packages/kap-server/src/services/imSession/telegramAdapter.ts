import { acceptsTelegramVoice, type ImHttpTransport, type ImInboundEvent, type ImOutboundFile, type ImOutboundText, type ImSessionAdapter } from './adapter';

const TELEGRAM_TEXT_LIMIT = 4096;

interface TelegramMessage {
  readonly message_id?: number;
  readonly text?: string;
  readonly caption?: string;
  readonly chat?: { readonly id?: number; readonly title?: string };
  readonly from?: { readonly id?: number; readonly first_name?: string; readonly username?: string };
  readonly message_thread_id?: number;
  readonly photo?: readonly { readonly file_id?: string; readonly file_size?: number }[];
  readonly document?: { readonly file_id?: string; readonly file_name?: string; readonly mime_type?: string; readonly file_size?: number };
  readonly voice?: { readonly file_id?: string; readonly mime_type?: string; readonly file_size?: number };
  readonly audio?: { readonly file_id?: string; readonly mime_type?: string; readonly file_name?: string; readonly file_size?: number };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class TelegramPollingAdapter implements ImSessionAdapter {
  readonly providerKind = 'telegram' as const;
  readonly textLimit = TELEGRAM_TEXT_LIMIT;
  readonly maxInboundBytes: number;
  private running = false;
  private offset = 0;
  private methods: string[] = [];

  constructor(private readonly transport: ImHttpTransport, maxInboundBytes = 20 * 1024 * 1024, private readonly pollTimeout = 0) {
    this.maxInboundBytes = maxInboundBytes;
  }

  calledMethods(): readonly string[] {
    return this.methods;
  }

  acceptsVoice(mediaType: string): boolean {
    return acceptsTelegramVoice(mediaType);
  }

  async describeConflict(): Promise<'webhook' | 'none'> {
    const body = await this.call('getWebhookInfo', {});
    const result = asRecord(body['result']);
    const url = result?.['url'];
    return typeof url === 'string' && url.length > 0 ? 'webhook' : 'none';
  }

  async start(listener: (event: ImInboundEvent) => Promise<void>, options?: { readonly offset?: number }): Promise<{ accountId: string; conflict?: 'webhook' }> {
    const me = asRecord((await this.call('getMe', {}))['result']);
    const id = me?.['id'];
    if (!Number.isSafeInteger(id)) throw new Error('telegram_identity_failed');
    if (await this.describeConflict() === 'webhook') return { accountId: String(id), conflict: 'webhook' };
    this.offset = options?.offset ?? 0;
    this.running = true;
    void this.poll(listener);
    return { accountId: String(id) };
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async sendText(message: ImOutboundText): Promise<{ messageId: string }> {
    const result = await this.call('sendMessage', {
      chat_id: message.identity.chatId,
      message_thread_id: message.identity.topicId === '0' ? undefined : Number(message.identity.topicId),
      text: message.text,
      reply_markup: message.buttons === undefined ? undefined : { inline_keyboard: [message.buttons.map((button) => ({ text: button.label, callback_data: button.id }))] },
    });
    return { messageId: messageIdOf(result) };
  }

  async editText(message: ImOutboundText & { messageId: string }): Promise<{ messageId: string; edited: boolean }> {
    try {
      await this.call('editMessageText', { chat_id: message.identity.chatId, message_id: Number(message.messageId), text: message.text });
      return { messageId: message.messageId, edited: true };
    } catch {
      const sent = await this.sendText(message);
      return { messageId: sent.messageId, edited: false };
    }
  }

  async sendFile(message: ImOutboundFile): Promise<{ messageId: string; deliveredAs: 'file' | 'image' | 'voice' }> {
    const method = message.asVoice ? 'sendVoice' : message.asImage ? 'sendPhoto' : 'sendDocument';
    const result = await this.call(method, {
      chat_id: message.identity.chatId,
      message_thread_id: message.identity.topicId === '0' ? undefined : Number(message.identity.topicId),
      name: message.name,
      media_type: message.mediaType,
      size: message.bytes.byteLength,
    });
    return { messageId: messageIdOf(result), deliveredAs: message.asVoice ? 'voice' : message.asImage ? 'image' : 'file' };
  }

  async answerCallback(callbackQueryId: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId });
  }

  private async poll(listener: (event: ImInboundEvent) => Promise<void>): Promise<void> {
    while (this.running) {
      let body: Record<string, unknown>;
      try {
        body = await this.call('getUpdates', { offset: this.offset, timeout: this.pollTimeout, limit: 100 });
      } catch {
        if (!this.running) return;
        continue;
      }
      const updates = Array.isArray(body['result']) ? body['result'] : [];
      if (updates.length === 0) {
        if (!this.running || this.pollTimeout === 0) return;
        continue;
      }
      for (const raw of updates) {
        const update = asRecord(raw);
        const updateId = update?.['update_id'];
        if (!Number.isSafeInteger(updateId)) continue;
        const event = await this.mapUpdate(update!, updateId as number);
        if (event !== undefined) await listener(event);
        this.offset = (updateId as number) + 1;
      }
    }
  }

  private async mapUpdate(update: Record<string, unknown>, updateId: number): Promise<ImInboundEvent | undefined> {
    const callback = asRecord(update['callback_query']);
    if (callback !== undefined) {
      const from = asRecord(callback['from']);
      const message = asRecord(callback['message']);
      const chat = asRecord(message?.['chat']);
      return {
        eventId: String(updateId),
        cursor: updateId,
        kind: 'callback',
        callbackData: typeof callback['data'] === 'string' ? callback['data'] : '',
        callbackQueryId: typeof callback['id'] === 'string' ? callback['id'] : undefined,
        identity: identityOf(chat, from, message),
        preview: '',
      };
    }
    const message = asRecord(update['message']) as TelegramMessage | undefined;
    if (message === undefined) return undefined;
    const chat = asRecord(message.chat);
    const from = asRecord(message.from);
    const identity = identityOf(chat, from, asRecord(message));
    const base = { eventId: String(updateId), cursor: updateId, identity };
    const photo = [...(message.photo ?? [])].sort((left, right) => (right.file_size ?? 0) - (left.file_size ?? 0))[0];
    if (photo?.file_id !== undefined) return this.mediaEvent(base, 'image', photo.file_id, 'photo.jpg', 'image/jpeg', photo.file_size, message.caption);
    if (message.document?.file_id !== undefined) return this.mediaEvent(base, 'file', message.document.file_id, message.document.file_name ?? 'file', message.document.mime_type ?? 'application/octet-stream', message.document.file_size, message.caption);
    const voice = message.voice ?? message.audio;
    if (voice?.file_id !== undefined) return this.mediaEvent(base, 'audio', voice.file_id, message.audio?.file_name ?? 'voice.ogg', voice.mime_type ?? 'audio/ogg', voice.file_size);
    return { ...base, kind: 'text', text: message.text ?? '', preview: (message.text ?? '').slice(0, 80) };
  }

  private async mediaEvent(base: Pick<ImInboundEvent, 'eventId' | 'cursor' | 'identity'>, kind: 'image' | 'file' | 'audio', fileId: string, name: string, mediaType: string, fileSize: number | undefined, caption?: string): Promise<ImInboundEvent> {
    if (fileSize !== undefined && fileSize > this.maxInboundBytes) {
      return { ...base, kind, tooLarge: true, preview: name, text: caption };
    }
    const file = asRecord((await this.call('getFile', { file_id: fileId }))['result']);
    const path = file?.['file_path'];
    if (typeof path !== 'string') return { ...base, kind, tooLarge: true, preview: name, text: caption };
    const bytes = await this.transport.download(path);
    return { ...base, kind, text: caption, preview: caption?.slice(0, 80) ?? name, media: { name, mediaType, bytes } };
  }

  private async call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.methods.push(method);
    const response = await this.transport.call(method, body);
    const record = asRecord(response.body);
    if (response.status >= 400 || record?.['ok'] === false) throw new Error(`telegram_${method}_failed`);
    return record ?? {};
  }
}

function identityOf(chat: Record<string, unknown> | undefined, from: Record<string, unknown> | undefined, message: Record<string, unknown> | undefined): ImInboundEvent['identity'] {
  const topic = message?.['message_thread_id'];
  return {
    chatId: String(chat?.['id'] ?? ''),
    senderId: String(from?.['id'] ?? ''),
    topicId: Number.isSafeInteger(topic) ? String(topic) : '0',
    chatTitle: typeof chat?.['title'] === 'string' ? chat['title'] : undefined,
    senderName: typeof from?.['username'] === 'string' ? from['username'] : typeof from?.['first_name'] === 'string' ? from['first_name'] : undefined,
  };
}

function messageIdOf(body: Record<string, unknown>): string {
  const result = asRecord(body['result']);
  const id = result?.['message_id'];
  if (!Number.isSafeInteger(id)) throw new Error('telegram_message_id_missing');
  return String(id);
}

export function telegramAdapterFactory(transportFor: (credential: string) => ImHttpTransport, pollTimeout = 25): { providerKind: 'telegram'; create(input: { instanceId: string; credential: string }): ImSessionAdapter } {
  return { providerKind: 'telegram', create: ({ credential }) => new TelegramPollingAdapter(transportFor(credential), 20 * 1024 * 1024, pollTimeout) };
}
