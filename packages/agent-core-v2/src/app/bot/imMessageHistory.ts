import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { PluginImHistoryPage } from '@kiki/protocol';
import type { ImHistoryQuery, ImLocalHistoryPage } from '@kiki-dsh/im-bridge-core/imMessageHistory';

export type { ImHistoryEntry, ImHistoryQuery, ImLocalHistoryPage } from '@kiki-dsh/im-bridge-core/imMessageHistory';

export interface IImMessageHistoryReader {
  readonly _serviceBrand: undefined;
  read(sessionId: string, query: ImHistoryQuery): Promise<ImLocalHistoryPage | PluginImHistoryPage>;
}

export const IImMessageHistoryReader: ServiceIdentifier<IImMessageHistoryReader> =
  createDecorator<IImMessageHistoryReader>('imMessageHistoryReader');
