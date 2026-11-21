import { z } from 'zod';

export const runtimeBindingResponseSchema = /* @__PURE__ */ z.object({
  workspace_id: z.string(),
  runtime_id: z.string(),
});

export const switchRuntimeRequestSchema = /* @__PURE__ */ z.object({
  runtime_id: z.string().min(1),
});

export const sessionRuntimeParamsSchema = /* @__PURE__ */ z.object({
  session_id: z.string().min(1),
});

export type RuntimeBindingResponse = z.infer<typeof runtimeBindingResponseSchema>;
