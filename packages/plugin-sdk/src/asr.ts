import { z } from 'zod';

import type { MediaConnection } from './media.js';

export const asrProviderDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  label: z.string().min(1),
  description: z.string().optional(),
  connectionSetting: z.string().min(1).optional(),
}).strict();

export const asrTranscribeInputSchema = z.object({
  wavPath: z.string().min(1),
  originalPath: z.string().min(1).optional(),
  mediaType: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
}).strict();

export const asrTranscribeResultSchema = z.object({
  text: z.string(),
  language: z.string().min(1).optional(),
}).strict();

export const asrProviderRegistrationSchema = z.object({
  pluginId: z.string().min(1),
  definition: asrProviderDefinitionSchema,
}).strict();

export const asrProvidersSchema = z.array(asrProviderRegistrationSchema);

export type AsrProviderDefinition = z.infer<typeof asrProviderDefinitionSchema>;
export type AsrTranscribeInput = z.infer<typeof asrTranscribeInputSchema>;
export type AsrTranscribeResult = z.infer<typeof asrTranscribeResultSchema>;
export type AsrProviderRegistration = z.infer<typeof asrProviderRegistrationSchema>;

export interface AsrProviderContext {
  readonly signal: AbortSignal;
  readonly settings: Readonly<Record<string, unknown>>;
  connection(): Promise<MediaConnection | undefined>;
}

export interface AsrProviderAdapter {
  transcribe(input: AsrTranscribeInput, context: AsrProviderContext): Promise<AsrTranscribeResult>;
}
