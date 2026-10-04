import { runtime, check, options, oneOf, range, guarded, pending, failed, videoDownload } from './runtime.mjs';
const models = ['agnes-video-2.5', 'agnes-video-2.5-flash', 'agnes-video-v2.0'];
export function createAdapters(fetchImpl) {
  return {
    video: {
      describe: async () => ({
        models: models.map((id) => ({ id, kind: 'video' })),
        constraints: [
          '2.5 duration 4–12s; resolution 720P/960P/2K. Flash only 720P, ≤5 reference images, no reference video.',
          'Explicit frame/reference roles select modes; reference counts are never guessed into frame roles.',
          'V2.0 uses num_frames (8k+1 up to 441), not exact integer seconds; pass options.num_frames without duration_seconds.',
          'Compatible endpoint required; no account/runtime or implicit public upload.',
        ],
        optionsSchema: { type: 'object', properties: { num_frames: { type: 'integer' } }, additionalProperties: false },
      }),
      submit: (input, ctx) =>
        guarded(async () => {
          const r = input.request;
          check(r.kind === 'video', 'Expected video request');
          const model = input.model ?? ctx.settings.videoModel ?? 'agnes-video-2.5';
          check(models.includes(model), 'Unsupported Agnes model');
          const o = options(r, ['num_frames']);
          const groups = {
            first_frame: [],
            last_frame: [],
            reference_image: [],
            reference_video: [],
            reference_audio: [],
          };
          for (const i of r.inputs ?? []) groups[i.role].push(i);
          check(groups.first_frame.length <= 1 && groups.last_frame.length <= 1, 'At most one first and last frame');
          const frames = groups.first_frame.length + groups.last_frame.length;
          check(!frames || frames === (r.inputs?.length ?? 0), 'Frame and reference modes cannot mix');
          check(groups.last_frame.length === 0 || groups.first_frame.length, 'last_frame requires first_frame');
          const rt = await runtime(ctx, fetchImpl);
          const urls = async (role) => Promise.all(groups[role].map((i) => rt.mediaUrl(i.ref, true)));
          let body;
          let effective;
          if (model === 'agnes-video-v2.0') {
            check(
              groups.reference_video.length === 0 && groups.reference_audio.length === 0,
              'V2.0 has no video/audio references'
            );
            check(
              r.duration_seconds === undefined && r.aspect_ratio === undefined && r.resolution === undefined,
              'V2.0 requires native num_frames rather than duration/ratio/resolution'
            );
            const frames = o.num_frames ?? 121;
            range(frames, 1, 441, 'num_frames', true);
            check((frames - 1) % 8 === 0, 'num_frames must be 8k+1');
            const images = [
              ...(await urls('first_frame')),
              ...(await urls('last_frame')),
              ...(await urls('reference_image')),
            ];
            body = {
              model,
              prompt: r.prompt,
              frame_rate: 24,
              num_frames: frames,
              image: images.length === 1 ? images[0] : undefined,
              extra_body: images.length > 1 ? { image: images, mode: 'keyframes' } : undefined,
            };
            effective = { frame_rate: 24, num_frames: frames };
          } else {
            check(o.num_frames === undefined, 'num_frames is V2.0 only');
            range(r.duration_seconds, 4, 12, 'duration_seconds', true);
            const resolution = r.resolution ?? '720P';
            oneOf(resolution, ['720P', '960P', '2K'], 'resolution');
            oneOf(r.aspect_ratio, ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], 'aspect_ratio');
            if (model.endsWith('flash'))
              check(
                resolution === '720P' && groups.reference_image.length <= 5 && groups.reference_video.length === 0,
                'Flash requires 720P, ≤5 reference images and no reference_video'
              );
            const reference = (r.inputs?.length ?? 0) - frames;
            body = {
              model,
              prompt: r.prompt,
              mode: frames ? 'keyframe' : reference ? 'reference' : 'text',
              seconds: String(r.duration_seconds ?? 5),
              size: resolution,
              aspect_ratio: r.aspect_ratio ?? '16:9',
              n: 1,
            };
            if (frames) {
              body.first_frame = (await urls('first_frame'))[0];
              body.last_frame = (await urls('last_frame'))[0];
            } else if (reference) {
              if (groups.reference_image.length > 0) body.images = await urls('reference_image');
              if (groups.reference_audio.length > 0) body.audios = await urls('reference_audio');
              if (groups.reference_video.length > 0)
                body.videos = (await urls('reference_video')).map((url) => ({ url }));
            }
          }
          const raw = await rt.json(rt.endpoint('/videos'), body);
          const result = raw.data ?? raw;
          const id = result.video_id ?? result.task_id ?? result.id;
          if (!id)
            return failed({ code: 'missing_handle', message: 'Agnes returned no video_id', submission: 'unknown' });
          return { ...pending({ id, model }), effective };
        }, 'unknown'),
      poll: (handle, ctx) =>
        guarded(async () => {
          const rt = await runtime(ctx, fetchImpl);
          const url = new URL(rt.baseUrl);
          url.pathname = '/agnesapi';
          url.search = new URLSearchParams({ video_id: handle.data.id, model_name: handle.data.model }).toString();
          let raw;
          try {
            raw = await rt.json(url.toString());
          } catch (error) {
            if (/^http_(?:429|5\d\d)$/.test(error.code) || error.code === 'transport_error')
              return pending(handle.data);
            throw error;
          }
          const result = raw.data ?? raw;
          const status = String(result.status ?? '').toLowerCase();
          if (['failed', 'cancelled', 'canceled', 'expired'].includes(status))
            return failed(result.error ?? { code: status, message: result.message ?? 'Agnes failed' });
          if (!['completed', 'succeeded', 'success', 'done'].includes(status)) return pending(handle.data);
          return videoDownload(handle, rt, result.metadata?.url ?? result.url);
        }, 'accepted'),
    },
  };
}
export const adapters = createAdapters();
