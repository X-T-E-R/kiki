import type { ImProviderKind } from '@kiki/protocol';

export interface ImInboundIdentity {
  readonly chatId: string;
  readonly senderId: string;
  readonly topicId: string;
  readonly chatTitle?: string;
  readonly senderName?: string;
  readonly topicTitle?: string;
}

export interface ImInboundMedia {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface ImInboundEvent {
  readonly eventId: string;
  readonly cursor?: number;
  readonly identity: ImInboundIdentity;
  readonly kind: 'text' | 'image' | 'file' | 'audio' | 'callback';
  readonly text?: string;
  readonly callbackData?: string;
  readonly callbackQueryId?: string;
  readonly media?: ImInboundMedia;
  readonly tooLarge?: boolean;
  readonly preview?: string;
}

export interface ImOutboundText {
  readonly identity: ImInboundIdentity;
  readonly text: string;
  readonly code: string;
  readonly messageId?: string;
  readonly buttons?: readonly { readonly id: string; readonly label: string }[];
}

export interface ImOutboundFile {
  readonly identity: ImInboundIdentity;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly asVoice: boolean;
  readonly asImage: boolean;
}

export interface ImSessionAdapter {
  readonly providerKind: ImProviderKind;
  readonly textLimit: number | undefined;
  readonly maxInboundBytes: number;
  describeConflict(): Promise<'webhook' | 'none'>;
  acceptsVoice(mediaType: string): boolean;
  start(listener: (event: ImInboundEvent) => Promise<void>, options?: { readonly offset?: number }): Promise<{ readonly accountId: string; readonly conflict?: 'webhook' }>;
  stop(): Promise<void>;
  sendText(message: ImOutboundText): Promise<{ readonly messageId: string }>;
  editText(message: ImOutboundText & { readonly messageId: string }): Promise<{ readonly messageId: string; readonly edited: boolean }>;
  sendFile(message: ImOutboundFile): Promise<{ readonly messageId: string; readonly deliveredAs: 'file' | 'image' | 'voice' }>;
  answerCallback(callbackQueryId: string): Promise<void>;
}

export interface ImAdapterFactory {
  readonly providerKind: ImProviderKind;
  create(input: { readonly instanceId: string; readonly credential: string }): ImSessionAdapter;
}

export interface ImHttpTransport {
  call(method: string, body: Record<string, unknown>): Promise<{ readonly status: number; readonly body: unknown }>;
  download(filePath: string): Promise<Uint8Array>;
}

const VOICE_TYPES = new Set(['audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/mp3']);

export function acceptsTelegramVoice(mediaType: string): boolean {
  return VOICE_TYPES.has(mediaType.toLowerCase());
}
