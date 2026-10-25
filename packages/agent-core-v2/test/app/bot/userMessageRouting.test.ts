import { describe, expect, it, vi } from 'vitest';

import { ErrorCodes } from '#/errors';
import {
  internalMessageChannel,
  routeUserMessage,
  validateUserMessageChannels,
  type MessageAttachmentReceipt,
  type UserMessageChannel,
  type UserMessageInput,
} from '#/app/bot/messageRouting';

const image: MessageAttachmentReceipt = { blobId: 'blobref:main:aaaa', path: '/tmp/a.png', mimeType: 'image/png', size: 10, kind: 'image' };
const video: MessageAttachmentReceipt = { blobId: 'blobref:main:bbbb', path: '/tmp/a.mp4', mimeType: 'video/mp4', size: 10, kind: 'video' };
const voice: MessageAttachmentReceipt = { blobId: 'blobref:main:cccc', path: '/tmp/a.ogg', mimeType: 'audio/ogg', size: 10, kind: 'voice' };

function input(attachments: readonly MessageAttachmentReceipt[] = []): UserMessageInput {
  return { sessionId: 's1', toolCallId: 'call-1', text: 'Hello', attachments };
}

function channel(id: string, enabled: boolean, kinds: readonly string[], send = vi.fn(async () => ({ status: 'delivered' as const, messageIds: [`${id}-1`] }))): UserMessageChannel {
  return { id, kind: id === 'internal' ? 'internal' : 'im', enabled, capabilities: kinds.map((kind) => ({ kind })), send };
}

