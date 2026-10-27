import { describe, expect, it } from 'vitest';
import type { Block } from '@kiki/session-core/session';
import { blockGalleryImages, galleryImageId, orderedGalleryImages, type GalleryImage } from './mediaGallery';

function entry(id: string, order: readonly number[], agentId = 'main'): GalleryImage {
  return { id, agentId, order, item: { kind: 'image', url: id } };
}

describe('gallery order', () => {
  it('keeps source order and drops another agent and duplicate ids', () => {
    const images = orderedGalleryImages([
      entry('late', [1, 1, 1]),
      entry('early', [1, 0, 40]),
      entry('other', [0, 1, 0], 'other'),
      entry('late', [0, 1, 0]),
    ], 'main');
    expect(images.map((image) => image.id)).toEqual(['late', 'early']);
  });

  it('preserves separate tool occurrences of the same file but folds registration of the same slot', () => {
    const blocks = [
      { id: 'tool-first', media: [{ kind: 'image', fileId: 'same' }] },
      { id: 'tool-second', media: [{ kind: 'image', fileId: 'same' }] },
    ] as unknown as readonly Block[];
    const source = blockGalleryImages(blocks, 'main');
    const images = orderedGalleryImages([...source, { ...source[1]!, order: [1, 1, 0] }], 'main');
    expect(images.map((image) => image.occurrenceId)).toEqual(['["tool-first",1,0]', '["tool-second",1,0]']);
    expect(images.map((image) => image.id)).toEqual(['main:file:same', 'main:file:same']);
  });

  it('reads attachment index from the block list and skips crops and non-images', () => {
    const blocks = [
      { media: [
        { kind: 'image', fileId: 'a' },
        { kind: 'file', fileId: 'notes' },
        { kind: 'image', fileId: 'crop', detail: { agentId: 'main', attachmentId: 'crop' } },
      ] },
      { media: [{ kind: 'image', url: 'https://example.test/b.png' }] },
    ] as unknown as readonly Block[];
    const images = blockGalleryImages(blocks, 'main');
    expect(images.map((image) => image.id)).toEqual(['main:file:a', 'main:url:https://example.test/b.png']);
    expect(images.map((image) => image.order)).toEqual([[0, 1, 0], [1, 1, 0]]);
    expect(galleryImageId({ kind: 'image' }, 'main')).toBeUndefined();
  });
});
