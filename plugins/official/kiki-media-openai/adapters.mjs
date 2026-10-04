import {
  runtime,
  check,
  options,
  fields,
  oneOf,
  range,
  guarded,
  imageResults,
  mimeFor,
  receiveAudio,
} from './runtime.mjs';

const imageModels = [
  'gpt-image-1',
  'gpt-image-1-mini',
  'gpt-image-1.5',
  'gpt-image-2',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare',
];
const speechModels = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'];
const imageOptions = ['quality', 'background', 'output_compression', 'input_fidelity', 'user'];
const speechOptions = ['speed', 'instructions'];
const describe = (models, kind, allowed, constraints) => async () => ({
  models: models.map((id) => ({ id, kind })),
  constraints,
  optionsSchema: {
    type: 'object',
    properties: Object.fromEntries(allowed.map((key) => [key, {}])),
    additionalProperties: false,
  },
  output_delivery: ['file'],
  cancellation: 'local_wait_only',
});

export function createAdapters(fetchImpl) {
  const image = {
    describe: describe(imageModels, 'image', imageOptions, [
      'GPT image returns base64; count is one native request, never split.',
      'Mask applies to first input image; supply a PNG alpha-channel mask.',
    ]),
    submit: (input, ctx) =>
      guarded(async () => {
        const r = input.request;
        check(r.kind === 'image', 'Expected image request');
        const model = input.model ?? ctx.settings.imageModel ?? 'gpt-image-1.5';
        check(imageModels.includes(model), 'Unknown image model; update adapter before using a new model');
        const o = options(r, imageOptions);
        fields(r, ['aspect_ratio']);
        range(r.count, 1, 10, 'count', true);
        oneOf(r.format, ['png', 'jpeg', 'webp'], 'format');
        oneOf(o.quality, ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], 'quality');
        oneOf(o.background, ['auto', 'transparent', 'opaque'], 'background');
        range(o.output_compression, 0, 100, 'output_compression', true);
        check(!r.mask || r.images?.length, 'Mask requires an input image');
        check((r.images?.length ?? 0) <= 16, 'At most 16 input images');
        check(o.input_fidelity === undefined || r.images?.length, 'input_fidelity is edit-only');
        oneOf(o.input_fidelity, ['low', 'high'], 'input_fidelity');
        const rt = await runtime(ctx, fetchImpl);
        const payload = {
          model,
          prompt: r.prompt,
          n: r.count ?? 1,
          size: r.size,
          output_format: r.format ?? 'png',
          ...o,
        };
        let result;
        if (r.images?.length) {
          const form = new FormData();
          for (const [key, value] of Object.entries(payload)) if (value !== undefined) form.set(key, String(value));
          for (const ref of r.images) {
            const file = await rt.bytes(ref);
            form.append('image[]', new Blob([file.data], { type: file.mime }), file.name);
          }
          if (r.mask) {
            const file = await rt.bytes(r.mask);
            check(file.mime === 'image/png', 'Mask must be PNG');
            form.set('mask', new Blob([file.data], { type: file.mime }), file.name);
          }
          result = await rt.json(rt.endpoint('/images/edits'), form);
        } else result = await rt.json(rt.endpoint('/images/generations'), payload);
        const outcome = await imageResults(result.data, rt, result.output_format ?? r.format ?? 'png', result.usage);
        return {
          ...outcome,
          effective: { model, size: result.size ?? r.size, format: result.output_format ?? r.format ?? 'png' },
        };
      }, 'unknown'),
  };
  const speech = {
    describe: describe(speechModels, 'tts', speechOptions, [
      'Language follows input text; no forced language or sample-rate parameter.',
      'Disclose to listeners that the speech is AI-generated.',
      'No automatic paid splitting of long text.',
    ]),
    submit: (input, ctx) =>
      guarded(async () => {
        const r = input.request;
        check(r.kind === 'tts', 'Expected TTS request');
        const model = input.model ?? ctx.settings.speechModel ?? 'gpt-4o-mini-tts';
        check(speechModels.includes(model), 'Unsupported speech model');
        const o = options(r, speechOptions);
        fields(r, ['language', 'sample_rate_hz']);
        check(r.text.length <= 4096, 'OpenAI TTS input must be at most 4096 characters; no automatic splitting');
        oneOf(r.format, ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'], 'format');
        range(o.speed, 0.25, 4, 'speed');
        check(!o.instructions || model === 'gpt-4o-mini-tts', 'instructions requires gpt-4o-mini-tts');
        const rt = await runtime(ctx, fetchImpl);
        const format = r.format ?? 'mp3';
        const response = await rt.send(rt.endpoint('/audio/speech'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { model, input: r.text, voice: r.voice, response_format: format, ...o },
        });
        const result = await receiveAudio(response, ctx, `speech.${format}`, mimeFor(format), { ai_generated: true });
        return { ...result, effective: { model, format } };
      }, 'unknown'),
  };
  return { image, speech };
}
export const adapters = createAdapters();
