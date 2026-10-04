/**
 * media-sources — the media surface with the states a reader actually meets.
 *
 * Small enough to read every row, real enough that each row is a different
 * situation rather than a copy: a healthy default, one that still needs a key,
 * one whose package failed to load, one that is switched off, one with no
 * settings at all (a script that manages its own environment — which is
 * *ready*, not broken), and one held up by a job waiting for it to come back.
 *
 * The jobs are the honesty case. Between them they cover every state the view
 * has to tell apart, and two of them exist specifically to catch a view that
 * overclaims:
 *
 *   - one with `submission: 'unknown'`, which must never offer a retry
 *     (a retry is a second bill against a provider that may have taken the
 *     first) and must not be drawn as a plain failure;
 *   - one stopped with `remote: 'unsupported'`, which stopped the local wait
 *     only — the row must say the vendor may still be generating, not imply a
 *     cancellation or a refund.
 *
 * Artifacts carry a `file_id`, never a path: the SDK drops `path` from the
 * public artifact so a file the provider wrote in its staging directory is
 * never mistaken for a file the reader may open.
 *
 * The bytes behind those ids are real. `fixtures/media-bytes/` holds a genuine
 * PNG and a genuine WAV, generated locally rather than downloaded, and they
 * are served through the real session-media routes. That is what makes a
 * preview and a play button observable instead of decorative: an artifact
 * whose bytes are missing renders as a permanent "Loading…", which is a
 * fixture gap dressed as a working surface. No vendor, no network, no payment.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_media';
const AID = 'agent_fixture_media';

const definition = (id, kinds, label, extra = {}) => ({
  schemaVersion: 1,
  id,
  kinds,
  label,
  resumeVersion: 1,
  ...extra,
});

/** A provider row: `<pluginId>/<adapterId>` plus the adapter it declares. */
const provider = (pluginId, adapter, kinds, label, extra = {}) => ({
  provider: `${pluginId}/${adapter}`,
  definition: definition(adapter, kinds, label, extra),
});

/** An installed package, in the shape the plugin list already reports. */
const summary = (id, overrides = {}) => ({
  id,
  displayName: id,
  enabled: true,
  state: 'ok',
  skillCount: 0,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'github',
  ...overrides,
});

const API_KEY = (title, description) => ({ type: 'string', title, description, secret: true });
const BASE_URL = (title, description) => ({ type: 'string', title, description });

// ---------------------------------------------------------------------------
// Providers: six situations, one per row.
// ---------------------------------------------------------------------------

const mediaProviders = [
  // Ready and chosen. The connection comes from a connection the reader
  // already has, which is why the key is not on this package.
  provider('kiki-media-openai', 'images', ['image'], 'OpenAI Images', { connectionSetting: 'connectionId' }),
  provider('kiki-media-openai', 'speech', ['tts'], 'OpenAI Speech', { connectionSetting: 'connectionId' }),
  provider('kiki-media-minimax', 'video', ['video'], 'MiniMax Video', { connectionSetting: 'connectionId' }),
  provider('kiki-media-minimax', 'speech', ['tts'], 'MiniMax Speech'),
  // Ready, but nothing is chosen for video yet — the "more than one candidate,
  // no default" case the tools must ask about rather than pick a paid one.
  provider('kiki-media-ark', 'seedance', ['video'], 'Ark Seedance'),
  // Not ready: it needs a key this reader has not entered. The row names the
  // key, because "needs setup" without a name is a chore rather than a task.
  provider('kiki-media-xai', 'images', ['image'], 'xAI Images'),
  provider('kiki-media-comfy', 'workflow', ['image', 'video'], 'Local ComfyUI'),
  // Not ready for a different reason: a local engine needs an endpoint the
  // reader runs themselves, not a key.
  provider('kiki-media-stepfun', 'tts', ['tts'], 'StepFun Speech'),
  // A script that brings its own environment or its own key file. It declares
  // no settings at all, and it is READY: an absent apiKey is not a verdict on
  // the author.
  provider('my-own-script', 'render', ['image'], 'My Own Renderer'),
  // The package failed to load. Nothing on this row will generate.
  provider('kiki-media-broken', 'images', ['image'], 'Ark (failed to load)'),
];

