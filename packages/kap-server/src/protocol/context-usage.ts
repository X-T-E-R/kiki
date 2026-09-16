import { z } from 'zod';

/** Optional context-attribution extensions shared by the status and snapshot wire surfaces. */
export const contextBreakdownSchema = z.object({
  systemTokens: z.number().int().nonnegative(),
  toolsTokens: z.number().int().nonnegative(),
  messagesTokens: z.number().int().nonnegative(),
  estimated: z.literal(true),
});
export type ContextBreakdown = z.infer<typeof contextBreakdownSchema>;

export const restContextBreakdownSchema = z.object({
  system_tokens: z.number().int().nonnegative(),
  tools_tokens: z.number().int().nonnegative(),
  messages_tokens: z.number().int().nonnegative(),
  estimated: z.literal(true),
});
export type RestContextBreakdown = z.infer<typeof restContextBreakdownSchema>;

export function toRestContextBreakdown(value: ContextBreakdown): RestContextBreakdown {
  return {
    system_tokens: value.systemTokens,
    tools_tokens: value.toolsTokens,
    messages_tokens: value.messagesTokens,
    estimated: true,
  };
}
