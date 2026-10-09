import { z } from 'zod';

export const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads';

export const htmlPreviewRequestSchema = z.object({
  path: z.string().min(1),
  root: z.string().min(1),
}).strict();
export type HtmlPreviewRequest = z.infer<typeof htmlPreviewRequestSchema>;

export const htmlPreviewResponseSchema = z.object({
  preview_id: z.string(),
  url: z.string(),
  expires_at: z.number(),
  sandbox: z.literal(HTML_PREVIEW_SANDBOX),
});
export type HtmlPreviewResponse = z.infer<typeof htmlPreviewResponseSchema>;
