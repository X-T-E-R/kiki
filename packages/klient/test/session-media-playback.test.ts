import { describe, expect, it, vi } from 'vitest';

import { createHttpRestFacade, type HttpRestTransport } from '../src/transports/http/rest';

const previewId = 'ab'.repeat(32);

function playbackFacade(payload: unknown) {
  const json = vi.fn(async () => payload);
  return { rest: createHttpRestFacade({ json, raw: vi.fn() } as unknown as HttpRestTransport), json };
}

describe('session media playback', () => {
  it('mints and revokes a canonical file id without reading the bytes', async () => {
    const { rest, json } = playbackFacade({
      preview_id: previewId,
      url: `http://127.0.0.1:8080/media-preview/${previewId}`,
      mime: 'video/mp4',
      size: 16,
      expires_at: 1_700_000_000_000,
    });
    const opened = await rest.sessions.openMediaPlayback('session/1', 'blobref:agent/hash', { timeoutMs: 15_000 });
    expect(opened).toMatchObject({ preview_id: previewId, mime: 'video/mp4', size: 16 });
    expect(json).toHaveBeenCalledWith('/sessions/session%2F1/media-playback', {
      method: 'POST', body: { file_id: 'blobref:agent/hash' }, signal: undefined, timeoutMs: 15_000,
    });
    await rest.sessions.closeMediaPlayback(previewId);
    expect(json).toHaveBeenLastCalledWith(`/sessions/media-playback/${previewId}`, {
      method: 'DELETE', signal: undefined, timeoutMs: 10_000,
    });
  });

  it('rejects a playback descriptor that is not the canonical grant', async () => {
    const { rest } = playbackFacade({ preview_id: previewId, url: '/media-preview/x', mime: 'video/mp4', size: 1, expires_at: 1, path: 'C:/clip.mp4' });
    await expect(rest.sessions.openMediaPlayback('session', 'file-1')).rejects.toThrow();
  });
});
