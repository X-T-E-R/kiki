import { describe, expect, it, vi } from 'vitest';

import { prepareDaemonPrompt } from '#/tui/daemon/attachments';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';

const now = Date.parse('2026-01-01T00:00:00.000Z');
const expiresAt = now + 60 * 60 * 1_000;
const refresher = {
  refreshMedia: async () => {
    throw new Error('unexpected media refresh');
  },
  refreshFile: async () => {
    throw new Error('unexpected file refresh');
  },
};

describe('daemon prompt attachments', () => {
  it('converts uploaded image placeholders into real protocol and engine content', async () => {
    const images = new ImageAttachmentStore();
    const image = images.addImage(
      new Uint8Array([1, 2, 3]),
      'image/png',
      10,
      20,
      undefined,
      'img-1',
      expiresAt,
    );

    await expect(
      prepareDaemonPrompt(
        `inspect ${image.placeholder} now`,
        images,
        new Map(),
        refresher,
        () => now,
      ),
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
      mediaUploadIds: ['img-1'],
      fileUploadIds: [],
      uploadExpiresAt: [expiresAt],
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
          expiresAt,
          sourcePath: 'notes.txt',
          name: 'notes.txt',
          mediaType: 'text/plain',
          size: 42,
          placeholder: '[file #1 notes.txt]',
        },
      ],
    ]);

    const prepared = await prepareDaemonPrompt(
      'read [file #1 notes.txt]',
      images,
      files,
      refresher,
      () => now,
    );

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
    expect(prepared).toMatchObject({
      hasFileAttachment: true,
      fileUploadIds: ['file-1'],
      uploadExpiresAt: [expiresAt],
    });
  });

  it('revalidates every selected attachment after another refresh advances the clock', async () => {
    let clock = now;
    const images = new ImageAttachmentStore();
    const first = images.addImage(
      new Uint8Array([1]),
      'image/png',
      1,
      1,
      undefined,
      'old-a',
      clock + 60_001,
    );
    const second = images.addImage(
      new Uint8Array([2]),
      'image/png',
      1,
      1,
      undefined,
      'old-b',
      clock - 1,
    );
    const refreshMedia = vi.fn(async (attachment: typeof first) => {
      if (attachment.id === second.id) clock += 60_001;
      attachment.fileId = attachment.id === first.id ? 'new-a' : 'new-b';
      attachment.fileExpiresAt = clock + 60 * 60 * 1_000;
    });

    const prepared = await prepareDaemonPrompt(
      `${first.placeholder} ${first.placeholder} ${second.placeholder}`,
      images,
      new Map(),
      { refreshMedia, refreshFile: refresher.refreshFile },
      () => clock,
    );

    expect(refreshMedia.mock.calls.map(([attachment]) => attachment.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(prepared?.mediaUploadIds).toEqual(['new-a', 'new-b']);
    expect(JSON.stringify(prepared)).not.toContain('old-a');
  });

  it('converges across multiple freshness rounds', async () => {
    let clock = now;
    const images = new ImageAttachmentStore();
    const first = images.addImage(new Uint8Array([1]), 'image/png', 1, 1, undefined, 'a', clock + 60_001);
    const second = images.addImage(new Uint8Array([2]), 'image/png', 1, 1, undefined, 'b', clock - 1);
    const third = images.addImage(new Uint8Array([3]), 'image/png', 1, 1, undefined, 'c', clock + 120_002);
    const refreshOrder: number[] = [];
    const refreshMedia = async (attachment: typeof first): Promise<void> => {
      refreshOrder.push(attachment.id);
      if (attachment.id === second.id) clock += 60_001;
      else if (attachment.id === first.id) clock += 2;
      attachment.fileId = `new-${String(attachment.id)}`;
      attachment.fileExpiresAt = clock + 60 * 60 * 1_000;
    };

    const prepared = await prepareDaemonPrompt(
      `${first.placeholder} ${second.placeholder} ${third.placeholder}`,
      images,
      new Map(),
      { refreshMedia, refreshFile: refresher.refreshFile },
      () => clock,
    );

    expect(refreshOrder).toEqual([second.id, first.id, third.id]);
    expect(prepared?.mediaUploadIds).toEqual(['new-1', 'new-2', 'new-3']);
  });

  it('fails without building refs when freshness cannot stabilize within the round limit', async () => {
    let clock = now;
    const images = new ImageAttachmentStore();
    const image = images.addImage(
      new Uint8Array([1]),
      'image/png',
      1,
      1,
      undefined,
      'old-image',
      clock - 1,
    );
    const refreshMedia = vi.fn(async (attachment: typeof image) => {
      attachment.fileId = `attempt-${String(refreshMedia.mock.calls.length)}`;
      attachment.fileExpiresAt = clock + 60_001;
      clock += 2;
    });

    await expect(
      prepareDaemonPrompt(
        image.placeholder,
        images,
        new Map(),
        { refreshMedia, refreshFile: refresher.refreshFile },
        () => clock,
      ),
    ).rejects.toThrow('Attachment freshness did not stabilize');
    expect(refreshMedia).toHaveBeenCalledTimes(3);
  });

  it('leaves user-authored placeholders untouched when no upload exists', async () => {
    await expect(
      prepareDaemonPrompt(
        'literal [image #99 (1×1)]',
        new ImageAttachmentStore(),
        new Map(),
        refresher,
        () => now,
      ),
    ).resolves.toBeUndefined();
  });
});
