import type { MediaRef } from '@kiki/session-core/composer/media';
import type { Block } from '@kiki/session-core/session';

export interface GalleryImage {
  readonly id: string;
  readonly agentId: string;
  readonly order: readonly number[];
  readonly item: MediaRef;
}

export function galleryImageId(item: MediaRef, agentId: string): string | undefined {
  if (item.blobHash !== undefined) return `${agentId}:blob:${item.blobHash}`;
  if (item.fileId !== undefined) return `${agentId}:file:${item.fileId}`;
  if (item.path !== undefined) return `${agentId}:path:${item.path}`;
  if (item.url !== undefined) return `${agentId}:url:${item.url}`;
  return undefined;
}

export function canonicalGalleryItem(item: MediaRef, agentId: string): MediaRef {
  return item.blobHash === undefined ? item : {
    ...item,
    path: undefined,
    fileId: item.fileId ?? `blobref:${agentId}:${item.blobHash}`,
  };
}

/** The source window, not DOM mount order, owns attachment ordering. */
export function blockGalleryImages(blocks: readonly Block[], agentId: string): GalleryImage[] {
  return blocks.flatMap((block, messageIndex) => {
    if (!('media' in block) || block.media === undefined) return [];
    return block.media.flatMap((item, attachmentIndex) => {
      if (item.kind !== 'image' || item.detail !== undefined) return [];
      const id = galleryImageId(item, agentId);
      return id === undefined ? [] : [{ id, agentId, order: [messageIndex, 1, attachmentIndex], item: canonicalGalleryItem(item, agentId) }];
    });
  });
}

export function orderedGalleryImages(images: readonly GalleryImage[], agentId: string): GalleryImage[] {
  const sorted = images.filter((image) => image.agentId === agentId).sort((a, b) => {
    for (let index = 0; index < Math.max(a.order.length, b.order.length); index += 1) {
      const difference = (a.order[index] ?? 0) - (b.order[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return a.id.localeCompare(b.id);
  });
  const seen = new Set<string>();
  return sorted.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
