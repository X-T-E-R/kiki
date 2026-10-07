/**
 * A model with a Recipe bound, two more recipe packages installed, a market
 * with an offline cached catalog, and the prompt bodies the manual editor
 * reads.
 *
 * The example recipes are local fixtures and are labelled as such: nothing here
 * claims an official package exists, and the source locators point at
 * `example.com` rather than anything real. The third package carries script
 * hooks — the shape the install confirmation has to be readable about — and its
 * commands only ever name text files that live in this fixture.
 */

import { createHash } from 'node:crypto';

const fixtureDigest = (text) => createHash('sha256').update(text).digest('hex');

const SYSTEM_BODY = [
  '# Working way',
  '',
  'Understand what the person is trying to do, and how the result will be used.',
  'Reuse what already exists; take ordinary judgement yourself.',
  '',
  'Ship something usable, then say plainly what it is and what you checked.',
].join('\n');

const STEER_BODY = [
  'Pick up the current input and take the next step that moves the work forward.',
  '',
  'Reuse a mature capability before writing a new one.',
].join('\n');

const clearWork = {
  installation_id: 'inst-clear-work',
  manifest_id: 'clear-work',
  name: 'Clear work',
  version: '1.2.0',
  description: 'Understand the job, then finish it and say what you checked.',
  revision: 'sha256:a91d3e2f7c4b60819d2e5f0a3b6c9d1e4f7a2b5c8d0e3f6a9b2c5d8e1f4a7b0',
  source: { locator: 'https://example.com/recipes/clear-work/recipe.toml' },
  update_mode: 'follow',
  health: 'ready',
};

const reviewOnly = {
  installation_id: 'inst-review-only',
  manifest_id: 'review-only',
  name: 'Review only',
  version: '0.4.0',
  description: 'A local example. It declares no model parameters.',
  revision: 'sha256:b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1',
  source: { locator: 'installation:inst-review-only' },
  update_mode: 'pinned',
  health: 'ready',
  last_error: { code: 'recipe.update_failed', message: 'The source did not answer.' },
};

const resolvedFor = (summary, system, steering) => ({
  revision: summary.revision,
  branches: {
    main: {
      system,
      steering,
      steering_on_turn: true,
      steering_on_input: true,
      steering_interval_steps: 0,
      fields: { 'system.language': "Unless the user says otherwise, answer in the language they used." },
    },
    sub: {
      system,
      steering,
      fields: { 'system.language': "Unless the user says otherwise, answer in the language they used." },
    },
    independent: { fields: {} },
  },
  dependencies: [],
  origins: [
    { position: 'main', slot: 'system', source: summary.source.locator, manifest_id: summary.manifest_id, version: summary.version, file: 'main.md' },
    { position: 'main', slot: 'steering', source: summary.source.locator, manifest_id: summary.manifest_id, version: summary.version, file: 'steer.md' },
    { position: 'main', slot: 'system.language', source: summary.source.locator, manifest_id: summary.manifest_id, version: summary.version },
  ],
  model: { temperature: 0.2, max_completion_tokens: 32000 },
  model_origins: {
    temperature: { source: summary.source.locator, manifest_id: summary.manifest_id, version: summary.version },
    max_completion_tokens: { source: summary.source.locator, manifest_id: summary.manifest_id, version: summary.version },
  },
});

const packageFiles = (summary, system, steering) => ({
  'recipe.toml': [
    'schema_version = 1',
    `id = "${summary.manifest_id}"`,
    `name = "${summary.name}"`,
    `version = "${summary.version}"`,
    '',
    '[prompts]',
    'system = { file = "main.md" }',
    'steering = { file = "steer.md" }',
    '',
    '[prompts.fields]',
    '"system.language" = "Unless the user says otherwise, answer in the language they used."',
    '',
    '[model]',
    'temperature = 0.2',
    'max_completion_tokens = 32000',
    '',
  ].join('\n'),
  'main.md': system,
  'steer.md': steering,
});

/*
  A package that runs scripts. The commands are inert (`echo`-shaped node calls
  into the fixture's own text files) and every locator is example.com: this
  fixture exists so the confirmation can be read, not so anything executes.
  What matters is the shape — two events, three resource files, one of them
  read by two commands — because that is what a person actually has to read.
*/
const hookPackage = {
  installation_id: 'inst-review-hooks',
  manifest_id: 'review-hooks',
  name: 'Review hooks',
  version: '0.2.0',
  description: 'A local example package that runs two commands and ships the files they read.',
  revision: 'sha256:c4e8f1a2b9d7036e5c8a1f4b7d0e3a6c9f2b5d8e1a4c7f0b3d6e9a2c5f8b1d40',
  source: { locator: 'https://example.com/recipes/review-hooks/recipe.toml' },
  update_mode: 'pinned',
  health: 'ready',
  hooks_fingerprint: 'sha256:9d2c7f4a1b6e8035c2d9f0a4b7e1c6d3f8a5b2e9c0d7f4a1b6e8035c2d9f0a4b7e',
};

