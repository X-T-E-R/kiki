import { createDecorator } from '#/_base/di/instantiation';
import type { BoardClient } from './boardContract';

export * from './boardContract';

export interface ITaskBoardService extends BoardClient {
  readonly _serviceBrand: undefined;
}

export const ITaskBoardService = createDecorator<ITaskBoardService>('taskBoardService');