const mediaSettings = {
  'kiki-media-openai': {
    schema: { schema: { properties: { connectionId: { type: 'string', title: 'Use a configured connection', description: 'Reuses credentials Kiki already holds for that connection.' } } } },
    values: { connectionId: 'openai' },
    secretsConfigured: [],
  },
  'kiki-media-minimax': {
    schema: { schema: { properties: { connectionId: { type: 'string', title: 'Use a configured connection' }, apiKey: API_KEY('API key', 'Stored in this Kiki home, never shown again after saving.') } } },
    values: { connectionId: 'minimax', apiKey: 'stored' },
    secretsConfigured: ['apiKey'],
  },
  'kiki-media-ark': {
    schema: { schema: { properties: { baseUrl: BASE_URL('Endpoint', 'Where this gateway is reachable.'), apiKey: API_KEY('API key') } } },
    values: { baseUrl: 'https://ark.example.test/api/v3' },
    secretsConfigured: ['apiKey'],
  },
  'kiki-media-xai': {
    schema: { schema: { properties: { apiKey: API_KEY('API key', 'Required before this provider can generate.') }, required: ['apiKey'] } },
    values: {},
    secretsConfigured: [],
  },
  'kiki-media-comfy': {
    schema: { schema: { properties: { endpoint: BASE_URL('ComfyUI address', 'The address your own ComfyUI is serving on.'), workflow: BASE_URL('Workflow', 'Which workflow this provider submits.') }, required: ['endpoint'] } },
    values: {},
    secretsConfigured: [],
  },
  'kiki-media-stepfun': {
    schema: { schema: { properties: { apiKey: API_KEY('API key') }, required: ['apiKey'] } },
    values: {},
    secretsConfigured: [],
  },
};

// ---------------------------------------------------------------------------
// Jobs: every state the view has to tell apart.
// ---------------------------------------------------------------------------

const artifact = (id, name, mime, kind, bytes, extra = {}) => ({
  id,
  name,
  mime,
  kind,
  role: 'original',
  complete: true,
  file_id: `media_file_${id}`,
  bytes,
  ...extra,
});

/**
 * The actual bytes, keyed by the `file_id` an artifact carries.
 *
 * Read from committed fixture assets rather than generated at capture time, so
 * a preview that renders and a player that plays are observations about files
 * that exist, not about a mock that agreed to succeed.
 */
const mediaBytes = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'media-bytes', name));

const COVER_PNG = mediaBytes('cover.png');
const VOICE_WAV = mediaBytes('voice.wav');

/** Real subtitle text, so the subtitle row is a file a reader can open. */
const SRT = [
  '1',
  '00:00:00,000 --> 00:00:01,600',
  'A wide shot of the coast at first light.',
  '',
  '2',
  '00:00:01,600 --> 00:00:03,200',
  'The title fades in over the water.',
  '',
].join('\n');

