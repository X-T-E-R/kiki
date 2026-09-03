/**
 * Media preview context — kept separate from the provider so consumers
 * (Markdown links, tool cards) do not import the overlay components and the
 * module graph stays acyclic.
 */

import { createContext, useContext } from 'react';

import type { MediaRef } from '@kiki/session-core/composer/media';

export interface MediaPreviewApi {
  /** Session owning canonical or staged media IDs. */
  readonly sessionId: string | undefined;
  /** Session workspace cwd; anchors relative file links. */
  readonly cwd: string | undefined;
  /** Open the fullscreen image lightbox for a ready URL (data:/blob:/http). */
  readonly openImage: (src: string, name?: string) => void;
  /** Open (or activate) the host file's tab in the preview workspace + focus it. */
  readonly openFile: (path: string) => void;
  /** Open an attachment backed by a canonical session media id. */
  readonly openAttachment: (item: MediaRef) => void;
  /** Number of open preview tabs (0 → the header toggle hides itself). */
  readonly previewTabCount: number;
  /** Whether the preview workspace panel is currently expanded. */
  readonly previewPanelOpen: boolean;
  /** Collapse/expand the preview workspace (tabs are preserved). */
  readonly togglePreviewPanel: () => void;
}

export const MediaPreviewContext = createContext<MediaPreviewApi | null>(null);

/** Null outside a MediaPreviewProvider — callers fall back to plain rendering. */
export function useMediaPreview(): MediaPreviewApi | null {
  return useContext(MediaPreviewContext);
}
