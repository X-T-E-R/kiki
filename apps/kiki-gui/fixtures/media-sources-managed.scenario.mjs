/**
 * media-sources-managed — the unified media plugin's source list, as the host
 * answers it now.
 *
 * The point of this scenario is that ONE package carries every source. Ten
 * vendors, one script of the reader's own, and a reader's own out-of-use one,
 * all inside `kiki-media`. Every row therefore differs in what it needs, and
 * the rows are only distinguishable if the list is keyed by sourceId rather
 * than by package: a view that grouped by package would draw one row.
 *
 * The facts each row carries are the host's, and the distinctions are the
 * ones a reader can be wrong about:
 *
 *   - a configured source with a stored secret (`secretsConfigured`, never a
 *     value — the fixture keeps no key in `values` either, so a row that
 *     printed a value would have nothing to print);
 *   - a source that still needs a key, named by the host's own `missing`;
 *   - a source the reader switched off, and a source they removed: both are
 *     their own choices, both keep their configuration, and neither is a fault;
 *   - a reader's own script, which brings its own command and environment, and
 *     whose command is the one fact about it worth showing on the row;
 *   - a source whose package failed to load, which is the only row drawn as
 *     broken — and the one job waiting for it.
 *
 * The jobs are unchanged from the pre-split surface: the same artifacts with
 * the same file ids, so the artifact list and the player exercise the same
 * bytes they always did. The providers now name sources rather than packages,
 * so a finished job is still found by the id the tools use.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_media';
const AID = 'agent_fixture_media';

const definition = (id, kinds, label, extra = {}) => ({ schemaVersion: 1, id, kinds, label, resumeVersion: 1, ...extra });

/**
 * One source inside the media package.
 *
 * `provider` is the id every write is addressed by, and it is what makes two
 * rows from one package different rows. The `properties` are the form the
 * source declares; the lifecycle keys (`enabled` / `removed` / `cleared`) are
 * excluded from the schema the host reports, exactly as the real host does.
 */
const source = ({ id, label, adapters, properties, values = {}, secrets = [], missing = [], required = [], enabled = true, removed = false, custom = false, connectionSetting }) => ({
  provider: `kiki-media/${id}`,
  sourceId: id,
  pluginId: 'kiki-media',
  label,
  custom,
  enabled,
  removed,
  definitions: adapters.map((adapter) => definition(adapter.id, adapter.kinds, adapter.label, connectionSetting === undefined ? {} : { connectionSetting })),
  schema: {
    schemaVersion: 1,
    schema: {
      type: 'object',
      properties: { ...properties, enabled: { type: 'boolean' }, removed: { type: 'boolean' }, cleared: { type: 'string' } },
      ...(required.length === 0 ? {} : { required }),
    },
  },
  // A secret never appears here. The host reports which keys are stored and
  // nothing else, and this fixture keeps the same discipline so a row that
  // printed a value would have nothing to print.
  values,
  secretsConfigured: secrets,
  missing,
});

const API_KEY = (title, description) => ({ type: 'string', title, description, secret: true });
const BASE_URL = (title, description) => ({ type: 'string', title, description });

