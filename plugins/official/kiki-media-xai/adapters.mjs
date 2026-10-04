import {
  runtime,
  check,
  options,
  fields,
  oneOf,
  range,
  guarded,
  imageResults,
  pending,
  failed,
  videoDownload,
} from './runtime.mjs';
const videoModels = ['grok-imagine-video', 'grok-imagine-video-1.5'];
export function createAdapters(fetchImpl) {
  return {
    image: {
      describe: async () => ({
        models: [
          { id: 'grok-imagine-image', kind: 'image' },
          { id: 'grok-imagine-image-pro', kind: 'image' },
        ],
        constraints: [
          'Generation and one-image JSON edit are supported; no mask.',
          'Output format is provider-controlled; explicit format/size is rejected.',
        ],
        optionsSchema: {
          type: 'object',
          properties: { resolution: { enum: ['1k', '1.5k', '2k'] }, user: { type: 'string' } },
          additionalProperties: false,
        },
      }),
      submit: (input, ctx) =>
        guarded(async () => {
          const r = input.request;
          check(r.kind === 'image', 'Expected image request');
          fields(r, ['mask', 'size', 'format']);
          check((r.images?.length ?? 0) <= 1, 'This xAI image edit adapter accepts exactly one input image');
          const o = options(r, ['resolution', 'user']);
          oneOf(o.resolution, ['1k', '1.5k', '2k'], 'resolution');
          const rt = await runtime(ctx, fetchImpl);
          const model = input.model ?? ctx.settings.imageModel ?? 'grok-imagine-image';
          const image = r.images?.[0] ? { url: await rt.mediaUrl(r.images[0]) } : undefined;
          const result = await rt.json(rt.endpoint(image ? '/images/edits' : '/images/generations'), {
            model,
            prompt: r.prompt,
            image,
            n: r.count ?? 1,
            aspect_ratio: r.aspect_ratio,
            response_format: 'b64_json',
            ...o,
          });
          return imageResults(result.data, rt, 'jpeg', result.usage);
        }, 'unknown'),
    },
    video: {
      describe: async () => ({
        models: videoModels.map((id) => ({ id, kind: 'video' })),
        constraints: [
          'No last_frame or reference_video in this generation adapter.',
          'reference_images/reference_audios are model-selective; the provider validates model entitlement. Audio references may be used without images.',
          'No verified remote cancel; stopping only stops local waiting.',
        ],
        optionsSchema: { type: 'object', properties: { user: { type: 'string' } }, additionalProperties: false },
      }),
      submit: (input, ctx) =>
        guarded(async () => {
          const r = input.request;
          check(r.kind === 'video', 'Expected video request');
          const o = options(r, ['user']);
          const model = input.model ?? ctx.settings.videoModel ?? 'grok-imagine-video';
          check(videoModels.includes(model), 'Unsupported xAI video model');
          range(r.duration_seconds, 1, 15, 'duration_seconds', true);
          oneOf(r.resolution, ['480p', '720p', '1080p'], 'resolution');
          oneOf(r.aspect_ratio, ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'], 'aspect_ratio');
          const inputs = r.inputs ?? [];
          check(
            inputs.every((item) => ['first_frame', 'reference_image', 'reference_audio'].includes(item.role)),
            'Unsupported xAI input role'
          );
          const frames = inputs.filter((i) => i.role === 'first_frame');
          const images = inputs.filter((i) => i.role === 'reference_image');
          const audios = inputs.filter((i) => i.role === 'reference_audio');
          check(frames.length <= 1 && audios.length <= 3, 'At most one first_frame and three reference_audios');
          check(
            frames.length === 0 || (images.length === 0 && audios.length === 0),
            'First-frame and reference modes cannot be mixed'
          );
          const rt = await runtime(ctx, fetchImpl);
          const response = await rt.json(rt.endpoint('/videos/generations'), {
            model,
            prompt: r.prompt,
            duration: r.duration_seconds,
            aspect_ratio: r.aspect_ratio,
            resolution: r.resolution,
            image: frames[0] ? { url: await rt.mediaUrl(frames[0].ref) } : undefined,
            reference_images:
              images.length > 0
                ? await Promise.all(images.map(async (i) => ({ url: await rt.mediaUrl(i.ref) })))
                : undefined,
            reference_audios:
              audios.length > 0
                ? await Promise.all(audios.map(async (i) => ({ url: await rt.mediaUrl(i.ref) })))
                : undefined,
            ...o,
          });
          if (!response.request_id)
            return failed({ code: 'missing_handle', message: 'xAI returned no request_id', submission: 'unknown' });
          return pending({ id: response.request_id, model });
        }, 'unknown'),
      poll: (handle, ctx) =>
        guarded(async () => {
          const rt = await runtime(ctx, fetchImpl);
          let result;
          try {
            result = await rt.json(rt.endpoint(`/videos/${encodeURIComponent(handle.data.id)}`));
          } catch (error) {
            if (/^http_(?:429|5\d\d)$/.test(error.code) || error.code === 'transport_error')
              return pending(handle.data);
            throw error;
          }
          if (['failed', 'expired'].includes(result.status))
            return failed(result.error ?? { code: result.status, message: `xAI task ${result.status}` });
          if (result.status !== 'done') return pending(handle.data);
          return videoDownload(
            handle,
            rt,
            result.video?.url ?? result.video?.file_output?.public_url,
            {},
            { duration_seconds: result.video?.duration },
            result.usage
          );
        }, 'accepted'),
    },
  };
}
export const adapters = createAdapters();
