import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const BOT_SECTION = 'bot';

export const BotConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxHandoffsPerHour: z.number().int().min(1).max(10_000).default(30),
  roomBudget: z.number().int().min(1).max(10_000).default(12),
}).strict();

export type BotConfig = z.infer<typeof BotConfigSchema>;

registerConfigSection(BOT_SECTION, BotConfigSchema, {
  defaultValue: { enabled: false, maxHandoffsPerHour: 30, roomBudget: 12 },
});