const mediaManagedSources = [
  // Ready, and the reader's chosen default for images. The key is a stored
  // secret, so the row says "configured" and never shows it.
  source({
    id: 'openai',
    label: 'OpenAI Media',
    adapters: [{ id: 'openai-image', kinds: ['image'], label: 'OpenAI images' }, { id: 'openai-speech', kinds: ['tts'], label: 'OpenAI speech' }],
    connectionSetting: 'connectionId',
    properties: {
      connectionId: { type: 'string', title: 'Kiki connection (optional)', description: 'Reuses a media-capable API connection you already have.' },
      apiKey: API_KEY('API key'),
      baseUrl: BASE_URL('API base URL', 'Where the request goes when no connection is chosen.'),
      imageModel: { type: 'string', title: 'Default image model', default: 'gpt-image-1' },
    },
    values: { connectionId: 'openai', baseUrl: 'https://api.openai.com/v1', imageModel: 'gpt-image-1' },
    secrets: ['apiKey'],
    missing: [],
    required: ['apiKey'],
  }),
  // Ready for images and video, and the default for video. Three modalities
  // from one source group: the row draws all three glyphs and one set of keys.
  source({
    id: 'minimax',
    label: 'MiniMax Media',
    adapters: [
      { id: 'minimax-image', kinds: ['image'], label: 'MiniMax images' },
      { id: 'minimax-video', kinds: ['video'], label: 'MiniMax video' },
      { id: 'minimax-speech', kinds: ['tts'], label: 'MiniMax speech' },
    ],
    connectionSetting: 'connectionId',
    properties: {
      connectionId: { type: 'string', title: 'Kiki connection (optional)' },
      apiKey: API_KEY('API key'),
      baseUrl: BASE_URL('API base URL'),
      imageModel: { type: 'string', title: 'Default image model', default: 'image-01' },
      videoModel: { type: 'string', title: 'Default video model', default: 'H3' },
    },
    values: { connectionId: 'minimax', baseUrl: 'https://api.minimax.example.test/v1' },
    secrets: ['apiKey'],
    missing: [],
    required: ['apiKey'],
  }),
  // The reader's default for speech, and ready. A gateway rather than a
  // vendor: the endpoint is the thing it needs, and it has one.
  source({
    id: 'ark',
    label: 'Ark Media',
    adapters: [{ id: 'ark-image', kinds: ['image'], label: 'Ark images' }, { id: 'ark-video', kinds: ['video'], label: 'Ark video' }],
    connectionSetting: 'connectionId',
    properties: { connectionId: { type: 'string', title: 'Kiki connection (optional)' }, apiKey: API_KEY('API key'), baseUrl: BASE_URL('Endpoint', 'Where this gateway is reachable.') },
    values: { baseUrl: 'https://ark.example.test/api/v3' },
    secrets: [],
    missing: ['apiKey'],
    required: ['apiKey'],
  }),
  // Needs a key this reader has not entered. The row names the key, because
  // "needs setup" without a name is a chore rather than a task.
  source({
    id: 'xai',
    label: 'xAI Media',
    adapters: [{ id: 'xai-image', kinds: ['image'], label: 'xAI images' }],
    properties: { apiKey: API_KEY('API key', 'Required before this source can generate.') },
    values: {},
    missing: ['apiKey'],
    required: ['apiKey'],
  }),
  // A local engine: it needs an endpoint the reader runs, not a key. Nothing
  // is required, so it is ready the moment it is switched on.
  source({
    id: 'comfyui',
    label: 'ComfyUI Workflow',
    adapters: [{ id: 'comfyui-workflow', kinds: ['image', 'video'], label: 'ComfyUI workflow' }],
    connectionSetting: 'connectionId',
    properties: { connectionId: { type: 'string', title: 'Kiki connection (optional)' }, endpoint: BASE_URL('ComfyUI address', 'Where your own ComfyUI is serving.'), workflow: BASE_URL('Workflow', 'Which workflow to submit.') },
    values: { endpoint: 'http://127.0.0.1:8188', workflow: 'default' },
    secrets: [],
    missing: [],
  }),
  // Speech from a vendor that needs a key and does not have one.
  source({
    id: 'stepfun',
    label: 'StepFun Speech',
    adapters: [{ id: 'stepfun-speech', kinds: ['tts'], label: 'StepFun speech' }],
    properties: { apiKey: API_KEY('API key') },
    values: {},
    missing: ['apiKey'],
    required: ['apiKey'],
  }),
  // Three OpenAI-compatible gateways, each with its own endpoint. Same
  // package, same runtime, three sources a reader configures independently —
  // which is the whole difference from three separately installed packages.
  ...['novita', 'agnes', 'newapi'].map((id) => source({
    id,
    label: `${id.charAt(0).toUpperCase()}${id.slice(1)} Compatible Video`,
    adapters: [{ id: `${id}-video`, kinds: ['video'], label: `${id} video` }],
    connectionSetting: 'connectionId',
    properties: { connectionId: { type: 'string', title: 'Kiki connection (optional)' }, baseUrl: BASE_URL('Endpoint'), apiKey: API_KEY('API key') },
    values: { baseUrl: `https://${id}.example.test/v1` },
    secrets: ['apiKey'],
    missing: [],
    required: ['apiKey'],
  })),
  // A reader's own script. It brings its own command and its own environment,
  // so it declares exactly one setting — the environment — and that setting is
  // a secret the host stores and never reads back.
  source({
    id: 'local-renderer',
    label: 'My Own Renderer',
    adapters: [{ id: 'script-local-renderer', kinds: ['image'], label: 'My Own Renderer' }],
    custom: true,
    properties: { environment: { type: 'string', title: 'Environment variables (JSON)', secret: true } },
    values: { command: 'python', args: '["render.py", "--width", "1024"]', cwd: '', protocol: 'file', format: 'png', mime: '' },
    secrets: ['environment'],
    missing: [],
  }),
  // The reader switched this one off. Everything is kept, so it is one click
  // away from working again — and it is not a failure.
  source({
    id: 'ark-alt',
    label: 'Ark Media (backup gateway)',
    adapters: [{ id: 'ark-alt-video', kinds: ['video'], label: 'Ark backup video' }],
    connectionSetting: 'connectionId',
    enabled: false,
    properties: { connectionId: { type: 'string', title: 'Kiki connection (optional)' }, baseUrl: BASE_URL('Endpoint'), apiKey: API_KEY('API key') },
    values: { baseUrl: 'https://ark-backup.example.test/v1' },
    secrets: ['apiKey'],
    missing: [],
    required: ['apiKey'],
  }),
  // Removed: out of use, with its configuration kept. The one control that
  // changes what the tools offer, and it is reversible from the same row.
  source({
    id: 'retired-gateway',
    label: 'Retired Video Gateway',
    adapters: [{ id: 'retired-video', kinds: ['video'], label: 'Retired video' }],
    removed: true,
    properties: { baseUrl: BASE_URL('Endpoint'), apiKey: API_KEY('API key') },
    values: { baseUrl: 'https://retired.example.test/v1' },
    secrets: ['apiKey'],
    missing: [],
  }),
];

