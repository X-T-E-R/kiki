import { z } from 'zod';

export const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-same-origin';

export const htmlPreviewRequestSchema = z.object({
  path: z.string().min(1).optional(),
  root: z.string().min(1).optional(),
  workspace_root: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  file_id: z.string().min(1).optional(),
  source_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
}).strict();
export type HtmlPreviewRequest = z.infer<typeof htmlPreviewRequestSchema>;

export const htmlPreviewResponseSchema = z.object({
  preview_id: z.string(),
  url: z.string(),
  expires_at: z.number(),
  sandbox: z.literal(HTML_PREVIEW_SANDBOX),
});
export type HtmlPreviewResponse = z.infer<typeof htmlPreviewResponseSchema>;
