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

export function createAdapters(fetchImpl) {
  return {
    image: {
      describe: async (_q, ctx) => ({
        models: [{ id: String(ctx.settings.imageModel ?? 'doubao-seedream-4-0-250828'), kind: 'image' }],
        constraints: [
          'Seedream JSON generation/reference input; no mask.',
          'count is 1; native sequential-image generation is not silently enabled.',
        ],
        optionsSchema: {
          type: 'object',
          properties: { watermark: { type: 'boolean' }, seed: { type: 'integer' } },
          additionalProperties: false,
        },
      }),
      submit: (input, ctx) =>
        guarded(async () => {
          const r = input.request;
          check(r.kind === 'image', 'Expected image request');
          fields(r, ['mask', 'aspect_ratio', 'format']);
          check(r.count === undefined || r.count === 1, 'Ark count must be 1; no implicit sequential-image requests');
          const o = options(r, ['watermark', 'seed']);
          const rt = await runtime(ctx, fetchImpl);
          const refs = await Promise.all((r.images ?? []).map((ref) => rt.mediaUrl(ref)));
          const model = input.model ?? ctx.settings.imageModel ?? 'doubao-seedream-4-0-250828';
          const response = await rt.json(rt.endpoint('/images/generations'), {
            model,
            prompt: r.prompt,
            size: r.size,
            response_format: 'b64_json',
            image: refs.length === 1 ? refs[0] : refs.length > 0 ? refs : undefined,
            ...o,
          });
          return imageResults(response.data, rt, 'png', response.usage);
        }, 'unknown'),
    },
    video: {
      describe: async (_q, ctx) => ({
        models: ctx.settings.videoModel ? [{ id: String(ctx.settings.videoModel), kind: 'video' }] : [],
        constraints: [
          'Configure an Ark endpoint/model with the Seedance 2.0 protocol. Seedance 2.5 is not claimed by this 2.0 profile.',
          'Inputs require public HTTP(S) URLs. No hidden OSS upload.',
          'Frame mode and reference mode are mutually exclusive; reference_audio requires a reference image or video.',
        ],
        optionsSchema: {
          type: 'object',
          properties: {
            generate_audio: { type: 'boolean' },
            watermark: { type: 'boolean' },
            seed: { type: 'integer' },
            camera_fixed: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      }),
      submit: (input, ctx) =>
        guarded(async () => {
          const r = input.request;
          check(r.kind === 'video', 'Expected video request');
          const model = input.model ?? ctx.settings.videoModel;
          check(typeof model === 'string' && model.length > 0, 'Configure/select the Ark Seedance 2.0 endpoint/model');
          check(!/2[.-]5/.test(model), 'Seedance 2.5 requires its own verified protocol profile, not the 2.0 limits');
          const o = options(r, ['generate_audio', 'watermark', 'seed', 'camera_fixed']);
          range(r.duration_seconds, 4, 15, 'duration_seconds', true);
          oneOf(r.resolution, ['480p', '720p', '1080p'], 'resolution');
          oneOf(r.aspect_ratio, ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], 'aspect_ratio');
          const inputs = r.inputs ?? [];
          const grouped = (role) => inputs.filter((i) => i.role === role);
          const limits = { first_frame: 1, last_frame: 1, reference_image: 9, reference_video: 3, reference_audio: 3 };
          for (const [role, max] of Object.entries(limits))
            check(grouped(role).length <= max, `${role} exceeds ${max}`);
          const frame = grouped('first_frame').length + grouped('last_frame').length;
          const reference = inputs.length - frame;
          check(!frame || !reference, 'Frame and reference modes cannot be mixed');
          check(grouped('last_frame').length === 0 || grouped('first_frame').length, 'last_frame requires first_frame');
          check(
            grouped('reference_audio').length === 0 ||
              grouped('reference_image').length ||
              grouped('reference_video').length,
            'reference_audio requires image or video'
          );
          const rt = await runtime(ctx, fetchImpl);
          const content = [{ type: 'text', text: r.prompt }];
          for (const item of inputs) {
            const type =
              item.role === 'reference_video'
                ? 'video_url'
                : item.role === 'reference_audio'
                ? 'audio_url'
                : 'image_url';
            content.push({ type, [type]: { url: await rt.mediaUrl(item.ref, true) }, role: item.role });
          }
          const result = await rt.json(rt.endpoint('/contents/generations/tasks'), {
            model,
            content,
            duration: r.duration_seconds ?? 5,
            ratio: r.aspect_ratio ?? '16:9',
            resolution: r.resolution ?? '720p',
            ...o,
          });
          if (!result.id)
            return failed({ code: 'missing_handle', message: 'Ark returned no task ID', submission: 'unknown' });
          return pending({ id: result.id, model });
        }, 'unknown'),
      poll: (handle, ctx) =>
        guarded(async () => {
          const rt = await runtime(ctx, fetchImpl);
          let result;
          try {
            result = await rt.json(rt.endpoint(`/contents/generations/tasks/${encodeURIComponent(handle.data.id)}`));
          } catch (error) {
            if (/^http_(?:429|5\d\d)$/.test(error.code) || error.code === 'transport_error')
              return pending(handle.data);
            throw error;
          }
          if (['failed', 'cancelled', 'expired'].includes(result.status))
            return failed(result.error ?? { code: result.status, message: `Ark task ${result.status}` });
          if (result.status !== 'succeeded') return pending(handle.data);
          return videoDownload(
            handle,
            rt,
            result.content?.video_url,
            {},
            { duration_seconds: result.duration, resolution: result.resolution, aspect_ratio: result.ratio },
            result.usage
          );
        }, 'accepted'),
    },
  };
}
export const adapters = createAdapters();
