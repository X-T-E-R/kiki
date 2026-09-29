/**
 * REST surface for appearance packs, plus a one-shot background importer.
 *
 *   GET    /appearance/packs                           list installed packs
 *   GET    /appearance/packs/{pack_id}                 one manifest
 *   GET    /appearance/packs/{pack_id}/files/{file}    one declared pack file (Range)
 *   POST   /appearance/packs[?replace=true]            install from a zip body
 *   DELETE /appearance/packs/{pack_id}                 remove an installed pack
 *   GET    /appearance/packs/{pack_id}/export          the pack as a zip
 *   POST   /appearance/fetch                           import one background from a URL
 *
 * Packs are directories next to the skin files: `<KIKI_HOME>/themes/<id>/`
 * holding `kiki-pack.json` and its media. Simple-mode backgrounds (a picture
 * the user picks) never touch the server: they are a per-device choice, like
 * the rest of the appearance page, and the GUI keeps their bytes locally.
 */

import { z } from 'zod';

import { APPEARANCE_PACK_ID_PATTERN, PACK_FILE_PATTERN, appearancePackSchema } from '../appearance';

export const appearancePackSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  variants: z.array(z.enum(['light', 'dark'])),
  /** Whether the pack also sets colors (a skin), or only media. */
  hasSkin: z.boolean(),
  /** Whether any variant plays a video. */
  hasVideo: z.boolean(),
  /** Sum of the pack's files on disk, in bytes. */
  bytes: z.number().int().nonnegative(),
});
export type AppearancePackSummary = z.infer<typeof appearancePackSummarySchema>;

export const listAppearancePacksResponseSchema = z.object({
  items: z.array(appearancePackSummarySchema),
  /** Absolute packs directory on the server host. */
  directory: z.string(),
  skipped: z.array(z.object({ file: z.string(), reason: z.string() })),
});
export type ListAppearancePacksResponse = z.infer<typeof listAppearancePacksResponseSchema>;

export const getAppearancePackResponseSchema = z.object({
  pack: appearancePackSchema,
  bytes: z.number().int().nonnegative(),
});
export type GetAppearancePackResponse = z.infer<typeof getAppearancePackResponseSchema>;

export const installAppearancePackResponseSchema = z.object({
  pack: appearancePackSummarySchema,
  /** True when an installed pack with the same id was replaced. */
  replaced: z.boolean(),
});
export type InstallAppearancePackResponse = z.infer<typeof installAppearancePackResponseSchema>;

export const appearancePackIdParamSchema = z.object({
  pack_id: z.string().regex(APPEARANCE_PACK_ID_PATTERN),
});

export const appearancePackFileParamSchema = z.object({
  pack_id: z.string().regex(APPEARANCE_PACK_ID_PATTERN),
  file: z.string().regex(PACK_FILE_PATTERN),
});

export const installAppearancePackQuerySchema = z.object({
  /** `true` replaces an installed pack with the same id instead of refusing. */
  replace: z.enum(['true', 'false']).optional(),
});

/**
 * Import one background from a URL. The server fetches it (https only, public
 * addresses only, size-capped, type-sniffed) and returns the bytes; the GUI
 * keeps them on the device. A remote picture is copied once, never hot-linked,
 * so it cannot track launches and still shows offline.
 */
export const fetchAppearanceMediaBodySchema = z.object({
  url: z.string().url().max(2048),
});