/** The installed adapters, for the on-demand capability and voice reads. */
const mediaProviders = [
  { provider: 'kiki-media/openai-image', definition: definition('openai-image', ['image'], 'OpenAI images', { connectionSetting: 'connectionId' }) },
  { provider: 'kiki-media/openai-speech', definition: definition('openai-speech', ['tts'], 'OpenAI speech', { connectionSetting: 'connectionId' }) },
  { provider: 'kiki-media/minimax-video', definition: definition('minimax-video', ['video'], 'MiniMax video', { connectionSetting: 'connectionId' }) },
  { provider: 'kiki-media/ark-video', definition: definition('ark-video', ['video'], 'Ark video', { connectionSetting: 'connectionId' }) },
  { provider: 'kiki-media/xai-image', definition: definition('xai-image', ['image'], 'xAI images') },
  { provider: 'kiki-media/script-local-renderer', definition: definition('script-local-renderer', ['image'], 'My Own Renderer') },
];

const mediaSettings = {
  'kiki-media': {
    schema: { schema: { properties: { defaultImageProvider: { type: 'string' }, defaultVideoProvider: { type: 'string' }, defaultTtsProvider: { type: 'string' } } } },
    // The per-modality defaults, on the media package's own settings. The list
    // reads them from here, so a source and its default badge can never
    // disagree about who holds the pointer.
    values: { defaultImageProvider: 'kiki-media/openai', defaultVideoProvider: 'kiki-media/minimax', defaultTtsProvider: 'kiki-media/openai' },
    secretsConfigured: [],
  },
};

const summary = (id, overrides = {}) => ({
  id,
  displayName: id,
  enabled: true,
  state: 'ok',
  skillCount: 1,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'github',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Jobs: the same artifacts and file ids as the pre-split surface, with the
// provider ids now naming sources. A finished job is still found by the id the
// tools use, which is what the Task route depends on.
// ---------------------------------------------------------------------------

const artifact = (id, name, mime, kind, bytes, extra = {}) => ({
  id, name, mime, kind, role: 'original', complete: true, file_id: `media_file_${id}`, bytes, ...extra,
});

const mediaBytes = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'media-bytes', name));
const COVER_PNG = mediaBytes('cover.png');
const VOICE_WAV = mediaBytes('voice.wav');

