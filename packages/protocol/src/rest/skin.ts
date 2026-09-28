/**
 * Read-only REST surface for user skin files in `<KIKI_HOME>/themes/`.
 *
 * Read-only on purpose: the GUI never writes a user's theme directory. The
 * settings editor exports a file for the user to drop in themselves, and the
 * server only ever lists and reads.
 */

import { z } from 'zod';

import { skinFileSchema } from '../skin';

export const skinSummarySchema = z.object({
  /** Filename stem, and the id the GUI stores as the selected skin. */
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  /** Which variants the file declares. */
  variants: z.array(z.enum(['light', 'dark'])),
});
export type SkinSummary = z.infer<typeof skinSummarySchema>;

export const listSkinsResponseSchema = z.object({
  items: z.array(skinSummarySchema),
  /** Absolute themes directory, shown in settings so users can find it. */
  directory: z.string(),
  /** Per-file reasons a candidate was skipped, for the settings diagnostics. */
  skipped: z.array(z.object({ file: z.string(), reason: z.string() })),
});
export type ListSkinsResponse = z.infer<typeof listSkinsResponseSchema>;

export const getSkinResponseSchema = z.object({
  skin: skinFileSchema,
  /** Tokens dropped while parsing; the rest of the file still applied. */
  warnings: z.array(z.string()),
});
export type GetSkinResponse = z.infer<typeof getSkinResponseSchema>;

export const skinIdParamSchema = z.object({
  skin_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
});
