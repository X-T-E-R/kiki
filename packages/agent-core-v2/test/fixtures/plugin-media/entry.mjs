import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const definition = { schemaVersion: 1, id: 'synthetic', kinds: ['image', 'video', 'tts', '3d'], label: 'Synthetic media', resumeVersion: 1, connectionSetting: 'connectionId' };
async function original(ctx, kind, name = 'original.bin', complete = true) {
  const file = path.join(ctx.stagingDir, name);
  await writeFile(file, kind === 'audio' ? Buffer.from('streamed-audio-original') : Buffer.from('media-original-bytes'));
  return { path: file, name, mime: kind === 'audio' ? 'audio/mpeg' : kind === 'video' ? 'video/mp4' : 'image/png', kind, role: 'original', complete };
}
export function register(api) {
  api.registerMediaProvider(definition, {
    async describe(input) {
      const models = [{ id: 'synthetic-image', kind: 'image' }, { id: 'synthetic-video', kind: 'video' }, { id: 'synthetic-tts', kind: 'tts' }, { id: 'synthetic-3d', kind: '3d' }];
      return { models: input?.kind ? models.filter((model) => model.kind === input.kind) : models };
    },
    async voices() { return { voices: [{ id: 'test-voice', languages: ['zh', 'en'] }], cursor: null }; },
    async submit(input, ctx) {
      const mode = input.request.prompt ?? input.request.text;
      ctx.progress({ kind: 'status', text: 'Synthetic provider accepted' });
      await appendFile(path.join(ctx.settings.remoteDir, 'submitted.log'), `${ctx.jobId}\n`);
      if (mode === 'connection') {
        const connection = await ctx.connection();
        const file = path.join(ctx.stagingDir, 'connection.json');
        await writeFile(file, JSON.stringify({ connection, settings: ctx.settings, env: process.env.KIKI_MEDIA_FIXTURE_ENV }));
        return { state: 'complete', artifacts: [{ path: file, name: 'connection.json', mime: 'application/json', kind: 'file', role: 'original', complete: true }] };
      }
      if (mode === 'unknown') throw new Error('Submission response lost after possible remote acceptance');
      if (mode === 'rejected') return { state: 'failed', error: { code: 'rejected', message: 'Fake rejection', submission: 'rejected' } };
      if (mode === 'async' || mode === 'download' || mode === 'cancelled') return { state: 'pending', phase: 'generation', handle: { version: 1, data: { mode } }, retryAfterMs: 100 };
      if (input.request.kind === '3d') {
        if (input.request.images?.length) {
          const refs = [];
          for (const ref of input.request.images) {
            if (ref.file_id) throw new Error('Host did not resolve 3d image inputs');
            refs.push(ref.path ? await readFile(ref.path, 'utf8') : ref.url);
          }
          await appendFile(path.join(ctx.settings.remoteDir, 'inputs.log'), `${refs.join('|')}\n`);
        }
        const ext = input.request.format ?? 'glb';
        const mimeByExt = { glb: 'model/gltf-binary', gltf: 'model/gltf+json', usdz: 'model/vnd.usdz+zip', obj: 'model/obj', stl: 'model/stl' };
        const modelFile = path.join(ctx.stagingDir, `model.${ext}`);
        await writeFile(modelFile, Buffer.from(`glTF-3d-payload:${mode ?? 'image-to-3d'}`));
        const previewFile = path.join(ctx.stagingDir, 'model.preview.png');
        await writeFile(previewFile, Buffer.from('preview-png-bytes'));
        return {
          state: 'complete',
          artifacts: [
            { path: modelFile, name: `model.${ext}`, mime: mimeByExt[ext] ?? 'application/octet-stream', kind: 'file', role: 'original', complete: true },
            { path: previewFile, name: 'model.preview.png', mime: 'image/png', kind: 'image', role: 'preview', complete: true },
          ],
        };
      }
      const kind = input.request.kind === 'tts' ? 'audio' : 'image';
      const draft = await original(ctx, kind, kind === 'audio' ? 'speech.mp3' : 'image.png', mode !== 'incomplete');
      if (mode === 'partial') return { state: 'failed', artifacts: [draft], error: { code: 'subtitle_failed', message: 'Optional subtitle download failed', submission: 'accepted', items: [{ item: 'subtitle', code: 'http_503', message: 'Unavailable' }] } };
      if (input.request.kind === 'image' && input.request.images?.length) {
        const ref = input.request.images[0];
        if (!ref.path || ref.file_id) throw new Error('Host did not resolve image inputs');
        const inputBytes = await readFile(ref.path);
        await appendFile(path.join(ctx.settings.remoteDir, 'inputs.log'), `${inputBytes.toString('utf8')}\n`);
      }
      return { state: 'complete', artifacts: [draft] };
    },
    async poll(handle, ctx) {
      await appendFile(path.join(ctx.settings.remoteDir, 'polled.log'), `${ctx.jobId}\n`);
      const ready = await readFile(path.join(ctx.settings.remoteDir, 'ready'), 'utf8').catch(() => '');
      if (!ready) return { state: 'pending', phase: 'generation', handle, retryAfterMs: 100 };
      if (handle.data.mode === 'download' && ready === 'fail') return { state: 'pending', phase: 'download', handle, retryAfterMs: 100 };
      return { state: 'complete', artifacts: [await original(ctx, 'video', 'video.mp4')] };
    },
    async cancel(handle) { return { remote: handle.data.mode === 'cancelled' ? 'cancelled' : 'requested', billing: 'unknown' }; },
  });
}