const SRT = [
  '1', '00:00:00,000 --> 00:00:01,600', 'A wide shot of the coast at first light.', '',
  '2', '00:00:01,600 --> 00:00:03,200', 'The title fades in over the water.', '',
].join('\n');

const mediaFiles = {
  media_file_out_01: { base64: COVER_PNG.toString('base64'), mime: 'image/png', name: 'cover-a1.png' },
  media_file_out_03: { base64: COVER_PNG.toString('base64'), mime: 'image/png', name: 'set-07-1.png' },
  media_file_thumb_01: { base64: COVER_PNG.toString('base64'), mime: 'image/png', name: 'cover-a1-preview.png' },
  media_file_out_02: { base64: VOICE_WAV.toString('base64'), mime: 'audio/wav', name: 'narration-01.wav' },
  media_file_sub_01: { base64: Buffer.from(SRT, 'utf8').toString('base64'), mime: 'application/x-subrip', name: 'narration-01.srt' },
};

const job = (over) => ({
  schemaVersion: 1,
  job_id: 'media-fixture-1',
  request_id: 'fixture-01',
  owner_session_id: SID,
  owner_agent_id: AID,
  provider: 'kiki-media/openai-image',
  state: 'succeeded',
  phase: 'generation',
  can_resume: false,
  artifacts: [],
  created_at: 1_760_000_000_000,
  updated_at: 1_760_000_060_000,
  ...over,
});

const mediaJobs = [
  job({
    job_id: 'media-fixture-image',
    request_id: 'cover-a1',
    state: 'succeeded',
    artifacts: [
      artifact('out_01', 'cover-a1.png', 'image/png', 'image', COVER_PNG.length),
      artifact('thumb_01', 'cover-a1-preview.png', 'image/png', 'image', COVER_PNG.length, { role: 'preview' }),
    ],
  }),
  job({ job_id: 'media-fixture-video', request_id: 'shot-03', provider: 'kiki-media/minimax-video', model: 'MiniMax-H3', state: 'pending', phase: 'generation', can_resume: true, task_id: 'task_fixture_media_video' }),
  job({
    job_id: 'media-fixture-speech',
    request_id: 'narration-01',
    provider: 'kiki-media/openai-speech',
    state: 'succeeded',
    artifacts: [
      artifact('out_02', 'narration-01.mp3', 'audio/mpeg', 'audio', VOICE_WAV.length, { metadata: { duration_seconds: 2.4 } }),
      artifact('sub_01', 'narration-01.srt', 'application/x-subrip', 'file', Buffer.byteLength(SRT, 'utf8'), { role: 'subtitle' }),
    ],
  }),
  job({
    job_id: 'media-fixture-partial',
    request_id: 'set-07',
    provider: 'kiki-media/xai-image',
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
    provider: 'kiki-media/ark-video',
    state: 'unknown',
    phase: 'submit',
    can_resume: false,
    error: { code: 'response_lost', message: 'The response to the submission was lost.', submission: 'unknown' },
  }),
  // A local stop on a source with no cancel path. The handle survives, so
  // resuming continues the same job — and the row must not read as cancelled.
  job({
    job_id: 'media-fixture-stopped',
    request_id: 'long-02',
    provider: 'kiki-media/minimax-video',
    state: 'stopped',
    phase: 'generation',
    can_resume: true,
    cancellation: { remote: 'unsupported', billing: 'unknown' },
  }),
  // A job whose source is out of use. The job and its files are kept, and the
  // one thing that will unblock it is named.
  job({
    job_id: 'media-fixture-blocked',
    request_id: 'waiting-03',
    provider: 'kiki-media/retired-gateway-video',
    state: 'pending',
    phase: 'generation',
    can_resume: true,
    blocked_reason: 'needs_provider',
    artifacts: [artifact('out_04', 'waiting-03.png', 'image/png', 'image', COVER_PNG.length)],
  }),
];