const mediaFiles = {
  // The cover art of the finished job: a real image, so the preview below it
  // has something to actually decode.
  media_file_out_01: { base64: COVER_PNG.toString('base64'), mime: 'image/png', name: 'cover-a1.png' },
  media_file_out_03: { base64: COVER_PNG.toString('base64'), mime: 'image/png', name: 'set-07-1.png' },
  media_file_out_04: { base64: COVER_PNG.toString('base64'), mime: 'image/png', name: 'waiting-03.png' },
  // The compressed preview is served as its own entry, at a different size,
  // because the klient asks for it on a different route and the view labels it
  // as a preview rather than as the original.
  media_file_thumb_01: { base64: COVER_PNG.toString('base64'), mime: 'image/png', name: 'cover-a1-preview.png' },
  // The voice line: a real WAV, so pressing play is a real fetch of real
  // audio rather than a control that resolves to an empty buffer. The artifact
  // declares `audio/mpeg`; the bytes are the honest WAV this fixture can
  // produce, and the declared type is what a real provider would have sent.
  media_file_out_02: { base64: VOICE_WAV.toString('base64'), mime: 'audio/wav', name: 'narration-01.wav' },
  // Subtitles are text, not a media container, and are served as such.
  media_file_sub_01: { base64: Buffer.from(SRT, 'utf8').toString('base64'), mime: 'application/x-subrip', name: 'narration-01.srt' },
};

const job = (over) => ({
  schemaVersion: 1,
  job_id: 'media-fixture-1',
  request_id: 'fixture-01',
  owner_session_id: SID,
  owner_agent_id: AID,
  provider: 'kiki-media-openai/images',
  state: 'succeeded',
  phase: 'generation',
  can_resume: false,
  artifacts: [],
  created_at: 1_760_000_000_000,
  updated_at: 1_760_000_060_000,
  ...over,
});

const mediaJobs = [
  // The short case: a synchronous image that came back with its file.
  job({
    job_id: 'media-fixture-image',
    request_id: 'cover-a1',
    provider: 'kiki-media-openai/images',
    state: 'succeeded',
    artifacts: [
      artifact('out_01', 'cover-a1.png', 'image/png', 'image', COVER_PNG.length),
      artifact('thumb_01', 'cover-a1-preview.png', 'image/png', 'image', COVER_PNG.length, { role: 'preview' }),
    ],
  }),
  // The long case: a video still generating at the provider.
  job({
    job_id: 'media-fixture-video',
    request_id: 'shot-03',
    provider: 'kiki-media-minimax/video',
    model: 'MiniMax-H3',
    state: 'pending',
    phase: 'generation',
    can_resume: true,
    task_id: 'task_fixture_media_video',
  }),
  // Speech, with a subtitle sidecar. The audio is meant to be heard where it
  // is listed, and the subtitle is an answer to read rather than to watch.
  job({
    job_id: 'media-fixture-speech',
    request_id: 'narration-01',
    provider: 'kiki-media-openai/speech',
    state: 'succeeded',
    artifacts: [
      artifact('out_02', 'narration-01.mp3', 'audio/mpeg', 'audio', VOICE_WAV.length, { metadata: { duration_seconds: 2.4 } }),
      artifact('sub_01', 'narration-01.srt', 'application/x-subrip', 'file', Buffer.byteLength(SRT, 'utf8'), { role: 'subtitle' }),
    ],
  }),
  // Two of three images landed. The finished files are still the reader's.
  job({
    job_id: 'media-fixture-partial',
    request_id: 'set-07',
    provider: 'kiki-media-xai/images',
    state: 'partial',
    can_resume: true,
    phase: 'download',
    artifacts: [artifact('out_03', 'set-07-1.png', 'image/png', 'image', COVER_PNG.length)],
    error: { code: 'item_failed', message: 'Two of three images finished.', submission: 'accepted' },
  }),
  // The case a view is most likely to get wrong. The submission may have been
  // accepted and charged; there is no handle, so there is nothing to resume
  // and nothing this view may offer to retry.
  job({
    job_id: 'media-fixture-unknown',
    request_id: 'risky-01',
    provider: 'kiki-media-ark/seedance',
    state: 'unknown',
    phase: 'submit',
    can_resume: false,
    error: { code: 'response_lost', message: 'The response to the submission was lost.', submission: 'unknown' },
  }),
  // A local stop on a provider with no cancel path. The handle survives, so
  // resuming continues the same job — and the row must not read as cancelled.
  job({
    job_id: 'media-fixture-stopped',
    request_id: 'long-02',
    provider: 'kiki-media-minimax/video',
    state: 'stopped',
    phase: 'generation',
    can_resume: true,
    cancellation: { remote: 'unsupported', billing: 'unknown' },
  }),
  // A job whose plugin is gone. The job and its files are kept, and the one
  // thing that will unblock it is named.
  job({
    job_id: 'media-fixture-blocked',
    request_id: 'waiting-03',
    provider: 'kiki-media-broken/images',
    state: 'pending',
    phase: 'generation',
    can_resume: true,
    blocked_reason: 'needs_provider',
    artifacts: [artifact('out_04', 'waiting-03.png', 'image/png', 'image', COVER_PNG.length)],
  }),
];

