import { expect, it } from 'vitest';

import { contentToCoreParts } from '../../../src/lib/promptMedia';
import { projectPromptContentParts } from '../../../src/services/messages/messageProjection';

it('maps an audio part to audio_url and projects it back as audio', () => {
  const core = contentToCoreParts([
    { type: 'audio', source: { kind: 'url', url: 'https://example.com/a.mp3' }, name: 'a.mp3' },
    { type: 'audio', source: { kind: 'base64', media_type: 'audio/mpeg', data: 'QQ==' } },
    { type: 'audio', source: { kind: 'session_media', file_id: 'file-1' }, name: 'note.ogg' },
  ]);
  expect(core).toEqual([
    { type: 'audio_url', audioUrl: { url: 'https://example.com/a.mp3', id: undefined, name: 'a.mp3' } },
    { type: 'audio_url', audioUrl: { url: 'data:audio/mpeg;base64,QQ==', name: undefined } },
    { type: 'audio_url', audioUrl: { url: 'kimi-file://file-1', id: 'file-1', name: 'note.ogg' } },
  ]);
  const projected = projectPromptContentParts(core);
  expect(JSON.stringify(projected)).not.toContain('[audio:');
  expect(projected).toEqual([
    { type: 'audio', source: { kind: 'url', url: 'https://example.com/a.mp3', id: undefined }, name: 'a.mp3' },
    { type: 'audio', source: { kind: 'base64', media_type: 'audio/mpeg', data: 'QQ==' }, name: undefined },
    { type: 'audio', source: { kind: 'session_media', file_id: 'file-1' }, name: 'note.ogg' },
  ]);
});
