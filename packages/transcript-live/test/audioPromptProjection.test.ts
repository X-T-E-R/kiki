import { expect, it } from 'vitest';

import { projectPromptContentParts } from '../src/promptProjection';

it('projects audio_url to an audio part', () => {
  const projected = projectPromptContentParts([
    { type: 'audio_url', audioUrl: { url: 'https://example.com/a.mp3', name: 'a.mp3' } },
    { type: 'audio_url', audioUrl: { url: 'kimi-file://file-1', name: 'note.ogg' } },
    { type: 'audio_url', audioUrl: { url: 'data:audio/ogg;base64,T2dn' } },
  ]);
  expect(JSON.stringify(projected)).not.toContain('[audio:');
  expect(projected).toEqual([
    { type: 'audio', source: { kind: 'url', url: 'https://example.com/a.mp3', id: undefined }, name: 'a.mp3' },
    { type: 'audio', source: { kind: 'session_media', file_id: 'file-1' }, name: 'note.ogg' },
    { type: 'audio', source: { kind: 'base64', media_type: 'audio/ogg', data: 'T2dn' }, name: undefined },
  ]);
});
