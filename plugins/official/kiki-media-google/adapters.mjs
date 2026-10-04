import { runtime, check, options, fields, oneOf, guarded, decode, pending, failed, videoDownload } from './runtime.mjs';

const models = [
  { id: 'gemini-2.5-flash-image', kind: 'image' },
  { id: 'gemini-3-pro-image', kind: 'image' },
  { id: 'gemini-3.1-flash-image', kind: 'image' },
  { id: 'veo-3.1-generate-preview', kind: 'video' },
  { id: 'veo-3.1-fast-generate-preview', kind: 'video' },
];
export function createAdapters(fetchImpl) {
  const headers = (ctx) => ({ 'x-goog-api-key': String(ctx.settings.apiKey ?? ''), Authorization: '' });
  return {
    image: {
      describe: async () => ({
        models: models.filter((m) => m.kind === 'image'),
        constraints: [
          'One native generation per call. count > 1 is rejected, not split.',
          'No mask support. generateContent protocol; output MIME is taken from the response.',
        ],
        optionsSchema: {
          type: 'object',
          properties: { image_size: { enum: ['1K', '2K', '4K'] } },
          additionalProperties: false,
        },
      }),
      submit: (input, ctx) =>
        guarded(async () => {
          const r = input.request;
          check(r.kind === 'image', 'Expected image request');
          const model = input.model ?? ctx.settings.imageModel ?? 'gemini-2.5-flash-image';
          check(
            models.some((m) => m.id === model && m.kind === 'image'),
            'Unsupported Gemini image model'
          );
          const o = options(r, ['image_size']);
          fields(r, ['mask', 'size', 'format']);
          check(r.count === undefined || r.count === 1, 'Gemini count must be 1; no implicit multiple POSTs');
          oneOf(o.image_size, ['1K', '2K', '4K'], 'image_size');
          const rt = await runtime(ctx, fetchImpl);
          const parts = [{ text: r.prompt }];
          for (const ref of r.images ?? []) {
            const file = await rt.bytes(ref);
            check(file.mime.startsWith('image/'), 'Gemini input must be an image');
            parts.push({ inlineData: { mimeType: file.mime, data: file.data.toString('base64') } });
          }
          const body = {
            contents: [{ role: 'user', parts }],
            generationConfig: {
              responseModalities: ['TEXT', 'IMAGE'],
              imageConfig: { aspectRatio: r.aspect_ratio, imageSize: o.image_size },
            },
          };
          const response = await rt.json(
            rt.endpoint(`/models/${encodeURIComponent(model)}:generateContent`),
            body,
            rt.authHeaders(headers(ctx))
          );
          const artifacts = [];
          for (const part of response.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? []) {
            const data = part.inlineData ?? part.inline_data;
            const mime = data?.mimeType ?? data?.mime_type;
            const name = `image-${artifacts.length + 1}.${
              mime === 'image/jpeg' ? 'jpeg' : mime === 'image/webp' ? 'webp' : 'png'
            }`;
            if (data?.data && mime?.startsWith('image/'))
              artifacts.push(await rt.write(decode(data.data), name, 'image', mime));
            else if (part.fileData?.fileUri)
              artifacts.push(
                await rt.download(part.fileData.fileUri, name, 'image', rt.authHeaders(headers(ctx)), part.fileData.mimeType)
              );
          }
          if (artifacts.length === 0)
            return failed({
              code: 'missing_output',
              message: response.promptFeedback?.blockReason ?? 'Gemini returned no image',
            });
          return { state: 'complete', artifacts, usage: response.usageMetadata, effective: { model } };
        }, 'unknown'),
    },
    video: {
      describe: async () => ({
        models: models.filter((m) => m.kind === 'video'),
        constraints: [
          'At most one first_frame; no reference audio/video, last_frame or extension in this adapter.',
          'Veo operation GET/download can resume without another generation POST.',
        ],
        optionsSchema: {
          type: 'object',
          properties: {
            negative_prompt: { type: 'string' },
            person_generation: { enum: ['allow_all', 'allow_adult', 'dont_allow'] },
          },
          additionalProperties: false,
        },
      }),
      submit: (input, ctx) =>
        guarded(async () => {
          const r = input.request;
          check(r.kind === 'video', 'Expected video request');
          const model = input.model ?? ctx.settings.videoModel ?? 'veo-3.1-generate-preview';
          check(
            models.some((m) => m.id === model && m.kind === 'video'),
            'Unsupported Veo model'
          );
          const o = options(r, ['negative_prompt', 'person_generation']);
          check(
            (r.inputs?.length ?? 0) <= 1 && (r.inputs ?? []).every((i) => i.role === 'first_frame'),
            'Veo adapter supports at most one first_frame only'
          );
          oneOf(r.duration_seconds, [4, 6, 8], 'duration_seconds');
          oneOf(r.aspect_ratio, ['16:9', '9:16'], 'aspect_ratio');
          oneOf(r.resolution, ['720p', '1080p', '4k'], 'resolution');
          check(
            !r.resolution || r.resolution === '720p' || (r.duration_seconds ?? 8) === 8,
            '1080p/4k requires duration 8'
          );
          const rt = await runtime(ctx, fetchImpl);
          const instance = { prompt: r.prompt };
          if (r.inputs?.[0]) {
            const file = await rt.bytes(r.inputs[0].ref);
            instance.image = { bytesBase64Encoded: file.data.toString('base64'), mimeType: file.mime };
          }
          const response = await rt.json(
            rt.endpoint(`/models/${encodeURIComponent(model)}:predictLongRunning`),
            {
              instances: [instance],
              parameters: {
                aspectRatio: r.aspect_ratio ?? '16:9',
                durationSeconds: r.duration_seconds ?? 8,
                resolution: r.resolution ?? '720p',
                sampleCount: 1,
                negativePrompt: o.negative_prompt,
                personGeneration: o.person_generation,
              },
            },
            rt.authHeaders(headers(ctx))
          );
          if (!response.name || !/^operations\/[A-Za-z0-9/_-]+$/.test(response.name))
            return failed({
              code: 'missing_handle',
              message: 'Veo returned no valid operation name',
              submission: 'unknown',
            });
          return pending({ id: response.name, model });
        }, 'unknown'),
      poll: (handle, ctx) =>
        guarded(async () => {
          check(
            handle.version === 1 && /^operations\/[A-Za-z0-9/_-]+$/.test(handle.data.id),
            'Invalid operation handle'
          );
          const rt = await runtime(ctx, fetchImpl);
          let result;
          try {
            result = await rt.json(rt.endpoint(handle.data.id), undefined, rt.authHeaders(headers(ctx)));
          } catch (error) {
            if (/^http_(?:429|5\d\d)$/.test(error.code) || error.code === 'transport_error')
              return pending(handle.data);
            throw error;
          }
          if (result.error) return failed(result.error);
          if (!result.done) return pending(handle.data);
          const url = result.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
          return videoDownload(handle, rt, url, rt.authHeaders(headers(ctx)), undefined, result.response?.usageMetadata);
        }, 'accepted'),
    },
  };
}
export const adapters = createAdapters();
