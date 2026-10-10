import { createDecorator } from '#/_base/di/instantiation';
import type { CognitionSlot } from '#/agent/cognition/cognitionFiles';

export interface IModelPromptReader {
  readonly _serviceBrand: undefined;
  read(slot: CognitionSlot, refs: readonly string[]): Promise<Array<{ path: string; text: string }>>;
}

export const IModelPromptReader = createDecorator<IModelPromptReader>('modelPromptReader');