const mediaVoices = {
  'kiki-media-openai/speech': {
    voices: [
      { id: 'alloy', label: 'Alloy', languages: ['en'] },
      { id: 'shimmer', label: 'Shimmer', languages: ['en'] },
      { id: 'narrator-zh', label: '中文旁白', languages: ['zh', 'en'] },
    ],
    cursor: null,
  },
  'kiki-media-minimax/speech': {
    voices: [
      { id: 'English_expressive_narrator', label: 'English Expressive Narrator', languages: ['en'] },
      { id: 'Chinese_warm_female', label: '中文温暖女声', languages: ['zh'] },
      { id: 'Chinese_steady_male', label: '中文沉稳男声', languages: ['zh'] },
    ],
    cursor: 'page-2',
  },
};

const mediaCapabilities = {
  'kiki-media-openai/images': {
    models: [
      { id: 'gpt-image-1', kind: 'image', label: 'GPT Image 1' },
      { id: 'gpt-image-1-mini', kind: 'image', label: 'GPT Image 1 mini' },
    ],
    constraints: ['Edit requests need at least one reference image.'],
    skill_refs: [{ name: 'media-image', path: './skills/media-image/SKILL.md', when: 'Composing or repairing an image request' }],
  },
  'kiki-media-minimax/video': {
    models: [{ id: 'MiniMax-H3', kind: 'video', label: 'MiniMax H3' }],
    constraints: [
      'A first frame and a last frame cannot be combined with reference images.',
      'Reference audio needs a reference image or video to go with it.',
    ],
    skill_refs: [{ name: 'media-video', path: './skills/media-video/SKILL.md', when: 'Choosing reference roles and shot inputs' }],
  },
  'kiki-media-openai/speech': {
    models: [{ id: 'gpt-4o-mini-tts', kind: 'tts', label: 'GPT-4o mini TTS' }],
    skill_refs: [{ name: 'media-tts', path: './skills/media-tts/SKILL.md', when: 'Picking a voice, a language, or subtitles' }],
  },
  'kiki-media-ark/seedance': {
    models: [{ id: 'seedance-2-0', kind: 'video', label: 'Seedance 2.0' }],
    // Only what this package actually declares. A newer model on a vendor's
    // site is not a capability until the adapter says so.
    constraints: ['This package declares Seedance 2.0 only.'],
  },
};

const mediaSubscriptions = [
  { id: 'official', url: 'https://example.test/kiki-media-official.json', enabled: true },
  { id: 'community', url: 'https://example.test/kiki-media-community.json', enabled: false },
];

const mediaCatalogs = {
  official: {
    source: 'https://example.test/kiki-media-official.json',
    version: '2026-10-04',
    plugins: [
      { id: 'kiki-media-comfy', displayName: 'Local ComfyUI', source: 'https://example.test/comfy', version: '0.4.0', description: 'Runs workflows on an engine you host.', tier: 'curated' },
      { id: 'kiki-media-stepfun', displayName: 'StepFun Speech', source: 'https://example.test/stepfun', version: '0.2.1', description: 'Speech synthesis over HTTP.', tier: 'curated' },
    ],
  },
};

