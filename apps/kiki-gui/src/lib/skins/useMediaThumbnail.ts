/**
 * A small still of a background ref for the settings page. Keyed by the ref's
 * id (not the object: every dial change writes a fresh slot object) and made
 * from a thumbnail-sized copy, so a slider drag neither re-reads the file nor
 * re-decodes an 8K original on the main thread.
 */

import { useEffect, useState } from 'react';

import type { BackgroundMediaRef } from './background';
import { resolveBackdropMedia } from './backdrop';
import { THUMBNAIL_EDGE, displayBlob } from './displayMedia';

export function useMediaThumbnail(ref: BackgroundMediaRef | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const id = ref?.id;
  const kind = ref?.kind;
  useEffect(() => {
    if (id === undefined || ref === undefined) return;
    let active = true;
    let objectUrl: string | null = null;
    const load = () => resolveBackdropMedia(ref);
    // Videos have no still to downscale; the element shows its first frame.
    void (kind === 'image' ? displayBlob(id, THUMBNAIL_EDGE, load) : load()).then((blob) => {
      if (!active || blob === null) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      active = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
    // `ref` is read only on a new id; a new object for the same id changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, kind]);
  return url;
}