const HOOK_SOURCE = 'https://example.com/recipes/review-hooks/recipe.toml';

/** The bytes each resource file holds, so a declared size is the real size. */
const hookResource = (path) => ({
  'scripts/stamp.mjs': '// Writes the run context next to the package.\n',
  'scripts/report.mjs': '// Appends one line per finished tool call.\n',
  'context.json': '{ "reviewed": 0 }\n',
}[path] ?? '');

const HOOK_SCRIPTS = [
  {
    event: 'PreToolUse',
    command: 'node scripts/stamp.mjs "$KIKI_RECIPE_ROOT/context.json"',
    matcher: 'Bash',
    timeout: 5,
    source: HOOK_SOURCE,
    files: ['scripts/stamp.mjs'],
  },
  {
    event: 'PostToolUse',
    command: 'node scripts/report.mjs > "$KIKI_RECIPE_ROOT/last-run.txt"',
    source: HOOK_SOURCE,
    files: ['scripts/report.mjs', 'context.json'],
  },
];

const hookManifest = [
  'schema_version = 1',
  `id = "${hookPackage.manifest_id}"`,
  `name = "${hookPackage.name}"`,
  `version = "${hookPackage.version}"`,
  '',
  '[prompts]',
  'system = { file = "main.md" }',
  '',
  '[[hooks]]',
  'event = "PreToolUse"',
  'command = "node scripts/stamp.mjs \\"$KIKI_RECIPE_ROOT/context.json\\""',
  'matcher = "Bash"',
  'timeout = 5',
  'files = ["scripts/stamp.mjs"]',
  '',
  '[[hooks]]',
  'event = "PostToolUse"',
  'command = "node scripts/report.mjs > \\"$KIKI_RECIPE_ROOT/last-run.txt\\""',
  'files = ["scripts/report.mjs", "context.json"]',
  '',
].join('\n');

/** One resolved hook: the declared command plus the files it can read. */
const hookResolved = (script) => ({
  event: script.event,
  command: script.command,
  matcher: script.matcher,
  timeout: script.timeout,
  source: script.source,
  manifest_id: hookPackage.manifest_id,
  files: Object.fromEntries(script.files.map((path) => [path, hookResource(path)])),
});

const hookPackageFiles = {
  'recipe.toml': hookManifest,
  'main.md': 'Point at what is wrong, then name the one change that fixes it.\n',
  'scripts/stamp.mjs': hookResource('scripts/stamp.mjs'),
  'scripts/report.mjs': hookResource('scripts/report.mjs'),
  'context.json': hookResource('context.json'),
};

/**
 * The same package as it arrives from somewhere else.
 *
 * A shared package carries its files and its commands and nothing else — not
 * the trust the sender's machine built up. So this one has a locator no
 * installation claims, which is what makes a preview of it ask.
 */
const SHARED_HOOK_SOURCE = 'https://example.com/recipes/shared-review-hooks/recipe.toml';

const sharedHookScripts = HOOK_SCRIPTS.map((script) => ({
  ...script,
  source: SHARED_HOOK_SOURCE,
  files: script.files.map((path) => ({
    path,
    sha256: fixtureDigest(hookResource(path)),
    bytes: Buffer.byteLength(hookResource(path)),
  })),
}));

const sharedHooks = {
  fingerprint: undefined,
  consent_required: true,
  scripts: sharedHookScripts,
};

const reviewSystem = 'Point at what is wrong and why it matters. Keep the person\\u2019s own work intact.\n';
const reviewSteer = 'Name the concrete next action, in one line.\n';