/** What a resume returns for a job that had a handle to continue. */
const mediaResumeOutcome = {
  'media-fixture-stopped': {
    state: 'succeeded',
    phase: 'download',
    artifacts: [artifact('out_05', 'long-02.mp4', 'video/mp4', 'video', 4_194_304, { metadata: { duration_seconds: 6 } })],
    cancellation: { remote: 'unsupported', billing: 'unknown' },
  },
  'media-fixture-video': {
    state: 'succeeded',
    phase: 'generation',
    artifacts: [artifact('out_06', 'shot-03.mp4', 'video/mp4', 'video', 6_291_456, { metadata: { duration_seconds: 5 } })],
  },
};

/**
 * The installed packages the providers came from.
 *
 * The media list joins `providers()` (which adapters exist) with this (whether
 * their package is installed, on, and healthy). Seeding only one of the two is
 * how every row ends up reading "the plugin did not load" — which is the honest
 * reading of a missing package, and exactly why a fixture that only seeds
 * providers looks like a page of failures.
 */
const mediaPlugins = [
  summary('kiki-media-openai', { displayName: 'OpenAI Media', version: '1.0.0' }),
  summary('kiki-media-minimax', { displayName: 'MiniMax Media', version: '1.0.0' }),
  summary('kiki-media-ark', { displayName: 'Ark Media', version: '0.9.2' }),
  summary('kiki-media-xai', { displayName: 'xAI Media', version: '0.4.0' }),
  summary('kiki-media-comfy', { displayName: 'Local ComfyUI', version: '0.3.1' }),
  summary('kiki-media-stepfun', { displayName: 'StepFun Speech', version: '0.2.1' }),
  summary('my-own-script', { displayName: 'My Own Renderer', version: '0.1.0', source: 'local-path' }),
  // The one that failed to load. Its row, and the job waiting on it, are the
  // blocked cases the view has to tell apart from an ordinary failure.
  summary('kiki-media-broken', {
    displayName: 'Ark Media (legacy)',
    version: '0.8.0',
    state: 'error',
    hasErrors: true,
    enabled: false,
  }),
];

/**
 * The connections the reader already has.
 *
 * A media provider that declares a `connectionSetting` borrows from this list
 * rather than asking for a second copy of a credential. It is the ordinary
 * connection catalog the Connections page manages — the same one — so the
 * picker shows ids, kinds and whether a credential is stored, and never a
 * header value or a token.
 */
const mediaConnections = [
  {
    id: 'openai',
    type: 'api',
    base_url: 'https://api.openai.com/v1',
    has_api_key: true,
    status: 'connected',
    models: ['gpt-4o-mini'],
  },
  {
    id: 'minimax',
    type: 'api',
    base_url: 'https://api.minimax.example.test/v1',
    has_api_key: true,
    status: 'connected',
    models: [],
  },
  {
    id: 'openai-subscription',
    // A signed-in account rather than a pasted key. A media provider may offer
    // no model on it, and the row says so only when one is actually used.
    type: 'account',
    has_api_key: false,
    status: 'connected',
    oauth: { storage: 'file', signed_in: true },
    models: ['gpt-5'],
  },
];

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: media sources' })],
  snapshots: { [SID]: { messages: [], has_more: false } },
  config: { default_model: 'fixture/kiki-pro' },
  providers: mediaConnections,
  plugins: mediaPlugins,
  mediaProviders,
  // The plugin settings route reads `pluginSettings`; a provider key is a plugin key.
  pluginSettings: mediaSettings,
  mediaJobs,
  mediaVoices,
  mediaCapabilities,
  mediaSubscriptions,
  mediaCatalogs,
  mediaResumeOutcome,
  mediaFiles,
  // Media generation ships off by default, so the scenario leaves the flag
  // unset and the view shows its "not enabled" notice while every source,
  // setting and past job below stays visible and editable. A scenario that
  // wants the generating path seeds `media_generation: true` here instead.
  experimentalFlags: {},
};
