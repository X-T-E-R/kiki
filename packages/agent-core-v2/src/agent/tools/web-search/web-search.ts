import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';
import { NativeSearchInputSchema, type NativeSearchInput } from '#/app/nbSearch/nativeInput';

export const WebSearchInputSchema: typeof NativeSearchInputSchema = NativeSearchInputSchema;
export type WebSearchInput = NativeSearchInput;

export interface IWebSearchTool extends AgentTool<WebSearchInput> {
  readonly _serviceBrand: undefined;
}
export const IWebSearchTool = createDecorator<IWebSearchTool>('webSearchTool');
