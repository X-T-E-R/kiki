/* oxlint-disable unicorn/no-useless-spread -- RPC waiters remove themselves during iteration; iterate a snapshot. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
// oxlint-disable-next-line import/extensions -- Exercise the built, sole public schema from native Node tests.
import {
  mediaOutcomeSchema,
  mediaProviderDefinitionSchema,
  mediaCapabilitiesSchema,
} from '../../../../packages/plugin-sdk/dist/media.js';

const official = fileURLToPath(new URL('../../', import.meta.url));
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const scratch = path.join(root, '.tmp', 'media-provider-adapters');
await mkdir(scratch, { recursive: true });
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII=',
  'base64'
);
await writeFile(path.join(scratch, 'fixture.png'), png);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const binary = (bytes = Buffer.from('transport-only-media'), mime = 'video/mp4') =>
  new Response(bytes, { headers: { 'content-type': mime } });
const sse = (events) =>
  new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
async function harness(vendor, responses, settings = {}) {
  const { createAdapters } = await import(pathToFileURL(path.join(official, `kiki-media-${vendor}`, 'adapters.mjs')));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, init);
    assert.ok(next, `Unexpected HTTP call ${url}`);
    return next;
  };
  const stagingDir = await mkdtemp(path.join(scratch, `${vendor}-`));
  return {
    adapters: createAdapters(fetchImpl),
    calls,
    ctx: {
      signal: new AbortController().signal,
      settings: { baseUrl: 'https://api.example.test/v1', apiKey: 'YOUR_API_KEY', ...settings },
      stagingDir,
      jobId: 'job-fixture',
      progress() {},
    },
  };
}
const image = (extra = {}) => ({ request: { kind: 'image', prompt: 'A simple shape', ...extra } });
const video = (extra = {}, model) => ({ model, request: { kind: 'video', prompt: 'A slow camera move', ...extra } });
const speech = (extra = {}, model) => ({
  model,
  request: { kind: 'tts', text: 'Hello world', voice: 'voice-fixture', ...extra },
});
const ref = (role) => ({ role, ref: { url: 'https://cdn.example.test/input.png' } });
const body = (call) => JSON.parse(call.body);
function outcome(value) {
  return mediaOutcomeSchema.parse(value);
}

await test('OpenAI generation and multi-image multipart edit preserve mask/count without response_format', async () => {
  const h = await harness('openai', [
    json({ data: [{ b64_json: png.toString('base64') }] }),
    json({ data: [{ b64_json: png.toString('base64') }] }),
  ]);
  assert.equal(outcome(await h.adapters.image.submit(image({ count: 2 }), h.ctx)).state, 'complete');
  assert.equal(body(h.calls[0]).n, 2);
  assert.equal(body(h.calls[0]).response_format, undefined);
  const input = { path: path.join(scratch, 'fixture.png') };
  assert.equal(
    outcome(await h.adapters.image.submit(image({ images: [input, input], mask: input }), h.ctx)).state,
    'complete'
  );
  assert.ok(h.calls[1].body instanceof FormData);
  assert.equal(h.calls[1].body.getAll('image[]').length, 2);
  assert.ok(h.calls[1].body.get('mask'));
  assert.equal(h.calls[1].headers['Content-Type'], undefined);
  assert.deepEqual(await readFile(path.join(h.ctx.stagingDir, 'image-1.png')), png);
  const invalid = await h.adapters.image.submit(image({ options: { response_format: 'url' } }), h.ctx);
  assert.equal(invalid.error.submission, 'not_sent');
  const invalidScalar = await h.adapters.image.submit(image({ images: [input], options: { user: { id: 'fixture-user' } } }), h.ctx);
  assert.equal(invalidScalar.error.code, 'invalid_request');
  assert.equal(invalidScalar.error.submission, 'not_sent');
  assert.equal(h.calls.length, 2);
});
await test('OpenAI speech body, finite binary result and explicit unsupported language/sample rate', async () => {
  const h = await harness('openai', [binary(Buffer.from('transport-only-audio'), 'audio/mpeg')]);
  assert.equal(
    outcome(await h.adapters.speech.submit(speech({ options: { instructions: 'calm', speed: 1.2 } }), h.ctx)).state,
    'complete'
  );
  assert.equal(body(h.calls[0]).instructions, 'calm');
  assert.equal(body(h.calls[0]).input, 'Hello world');
  assert.equal(body(h.calls[0]).response_format, 'mp3');
  for (const request of [
    speech({ language: 'zh' }),
    speech({ sample_rate_hz: 48000 }),
    speech({ text: 'x'.repeat(4097) }),
    speech({ options: { instructions: 'calm' } }, 'tts-1'),
  ])
    assert.equal((await h.adapters.speech.submit(request, h.ctx)).error.submission, 'not_sent');
  assert.equal(h.calls.length, 1);
});
await test('Gemini native images keep input MIME and reject implicit paid count splitting', async () => {
  const h = await harness('google', [
    json({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }],
    }),
  ]);
  assert.equal(
    outcome(
      await h.adapters.image.submit(
        image({ images: [{ path: path.join(scratch, 'fixture.png') }], aspect_ratio: '16:9' }),
        h.ctx
      )
    ).state,
    'complete'
  );
  assert.equal(body(h.calls[0]).contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(h.calls[0].headers['x-goog-api-key'], 'YOUR_API_KEY');
  for (const r of [image({ count: 2 }), image({ mask: { path: path.join(scratch, 'fixture.png') } })])
    assert.equal((await h.adapters.image.submit(r, h.ctx)).error.submission, 'not_sent');
  assert.equal(h.calls.length, 1);
});
await test('Veo operation submit/poll/authenticated download and role counterexample', async () => {
  const local = await harness('google', [
    json({ name: 'operations/video-fixture' }),
    json({ done: false }),
    json({
      done: true,
      response: {
        generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://cdn.example.test/video.mp4' } }] },
      },
    }),
    binary(),
  ]);
  const created = outcome(
    await local.adapters.video.submit(
      video({
        inputs: [{ role: 'first_frame', ref: { path: path.join(scratch, 'fixture.png') } }],
        duration_seconds: 8,
      }),
      local.ctx
    )
  );
  assert.equal(created.state, 'pending');
  assert.equal(body(local.calls[0]).instances[0].image.mimeType, 'image/png');
  assert.equal(outcome(await local.adapters.video.poll(created.handle, local.ctx)).state, 'pending');
  assert.equal(outcome(await local.adapters.video.poll(created.handle, local.ctx)).state, 'complete');
  assert.equal(local.calls.at(-1).headers['x-goog-api-key'], 'YOUR_API_KEY');
  assert.equal(
    (await local.adapters.video.submit(video({ inputs: [ref('last_frame')] }), local.ctx)).error.submission,
    'not_sent'
  );
});
await test('Ark reference-image JSON and explicit Seedance roles/public-only inputs', async () => {
  const h = await harness(
    'ark',
    [
      json({ data: [{ b64_json: png.toString('base64') }] }),
      json({ id: 'ark-task' }),
      json({ status: 'succeeded', content: { video_url: 'https://cdn.example.test/ark.mp4' } }),
      binary(),
    ],
    { videoModel: 'seedance-2.0-fixture' }
  );
  assert.equal(
    outcome(await h.adapters.image.submit(image({ images: [{ path: path.join(scratch, 'fixture.png') }] }), h.ctx))
      .state,
    'complete'
  );
  assert.ok(body(h.calls[0]).image.startsWith('data:image/png;base64,'));
  const created = outcome(
    await h.adapters.video.submit(video({ inputs: [ref('reference_image'), ref('reference_audio')] }), h.ctx)
  );
  assert.equal(created.state, 'pending');
  assert.deepEqual(
    body(h.calls[1])
      .content.map((item) => item.role)
      .filter(Boolean),
    ['reference_image', 'reference_audio']
  );
  assert.equal(outcome(await h.adapters.video.poll(created.handle, h.ctx)).state, 'complete');
  for (const r of [
    video({ inputs: [ref('reference_audio')] }),
    video({ inputs: [ref('first_frame'), ref('reference_image')] }),
    video({ inputs: [{ role: 'reference_image', ref: { path: path.join(scratch, 'fixture.png') } }] }),
  ])
    assert.equal((await h.adapters.video.submit(r, h.ctx)).error.submission, 'not_sent');
});
await test('xAI official image object and video reference-audio arrays are not miscast', async () => {
  const h = await harness('xai', [
    json({ data: [{ b64_json: png.toString('base64') }] }),
    json({ request_id: 'xai-task' }),
    json({
      status: 'done',
      video: { url: 'https://cdn.example.test/xai.mp4', duration: 5 },
      usage: { input_tokens: 3 },
    }),
    binary(),
  ]);
  assert.equal(
    outcome(await h.adapters.image.submit(image({ images: [{ url: 'https://cdn.example.test/image.png' }] }), h.ctx))
      .state,
    'complete'
  );
  assert.deepEqual(body(h.calls[0]).image, { url: 'https://cdn.example.test/image.png' });
  const created = outcome(
    await h.adapters.video.submit(
      video({ inputs: [ref('reference_audio')], duration_seconds: 5 }, 'grok-imagine-video-1.5'),
      h.ctx
    )
  );
  assert.equal(created.state, 'pending');
  assert.equal(body(h.calls[1]).reference_audios[0].url, 'https://cdn.example.test/input.png');
  assert.equal(body(h.calls[1]).generate_audio, undefined);
  assert.equal(outcome(await h.adapters.video.poll(created.handle, h.ctx)).state, 'complete');
  assert.equal(
    (await h.adapters.video.submit(video({ inputs: [ref('reference_video')] }), h.ctx)).error.submission,
    'not_sent'
  );
});
await test('MiniMax portrait-reference images and native count preserve actual output MIME', async () => {
  const h = await harness('minimax', [
    json({
      base_resp: { status_code: 0 },
      data: { image_base64: [png.toString('base64')] },
      metadata: { success_count: 1, failed_count: 0 },
    }),
  ]);
  const result = outcome(
    await h.adapters.image.submit(
      image({ images: [{ url: 'https://cdn.example.test/person.png' }], count: 3, size: '1024x1024' }),
      h.ctx
    )
  );
  assert.equal(result.state, 'complete');
  assert.equal(result.artifacts[0].mime, 'image/png');
  assert.ok(result.artifacts[0].name.endsWith('.png'));
  assert.equal(body(h.calls[0]).n, 3);
  assert.deepEqual(body(h.calls[0]).subject_reference, [
    { type: 'character', image_file: 'https://cdn.example.test/person.png' },
  ]);
  for (const r of [
    image({ size: '513x1024' }),
    image({ size: '1024x1024', aspect_ratio: '1:1' }),
    image({ mask: { path: path.join(scratch, 'fixture.png') } }),
  ])
    assert.equal((await h.adapters.image.submit(r, h.ctx)).error.submission, 'not_sent');
});
await test('MiniMax H3/Max schema, explicit roles, no slicing/DELETE and exact download resume', async () => {
  const h = await harness('minimax', [
    json({ task_id: 'mini-task' }),
    json({ task: { status: 'succeeded', content: { url: 'https://cdn.example.test/mini.mp4' } } }),
    new Response('unavailable', { status: 503 }),
    json({ task: { status: 'succeeded', content: { url: 'https://cdn.example.test/mini.mp4' } } }),
    binary(),
  ]);
  const created = outcome(
    await h.adapters.video.submit(
      video(
        { inputs: [ref('reference_image'), ref('reference_audio')], resolution: '768P', duration_seconds: 5 },
        'MiniMax-H3-Max'
      ),
      h.ctx
    )
  );
  assert.equal(created.state, 'pending');
  assert.deepEqual(
    body(h.calls[0])
      .content.map((i) => i.role)
      .filter(Boolean),
    ['reference_image', 'reference_audio']
  );
  const downloadPending = outcome(await h.adapters.video.poll(created.handle, h.ctx));
  assert.equal(downloadPending.state, 'pending');
  assert.equal(downloadPending.phase, 'download');
  assert.equal(outcome(await h.adapters.video.poll(downloadPending.handle, h.ctx)).state, 'complete');
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'DELETE').length, 0);
  assert.equal(h.adapters.video.cancel, undefined);
  for (const r of [
    video({ resolution: '2K' }, 'MiniMax-H3-Max'),
    video({ duration_seconds: 4 }, 'MiniMax-H3-Max'),
    video({ inputs: Array.from({ length: 10 }, () => ref('reference_image')) }),
    video({ inputs: [ref('first_frame')], aspect_ratio: '16:9' }),
    video({ inputs: [ref('first_frame'), ref('reference_image')] }),
  ])
    assert.equal((await h.adapters.video.submit(r, h.ctx)).error.submission, 'not_sent');
});
await test('MiniMax SSE terminal/exclude-aggregate body and byte order', async () => {
  const h = await harness('minimax', [
    sse([
      { data: { audio: '0102', status: 1 }, base_resp: { status_code: 0 } },
      { data: { audio: '0304', status: 2 }, base_resp: { status_code: 0 }, extra_info: { usage_characters: 4 } },
    ]),
  ]);
  const result = outcome(await h.adapters.speech.submit(speech({ language: 'zh', options: { stream: true } }), h.ctx));
  assert.equal(result.state, 'complete');
  assert.equal(body(h.calls[0]).stream_options.exclude_aggregated_audio, true);
  assert.equal(body(h.calls[0]).language_boost, 'Chinese');
  assert.deepEqual(await readFile(result.artifacts[0].path), Buffer.from([1, 2, 3, 4]));
  assert.equal(result.usage.usage_characters, 4);
});
await test('MiniMax JSON fallback, odd hex, API error, EOF partial and subtitle failure retain audio', async () => {
  const cases = [
    { response: json({ data: { audio: '0102', status: 2 }, base_resp: { status_code: 0 } }), state: 'complete' },
    { response: json({ data: { audio: '123', status: 2 }, base_resp: { status_code: 0 } }), state: 'failed' },
    { response: json({ base_resp: { status_code: 1008, status_msg: 'Insufficient balance' } }), state: 'failed' },
    { response: sse([{ data: { audio: '0102', status: 1 } }]), state: 'failed', partial: true },
  ];
  for (const c of cases) {
    const h = await harness('minimax', [c.response]);
    const result = outcome(await h.adapters.speech.submit(speech({ options: { stream: true } }), h.ctx));
    assert.equal(result.state, c.state);
    if (c.partial) {
      assert.equal(result.artifacts[0].complete, false);
      assert.equal(result.error.submission, 'accepted');
    }
  }
  const h = await harness('minimax', [
    json({ data: { audio: '0102', status: 2, subtitle_file: 'https://cdn.example.test/subtitles.json' } }),
    new Response('unavailable', { status: 503 }),
  ]);
  const result = outcome(await h.adapters.speech.submit(speech({ options: { subtitle_enable: true } }), h.ctx));
  assert.equal(result.state, 'failed');
  assert.equal(result.error.code, 'subtitle_failed');
  assert.equal(result.artifacts[0].complete, true);
  const unused = await harness('minimax', []);
  assert.equal(
    (await unused.adapters.speech.submit(speech({ text: 'x'.repeat(10000) }), unused.ctx)).error.submission,
    'not_sent'
  );
  assert.equal(unused.calls.length, 0);
});
await test('StepFun binary/SSE snake_case/sample rate and EOF/invalid base64 are not success', async () => {
  const h = await harness('stepfun', [
    sse([
      { type: 'speech.audio.delta', audio: 'AQI=' },
      { type: 'speech.audio.done', audio: '' },
    ]),
  ]);
  const result = outcome(
    await h.adapters.speech.submit(
      speech({ language: 'zh', sample_rate_hz: 48000, options: { stream_format: 'sse', instruction: 'calm' } }),
      h.ctx
    )
  );
  assert.equal(result.state, 'complete');
  assert.equal(body(h.calls[0]).sample_rate, 48000);
  assert.equal(body(h.calls[0]).instruction, 'calm');
  assert.deepEqual(await readFile(result.artifacts[0].path), Buffer.from([1, 2]));
  for (const response of [
    sse([{ type: 'speech.audio.delta', audio: 'AQI=' }]),
    sse([{ type: 'speech.audio.delta', audio: 'bad' }, { type: 'speech.audio.done' }]),
    sse(['[DONE]']),
  ]) {
    const broken = await harness('stepfun', [response]);
    assert.equal(
      outcome(await broken.adapters.speech.submit(speech({ options: { stream_format: 'sse' } }), broken.ctx)).state,
      'failed'
    );
  }
  const noPost = await h.adapters.speech.submit(speech({ text: 'x'.repeat(1001) }), h.ctx);
  assert.equal(noPost.error.submission, 'not_sent');
});
await test('Novita compatibility body, duration and all downloaded original outputs', async () => {
  const h = await harness(
    'novita',
    [
      json({ task_id: 'novita-task' }),
      json({
        task: { status: 'TASK_STATUS_SUCCEED' },
        videos: [{ video_url: 'https://cdn.example.test/a.mp4' }, { video_url: 'https://cdn.example.test/b.mp4' }],
      }),
      binary(),
      binary(),
    ],
    { videoModel: 'endpoint-model' }
  );
  const created = outcome(await h.adapters.video.submit(video({ duration_seconds: 10 }), h.ctx));
  assert.equal(body(h.calls[0]).duration, '10');
  const result = outcome(await h.adapters.video.poll(created.handle, h.ctx));
  assert.equal(result.artifacts.length, 2);
  assert.ok(h.calls[1].url.includes('/async/task-result?task_id='));
  assert.equal((await h.adapters.video.submit(video({ duration_seconds: 7 }), h.ctx)).error.submission, 'not_sent');
});
await test('Agnes donor body oracle, explicit reference mode/root poll, Flash and V2.0 counterexamples', async () => {
  const h = await harness('agnes', [
    json({ video_id: 'agnes-task' }),
    json({ status: 'completed', metadata: { url: 'https://cdn.example.test/agnes.mp4' } }),
    binary(),
  ]);
  const created = outcome(
    await h.adapters.video.submit(
      video({ inputs: [ref('first_frame')], duration_seconds: 5, aspect_ratio: '16:9', resolution: '720P' }),
      h.ctx
    )
  );
  assert.deepEqual(body(h.calls[0]), {
    model: 'agnes-video-2.5',
    prompt: 'A slow camera move',
    mode: 'keyframe',
    seconds: '5',
    size: '720P',
    aspect_ratio: '16:9',
    n: 1,
    first_frame: 'https://cdn.example.test/input.png',
  });
  assert.equal(outcome(await h.adapters.video.poll(created.handle, h.ctx)).state, 'complete');
  assert.equal(h.calls[1].url, 'https://api.example.test/agnesapi?video_id=agnes-task&model_name=agnes-video-2.5');
  for (const r of [
    video({ resolution: '2K' }, 'agnes-video-2.5-flash'),
    video({ inputs: [ref('reference_video')] }, 'agnes-video-2.5-flash'),
    video({ duration_seconds: 15 }),
    video({ duration_seconds: 5 }, 'agnes-video-v2.0'),
  ])
    assert.equal((await h.adapters.video.submit(r, h.ctx)).error.submission, 'not_sent');
});
await test('NewAPI native reference arrays/audio dependency and succeeded nested response', async () => {
  const h = await harness(
    'newapi',
    [
      json({ data: { id: 'newapi-task' } }),
      json({ data: { status: 'SUCCESS', result_url: 'https://cdn.example.test/newapi.mp4' } }),
      binary(),
    ],
    { videoModel: 'gateway-model' }
  );
  const created = outcome(
    await h.adapters.video.submit(
      video({ inputs: [ref('reference_image'), ref('reference_video'), ref('reference_audio')] }),
      h.ctx
    )
  );
  assert.equal(body(h.calls[0]).audio_urls.length, 1);
  assert.equal(body(h.calls[0]).video_urls.length, 1);
  assert.equal(outcome(await h.adapters.video.poll(created.handle, h.ctx)).state, 'complete');
  assert.equal(
    (await h.adapters.video.submit(video({ inputs: [ref('reference_audio')] }), h.ctx)).error.submission,
    'not_sent'
  );
  assert.equal(
    (await h.adapters.video.submit(video({ inputs: [ref('first_frame')] }), h.ctx)).error.submission,
    'not_sent'
  );
});
await test('ComfyUI upload/binding/prompt, transient empty history and all outputs', async () => {
  const h = await harness('comfyui', [
    json({ name: 'input.png' }),
    json({ prompt_id: 'comfy-task' }),
    json({ 'comfy-task': { status: { completed: true, status_str: 'success' }, outputs: {} } }),
    json({
      'comfy-task': {
        status: { completed: true, status_str: 'success' },
        outputs: {
          9: { images: [{ filename: 'a.png' }] },
          10: { videos: [{ filename: 'a.mp4' }, { filename: 'b.mp4' }] },
        },
      },
    }),
    binary(png, 'image/png'),
    binary(),
    binary(),
  ]);
  const request = image({
    images: [{ path: path.join(scratch, 'fixture.png') }],
    options: {
      workflow: { 6: { inputs: { text: '' } }, 7: { inputs: { image: '' } } },
      prompt_binding: { node: '6', input: 'text' },
      input_bindings: [{ node: '7', input: 'image', role: 'reference_image' }],
    },
  });
  const created = outcome(await h.adapters.workflow.submit(request, h.ctx));
  assert.equal(created.state, 'pending');
  assert.ok(h.calls[0].body instanceof FormData);
  assert.equal(body(h.calls[1]).prompt['6'].inputs.text, 'A simple shape');
  assert.equal(body(h.calls[1]).prompt['7'].inputs.image, 'input.png');
  const empty = outcome(await h.adapters.workflow.poll(created.handle, h.ctx));
  assert.equal(empty.state, 'pending');
  const result = outcome(await h.adapters.workflow.poll(empty.handle, h.ctx));
  assert.equal(result.artifacts.length, 3);
  assert.equal(result.artifacts.filter((a) => a.kind === 'video').length, 2);
  assert.equal(h.adapters.workflow.cancel, undefined);
});
await test('Transport boundaries: POST unknown, no retries, GET transient handle retention, atomics/auth', async () => {
  const lost = await harness('minimax', [new Error('socket lost')]);
  const result = outcome(await lost.adapters.video.submit(video(), lost.ctx));
  assert.equal(result.error.submission, 'unknown');
  assert.equal(lost.calls.length, 1);
  const query = await harness('minimax', [new Response('busy', { status: 429 })]);
  const remote = { version: 1, data: { id: 'accepted-task', model: 'MiniMax-H3' } };
  assert.deepEqual(outcome(await query.adapters.video.poll(remote, query.ctx)).handle, remote);
  const { runtime } = await import('../runtime.mjs');
  const h = await harness('openai', [
    new Response(Buffer.from('x'), { headers: { 'content-length': '4', 'content-type': 'video/mp4' } }),
    binary(),
  ]);
  const rt = await runtime(h.ctx, async (url, init) => {
    h.calls.push({ url, ...init });
    return h.calls.length === 1 ? new Response(Buffer.from('x'), { headers: { 'content-length': '4' } }) : binary();
  });
  const existing = path.join(h.ctx.stagingDir, 'video.mp4');
  await writeFile(existing, 'original');
  await assert.rejects(rt.download('https://cdn.example.test/video.mp4', 'video.mp4', 'video'), /truncated/);
  assert.equal(await readFile(existing, 'utf8'), 'original');
  await rt.download('https://cdn.example.test/video.mp4', 'video.mp4', 'video');
  assert.equal(new Headers(h.calls.at(-1).headers).get('authorization'), null);
  const controller = new AbortController();
  controller.abort();
  const aborted = await h.adapters.image.submit(image(), { ...h.ctx, signal: controller.signal });
  assert.equal(aborted.state, 'failed');
});

await test('All isolated install directories load/register through actual hostRunner and unique SDK schemas', async () => {
  const vendors = ['openai', 'google', 'ark', 'xai', 'minimax', 'stepfun', 'novita', 'agnes', 'newapi', 'comfyui'];
  let registrations = 0;
  for (const vendor of vendors) {
    const directory = await mkdtemp(path.join(scratch, 'installed-'));
    await cp(path.join(official, `kiki-media-${vendor}`), directory, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(directory, 'kimi.plugin.json'), 'utf8'));
    assert.ok((await readFile(path.join(directory, 'runtime.mjs'), 'utf8')).startsWith('// GENERATED'));
    assert.match(await readFile(path.join(directory, 'LICENSE'), 'utf8'), /Permission is hereby granted/);
    const entry = await import(pathToFileURL(path.join(directory, 'entry.mjs')));
    const registered = [];
    entry.register({
      registerMediaProvider(definition, adapter) {
        mediaProviderDefinitionSchema.parse(definition);
        registered.push({ definition, adapter });
      },
    });
    assert.equal(registered.length, manifest['x-kiki'].mediaProviders.length);
    registrations += registered.length;
    for (const registration of registered)
      mediaCapabilitiesSchema.parse(
        await registration.adapter.describe({}, { settings: {}, signal: new AbortController().signal })
      );
    const runner = path.join(root, 'packages', 'agent-core-v2', 'src', 'app', 'plugin', 'hostRunner.mjs');
    const child = spawn(process.execPath, [runner, path.join(directory, 'entry.mjs')], {
      cwd: directory,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const received = [];
    const waiting = [];
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      received.push(message);
      for (const waiter of [...waiting])
        if (waiter.predicate(message)) {
          waiting.splice(waiting.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
    });
    const wait = (predicate) => {
      const old = received.find(predicate);
      if (old) return Promise.resolve(old);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Host RPC timeout: ${stderr}`)), 10000);
        waiting.push({ predicate, resolve, timer });
      });
    };
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    try {
      send({ id: 1, method: 'handshake', params: { version: 1 } });
      await wait((m) => m.method === 'ready' || m.method === 'register-error');
      assert.equal(
        received.some((m) => m.method === 'register-error'),
        false,
        stderr
      );
      assert.equal(received.filter((m) => m.method === 'register-media-provider').length, registered.length);
      send({
        id: 2,
        method: 'media-provider-request',
        params: {
          providerId: registered[0].definition.id,
          action: 'describe',
          input: {},
          settings: {},
          jobId: 'fixture-job',
          stagingDir: directory,
        },
      });
      const response = await wait((m) => m.id === 2);
      assert.equal(response.error, undefined, JSON.stringify(response));
      mediaCapabilitiesSchema.parse(response.result);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('close', resolve));
    }
  }
  assert.equal(registrations, 16);
});

await test('Every async family preserves failure terminal rather than waiting forever', async () => {
  const cases = [
    ['google', json({ done: true, error: { code: 3, message: 'generation rejected' } })],
    ['ark', json({ status: 'expired' })],
    ['xai', json({ status: 'failed', error: { code: 'invalid_argument', message: 'invalid media' } })],
    ['minimax', json({ task: { status: 'expired' } })],
    ['novita', json({ task: { status: 'TASK_STATUS_FAILED', reason: 'generation failed' } })],
    ['agnes', json({ status: 'failed', message: 'generation failed' })],
    ['newapi', json({ data: { status: 'FAILURE', fail_reason: 'generation failed' } })],
    ['comfyui', json({ 'remote-id': { status: { completed: true, status_str: 'error', messages: ['failed'] } } })],
  ];
  for (const [vendor, response] of cases) {
    const h = await harness(vendor, [response]);
    const adapter = h.adapters.video ?? h.adapters.workflow;
    const id = vendor === 'google' ? 'operations/remote-id' : 'remote-id';
    const result = outcome(await adapter.poll({ version: 1, data: { id, model: 'fixture' } }, h.ctx));
    assert.equal(result.state, 'failed', vendor);
    assert.equal(result.error.submission, 'accepted', vendor);
    assert.equal(h.calls.length, 1);
    assert.equal(adapter.cancel, undefined);
  }
});
await test('Image partial outputs, MiniMax subtitle JSON/SRT milliseconds and voices preserve data', async () => {
  const partial = await harness('openai', [
    json({ data: [{ b64_json: png.toString('base64') }, { b64_json: 'invalid' }] }),
  ]);
  const result = outcome(await partial.adapters.image.submit(image(), partial.ctx));
  assert.equal(result.state, 'failed');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].complete, true);
  assert.equal(result.error.items.length, 1);
  const h = await harness('minimax', [
    json({ data: { audio: '0102', status: 2, subtitle_file: 'https://cdn.example.test/subtitle.json' } }),
    json([{ text: 'First sentence', time_begin: 999.8, time_end: 1500 }]),
    json({ system_voice: [{ voice_id: 'voice-a', voice_name: 'Voice A' }] }),
  ]);
  const audio = outcome(await h.adapters.speech.submit(speech({ options: { subtitle_enable: true } }), h.ctx));
  assert.equal(audio.state, 'complete');
  assert.equal(audio.artifacts.length, 3);
  assert.equal(await readFile(audio.artifacts[2].path, 'utf8'), '1\n00:00:01,000 --> 00:00:01,500\nFirst sentence');
  assert.equal(new Headers(h.calls[1].headers).get('authorization'), null);
  assert.deepEqual(await h.adapters.speech.voices({}, h.ctx), {
    voices: [{ id: 'voice-a', label: 'Voice A' }],
    cursor: null,
  });
  assert.equal(body(h.calls[2]).voice_type, 'system');
});
await test('OpenAI binary chunked audio preserves interrupted/cancelled bytes as incomplete, not success', async () => {
  const controller = new AbortController();
  let stage = 0;
  const interrupted = new Response(
    new ReadableStream({
      pull(stream) {
        if (stage++ === 0) stream.enqueue(new Uint8Array([1, 2]));
        else stream.error(new Error('Unexpected EOF'));
      },
    }),
    { headers: { 'content-type': 'audio/mpeg' } }
  );
  const h = await harness('openai', [interrupted]);
  const result = outcome(await h.adapters.speech.submit(speech(), h.ctx));
  assert.equal(result.state, 'failed');
  assert.equal(result.error.submission, 'accepted');
  assert.equal(result.artifacts[0].complete, false);
  assert.deepEqual(await readFile(result.artifacts[0].path), Buffer.from([1, 2]));
  let sent = false;
  const cancellation = new Response(
    new ReadableStream({
      pull(stream) {
        if (!sent) {
          sent = true;
          stream.enqueue(new Uint8Array([3, 4]));
        } else {
          controller.abort();
          stream.enqueue(new Uint8Array([5, 6]));
          stream.close();
        }
      },
    }),
    { headers: { 'content-type': 'audio/mpeg' } }
  );
  const stopped = await harness('openai', [cancellation]);
  const cancelled = outcome(
    await stopped.adapters.speech.submit(speech(), { ...stopped.ctx, signal: controller.signal })
  );
  assert.equal(cancelled.state, 'failed');
  assert.equal(cancelled.error.submission, 'accepted');
  assert.equal(cancelled.error.code, 'local_stopped');
  const tooShort = await harness('openai', [
    new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg', 'content-length': '4' } }),
  ]);
  assert.equal(outcome(await tooShort.adapters.speech.submit(speech(), tooShort.ctx)).state, 'failed');
});
await test('Installed host RPC executes image/speech/video with fake HTTP, never workspace-only imports', async () => {
  const preloader = path.join(scratch, 'host-fake-http.mjs');
  await writeFile(
    preloader,
    `const png = '${png.toString(
      'base64'
    )}';\nglobalThis.fetch = async (url, init = {}) => {\n const pathname = new URL(url).pathname;\n const json = (body) => new Response(JSON.stringify(body), {headers:{'content-type':'application/json'}});\n if (pathname.endsWith('/images/generations')) return json({data:[{b64_json:png}]});\n if (pathname.endsWith('/audio/speech')) return new Response(new Uint8Array([1,2,3]), {headers:{'content-type':'audio/mpeg'}});\n if (pathname.endsWith('/v2/video_generation')) return json({task_id:'host-video'});\n if (pathname.endsWith('/query/video_generation/host-video')) return json({task:{status:'succeeded',content:{url:'https://download.example.test/result.mp4'}}});\n if (url === 'https://download.example.test/result.mp4') return new Response(new Uint8Array([4,5,6]), {headers:{'content-type':'video/mp4'}});\n throw new Error('Fixture denies all other HTTP calls: '+url);\n};\n`
  );
  for (const vendor of ['openai', 'minimax']) {
    const directory = await mkdtemp(path.join(scratch, 'rpc-installed-'));
    await cp(path.join(official, `kiki-media-${vendor}`), directory, { recursive: true });
    const runner = path.join(root, 'packages', 'agent-core-v2', 'src', 'app', 'plugin', 'hostRunner.mjs');
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(preloader).href, runner, path.join(directory, 'entry.mjs')],
      { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const reader = createInterface({ input: child.stdout });
    const messages = [];
    const queue = [];
    reader.on('line', (line) => {
      const value = JSON.parse(line);
      messages.push(value);
      for (const w of [...queue])
        if (w.predicate(value)) {
          queue.splice(queue.indexOf(w), 1);
          clearTimeout(w.timer);
          w.resolve(value);
        }
    });
    const wait = (predicate) => {
      const known = messages.find(predicate);
      return known
        ? Promise.resolve(known)
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('RPC did not reply')), 10000);
            queue.push({ predicate, resolve, timer });
          });
    };
    const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    let id = 1;
    const request = async (providerId, action, input, settings = { apiKey: 'YOUR_API_KEY' }) => {
      const requestId = ++id;
      send({
        id: requestId,
        method: 'media-provider-request',
        params: {
          providerId,
          action,
          input,
          settings,
          jobId: 'host-fixture',
          stagingDir: path.join(directory, 'outputs'),
        },
      });
      const reply = await wait((m) => m.id === requestId);
      assert.equal(reply.error, undefined);
      return outcome(reply.result);
    };
    try {
      send({ id: 1, method: 'handshake', params: { version: 1 } });
      await wait((m) => m.method === 'ready');
      if (vendor === 'openai') {
        const missing = await request('image', 'submit', image(), {});
        assert.equal(missing.error.submission, 'not_sent');
        assert.equal(missing.error.code, 'needs_configuration');
        const img = await request('image', 'submit', image());
        assert.equal(img.state, 'complete');
        assert.deepEqual(await readFile(img.artifacts[0].path), png);
        const audio = await request('speech', 'submit', speech());
        assert.equal(audio.state, 'complete');
        assert.deepEqual(await readFile(audio.artifacts[0].path), Buffer.from([1, 2, 3]));
      } else {
        const created = await request('video', 'submit', video());
        assert.equal(created.state, 'pending');
        const completed = await request('video', 'poll', created.handle);
        assert.equal(completed.state, 'complete');
        assert.deepEqual(await readFile(completed.artifacts[0].path), Buffer.from([4, 5, 6]));
      }
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('close', resolve));
    }
  }
});

await test('Selected connection replaces endpoint/key, rotates opaque headers and never falls back', async () => {
  const h = await harness('openai', Array.from({ length: 3 }, () => json({ data: [{ b64_json: png.toString('base64') }] })), { connectionId: 'fixture-connection' });
  let rotation = 0;
  h.ctx.connection = async () => ({ id: 'fixture-connection', baseUrl: 'https://selected.example.test/custom/v1', authentication: 'oauth', headers: { Authorization: `Bearer rotated-${++rotation}`, 'x-account-id': 'synthetic-account' } });
  for (let i = 1; i <= 2; i++) {
    const result = outcome(await h.adapters.image.submit(image(), h.ctx));
    assert.equal(result.state, 'complete');
    assert.equal(h.calls[i - 1].url, 'https://selected.example.test/custom/v1/images/generations');
    const headers = new Headers(h.calls[i - 1].headers);
    assert.equal(headers.get('authorization'), `Bearer rotated-${i}`);
    assert.equal(headers.get('x-account-id'), 'synthetic-account');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.doesNotMatch(JSON.stringify(result), /rotated-|synthetic-account|YOUR_API_KEY/);
  }
  const own = { ...h.ctx, settings: { ...h.ctx.settings, connectionId: '' }, connection() { throw new Error('Must not call an unselected helper'); } };
  assert.equal(outcome(await h.adapters.image.submit(image(), own)).state, 'complete');
  assert.equal(h.calls[2].url, 'https://api.example.test/v1/images/generations');
  assert.equal(new Headers(h.calls[2].headers).get('authorization'), 'Bearer YOUR_API_KEY');
  for (const resolver of [async () => { throw new Error('Secret resolver error'); }, async () => undefined, async () => ({ id: 'bad-endpoint', headers: {}, authentication: 'none' })]) {
    const result = outcome(await h.adapters.image.submit(image(), { ...h.ctx, connection: resolver }));
    assert.equal(result.state, 'failed');
    assert.equal(result.error.submission, 'not_sent');
    assert.doesNotMatch(JSON.stringify(result), /Secret resolver error|YOUR_API_KEY/);
  }
  assert.equal(h.calls.length, 3);
});
await test('Google connection uses its x-goog-api-key on API and vendor-authenticated video download', async () => {
  const h = await harness('google', [json({ name: 'operations/selected' }), json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://cdn.example.test/selected.mp4' } }] } } }), binary()], { connectionId: 'google-fixture' });
  h.ctx.connection = async () => ({ id: 'google-fixture', type: 'google', authentication: 'api-key', baseUrl: 'https://google.example.test/custom/v1beta', headers: { 'x-goog-api-key': 'selected-google-key' } });
  const created = outcome(await h.adapters.video.submit(video(), h.ctx));
  assert.equal(created.state, 'pending');
  assert.equal(outcome(await h.adapters.video.poll(created.handle, h.ctx)).state, 'complete');
  for (const call of h.calls) {
    assert.equal(new Headers(call.headers).get('x-goog-api-key'), 'selected-google-key');
    assert.equal(new Headers(call.headers).get('authorization'), null);
  }
  assert.equal(h.calls[0].url, 'https://google.example.test/custom/v1beta/models/veo-3.1-generate-preview:predictLongRunning');
});
await test('MiniMax connection normalizes only its version suffix while preserving endpoint prefix', async () => {
  for (const version of ['v1', 'v2']) {
    const h = await harness('minimax', [json({ data: { image_base64: [png.toString('base64')] } }), json({ task_id: 'selected-mini' })], { connectionId: 'mini-fixture' });
    h.ctx.connection = async () => ({ id: 'mini-fixture', baseUrl: `https://mini.example.test/custom/${version}`, authentication: 'api-key', headers: { Authorization: 'Bearer selected-mini-key' } });
    assert.equal(outcome(await h.adapters.image.submit(image(), h.ctx)).state, 'complete');
    const created = outcome(await h.adapters.video.submit(video(), h.ctx));
    assert.equal(created.state, 'pending');
    assert.equal(h.calls[0].url, 'https://mini.example.test/custom/v1/image_generation');
    assert.equal(h.calls[1].url, 'https://mini.example.test/custom/v2/video_generation');
    assert.doesNotMatch(JSON.stringify(created), /selected-mini-key|YOUR_API_KEY/);
    for (const call of h.calls) assert.equal(new Headers(call.headers).get('authorization'), 'Bearer selected-mini-key');
  }
});
await test('Selected authentication is not sent when reading a user input URL even on API origin', async () => {
  const h = await harness('openai', [binary(png, 'image/png'), json({ data: [{ b64_json: png.toString('base64') }] })], { connectionId: 'selected' });
  h.ctx.connection = async () => ({ id: 'selected', baseUrl: 'https://selected.example.test/custom/v1', headers: { Authorization: 'Bearer selected-key' }, authentication: 'api-key' });
  assert.equal(outcome(await h.adapters.image.submit(image({ images: [{ url: 'https://selected.example.test/input.png' }] }), h.ctx)).state, 'complete');
  assert.equal(new Headers(h.calls[0].headers).get('authorization'), null);
  assert.equal(new Headers(h.calls[1].headers).get('authorization'), 'Bearer selected-key');
});
await test('Actual installed host RPC resolves API-key and rotating synthetic OAuth; arbitrary scripts skip helper', async () => {
  const preloader = path.join(scratch, 'connection-fake-http.mjs');
  await writeFile(preloader, `import assert from 'node:assert/strict';
const expected = ['Bearer connected-key','Bearer oauth-1','Bearer oauth-2','Bearer YOUR_API_KEY'];
let index = 0;
globalThis.fetch = async (url, init) => {
 const headers = new Headers(init.headers);
 assert.equal(headers.get('authorization'), expected[index]);
 assert.equal(headers.get('content-type'), 'application/json');
 assert.equal(headers.get('x-account-id'), index === 1 || index === 2 ? 'synthetic-account' : null);
 assert.equal(url, index === 3 ? 'https://api.openai.com/v1/images/generations' : 'https://selected.example.test/custom/v1/images/generations');
 index++;
 return new Response(JSON.stringify({data:[{b64_json:'${png.toString('base64')}'}]}), {headers:{'content-type':'application/json'}});
};`);
  for (const arbitrary of [false, true]) {
    const directory = await mkdtemp(path.join(scratch, 'connection-installed-'));
    if (!arbitrary) await cp(path.join(official, 'kiki-media-openai'), directory, { recursive: true });
    else await writeFile(path.join(directory, 'entry.mjs'), `import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
export function register(api) { api.registerMediaProvider({schemaVersion:1,id:'custom',label:'Independent script',kinds:['image'],resumeVersion:1}, {async describe() { return {}; }, async submit(input,ctx) {await mkdir(ctx.stagingDir,{recursive:true}); const file=path.join(ctx.stagingDir,'custom.png'); await writeFile(file,Buffer.from('${png.toString('base64')}','base64')); return {state:'complete',artifacts:[{path:file,name:'custom.png',mime:'image/png',kind:'image',role:'original',complete:true}]};}}); }`);
    const runner = path.join(root, 'packages', 'agent-core-v2', 'src', 'app', 'plugin', 'hostRunner.mjs');
    const child = spawn(process.execPath, ['--import', pathToFileURL(preloader).href, runner, path.join(directory, 'entry.mjs')], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    const reader = createInterface({ input: child.stdout });
    const messages = [], queue = [];
    let connectionCalls = 0, oauthRotation = 0, mode = 'api-key', stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    reader.on('line', line => {
      const value = JSON.parse(line);
      messages.push(value);
      if (value.method === 'media-call' && value.params.action === 'connection') {
        connectionCalls++;
        const headers = mode === 'api-key' ? { Authorization: 'Bearer connected-key' } : { Authorization: `Bearer oauth-${++oauthRotation}`, 'x-account-id': 'synthetic-account' };
        send({ method: 'media-result', params: { callId: value.params.callId, result: { id: 'selected', authentication: mode, baseUrl: 'https://selected.example.test/custom/v1', headers } } });
      }
      for (const waiter of [...queue]) if (waiter.predicate(value)) { queue.splice(queue.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(value); }
    });
    const wait = predicate => {
      const known = messages.find(predicate);
      return known ? Promise.resolve(known) : new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Connection host RPC timeout: ${stderr}`)), 10000); queue.push({ predicate, resolve, timer }); });
    };
    let id = 1;
    const submit = async settings => {
      const requestId = ++id;
      send({ id: requestId, method: 'media-provider-request', params: { providerId: arbitrary ? 'custom' : 'image', action: 'submit', input: image(), settings, jobId: 'connection-host-fixture', stagingDir: path.join(directory, 'outputs') } });
      const reply = await wait(message => message.id === requestId);
      assert.equal(reply.error, undefined, JSON.stringify(reply));
      const result = outcome(reply.result);
      assert.equal(result.state, 'complete', JSON.stringify(result));
      assert.deepEqual(await readFile(result.artifacts[0].path), png);
      assert.doesNotMatch(JSON.stringify(result), /connected-key|oauth-[12]|synthetic-account|YOUR_API_KEY/);
    };
    try {
      send({ id: 1, method: 'handshake', params: { version: 1 } });
      await wait(message => message.method === 'ready' || message.method === 'register-error');
      assert.equal(messages.some(message => message.method === 'register-error'), false, stderr);
      if (arbitrary) { await submit({}); assert.equal(connectionCalls, 0); }
      else {
        const registered = messages.find(message => message.method === 'register-media-provider');
        assert.equal(registered.params.definition.connectionSetting, 'connectionId');
        await submit({ connectionId: 'selected' });
        mode = 'oauth';
        await submit({ connectionId: 'selected', apiKey: 'OWN-MUST-NOT-MIX', baseUrl: 'https://own.example.test/v1' });
        await submit({ connectionId: 'selected' });
        await submit({ apiKey: 'YOUR_API_KEY' });
        assert.equal(connectionCalls, 3);
        assert.equal(oauthRotation, 2);
      }
    } finally { child.stdin.end(); await new Promise(resolve => child.once('close', resolve)); }
  }
});

await test('Native fetch redirect boundary preserves originals without forwarding synthetic credentials', async (t) => {
  const { createServer } = await import('node:http');
  const { runtime } = await import('../runtime.mjs');
  const sourceCalls = [], targetCalls = [];
  let sourceUrl, targetUrl;
  const source = createServer((request, response) => {
    sourceCalls.push({ path: request.url, method: request.method, headers: request.headers });
    if (request.url === '/original') { response.writeHead(200, { 'content-type': 'image/png' }); response.end(png); }
    else if (request.url === '/same-download') { response.writeHead(302, { location: '/original' }); response.end(); }
    else if (request.url === '/loop') { response.writeHead(302, { location: '/loop' }); response.end(); }
    else { response.writeHead(307, { location: `${targetUrl}${request.url === '/chain' ? '/back' : '/original'}` }); response.end(); }
  });
  const target = createServer((request, response) => {
    targetCalls.push({ path: request.url, method: request.method, headers: request.headers });
    if (request.url === '/back') { response.writeHead(302, { location: `${sourceUrl}/original` }); response.end(); }
    else { response.writeHead(200, { 'content-type': 'image/png' }); response.end(png); }
  });
  /** @type {(server: import('node:http').Server) => Promise<string>} */
  const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') { reject(new Error('Expected a TCP listening address')); return; }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  try {
    sourceUrl = await listen(source);
    targetUrl = await listen(target);
    const stagingDir = await mkdtemp(path.join(scratch, 'native-redirect-'));
    const credentials = { Authorization: 'Bearer synthetic-only', 'x-goog-api-key': 'synthetic-google-key', 'x-grok-identity': 'synthetic-identity', 'x-account-id': 'synthetic-account' };
    const rt = await runtime({ settings: { connectionId: 'synthetic-connection' }, connection: async () => ({ id: 'synthetic-connection', baseUrl: sourceUrl, authentication: 'api-key', headers: credentials }), signal: new AbortController().signal, stagingDir });
    // Real Node fetch, not an injected mock: this fails on the original helper,
    // where custom API-key and identity fields reach the second localhost origin.
    await assert.rejects(rt.json(`${sourceUrl}/api-redirect`, { prompt: 'synthetic' }), error => error.code === 'http_redirect' && error.submission === 'unknown');
    assert.equal(targetCalls.length, 0, JSON.stringify(targetCalls));
    assert.equal(sourceCalls[0].headers['x-goog-api-key'], credentials['x-goog-api-key']);
    assert.equal(sourceCalls[0].headers['content-type'], 'application/json');
    await assert.rejects(rt.json(`${sourceUrl}/same-download`), error => error.code === 'http_redirect');
    const same = await rt.download(`${sourceUrl}/same-download`, 'same.png', 'image');
    assert.deepEqual(await readFile(same.path), png);
    const sameFinal = sourceCalls.at(-1);
    assert.equal(sameFinal.path, '/original');
    for (const [name, value] of Object.entries(credentials)) assert.equal(sameFinal.headers[name.toLowerCase()], value);
    const cross = await rt.download(`${sourceUrl}/cross-download`, 'cross.png', 'image');
    assert.deepEqual(await readFile(cross.path), png);
    for (const name of Object.keys(credentials)) assert.equal(targetCalls.at(-1).headers[name.toLowerCase()], undefined);
    // Google-style explicit authentication on a download origin outside baseUrl.
    const external = await rt.download(`${targetUrl}/back`, 'external.png', 'image', credentials);
    assert.deepEqual(await readFile(external.path), png);
    for (const [name, value] of Object.entries(credentials)) assert.equal(targetCalls.at(-1).headers[name.toLowerCase()], value);
    for (const name of Object.keys(credentials)) assert.equal(sourceCalls.at(-1).headers[name.toLowerCase()], undefined);
    // Crossing once must not silently reattach auth if the chain returns to API origin.
    const chain = await rt.download(`${sourceUrl}/chain`, 'chain.png', 'image');
    assert.deepEqual(await readFile(chain.path), png);
    for (const name of Object.keys(credentials)) {
      assert.equal(targetCalls.at(-1).headers[name.toLowerCase()], undefined);
      assert.equal(sourceCalls.at(-1).headers[name.toLowerCase()], undefined);
    }
    const input = await rt.bytes({ url: `${sourceUrl}/input` });
    assert.deepEqual(input.data, png);
    for (const name of Object.keys(credentials)) assert.equal(targetCalls.at(-1).headers[name.toLowerCase()], undefined);
    const cdn = await rt.download(`${targetUrl}/back`, 'cdn.png', 'image');
    assert.deepEqual(await readFile(cdn.path), png);
    for (const name of Object.keys(credentials)) assert.equal(sourceCalls.at(-1).headers[name.toLowerCase()], undefined);
    await assert.rejects(rt.download(`${sourceUrl}/loop`, 'loop.png', 'image'), error => error.code === 'redirect_failed');
    t.diagnostic('Native localhost: API redirect rejected, same-origin auth retained, cross-origin headers cleared, user-input/CDN originals preserved.');
  } finally { await Promise.all([close(source), close(target)]); }
});
