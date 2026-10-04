import { z } from 'zod';

export const webAccessEnableInputSchema = z.object({
  mode: z.enum(['temporary', 'persistent']),
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(0).max(65535).optional(),
  publicUrl: z.string().url().max(2048).optional(),
  insecureNoTls: z.boolean().optional(),
}).strict();
export type WebAccessEnableInput = z.infer<typeof webAccessEnableInputSchema>;
export const webSessionSummarySchema = z.object({
  id: z.string().uuid(), label: z.string(), createdAt: z.number(), lastUsedAt: z.number(), expiresAt: z.number(),
});
export type WebSessionSummary = z.infer<typeof webSessionSummarySchema>;
export const webAccessStatusSchema = z.object({
  enabled: z.boolean(), mode: z.enum(['temporary', 'persistent']).nullable(),
  url: z.string().nullable(), expiresAt: z.number().nullable(),
  host: z.string().nullable(), port: z.number().nullable(), insecure: z.boolean(),
  sessions: z.array(webSessionSummarySchema),
});
export type WebAccessStatus = z.infer<typeof webAccessStatusSchema>;
export const webAccessLinkSchema = z.object({ url: z.string(), expiresAt: z.number() });
export type WebAccessLink = z.infer<typeof webAccessLinkSchema>;
export const webAccessExchangeInputSchema = z.object({ code: z.string().min(32).max(128), label: z.string().max(128).optional() }).strict();
export type WebAccessExchangeInput = z.infer<typeof webAccessExchangeInputSchema>;
export const webAccessSessionSchema = z.object({ authenticated: z.boolean(), session: webSessionSummarySchema.nullable() });
export type WebAccessSession = z.infer<typeof webAccessSessionSchema>;
