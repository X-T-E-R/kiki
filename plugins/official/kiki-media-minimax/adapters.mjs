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
  decode,
  events,
  mimeFor,
} from './runtime.mjs';
import { open, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

const speechModels = [
  'speech-2.8-hd',
  'speech-2.8-turbo',
  'speech-2.6-hd',
  'speech-2.6-turbo',
  'speech-02-hd',
  'speech-02-turbo',
  'speech-01-hd',
  'speech-01-turbo',
];
const languageMap = {
  zh: 'Chinese',
  yue: 'Chinese,Yue',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  auto: 'auto',
};
const speechKeys = [
  'stream',
  'speed',
  'vol',
  'pitch',
  'emotion',
  'text_normalization',
  'latex_read',
  'bitrate',
  'channel',
  'language_boost',
  'pronunciation_dict',
  'subtitle_enable',
  'subtitle_type',
];
const schema = (keys) => ({
  type: 'object',
  properties: Object.fromEntries(keys.map((k) => [k, {}])),
  additionalProperties: false,
});
export function createAdapters(fetchImpl) {
  return {
    image: {
      describe: async () => ({
        models: [{ id: 'image-01', kind: 'image' }],
        constraints: [
          'Reference images represent portrait characters, not arbitrary editing or masks.',
          'Native count 1–9; size is width x height, 512–2048 in multiples of 8.',
          'If size and aspect_ratio are both explicit, reject instead of silently overriding size.',
        ],
        optionsSchema: schema(['seed', 'prompt_optimizer']),
      }),
      submit: (input, ctx) =>
        guarded(async () => {
          const r = input.request;
          check(r.kind === 'image', 'Expected image request');
          fields(r, ['mask', 'format']);
          const model = input.model ?? ctx.settings.imageModel ?? 'image-01';
          check(model === 'image-01', 'Only verified image-01 is supported');
          const o = options(r, ['seed', 'prompt_optimizer']);
          range(r.count, 1, 9, 'count', true);
          check(r.prompt.length <= 1500, 'Image prompt limit is 1500 characters');
          check(r.size === undefined || r.aspect_ratio === undefined, 'size and aspect_ratio cannot both be explicit');
          oneOf(r.aspect_ratio, ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'], 'aspect_ratio');
          let width;
          let height;
          if (r.size !== undefined) {
            const match = /^(\d+)x(\d+)$/.exec(r.size);
            check(match, 'size must be width x height');
            width = Number(match[1]);
            height = Number(match[2]);
            range(width, 512, 2048, 'width', true);
            range(height, 512, 2048, 'height', true);
            check(width % 8 === 0 && height % 8 === 0, 'Dimensions must be divisible by 8');
          }
          const rt = await runtime(ctx, fetchImpl, true);
          const refs = await Promise.all(
            (r.images ?? []).map(async (ref) => ({ type: 'character', image_file: await rt.mediaUrl(ref) }))
          );
          const response = await rt.json(rt.endpoint('/v1/image_generation'), {
            model,
            prompt: r.prompt,
            n: r.count ?? 1,
            width,
            height,
            aspect_ratio: r.aspect_ratio,
            response_format: 'base64',
            subject_reference: refs.length > 0 ? refs : undefined,
            ...o,
          });
          const values = (response.data?.image_base64 ?? [])
            .map((b64_json) => ({ b64_json }))
            .concat((response.data?.image_urls ?? []).map((url) => ({ url })));
          const result = await imageResults(values, rt, 'jpeg');
          if (response.metadata?.failed_count > 0)
            return {
              state: 'failed',
              artifacts: result.artifacts,
              error: {
                code: 'moderation_partial',
                message: `${response.metadata.failed_count} image outputs blocked by provider`,
                submission: 'accepted',
              },
            };
          return result;
        }, 'unknown'),
    },
    video: {
      describe: async () => ({
        models: [
          { id: 'MiniMax-H3', kind: 'video' },
          { id: 'MiniMax-H3-Max', kind: 'video' },
        ],
        constraints: [
          'H3: 768P/2K, 4–15s. H3-Max: 480P/768P, 5–15s.',
          'Frame mode and reference mode cannot mix. first/last≤1, image≤9, video/audio≤3.',
          'Cancel stops local waiting only; DELETE can delete finished remote records under a race and is deliberately not invoked.',
          'Reference clips must be 2–15s with each modality total≤15s; total request body≤64MB.',
        ],
        optionsSchema: schema(['prompt_expansion_mode']),
      }),
      submit: (input, ctx) =>
        guarded(async () => {
          const r = input.request;
          check(r.kind === 'video', 'Expected video request');
          const model = input.model ?? ctx.settings.videoModel ?? 'MiniMax-H3';
          check(['MiniMax-H3', 'MiniMax-H3-Max'].includes(model), 'Unsupported MiniMax video model');
          const o = options(r, ['prompt_expansion_mode']);
          check(
            o.prompt_expansion_mode === undefined || model === 'MiniMax-H3-Max',
            'prompt_expansion_mode is H3-Max only'
          );
          oneOf(o.prompt_expansion_mode, ['disabled', 'balanced', 'quality'], 'prompt_expansion_mode');
          range(r.duration_seconds, model === 'MiniMax-H3' ? 4 : 5, 15, 'duration_seconds', true);
          oneOf(r.resolution, model === 'MiniMax-H3' ? ['768P', '2K'] : ['480P', '768P'], 'resolution');
          oneOf(r.aspect_ratio, ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], 'aspect_ratio');
          check(r.prompt.trim().length > 0 && r.prompt.length <= 7000, 'Video prompt must have 1–7000 characters');
          const inputs = r.inputs ?? [];
          const grouped = (role) => inputs.filter((i) => i.role === role);
          for (const [role, max] of Object.entries({
            first_frame: 1,
            last_frame: 1,
            reference_image: 9,
            reference_video: 3,
            reference_audio: 3,
          }))
            check(grouped(role).length <= max, `${role} exceeds ${max}`);
          const frame = grouped('first_frame').length + grouped('last_frame').length;
          check(!frame || inputs.length === frame, 'Frame and reference modes cannot mix');
          check(grouped('last_frame').length === 0 || grouped('first_frame').length, 'last_frame requires first_frame');
          check(
            grouped('reference_audio').length === 0 ||
              grouped('reference_image').length ||
              grouped('reference_video').length,
            'reference_audio requires image or video'
          );
          check(
            !frame || r.aspect_ratio === undefined || r.aspect_ratio === 'adaptive',
            'Frame mode uses adaptive ratio; explicit other ratios would be ignored upstream'
          );
          check(inputs.length > 0 || r.aspect_ratio !== 'adaptive', 'Text-to-video cannot use adaptive ratio');
          const rt = await runtime(ctx, fetchImpl, true);
          const content = [{ type: 'text', text: r.prompt }];
          for (const item of inputs) {
            const type =
              item.role === 'reference_video'
                ? 'video_url'
                : item.role === 'reference_audio'
                ? 'audio_url'
                : 'image_url';
            content.push({ type, [type]: { url: await rt.mediaUrl(item.ref) }, role: item.role });
          }
          const body = {
            model,
            content,
            resolution: r.resolution ?? '768P',
            duration: r.duration_seconds ?? 5,
            ratio: r.aspect_ratio ?? (inputs.length > 0 ? 'adaptive' : '16:9'),
            extra: o.prompt_expansion_mode ? { prompt_expansion_mode: o.prompt_expansion_mode } : undefined,
          };
          check(
            Buffer.byteLength(JSON.stringify(body)) <= 64 * 1024 * 1024,
            'Request exceeds 64MB; use public URLs instead of embedded files'
          );
          const response = await rt.json(rt.endpoint('/v2/video_generation'), body);
          if (!response.task_id)
            return failed({ code: 'missing_handle', message: 'MiniMax returned no task_id', submission: 'unknown' });
          return pending({ id: response.task_id, model });
        }, 'unknown'),
      poll: (handle, ctx) =>
        guarded(async () => {
          const rt = await runtime(ctx, fetchImpl, true);
          let response;
          try {
            response = await rt.json(rt.endpoint(`/v2/query/video_generation/${encodeURIComponent(handle.data.id)}`));
          } catch (error) {
            if (/^http_(?:429|5\d\d)$/.test(error.code) || error.code === 'transport_error')
              return pending(handle.data);
            throw error;
          }
          const task = response.task ?? {};
          if (['failed', 'cancelled', 'expired'].includes(task.status))
            return failed(task.error ?? { code: task.status, message: `MiniMax task ${task.status}` });
          if (task.status !== 'succeeded') return pending(handle.data);
          return videoDownload(
            handle,
            rt,
            task.content?.url,
            {},
            { duration_seconds: task.duration, resolution: task.resolution, aspect_ratio: task.ratio },
            task.usage
          );
        }, 'accepted'),
    },
    speech: {
      describe: async () => ({
        models: speechModels.map((id) => ({ id, kind: 'tts' })),
        constraints: [
          'One HTTP synthesis, input <10000 characters; never auto-split paid calls.',
          'SSE requires status=2, not EOF; final aggregated audio is excluded to avoid duplicate tail audio.',
          'Language is language_boost guidance, not a guaranteed language lock.',
          'Subtitle failure preserves the completed audio as partial delivery.',
        ],
        optionsSchema: schema(speechKeys),
      }),
      submit: (input, ctx) =>
        guarded(async () => {
          const r = input.request;
          check(r.kind === 'tts', 'Expected TTS request');
          const model = input.model ?? ctx.settings.speechModel ?? 'speech-2.8-hd';
          check(speechModels.includes(model), 'Unsupported MiniMax speech model');
          const o = options(r, speechKeys);
          check(
            [...r.text].length < 10000,
            'MiniMax TTS input must be less than 10000 characters; no automatic splitting'
          );
          const format = r.format ?? 'mp3';
          oneOf(format, ['mp3', 'pcm', 'flac', 'wav', 'pcmu_raw', 'pcmu_wav', 'opus'], 'format');
          const streaming = o.stream ?? r.text.length > 3000;
          check(typeof streaming === 'boolean', 'stream must be boolean');
          check(!streaming || !['wav', 'pcmu_wav'].includes(format), 'Streaming WAV is unsupported');
          range(o.speed, 0.5, 2, 'speed');
          range(o.vol, Number.MIN_VALUE, 10, 'vol');
          range(o.pitch, -12, 12, 'pitch', true);
          oneOf(o.channel, [1, 2], 'channel');
          oneOf(o.bitrate, [32000, 64000, 128000, 256000], 'bitrate');
          oneOf(r.sample_rate_hz, [8000, 16000, 22050, 24000, 32000, 44100], 'sample_rate_hz');
          oneOf(o.subtitle_type, ['sentence', 'word', 'word_streaming'], 'subtitle_type');
          check(o.subtitle_type !== 'word_streaming' || streaming, 'word_streaming requires streaming');
          check(
            !o.latex_read || !r.language || ['zh', 'Chinese'].includes(r.language),
            'latex_read forces Chinese; conflicts with explicit language'
          );
          const language = o.language_boost ?? (r.language ? languageMap[r.language] ?? r.language : 'auto');
          check(
            !r.language || !o.language_boost || language === (languageMap[r.language] ?? r.language),
            'language and language_boost conflict'
          );
          check(
            !['fluent', 'whisper'].includes(o.emotion) || model.startsWith('speech-2.6'),
            'fluent/whisper are only verified for speech-2.6'
          );
          const rt = await runtime(ctx, fetchImpl, true);
          const body = {
            model,
            text: r.text,
            stream: streaming,
            stream_options: streaming ? { exclude_aggregated_audio: true } : undefined,
            output_format: 'hex',
            language_boost: language,
            voice_setting: {
              voice_id: r.voice,
              speed: o.speed,
              vol: o.vol,
              pitch: o.pitch,
              emotion: o.emotion,
              text_normalization: o.text_normalization,
              latex_read: o.latex_read,
            },
            audio_setting: {
              format,
              sample_rate: r.sample_rate_hz ?? (format.startsWith('pcmu') ? 8000 : format === 'opus' ? 24000 : 32000),
              bitrate: o.bitrate,
              channel: o.channel ?? 1,
            },
            pronunciation_dict: o.pronunciation_dict,
            subtitle_enable: o.subtitle_enable,
            subtitle_type: o.subtitle_type,
          };
          const response = await rt.send(rt.endpoint('/v1/t2a_v2'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          });
          await mkdir(ctx.stagingDir, { recursive: true });
          const target = path.join(ctx.stagingDir, `speech.${format}`);
          const file = await open(`${target}.part`, 'w');
          let terminal = false;
          let size = 0;
          let last;
          let streamError;
          const consume = async (event) => {
            if (event.base_resp && event.base_resp.status_code !== 0)
              throw Object.assign(new Error(event.base_resp.status_msg ?? 'TTS failed'), {
                code: String(event.base_resp.status_code),
                submission: size ? 'accepted' : 'rejected',
              });
            last = event;
            if (event.data?.audio) {
              const chunk = decode(event.data.audio, 'hex');
              await file.write(chunk);
              size += chunk.length;
            }
            if (event.data?.status === 2) terminal = true;
          };
          try {
            if (response.headers.get('content-type')?.includes('text/event-stream')) {
              for await (const event of events(response, ctx.signal)) {
                if (event === '[DONE]') break;
                await consume(JSON.parse(event));
                if (terminal) break;
              }
            } else await consume(await response.json());
            if (!terminal)
              throw Object.assign(new Error('Speech ended without status=2'), {
                code: 'incomplete_stream',
                submission: 'accepted',
              });
            if (!size)
              throw Object.assign(new Error('Speech returned empty audio'), {
                code: 'empty_audio',
                submission: 'accepted',
              });
          } catch (error) {
            streamError = error;
          } finally {
            await file.close();
          }
          const artifacts = [];
          if (size) {
            await rename(`${target}.part`, target);
            artifacts.push({
              path: target,
              name: `speech.${format}`,
              kind: 'audio',
              mime: mimeFor(format),
              role: 'original',
              complete: !streamError,
              metadata: { sample_rate_hz: body.audio_setting.sample_rate, channels: body.audio_setting.channel },
            });
          }
          if (streamError) return failed(streamError, 'accepted', artifacts);
          if (o.subtitle_enable) {
            try {
              check(last?.data?.subtitle_file, 'Subtitles requested but no subtitle file returned');
              const subtitle = await rt.json(last.data.subtitle_file);
              check(Array.isArray(subtitle) && subtitle.length > 0, 'Subtitle response must be a nonempty array');
              const stamp = (ms) => {
                check(Number.isFinite(ms) && ms >= 0, 'Invalid subtitle milliseconds');
                const t = Math.round(ms);
                return `${String(Math.floor(t / 3600000)).padStart(2, '0')}:${String(
                  Math.floor(t / 60000) % 60
                ).padStart(2, '0')}:${String(Math.floor(t / 1000) % 60).padStart(2, '0')},${String(t % 1000).padStart(
                  3,
                  '0'
                )}`;
              };
              const srt = subtitle
                .map((s, i) => {
                  check(s.time_end >= s.time_begin && typeof s.text === 'string', 'Invalid subtitle timing/text');
                  return `${i + 1}\n${stamp(s.time_begin)} --> ${stamp(s.time_end)}\n${s.text}`;
                })
                .join('\n\n');
              artifacts.push(
                await rt.write(JSON.stringify(subtitle), 'subtitles.json', 'file', 'application/json', true, 'subtitle')
              );
              artifacts.push(await rt.write(srt, 'subtitles.srt', 'file', 'application/x-subrip', true, 'subtitle'));
            } catch (error) {
              return {
                state: 'failed',
                artifacts,
                error: {
                  code: 'subtitle_failed',
                  message: 'Audio complete; subtitles could not be delivered',
                  submission: 'accepted',
                  items: [{ item: 'subtitles', code: error.code ?? 'subtitle_failed', message: error.message }],
                },
              };
            }
          }
          return {
            state: 'complete',
            artifacts,
            effective: { model, language_boost: language, format },
            usage: last?.extra_info,
          };
        }, 'unknown'),
      voices: async (_query, ctx) => {
        const rt = await runtime(ctx, fetchImpl, true);
        const response = await rt.json(rt.endpoint('/v1/get_voice'), { voice_type: 'system' });
        return {
          voices: (response.system_voice ?? []).map((voice) => ({
            id: voice.voice_id,
            label: voice.voice_name ?? voice.voice_id,
          })),
          cursor: null,
        };
      },
    },
  };
}
export const adapters = createAdapters();
