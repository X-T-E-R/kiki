/**
 * Display-sized copies of background pictures.
 *
 * A wallpaper can be an 8K photo (7680×4320, ~130 MB once decoded). Showing
 * the original means the browser decodes all of it on the main thread every
 * time an element holding it is re-laid-out or re-created — a settings slider
 * drag used to stall the window for hundreds of milliseconds per step. Pictures
 * larger than the screen are therefore downscaled once, off the main thread
 * (`createImageBitmap` resize + `OffscreenCanvas.convertToBlob`), and every
 * consumer shows that copy: the backdrop at screen size, the settings
 * thumbnail at thumbnail size, the contrast sampler from either.
 *
 * Results are cached per media id and edge, so re-applying the same slot (the
 * sync loop does it on every setting change) never decodes again. Videos, GIFs
 * (animation would be lost) and hosts without the APIs (jsdom, old WebViews)
 * get the original blob back unchanged.
 */

/**
 * Blobs only: every consumer makes (and revokes) its own object URL from the
 * cached blob, so evicting an entry can never break an element still showing it.
 */
const cache = new Map<string, Promise<Blob>>();
/** Enough for the backdrop plus a thumbnail of a few recent pictures. */
const MAX_ENTRIES = 8;

/** The long edge the backdrop needs: the screen in device pixels, within bounds. */
export function backdropEdge(): number {
  if (typeof window === 'undefined') return 2560;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const screenEdge = Math.max(window.screen?.width ?? 0, window.screen?.height ?? 0, window.innerWidth, window.innerHeight);
  return Math.min(3840, Math.max(1920, Math.ceil(screenEdge * dpr)));
}

export const THUMBNAIL_EDGE = 320;

function canDownscale(): boolean {
  return typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined';
}

/** The picture at most `edge` px on its long side; the original when it already fits. */
export async function downscaleImage(blob: Blob, edge: number): Promise<Blob> {
  if (!blob.type.startsWith('image/') || blob.type === 'image/gif' || !canDownscale()) return blob;
  let source: ImageBitmap | undefined;
  let scaled: ImageBitmap | undefined;
  try {
    source = await createImageBitmap(blob);
    const long = Math.max(source.width, source.height);
    if (long <= edge) return blob;
    const scale = edge / long;
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    scaled = await createImageBitmap(source, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('bitmaprenderer');
    if (context === null) return blob;
    context.transferFromImageBitmap(scaled);
    scaled = undefined; // ownership moved to the canvas
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
  } catch {
    return blob;
  } finally {
    source?.close();
    scaled?.close();
  }
}

function evict(): void {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
}

/**
 * A display-sized blob for a media id, computed once. `load` supplies the
 * original bytes and is only called on a cache miss.
 */
export function displayBlob(id: string, edge: number, load: () => Promise<Blob | null>): Promise<Blob | null> {
  const key = `${id}|${edge}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return hit.catch(() => null);
  }
  const pending = load().then((blob) => (blob === null ? Promise.reject(new Error('missing')) : downscaleImage(blob, edge)));
  cache.set(key, pending);
  evict();
  return pending.catch(() => {
    // A missing file is not remembered: it may arrive (a pack reconnects).
    if (cache.get(key) === pending) cache.delete(key);
    return null;
  });
}

/** Drop every cached copy (tests). */
export function resetDisplayMedia(): void {
  cache.clear();
}
