import { runtime, check, options, fields, oneOf, guarded, pending, failed } from './runtime.mjs';
export function createAdapters(fetchImpl) {
  return {
    video: {
      describe: async (_q, ctx) => ({
        models: ctx.settings.videoModel ? [{ id: String(ctx.settings.videoModel), kind: 'video' }] : [],
        constraints: [
          'Canvas /video/create compatibility profile, not every Novita product endpoint.',
          'At most one first_frame. Native duration 5 or 10 seconds. No video/audio/last-frame reference.',
          'Configure a compatible endpoint and its actual model; no unverified model list is advertised.',
        ],
        optionsSchema: { type: 'object', properties: {}, additionalProperties: false },
      }),
      submit: (input, ctx) =>
        guarded(async () => {
          const r = input.request;
          check(r.kind === 'video', 'Expected video request');
          options(r, []);
          fields(r, ['resolution']);
          const model = input.model ?? ctx.settings.videoModel;
          check(model, 'Select/configure a compatible video model');
          const inputs = r.inputs ?? [];
          check(
            inputs.length <= 1 && inputs.every((i) => i.role === 'first_frame'),
            'Novita adapter accepts at most one first_frame'
          );
          oneOf(r.duration_seconds, [5, 10], 'duration_seconds');
          oneOf(r.aspect_ratio, ['16:9', '9:16', '1:1'], 'aspect_ratio');
          check(
            inputs.length === 0 || r.aspect_ratio === undefined,
            'Image input determines ratio; explicit aspect_ratio would be ignored'
          );
          const rt = await runtime(ctx, fetchImpl);
          const response = await rt.json(rt.endpoint('/video/create'), {
            model,
            prompt: r.prompt,
            duration: String(r.duration_seconds ?? 5),
            image: inputs[0] ? await rt.mediaUrl(inputs[0].ref) : undefined,
            aspect_ratio: inputs.length > 0 ? undefined : r.aspect_ratio ?? '16:9',
          });
          if (!response.task_id)
            return failed({ code: 'missing_handle', message: 'Novita returned no task_id', submission: 'unknown' });
          return pending({ id: response.task_id, model });
        }, 'unknown'),
      poll: (handle, ctx) =>
        guarded(async () => {
          const rt = await runtime(ctx, fetchImpl);
          let result;
          try {
            result = await rt.json(rt.endpoint(`/async/task-result?task_id=${encodeURIComponent(handle.data.id)}`));
          } catch (error) {
            if (/^http_(?:429|5\d\d)$/.test(error.code) || error.code === 'transport_error')
              return pending(handle.data);
            throw error;
          }
          if (result.task?.status === 'TASK_STATUS_FAILED')
            return failed({ code: 'generation_failed', message: result.task.reason ?? 'Novita failed' });
          if (result.task?.status !== 'TASK_STATUS_SUCCEED') return pending(handle.data);
          if (!result.videos?.length || result.videos.some((v) => !v.video_url))
            return failed({ code: 'missing_output', message: 'Novita succeeded without all video URLs' });
          const artifacts = [];
          try {
            for (const [i, video] of result.videos.entries())
              artifacts.push(await rt.download(video.video_url, `video-${i + 1}.mp4`, 'video'));
          } catch {
            return pending(handle.data, 'download', artifacts);
          }
          return { state: 'complete', artifacts };
        }, 'accepted'),
    },
  };
}
export const adapters = createAdapters();