const mediaVoices = {
  'kiki-media/openai-speech': {
    voices: [
      { id: 'alloy', label: 'Alloy', languages: ['en'] },
      { id: 'shimmer', label: 'Shimmer', languages: ['en'] },
      { id: 'narrator-zh', label: '中文旁白', languages: ['zh', 'en'] },
    ],
    cursor: null,
  },
  'kiki-media/minimax-speech': {
    voices: [
      { id: 'English_expressive_narrator', label: 'English Expressive Narrator', languages: ['en'] },
      { id: 'Chinese_warm_female', label: '中文温暖女声', languages: ['zh'] },
      { id: 'Chinese_steady_male', label: '中文沉稳男声', languages: ['zh'] },
    ],
    cursor: 'page-2',
  },
};

const mediaCapabilities = {
  'kiki-media/openai-image': {
    models: [{ id: 'gpt-image-1', kind: 'image', label: 'GPT Image 1' }, { id: 'gpt-image-1-mini', kind: 'image', label: 'GPT Image 1 mini' }],
    constraints: ['Edit requests need at least one reference image.'],
    skill_refs: [{ name: 'media-image', path: './skills/media-image/SKILL.md', when: 'Composing or repairing an image request' }],
  },
  'kiki-media/minimax-video': {
    models: [{ id: 'minimax-H3', kind: 'video', label: 'MiniMax H3' }],
    constraints: ['A first frame and a last frame cannot be combined with reference images.'],
    skill_refs: [{ name: 'media-video', path: './skills/media-video/SKILL.md', when: 'Choosing reference roles and shot inputs' }],
  },
  'kiki-media/openai-speech': {
    models: [{ id: 'gpt-4o-mini-tts', kind: 'tts', label: 'GPT-4o mini TTS' }],
    skill_refs: [{ name: 'media-tts', path: './skills/media-tts/SKILL.md', when: 'Picking a voice, a language, or subtitles' }],
  },
};

const mediaSubscriptions = [
  { id: 'official', url: 'https://example.test/kiki-media-official.json', enabled: true },
  { id: 'community', url: 'https://example.test/kiki-media-community.json', enabled: false },
];

const mediaCatalogs = {
  official: {
    source: 'https://example.test/kiki-media-official.json',
    version: '2026-10-07',
    plugins: [
      { id: 'kiki-media', displayName: 'Media', source: 'https://example.test/kiki-media', version: '0.2.0', description: 'Image, video and speech generation, plus your own scripts.', tier: 'official' },
    ],
  },
};

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
 * ONE installed package, not ten.
 *
 * The media list joins `managedSources()` (which sources exist and how they are
 * configured) with this (whether the package carrying them is installed, on
 * and healthy). Seeding one package for eleven sources is the case that
 * matters: a view that grouped by package would draw a single row here and
 * look correct.
 */
const mediaPlugins = [
  summary('kiki-media', { displayName: 'Media', version: '0.2.0' }),
];

/**
 * The connections the reader already has. A source that declares a
 * `connectionSetting` borrows from this list rather than asking for a second
 * copy of a credential. It is the ordinary connection catalog the Connections
 * page manages, so the picker shows ids, kinds and whether a credential is
 * stored, and never a header value or a token.
 */
const mediaConnections = [
  { id: 'openai', type: 'api', base_url: 'https://api.openai.com/v1', has_api_key: true, status: 'connected', models: ['gpt-4o-mini'] },
  { id: 'minimax', type: 'api', base_url: 'https://api.minimax.example.test/v1', has_api_key: true, status: 'connected', models: [] },
  { id: 'openai-subscription', type: 'account', has_api_key: false, status: 'connected', oauth: { storage: 'file', signed_in: true }, models: ['gpt-5'] },
];

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: media sources' })],
  snapshots: { [SID]: { messages: [], has_more: false } },
  config: { default_model: 'fixture/kiki-pro' },
  providers: mediaConnections,
  plugins: mediaPlugins,
  mediaProviders,
  mediaManagedSources,
  pluginSettings: mediaSettings,
  mediaJobs,
  mediaVoices,
  mediaCapabilities,
  mediaSubscriptions,
  mediaCatalogs,
  mediaResumeOutcome,
  mediaFiles,
  experimentalFlags: {},
};
