/**
 * Media preview context — kept separate from the provider so consumers
 * (Markdown links, tool cards) do not import the overlay components and the
 * module graph stays acyclic.
 */

import { createContext, useContext } from 'react';

export interface MediaPreviewApi {
  /** Session workspace cwd; anchors relative file links. */
  readonly cwd: string | undefined;
  /** Open the fullscreen image lightbox for a ready URL (data:/blob:/http). */
  readonly openImage: (src: string, name?: string) => void;
  /** Open the file preview pane for an absolute host path (fs:content). */
  readonly openFile: (path: string) => void;
}

export const MediaPreviewContext = createContext<MediaPreviewApi | null>(null);

/** Null outside a MediaPreviewProvider — callers fall back to plain rendering. */
export function useMediaPreview(): MediaPreviewApi | null {
  return useContext(MediaPreviewContext);
}
