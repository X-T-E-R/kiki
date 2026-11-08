import { z } from 'zod';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const SEND_MESSAGE_SECTION = 'sendMessage';

export const SendMessageVoiceModeSchema = z.enum(['none', 'append', 'only']);

export type SendMessageVoiceMode = z.infer<typeof SendMessageVoiceModeSchema>;

export const SendMessageConfigSchema = z
  .object({
    voiceMode: SendMessageVoiceModeSchema.default('none'),
    ttsProvider: z.string().min(1).optional(),
    ttsModel: z.string().min(1).optional(),
    ttsVoice: z.string().min(1).optional(),
    ttsLanguage: z.string().min(1).optional(),
    ttsFormat: z.string().min(1).optional(),
    ttsSampleRateHz: z.number().int().positive().optional(),
    ttsOptions: z.record(z.string(), z.unknown()).optional(),
    ffmpegPath: z.string().min(1).optional(),
  })
  .strict();

export type SendMessageConfig = z.infer<typeof SendMessageConfigSchema>;

registerConfigSection(SEND_MESSAGE_SECTION, SendMessageConfigSchema, {
  defaultValue: { voiceMode: 'none' },
});
