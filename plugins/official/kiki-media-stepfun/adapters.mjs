// Modified HTTP protocol adaptation: Android callbacks/DTO/runtime and EOF-as-success behavior are not retained.
import { runtime, check, options, oneOf, range, guarded, decode, events, failed, mimeFor, receiveAudio } from './runtime.mjs';
import { open, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
const models = ['stepaudio-3-tts', 'stepaudio-2.5-tts'];
export function createAdapters(fetchImpl) {
  return {
    speech: {
      describe: async () => ({
        models: models.map((id) => ({ id, kind: 'tts' })),
        constraints: [
          'At most 1000 input characters in one paid request; no automatic split.',
          'SSE requires speech.audio.done; EOF and [DONE] alone are not success.',
          'Pronunciation-map schema is ambiguous in current docs; not accepted by this adapter.',
          'Parenthesized content is an instruction and will not be spoken.',
        ],
        optionsSchema: {
          type: 'object',
          properties: {
            speed: { type: 'number', minimum: 0.5, maximum: 2 },
            volume: { type: 'number', minimum: 0.1, maximum: 2 },
            instruction: { type: 'string' },
            stream_format: { enum: ['audio', 'sse'] },
            return_url: { type: 'boolean' },
            markdown_filter: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      }),
      submit: (input, ctx) =>
        guarded(async () => {
          const r = input.request;
          check(r.kind === 'tts', 'Expected TTS request');
          const model = input.model ?? ctx.settings.speechModel ?? 'stepaudio-3-tts';
          check(models.includes(model), 'Unsupported StepFun model');
          const o = options(r, ['speed', 'volume', 'instruction', 'stream_format', 'return_url', 'markdown_filter']);
          check([...r.text].length <= 1000, 'StepFun input limit is 1000 characters; no automatic splitting');
          check(
            !o.instruction || o.instruction.length <= (model === 'stepaudio-3-tts' ? 500 : 200),
            'instruction exceeds model limit'
          );
          range(o.speed, 0.5, 2, 'speed');
          range(o.volume, 0.1, 2, 'volume');
          oneOf(r.language, ['zh', 'en', 'ja', 'ko', 'fr', 'es'], 'language');
          const format = r.format ?? 'mp3';
          oneOf(format, ['wav', 'mp3', 'flac', 'opus', 'pcm'], 'format');
          oneOf(r.sample_rate_hz, [8000, 16000, 22050, 24000, 48000], 'sample_rate_hz');
          oneOf(o.stream_format, ['audio', 'sse'], 'stream_format');
          check(!o.return_url || o.stream_format !== 'sse', 'return_url is non-SSE only');
          const rt = await runtime(ctx, fetchImpl);
          const response = await rt.send(rt.endpoint('/audio/speech'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: {
              model,
              input: r.text,
              voice: r.voice,
              language: r.language,
              response_format: format,
              sample_rate: r.sample_rate_hz,
              ...o,
            },
          });
          if (o.return_url) {
            const result = await response.json();
            if (!result.data?.url) return failed({ code: 'missing_output', message: 'StepFun returned no audio URL' });
            return {
              state: 'complete',
              artifacts: [await rt.download(result.data.url, `speech.${format}`, 'audio', {}, mimeFor(format))],
            };
          }
          if (!response.headers.get('content-type')?.includes('text/event-stream')) {
            return receiveAudio(response, ctx, `speech.${format}`, mimeFor(format), { sample_rate_hz: r.sample_rate_hz ?? 24000 });
          }
          await mkdir(ctx.stagingDir, { recursive: true });
          const target = path.join(ctx.stagingDir, `speech.${format}`);
          const file = await open(`${target}.part`, 'w');
          let terminal = false;
          let size = 0;
          let receptionError;
          try {
            if (response.headers.get('content-type')?.includes('text/event-stream')) {
              for await (const data of events(response, ctx.signal)) {
                if (data === '[DONE]') break;
                const event = JSON.parse(data);
                if (event.type === 'speech.audio.error')
                  throw Object.assign(new Error(event.message ?? event.error?.message ?? 'StepFun speech error'), {
                    code: 'speech_error',
                  });
                if (event.type === 'speech.audio.delta') {
                  const chunk = decode(event.audio);
                  await file.write(chunk);
                  size += chunk.length;
                } else if (event.type === 'speech.audio.done') {
                  terminal = true;
                  break;
                } else
                  throw Object.assign(new Error(`Unknown speech event: ${event.type}`), { code: 'invalid_response' });
              }
            } else {
              if (response.headers.get('content-type')?.includes('json'))
                throw Object.assign(new Error('StepFun returned JSON instead of audio'), { code: 'invalid_response' });
              for await (const chunk of response.body) {
                ctx.signal.throwIfAborted();
                await file.write(chunk);
                size += chunk.length;
              }
              terminal = true;
            }
            if (!terminal || !size)
              throw Object.assign(new Error('Speech ended without complete nonempty audio'), {
                code: 'incomplete_stream',
              });
          } catch (error) {
            receptionError = error;
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
              complete: !receptionError,
              metadata: { sample_rate_hz: r.sample_rate_hz ?? 24000 },
            });
          }
          if (receptionError) return failed(receptionError, 'accepted', artifacts);
          return { state: 'complete', artifacts, effective: { model, format, language: r.language ?? 'en' } };
        }, 'unknown'),
    },
  };
}
export const adapters = createAdapters();
