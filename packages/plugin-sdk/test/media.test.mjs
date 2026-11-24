import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  mediaActionSchema,
  mediaCapabilitiesSchema,
  mediaGenerateInputSchema,
  mediaJobSchema,
  mediaKindSchema,
  mediaProviderDefinitionSchema,
  mediaRequestSchema,
} from '@kiki/plugin-sdk/media';

await test('mediaKindSchema accepts image, video, tts, and 3d', () => {
  for (const kind of ['image', 'video', 'tts', '3d']) {
    assert.equal(mediaKindSchema.parse(kind), kind);
  }
  assert.equal(mediaKindSchema.safeParse('audio').success, false);
});

await test('mediaRequestSchema validates 3d text, image, combined, and rejects empty or unknown fields', () => {
  assert.deepEqual(mediaRequestSchema.parse({ kind: '3d', prompt: 'ceramic teapot', format: 'glb' }), {
    kind: '3d',
    prompt: 'ceramic teapot',
    format: 'glb',
  });
  assert.deepEqual(
    mediaRequestSchema.parse({
      kind: '3d',
      images: [{ path: '/tmp/ref.png' }, { file_id: 'f_123' }, { url: 'https://example.test/ref.png' }],
      options: { texture: true },
    }),
    {
      kind: '3d',
      images: [{ path: '/tmp/ref.png' }, { file_id: 'f_123' }, { url: 'https://example.test/ref.png' }],
      options: { texture: true },
    },
  );
  const missingInputs = mediaRequestSchema.safeParse({ kind: '3d' });
  assert.equal(missingInputs.success, false);
  assert.match(missingInputs.error.issues[0].message, /3d media request requires prompt or images/);

  const emptyImages = mediaRequestSchema.safeParse({ kind: '3d', images: [] });
  assert.equal(emptyImages.success, false);
  assert.match(emptyImages.error.issues[0].message, /3d media request requires prompt or images/);

  assert.equal(mediaRequestSchema.safeParse({ kind: '3d', prompt: '' }).success, false);
  assert.equal(mediaRequestSchema.safeParse({ kind: '3d', prompt: 'mug', extra: 1 }).success, false);
});

await test('generate, action, provider definition, capabilities, and JSON Schema support kind 3d', () => {
  const gen = mediaGenerateInputSchema.parse({
    request: { kind: '3d', prompt: 'low-poly lantern', format: 'glb', options: { quality: 'high' } },
  });
  assert.equal(gen.execution, 'auto');
  assert.equal(gen.request.kind, '3d');

  assert.deepEqual(mediaActionSchema.parse({ action: 'capabilities', kind: '3d' }), {
    action: 'capabilities',
    kind: '3d',
  });

  const def = mediaProviderDefinitionSchema.parse({
    schemaVersion: 1,
    id: 'tripo-3d',
    kinds: ['3d'],
    label: 'Tripo 3D',
    resumeVersion: 1,
    connectionSetting: 'connectionId',
  });
  assert.deepEqual(def.kinds, ['3d']);

  const caps = mediaCapabilitiesSchema.parse({
    models: [{ id: 'tripo-v2.5', kind: '3d', label: 'Tripo v2.5' }],
  });
  assert.equal(caps.models[0].kind, '3d');

  const generateJsonSchema = z.toJSONSchema(mediaGenerateInputSchema);
  const requestVariants = generateJsonSchema.properties.request.oneOf;
  const variant3d = requestVariants.find((item) => item.properties?.kind?.const === '3d');
  assert.ok(variant3d, 'JSON Schema includes kind=3d variant');
  assert.ok(variant3d.properties.prompt);
  assert.ok(variant3d.properties.images);
  assert.ok(variant3d.properties.format);
  assert.ok(variant3d.properties.options);

  const actionJsonSchema = z.toJSONSchema(mediaActionSchema);
  const capabilitiesVariant = actionJsonSchema.oneOf.find((item) => item.properties?.action?.const === 'capabilities');
  assert.ok(capabilitiesVariant.properties.kind.enum.includes('3d'));

  const jobWithEffectiveKind = mediaJobSchema.parse({
    schemaVersion: 1,
    job_id: 'media-1',
    request_id: 'req-1',
    owner_session_id: 's1',
    owner_agent_id: 'main',
    provider: 'kiki-media/tripo-3d',
    state: 'running',
    phase: 'submit',
    can_resume: false,
    artifacts: [],
    effective: { kind: '3d' },
    created_at: 1,
    updated_at: 1,
  });
  assert.equal(jobWithEffectiveKind.effective?.kind, '3d');
  assert.equal(mediaJobSchema.safeParse({ ...jobWithEffectiveKind, kind: '3d' }).success, false);
});
