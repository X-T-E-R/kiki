import { createDecorator } from '#/_base/di/instantiation';
import type { ImMessageMetadata, MessageContent, PluginImHistoryPage } from '@kiki/protocol';

export interface ImHistoryEntry {
  readonly sequence: number;
  readonly eventId: string;
  readonly receivedAt: number;
  readonly metadata: ImMessageMetadata;
  readonly operation: 'create' | 'edit' | 'retract';
  readonly isSelf?: boolean;
  readonly sessionId: string;
  readonly timestamp?: number;
  readonly text: string;
  readonly truncated?: boolean;
  readonly content?: readonly MessageContent[];
  readonly media?: readonly { readonly kind: string; readonly name: string; readonly mediaType: string }[];
}

export interface ImHistoryQuery {
  readonly channel?: string;
  readonly topicId?: string;
  readonly cursor?: string;
  readonly keyword?: string;
  readonly senderId?: string;
  readonly before?: number;
  readonly limit?: number;
  readonly source?: 'local' | 'platform';
  readonly signal?: AbortSignal;
}

export interface ImLocalHistoryPage {
  readonly status: 'ok';
  readonly source: 'local';
  readonly messages: readonly Omit<ImHistoryEntry, 'sessionId' | 'content'>[];
  readonly nextCursor?: string;
  readonly coverage: 'received_only' | 'retention_limited';
  readonly end: 'reached' | 'more';
}

export interface IImMessageHistoryReader {
  readonly _serviceBrand: undefined;
  read(sessionId: string, query: ImHistoryQuery): Promise<ImLocalHistoryPage | PluginImHistoryPage>;
}

export const IImMessageHistoryReader = createDecorator<IImMessageHistoryReader>('imMessageHistoryReader');
