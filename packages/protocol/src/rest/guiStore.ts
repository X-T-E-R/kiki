import { z } from 'zod';

const keySchema = /* @__PURE__ */ z.string().min(1).max(256);

export const guiStoreGetItemQuerySchema = /* @__PURE__ */ z.object({ key: keySchema });

export const guiStoreSetItemBodySchema = /* @__PURE__ */ z.object({
  key: keySchema,
  value: z.string(),
});

export const guiStoreRemoveItemBodySchema = /* @__PURE__ */ z.object({ key: keySchema });

export const guiStoreGetItemResponseSchema = /* @__PURE__ */ z.object({
  value: z.string().nullable(),
});
export type GuiStoreGetItemResponse = z.infer<typeof guiStoreGetItemResponseSchema>;

export const guiStoreLengthResponseSchema = /* @__PURE__ */ z.object({
  length: z.number(),
});
export type GuiStoreLengthResponse = z.infer<typeof guiStoreLengthResponseSchema>;