export default {
  sessions: [],
  workspaces: [],
  providers: [
    { id: 'example', name: 'Example API', base_url: 'https://api.example.com/v1', type: 'openai-compatible' },
  ],
  models: [
    {
      id: 'example/kimi-k2',
      provider_id: 'example',
      remote_id: 'kimi-k2',
      display_name: 'Kimi K2',
      max_context_size: 262144,
      support_efforts: ['low', 'high'],
      default_effort: 'high',
      capabilities: ['thinking', 'tools'],
      // Bound to the first recipe: the row must show the package name, its
      // version and that a newer one is waiting, without claiming the running
      // session has already switched.
      recipe: 'inst-clear-work',
      // The shared level still points at author files, so the editor has to
      // offer them read-only and keep the originals when something is saved.
      cognition: {
        overlay: 'cognition/legacy.md',
        steering: 'cognition/legacy-steer.md',
        main: { overlay: { text: 'Main agent opening lines, stored on the model.' } },
        independent: 'off',
      },
      // What the fixture serves for those references. A real home reads them off
      // disk; `missing` stands in for a file that cannot be read.
      __cognition_files: {
        'cognition/legacy.md': 'Legacy overlay file, kept but not used.',
        'cognition/legacy-steer.md': 'Legacy reminder file.',
      },
    },
    {
      id: 'example/kimi-lite',
      provider_id: 'example',
      remote_id: 'kimi-lite',
      display_name: 'Kimi Lite',
      max_context_size: 131072,
      capabilities: ['tools'],
    },
  ],
  recipes: [
    {
      summary: { ...clearWork, update_available: true },
      resolved: resolvedFor(clearWork, SYSTEM_BODY, STEER_BODY),
      files: packageFiles(clearWork, SYSTEM_BODY, STEER_BODY),
      history: [clearWork.revision],
      editable: false,
    },
    {
      summary: reviewOnly,
      resolved: resolvedFor(reviewOnly, reviewSystem, reviewSteer),
      files: packageFiles(reviewOnly, reviewSystem, reviewSteer),
      history: [reviewOnly.revision],
      editable: true,
    },
    {
      summary: hookPackage,
      resolved: {
        ...resolvedFor(hookPackage, hookPackageFiles['main.md'], reviewSteer),
        hooks: HOOK_SCRIPTS.map(hookResolved),
        hooks_fingerprint: hookPackage.hooks_fingerprint,
      },
      files: hookPackageFiles,
      history: [hookPackage.revision],
      editable: true,
      // What the fixture serves for a preview of this package: the scripts it
      // declares, whether this machine already trusts them, and each file's
      // digest and size. A trusted fingerprint is a fact about the fixture's
      // installed set, so the preview answers `consent_required: false` for it
      // and a fresh locator answers `true`.
      hooks: {
        fingerprint: hookPackage.hooks_fingerprint,
        consent_required: false,
        scripts: HOOK_SCRIPTS.map((script) => ({
          event: script.event,
          command: script.command,
          matcher: script.matcher,
          timeout: script.timeout,
          source: script.source,
          files: script.files.map((path) => ({
            path,
            sha256: fixtureDigest(hookResource(path)),
            bytes: Buffer.byteLength(hookResource(path)),
          })),
        })),
      },
    },
  ],
  /*
    This machine has already authorized the hook package above — it is the state
    after one install, and it is what makes the "unchanged scripts are not asked
    about again" case representable. The market entry below is the same idea
    arriving from somewhere else: same commands, no trust carried with it.
  */
  trustedHookFingerprints: [hookPackage.hooks_fingerprint],
  /*
    Packages this machine has never installed. A market delivers the package
    itself — its commands and its files — and not the trust the sender built up,
    so a preview of one of these is where the question actually has to be asked.
  */
  sharedHookPackages: {
    [SHARED_HOOK_SOURCE]: { name: 'Review hooks', hooks: sharedHooks },
  },
  recipeMarkets: [
    {
      id: 'example-market',
      name: 'Example market',
      url: 'https://example.com/recipes/catalog.json',
      enabled: true,
      offline: true,
      catalog: {
        version: 1,
        recipes: [
          { id: 'clear-work', displayName: 'Clear work', version: '1.3.0', source: 'https://example.com/recipes/clear-work-1.3.0.zip', sha256: 'c'.repeat(64) },
          { id: 'deep-review', displayName: 'Deep review', description: 'A longer review pass.', version: '2.0.0', source: 'https://example.com/recipes/deep-review/recipe.toml' },
          // A package this machine has never installed. What a market delivers
          // is the package itself, never the trust the sender built up for it.
          { id: 'shared-review-hooks', displayName: 'Review hooks', description: 'Carries script hooks.', version: '0.2.0', source: SHARED_HOOK_SOURCE },
        ],
      },
    },
  ],
  auth: {
    ready: true,
    providers_count: 1,
    default_model: 'example/kimi-k2',
    managed_provider: null,
  },
  config: {
    default_model: 'example/kimi-k2',
    default_permission_mode: 'manual',
    providers: {},
  },
};
