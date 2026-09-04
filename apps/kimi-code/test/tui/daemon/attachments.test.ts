import { describe, expect, it } from 'vitest';

import { prepareDaemonPrompt } from '#/tui/daemon/attachments';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';

describe('daemon prompt attachments', () => {
  it('converts uploaded image placeholders into real protocol and engine content', async () => {
    const images = new ImageAttachmentStore();
    const image = images.addImage(new Uint8Array([1, 2, 3]), 'image/png', 10, 20, undefined, 'img-1');

    await expect(
      prepareDaemonPrompt(`inspect ${image.placeholder} now`, images, new Map()),
    ).resolves.toEqual({
      content: [
        { type: 'text', text: 'inspect ' },
        { type: 'image', source: { kind: 'file', file_id: 'img-1' } },
        { type: 'text', text: ' now' },
      ],
      engineContent: [
        { type: 'text', text: 'inspect ' },
        { type: 'image_url', imageUrl: { url: 'kimi-file://img-1' } },
        { type: 'text', text: ' now' },
      ],
      hasFileAttachment: false,
      imageAttachmentIds: [image.id],
      fileAttachmentIds: [],
      uploadIds: ['img-1'],
    });
  });

  it('converts generic uploaded files into file content parts', async () => {
    const images = new ImageAttachmentStore();
    const files = new Map([
      [
        1,
        {
          id: 1,
          fileId: 'file-1',
          name: 'notes.txt',
          mediaType: 'text/plain',
          size: 42,
          placeholder: '[file #1 notes.txt]',
        },
      ],
    ]);

    const prepared = await prepareDaemonPrompt('read [file #1 notes.txt]', images, files);

    expect(prepared?.content).toEqual([
      { type: 'text', text: 'read ' },
      {
        type: 'file',
        file_id: 'file-1',
        name: 'notes.txt',
        media_type: 'text/plain',
        size: 42,
      },
    ]);
    expect(prepared?.hasFileAttachment).toBe(true);
  });

  it('leaves user-authored placeholders untouched when no upload exists', async () => {
    await expect(
      prepareDaemonPrompt('literal [image #99 (1×1)]', new ImageAttachmentStore(), new Map()),
    ).resolves.toBeUndefined();
  });
});