describe('user message routing', () => {
  it('delivers through the in-app channel by default', async () => {
    const receipt = await routeUserMessage(input([image]), [internalMessageChannel()]);
    expect(receipt.deliveredTo).toEqual(['user']);
    expect(receipt.delivery).toBe('delivered');
    expect(receipt.channels).toEqual([{ channelId: 'internal', status: 'delivered' }]);
  });

  it('reports no enabled destination instead of a false delivery', async () => {
    await expect(routeUserMessage(input(), [internalMessageChannel(false)])).rejects.toThrow('no_destination');
  });

  it('rejects media no enabled channel can take', async () => {
    expect(() => validateUserMessageChannels(input([video]), [channel('im:1', true, ['image']), internalMessageChannel(false)]))
      .toThrow('media_unsupported');
  });

  it('delivers to a supporting channel and tells an unsupporting one what was skipped', async () => {
    const supporting = channel('im:yes', true, ['image', 'video']);
    const sent: { input: UserMessageInput; skipped: readonly string[] }[] = [];
    const limited: UserMessageChannel = {
      ...channel('im:no', true, ['image']),
      send: async (input, skipped) => { sent.push({ input, skipped }); return { status: 'delivered' }; },
    };
    const receipt = await routeUserMessage(input([image, video]), [supporting, limited]);
    expect(supporting.send).toHaveBeenCalledOnce();
    expect(sent[0]!.input.attachments.map((item) => item.kind)).toEqual(['image']);
    expect(sent[0]!.skipped).toEqual(['video']);
    expect(receipt.channels).toEqual([
      expect.objectContaining({ channelId: 'im:yes', status: 'delivered' }),
      expect.objectContaining({ channelId: 'im:no', status: 'partial', unsupported: ['video'] }),
    ]);
    expect(receipt.deliveredTo).toEqual(['user']);
  });

  it('marks a channel that can take none of the attachments as unsupported rather than dropping them silently', async () => {
    const supporting = channel('im:yes', true, ['image']);
    const limited = channel('im:no', true, ['file']);
    const receipt = await routeUserMessage(input([image]), [supporting, limited]);
    expect(receipt.channels).toEqual([
      expect.objectContaining({ channelId: 'im:yes', status: 'delivered' }),
      expect.objectContaining({ channelId: 'im:no', status: 'partial', unsupported: ['image'] }),
    ]);
  });

  it('keeps an unknown outcome unknown instead of claiming delivery', async () => {
    const failing = channel('im:1', true, ['image'], vi.fn(async () => { throw new Error('timeout'); }));
    const receipt = await routeUserMessage(input([image]), [failing, internalMessageChannel(false)]);
    expect(receipt.delivery).toBe('pending');
    expect(receipt.deliveredTo).toEqual([]);
    expect(receipt.channels).toEqual([expect.objectContaining({ channelId: 'im:1', status: 'unknown' })]);
  });

  it('never silently downgrades explicit voice to a file', async () => {
    const fileOnly = channel('im:1', true, ['file']);
    await expect(routeUserMessage(input([voice]), [fileOnly, internalMessageChannel(false)])).rejects.toThrow('media_unsupported');
  });

  it('accepts audio and voice separately when the channel declares both', async () => {
    const both = channel('im:1', true, ['audio', 'voice']);
    const receipt = await routeUserMessage(input([voice]), [both, internalMessageChannel(false)]);
    expect(receipt.channels).toEqual([expect.objectContaining({ channelId: 'im:1', status: 'delivered' })]);
  });

  it('matches declared MIME types instead of trusting the kind alone', async () => {
    const pngOnly: UserMessageChannel = {
      id: 'im:png', kind: 'im', enabled: true,
      capabilities: [{ kind: 'image', mimeTypes: ['image/png'] }],
      send: vi.fn(async () => ({ status: 'delivered' as const })),
    };
    const webp: MessageAttachmentReceipt = { ...image, mimeType: 'image/webp' };
    await expect(routeUserMessage(input([webp]), [pngOnly, internalMessageChannel(false)])).rejects.toThrow('media_unsupported');
  });

  it('does not send through a disabled IM binding', async () => {
    const disabled = channel('im:off', false, ['image']);
    const receipt = await routeUserMessage(input(), [disabled, internalMessageChannel()]);
    expect(disabled.send).not.toHaveBeenCalled();
    expect(receipt.channels).toEqual([expect.objectContaining({ channelId: 'internal' })]);
  });

  it('defaults to enabled bound channels and excludes available unbound channels', async () => {
    const bound = channel('im:bound', true, []);
    const available = { ...channel('notify:available', true, []), bound: false };
    const receipt = await routeUserMessage(input(), [bound, available]);
    expect(bound.send).toHaveBeenCalledOnce();
    expect(available.send).not.toHaveBeenCalled();
    expect(receipt.channels?.map((item) => item.channelId)).toEqual(['im:bound']);
  });

  it('deduplicates explicit targets and rejects missing or disabled targets with a reason', async () => {
    const target = channel('im:target', true, []);
    const receipt = await routeUserMessage({ ...input(), channel: 'im:target', channels: ['im:target'] }, [target]);
    expect(target.send).toHaveBeenCalledOnce();
    expect(receipt.channels).toHaveLength(1);
    await expect(routeUserMessage({ ...input(), channel: 'im:missing' }, [target])).rejects.toMatchObject({
      code: ErrorCodes.REQUEST_INVALID, details: { reason: 'channel_not_found', channelId: 'im:missing' },
    });
    await expect(routeUserMessage({ ...input(), channels: ['im:target', 'im:missing'] }, [target])).rejects.toMatchObject({
      code: ErrorCodes.REQUEST_INVALID, details: { reason: 'channel_not_found', channelId: 'im:missing' },
    });
    const disabled = channel('im:disabled', false, []);
    await expect(routeUserMessage({ ...input(), channel: 'im:disabled' }, [disabled])).rejects.toMatchObject({
      code: ErrorCodes.REQUEST_INVALID, details: { reason: 'channel_disabled', channelId: 'im:disabled' },
    });
  });

  it('requires the borrowing policy for an explicit unbound target and marks a borrowed send', async () => {
    const available = { ...channel('notify:available', true, []), bound: false };
    await expect(routeUserMessage({ ...input(), channel: available.id }, [available])).rejects.toMatchObject({
      code: ErrorCodes.REQUEST_INVALID, details: { reason: 'channel_borrowing_disabled', channelId: available.id },
    });
    const receipt = await routeUserMessage({ ...input(), channels: [available.id, available.id] }, [available], { allowChannelBorrowing: true });
    expect(receipt.channels).toEqual([expect.objectContaining({ channelId: available.id, borrowed: true })]);
    expect(available.send).toHaveBeenCalledOnce();
  });
});
