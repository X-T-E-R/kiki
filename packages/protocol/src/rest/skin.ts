/**
 * Read-only REST surface for the GUI skins the server knows about: user skin
 * files in `<KIKI_HOME>/themes/`, plus themes contributed by enabled plugins.
 *
 * Read-only on purpose: the GUI never writes a user's theme directory. The
 * settings editor exports a file for the user to drop in themselves, and the
 * server only ever lists and reads.
 */

import { z } from 'zod';

import { skinFileSchema } from '../skin';

/**
 * A skin file's id: its filename stem. Only these ids can name a file in the
 * themes directory, so only these ids ever reach the filesystem.
 */
export const SKIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The id of a skin contributed by an installed plugin: `<plugin id>:<theme id>`.
 * Neither component can contain `:`, so the join is unambiguous, and plugin ids
 * may carry `_` while theme ids (slugs) may not. Plugin skins never touch the
 * themes directory: they resolve through the plugin the server already loaded.
 */
export const PLUGIN_SKIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}:[a-z0-9][a-z0-9-]{0,63}$/;

/** Provenance of a skin the server did not read from the themes directory. */
export const skinPluginOriginSchema = z.object({
  /** Installed plugin id, e.g. `kiki-office`. */
  id: z.string(),
  /** Manifest version of that plugin, when it declares one. */
  version: z.string().optional(),
});
export type SkinPluginOrigin = z.infer<typeof skinPluginOriginSchema>;

export const skinSummarySchema = z.object({
  /** Filename stem, or `<plugin id>:<theme id>` for a plugin skin. */
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  /** Which variants the file declares. */
  variants: z.array(z.enum(['light', 'dark'])),
  /** Present only when an enabled plugin contributed this skin. */
  plugin: skinPluginOriginSchema.optional(),
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
  /** Present only when an enabled plugin contributed this skin. */
  plugin: skinPluginOriginSchema.optional(),
});
export type GetSkinResponse = z.infer<typeof getSkinResponseSchema>;

export const skinIdParamSchema = z.object({
  skin_id: z.string().regex(
    /^[a-z0-9][a-z0-9-]{0,63}$|^[a-z0-9][a-z0-9_-]{0,63}:[a-z0-9][a-z0-9-]{0,63}$/,
  ),
});
