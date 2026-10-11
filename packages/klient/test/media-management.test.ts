import { describe, expect, it, vi } from 'vitest';
import { createGlobalMedia } from '../src/core/facade/media.js';
import { mediaContract } from '../src/contract/global/media.js';

describe('single-plugin media source management', () => {
  it('exposes the four source operations through normal global procedure calls', async () => {
    const call = vi.fn(async () => []);
    const media = createGlobalMedia(call);
    await media.managedSources();
    await media.sourceSettings({ provider: 'kiki-media/openai-image' });
    await media.updateSource({ provider: 'kiki-media/openai-image', values: { apiKey: null }, enabled: false, removed: true });
    await media.addScriptSource({ id: 'local', label: 'Local', kinds: ['tts'], command: 'node', args: ['speech.mjs', '{output}'], environment: { EXAMPLE_ENV: 'fixture' } });
    expect(call.mock.calls).toEqual([
      ['pluginMediaService', 'managedSources', []],
      ['pluginMediaService', 'sourceSettings', [{ provider: 'kiki-media/openai-image' }]],
      ['pluginMediaService', 'updateSource', [{ provider: 'kiki-media/openai-image', values: { apiKey: null }, enabled: false, removed: true }]],
      ['pluginMediaService', 'addScriptSource', [{ id: 'local', label: 'Local', kinds: ['tts'], command: 'node', args: ['speech.mjs', '{output}'], environment: { EXAMPLE_ENV: 'fixture' } }]],
    ]);
  });
  it('strictly validates management input and keeps script input optional defaults', () => {
    expect(mediaContract.addScriptSource.input.parse([{ id: 'local', label: 'Local', kinds: ['image'], command: 'node' }])[0]).toMatchObject({ protocol: 'file' });
    expect(mediaContract.updateSource.input.parse([{ provider: 'kiki-media/openai-image', values: { apiKey: null } }])).toHaveLength(1);
    expect(() => mediaContract.addScriptSource.input.parse([{ id: '../escape', label: 'Local', kinds: ['image'], command: 'node' }])).toThrow();
    expect(() => mediaContract.sourceSettings.input.parse([{ provider: 'kiki-media/openai-image', values: {} }])).toThrow();
    expect(() => mediaContract.addScriptSource.input.parse([{ id: 'local', label: 'Local', kinds: ['image'], command: 'node', environment: { BAD: 4 } }])).toThrow();
  });
});
