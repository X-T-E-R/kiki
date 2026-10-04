import { runtime, check, options, range, guarded, pending, failed, videoDownload } from './runtime.mjs';
export function createAdapters(fetchImpl) {
  return {
    video: {
      describe: async (_q, ctx) => ({
        models: ctx.settings.videoModel ? [{ id: String(ctx.settings.videoModel), kind: 'video' }] : [],
        constraints: [
          'NewAPI /video/generations compatibility profile; model IDs are configured for your gateway.',
          'Only reference_image/video/audio roles; 9 images, 3 videos, 3 audios. Audio requires video.',
          'Public URLs required; no implicit upload.',
        ],
        optionsSchema: {
          type: 'object',
          properties: { generate_audio: { type: 'boolean' } },
          additionalProperties: false,
        },
      }),
      submit: (input, ctx) =>
        guarded(async () => {
          const r = input.request;
          check(r.kind === 'video', 'Expected video request');
          const model = input.model ?? ctx.settings.videoModel;
          check(model, 'Select/configure a gateway video model');
          const o = options(r, ['generate_audio']);
          range(r.duration_seconds, 1, 30, 'duration_seconds', true);
          const groups = { reference_image: [], reference_video: [], reference_audio: [] };
          for (const item of r.inputs ?? []) {
            check(Object.hasOwn(groups, item.role), 'NewAPI does not map frame roles to reference inputs');
            groups[item.role].push(item);
          }
          check(
            groups.reference_image.length <= 9 &&
              groups.reference_video.length <= 3 &&
              groups.reference_audio.length <= 3,
            'NewAPI input count limit exceeded'
          );
          check(
            groups.reference_audio.length === 0 || groups.reference_video.length,
            'NewAPI reference_audio requires reference_video'
          );
          const rt = await runtime(ctx, fetchImpl);
          const urls = async (role) =>
            groups[role].length > 0 ? Promise.all(groups[role].map((i) => rt.mediaUrl(i.ref, true))) : undefined;
          const raw = await rt.json(rt.endpoint('/video/generations'), {
            model,
            prompt: r.prompt,
            seconds: String(r.duration_seconds ?? 5),
            aspect_ratio: r.aspect_ratio ?? '16:9',
            resolution: r.resolution,
            image_urls: await urls('reference_image'),
            video_urls: await urls('reference_video'),
            audio_urls: await urls('reference_audio'),
            ...o,
          });
          const result = raw.data ?? raw;
          const id = result.id ?? result.task_id ?? result.request_id;
          if (!id)
            return failed({ code: 'missing_handle', message: 'NewAPI returned no task ID', submission: 'unknown' });
          return pending({ id, model });
        }, 'unknown'),
      poll: (handle, ctx) =>
        guarded(async () => {
          const rt = await runtime(ctx, fetchImpl);
          let raw;
          try {
            raw = await rt.json(rt.endpoint(`/video/generations/${encodeURIComponent(handle.data.id)}`));
          } catch (error) {
            if (/^http_(?:429|5\d\d)$/.test(error.code) || error.code === 'transport_error')
              return pending(handle.data);
            throw error;
          }
          const result = raw.data ?? raw;
          const status = String(result.status ?? '').toUpperCase();
          if (['FAILURE', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(status))
            return failed({
              code: status.toLowerCase(),
              message: result.fail_reason ?? result.error?.message ?? 'Gateway generation failed',
            });
          if (!['SUCCESS', 'SUCCEEDED', 'COMPLETED'].includes(status)) return pending(handle.data);
          return videoDownload(handle, rt, result.result_url ?? result.video_url ?? result.url);
        }, 'accepted'),
    },
  };
}
export const adapters = createAdapters();
