import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';
import { NativeFetchInputSchema, type NativeFetchInput } from '#/app/nbSearch/nativeInput';

export const FetchURLInputSchema: typeof NativeFetchInputSchema = NativeFetchInputSchema;
export type FetchURLInput = NativeFetchInput;

export interface IFetchURLTool extends AgentTool<FetchURLInput> {
  readonly _serviceBrand: undefined;
}
export const IFetchURLTool = createDecorator<IFetchURLTool>('fetchURLTool');
