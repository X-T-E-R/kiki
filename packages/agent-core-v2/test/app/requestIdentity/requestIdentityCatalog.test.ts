import { describe, expect, it } from 'vitest';

import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import {
  parseNpmRelease,
  RequestIdentityCatalog,
  type RequestIdentityCliProbe,
  type RequestIdentityFetch,
} from '#/app/requestIdentity/requestIdentityCatalog';
import type { RequestIdentityProfile, RequestIdentityProfileDraft } from '@kiki/protocol';
import { resolveRequestIdentityLayers } from '#/kosong/requestIdentity/requestIdentityPolicy';

type Sections = Record<string, unknown>;

function codexRelease(version: string, skip?: string): unknown {
  const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
  return {
    name: '@openai/codex',
    version,
    optionalDependencies: Object.fromEntries(
      targets.filter((target) => target !== skip).map((target) => [`@openai/codex-${target}`, `npm:@openai/codex@${version}-${target}`]),
    ),
  };
}

function createCatalog(options: {
  sections?: Sections;
  responses?: Record<string, unknown>;
  cli?: Record<string, string>;
  store?: Map<string, unknown>;
} = {}) {
  const store = options.store ?? new Map<string, unknown>();
  const fetched: string[] = [];
  const fetchImpl: RequestIdentityFetch = async (url) => {
    fetched.push(url);
    const body = options.responses?.[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const cliProbe: RequestIdentityCliProbe = async (command) => {
    const output = options.cli?.[command];
    if (output === undefined) throw new Error(`${command} is not installed or did not answer --version`);
    return output;
  };
  const bootstrap = {
    scope: () => 'store',
    platform: 'linux',
    arch: 'x64',
    clientIdentity: { productName: 'test', version: '1.0.0', platform: 'test' },
  } as unknown as IBootstrapService;
  const config = { get: (domain: string) => options.sections?.[domain] } as unknown as IConfigService;
  const docs = {
    get: async (_scope: string, key: string) => structuredClone(store.get(key)),
    set: async (_scope: string, key: string, value: unknown) => {
      store.set(key, structuredClone(value));
    },
  } as never;
  const catalog = new RequestIdentityCatalog(bootstrap, docs, config, fetchImpl, cliProbe);
  return { catalog, store, fetched };
}

function draftOf(profile: RequestIdentityProfile): RequestIdentityProfileDraft {
  const { id: _id, builtin: _builtin, duplicated_from: _from, created_at: _created, updated_at: _updated, ...draft } = profile;
  return draft;
}

const CODEX_NPM = 'https://registry.npmjs.org/@openai%2Fcodex/latest';

describe('RequestIdentityCatalog profiles', () => {
  it('lists read-only built-ins for every supported client', async () => {
    const { catalog } = createCatalog();
    const profiles = await catalog.listProfiles();
    expect(profiles.map((profile) => profile.id)).toEqual(['kimi_code', 'codex', 'claude_code', 'grok_build', 'opencode', 'none']);
    expect(profiles.every((profile) => profile.builtin)).toBe(true);
    await expect(catalog.updateProfile('codex', { ...draftOf(profiles[1]!), label: 'x' })).rejects.toThrow('read-only');
    await expect(catalog.deleteProfile('codex')).rejects.toThrow('cannot be deleted');
  });

  it('duplicates a built-in into an editable custom profile and persists it', async () => {
    const { catalog, store } = createCatalog();
    const copy = await catalog.duplicateProfile('codex');
    expect(copy).toMatchObject({ id: 'custom:codex-1', builtin: false, duplicated_from: 'codex', label: 'Codex CLI (copy)' });
    const edited = await catalog.updateProfile(copy.id, {
      ...draftOf(copy),
      label: 'Codex desktop',
      version: { mode: 'fixed', value: '26.1.0' },
      user_agent: 'Codex Desktop/{version} ({os_type}; {arch})',
      headers: [{ name: 'originator', value: 'Codex Desktop' }],
    });
    expect(edited.updated_at).toBeDefined();
    const reloaded = createCatalog({ store }).catalog;
    expect((await reloaded.listProfiles()).find((profile) => profile.id === copy.id)?.label).toBe('Codex desktop');
    expect((await reloaded.duplicateProfile('codex')).id).toBe('custom:codex-2');
  });

  it.each([
    ['an unknown template variable', { user_agent: 'x/{secret}' }, 'unknown template variable {secret}'],
    ['a credential header', { headers: [{ name: 'Authorization', value: 'Bearer x' }] }, 'managed by the provider connection'],
    ['an OAuth account header', { headers: [{ name: 'ChatGPT-Account-Id', value: 'override-example' }] }, 'managed by the provider connection'],
    ['an OAuth token mode', { headers: [{ name: 'X-XAI-Token-Auth', value: 'override-example' }] }, 'managed by the provider connection'],
    ['an OAuth authentication response', { headers: [{ name: 'x-authenticateresponse', value: 'override-example' }] }, 'managed by the provider connection'],
    ['an OAuth user header', { headers: [{ name: 'x-userid', value: 'override-example' }] }, 'managed by the provider connection'],
    ['a duplicated header', { headers: [{ name: 'a', value: '1' }, { name: 'A', value: '2' }] }, 'listed twice'],
    ['a User-Agent header row', { headers: [{ name: 'user-agent', value: 'x' }] }, 'User-Agent field'],
    ['a body field the request owns', { params: [{ name: 'model', value: 'x' }] }, 'owned by the model request'],
    ['a track version without a track', { track: null, version: { mode: 'track' } }, 'needs a release track'],
  ])('rejects %s', async (_name, patch, message) => {
    const { catalog } = createCatalog();
    const copy = await catalog.duplicateProfile('claude_code');
    await expect(catalog.updateProfile(copy.id, { ...draftOf(copy), ...patch } as never)).rejects.toThrow(message);
  });

  it('rejects unknown fields in a profile draft', async () => {
    const { catalog } = createCatalog();
    const copy = await catalog.duplicateProfile('claude_code');
    await expect(catalog.updateProfile(copy.id, { ...draftOf(copy), fingerprint: 'x' } as never)).rejects.toThrow();
  });

  it('refuses to delete a profile a provider still uses and reports that usage', async () => {
    const sections: Sections = {
      requestIdentity: { preset: 'codex_compatible' },
      providers: {},
    };
    const { catalog } = createCatalog({ sections });
    const copy = await catalog.duplicateProfile('claude_code');
    sections['providers'] = { anthropic: { requestIdentity: { profile: copy.id } } };
    await expect(catalog.deleteProfile(copy.id)).rejects.toThrow('still used by provider anthropic');
    const usage = await catalog.usage();
    expect(usage).toContainEqual(expect.objectContaining({ scope: 'global', effective_profile: 'codex' }));
    expect(usage).toContainEqual(expect.objectContaining({ scope: 'provider', provider_id: 'anthropic', effective_profile: copy.id }));
  });

  it('projects implicit OAuth defaults in usages without authoring provider selections', async () => {
    const sections: Sections = { providers: {
      codex: { oauth: { storage: 'file', key: 'oauth/openai-codex' } },
      grok: { oauth: { storage: 'file', key: 'oauth/grok-build' } },
      api: { apiKey: 'YOUR_API_KEY' },
    }, defaultProvider: 'grok', models: { c: { provider: 'codex' }, g: { providerId: 'grok' }, inherited: {} } };
    const { catalog } = createCatalog({ sections });
    expect(await catalog.usage()).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'provider', provider_id: 'codex', effective_profile: 'codex' }),
      expect.objectContaining({ scope: 'model', model_id: 'g', effective_profile: 'grok_build' }),
      expect.objectContaining({ scope: 'model', model_id: 'inherited', provider_id: 'grok', effective_profile: 'grok_build' }),
      expect.objectContaining({ scope: 'provider', provider_id: 'api', effective_profile: 'kimi_code' }),
    ]));
    const copy = await catalog.duplicateProfile('opencode');
    sections['requestIdentity'] = { profile: copy.id };
    expect((await catalog.usage()).filter((row) => row.scope !== 'global').every((row) => row.effective_profile === copy.id)).toBe(true);
    sections['requestIdentity'] = { profile: 'none' };
    expect((await catalog.usage()).every((row) => row.effective_profile === 'none')).toBe(true);
    expect(sections['providers']).toEqual({ codex: { oauth: { storage: 'file', key: 'oauth/openai-codex' } },
      grok: { oauth: { storage: 'file', key: 'oauth/grok-build' } }, api: { apiKey: 'YOUR_API_KEY' } });
    await catalog.dispose();
  });

  it('lets config validation outside DI resolve custom profiles once the catalog is loaded', async () => {
    const { catalog } = createCatalog();
    const copy = await catalog.duplicateProfile('grok_build');
    expect(resolveRequestIdentityLayers({ profile: copy.id }).profile).toBe(copy.id);
    await catalog.dispose();
    expect(() => resolveRequestIdentityLayers({ profile: copy.id })).toThrow('does not exist');
  });
});

describe('RequestIdentityCatalog preview', () => {
  it.each(['openai', 'openai_responses', 'anthropic', 'google-genai'] as const)('renders the OpenCode service identity over %s', async (protocol) => {
    const { catalog } = createCatalog();
    const preview = await catalog.preview({ profile: 'opencode', protocol, model: 'example-model' });
    expect(preview.error).toBeUndefined();
    expect(preview.version).toBe('1.18.21');
    expect(preview.version_origin).toBe('track:builtin');
    expect(preview.headers).toEqual([
      { name: 'x-opencode-session', value: '00000000-0000-4000-8000-000000000004', kind: 'per_request', origin: 'lineage' },
      { name: 'x-opencode-request', value: '00000000-0000-7000-8000-000000000005', kind: 'per_request', origin: 'lineage' },
      { name: 'User-Agent', value: 'opencode/1.18.21', kind: 'static', origin: 'profile' },
      { name: 'x-opencode-client', value: 'cli', kind: 'static', origin: 'profile' },
    ]);
    expect(preview.params).toEqual({});
    expect(preview.suppressed_user_agent).toBe(false);
  });

  it('renders the exact values a Codex request sends, marking per-request identifiers', async () => {
    const { catalog } = createCatalog();
    const preview = await catalog.preview({ profile: 'codex', protocol: 'openai_responses', model: 'gpt-example' });
    expect(preview.version).toBe('0.159.2');
    expect(preview.headers).toContainEqual(expect.objectContaining({ name: 'User-Agent', value: expect.stringMatching(/^codex_cli_rs\/0\.159\.2 \(Linux .+; x86_64\)$/u), kind: 'static', origin: 'profile' }));
    expect(preview.headers).toContainEqual(expect.objectContaining({ name: 'session-id', kind: 'per_request', origin: 'lineage' }));
    expect(preview.params['client_metadata']).toContain('installation_id');
  });

  it('keeps identity values verbatim in an observation but never the credentials beside them', () => {
    const { catalog } = createCatalog();
    catalog.recordObservation({
      providerId: 'openai',
      model: 'gpt-example',
      protocol: 'openai_responses',
      policy: resolveRequestIdentityLayers({ profile: 'codex' }),
      sessionId: 's',
      agentId: 'main',
      headers: {
        'User-Agent': 'codex_cli_rs/0.159.2 (Linux 6.1; x86_64)',
        Authorization: 'Bearer sk-live',
        'x-api-key': 'sk-live',
        Cookie: 'session=1',
        'ChatGPT-Account-Id': 'account-example',
        'x-userid': 'user-example',
        'X-XAI-Token-Auth': 'xai-grok-cli',
        'x-authenticateresponse': 'authenticate-response',
        'x-kiki-internal-suppress-user-agent': '1',
      },
      params: { service_tier: 'priority' },
      suppressedUserAgent: false,
    });
    const [observation] = catalog.observations();
    expect(observation?.headers).toEqual([{ name: 'User-Agent', value: 'codex_cli_rs/0.159.2 (Linux 6.1; x86_64)' }]);
    expect(observation?.params).toEqual({ service_tier: 'priority' });
    expect(observation?.profile).toBe('codex');
  });

  it('reports a protocol mismatch instead of inventing values', async () => {
    const { catalog } = createCatalog();
    const preview = await catalog.preview({ profile: 'claude_code', protocol: 'openai_responses', model: 'm' });
    expect(preview.error).toContain('only supports Anthropic Messages');
    expect(preview.headers).toEqual([]);
  });
});

describe('RequestIdentityCatalog release tracks', () => {
  it('stages, applies, pins and rolls back OpenCode versions without changing a custom fixed copy', async () => {
    const url = 'https://registry.npmjs.org/opencode-ai/latest';
    const { catalog } = createCatalog({
      responses: { [url]: { name: 'opencode-ai', version: '1.19.0' } },
      cli: { opencode: '1.19.1\n' },
    });
    const copy = await catalog.duplicateProfile('opencode');
    await catalog.updateProfile(copy.id, { ...draftOf(copy), version: { mode: 'fixed', value: '1.18.21' } });
    const checked = await catalog.checkTrack('opencode_cli', 'npm');
    expect(checked.candidate?.version).toBe('1.19.0');
    const preview = () => catalog.preview({ profile: 'opencode', protocol: 'openai', model: 'm' });
    expect((await preview()).version).toBe('1.18.21');
    await catalog.applyCandidate('opencode_cli', '1.19.0');
    expect((await preview()).headers).toContainEqual(expect.objectContaining({ name: 'User-Agent', value: 'opencode/1.19.0' }));
    expect((await catalog.preview({ profile: copy.id, protocol: 'anthropic', model: 'm' })).version).toBe('1.18.21');
    await catalog.pinTrack('opencode_cli', true);
    const local = await catalog.checkTrack('opencode_cli', 'local_cli');
    expect(local.candidate?.version).toBe('1.19.1');
    await expect(catalog.applyCandidate('opencode_cli', '1.19.1')).rejects.toThrow('unpin');
    await catalog.pinTrack('opencode_cli', false);
    await catalog.rollbackTrack('opencode_cli');
    expect((await preview()).version).toBe('1.18.21');
  });

  it('stages an npm release as a candidate and changes nothing until it is applied', async () => {
    const { catalog } = createCatalog({ responses: { [CODEX_NPM]: codexRelease('0.160.0') } });
    const checked = await catalog.checkTrack('codex_cli', 'npm');
    expect(checked.current.version).toBe('0.159.2');
    expect(checked.candidate).toMatchObject({ version: '0.160.0', origin: 'npm', source_detail: '@openai/codex' });
    expect(checked.last_check).toMatchObject({ source: 'npm', ok: true, version: '0.160.0' });
    expect((await catalog.preview({ profile: 'codex', protocol: 'openai_responses', model: 'm' })).version).toBe('0.159.2');

    await expect(catalog.applyCandidate('codex_cli', '0.161.0')).rejects.toThrow('check again');
    const applied = await catalog.applyCandidate('codex_cli', '0.160.0');
    expect(applied.current).toMatchObject({ version: '0.160.0', origin: 'npm' });
    expect(applied.candidate).toBeNull();
    expect(applied.history[0]).toMatchObject({ version: '0.159.2', origin: 'builtin' });
    expect((await catalog.preview({ profile: 'codex', protocol: 'openai_responses', model: 'm' })).version).toBe('0.160.0');
  });

  it('rolls back to the previous value and resets to the shipped value', async () => {
    const responses: Record<string, unknown> = { [CODEX_NPM]: codexRelease('0.160.0') };
    const { catalog } = createCatalog({ responses });
    await catalog.checkTrack('codex_cli', 'npm');
    await catalog.applyCandidate('codex_cli', '0.160.0');
    responses[CODEX_NPM] = codexRelease('0.161.0');
    await catalog.checkTrack('codex_cli', 'npm');
    await catalog.applyCandidate('codex_cli', '0.161.0');

    const rolled = await catalog.rollbackTrack('codex_cli');
    expect(rolled.current.version).toBe('0.160.0');
    const reset = await catalog.resetTrack('codex_cli');
    expect(reset.current).toMatchObject({ version: '0.159.2', origin: 'builtin' });
    expect(reset.history[0]?.version).toBe('0.160.0');
  });

  it('keeps a pinned track fixed: checks are recorded, apply and rollback are refused', async () => {
    const { catalog } = createCatalog({ responses: { [CODEX_NPM]: codexRelease('0.160.0') } });
    await catalog.pinTrack('codex_cli', true);
    const checked = await catalog.checkTrack('codex_cli', 'npm');
    expect(checked).toMatchObject({ pinned: true, candidate: { version: '0.160.0' } });
    await expect(catalog.applyCandidate('codex_cli', '0.160.0')).rejects.toThrow('unpin');
    await expect(catalog.rollbackTrack('codex_cli')).rejects.toThrow('unpin');
    expect((await catalog.pinTrack('codex_cli', false)).pinned).toBe(false);
  });

  it('skips a half-published Codex release and keeps the current value', async () => {
    const { catalog } = createCatalog({ responses: { [CODEX_NPM]: codexRelease('0.160.0', 'win32-arm64') } });
    const checked = await catalog.checkTrack('codex_cli', 'npm');
    expect(checked.candidate).toBeNull();
    expect(checked.current.version).toBe('0.159.2');
    expect(checked.last_check).toMatchObject({ ok: false, error: '@openai/codex 0.160.0 is missing the win32-arm64 build' });
  });

  it('reads the installed CLI version', async () => {
    const { catalog } = createCatalog({ cli: { claude: '2.1.220 (Claude Code)\n' } });
    const checked = await catalog.checkTrack('claude_code', 'local_cli');
    expect(checked.candidate).toMatchObject({ version: '2.1.220', origin: 'local_cli', source_detail: 'claude --version' });
    const missing = await catalog.checkTrack('grok_cli', 'local_cli');
    expect(missing.last_check).toMatchObject({ ok: false, error: 'grok is not installed or did not answer --version' });
  });

  it('applies manifest template updates to the built-in profile, and a rollback restores them', async () => {
    const url = 'https://identity.example.test/manifest.json';
    const { catalog } = createCatalog({
      responses: {
        [url]: {
          schema: 1,
          tracks: { grok_cli: { version: '1.1.0', user_agent: 'grok-shell/{version} ({grok_os}; {grok_arch}) headless' } },
        },
      },
    });
    await catalog.setManifestUrl(url);
    await catalog.checkTrack('grok_cli', 'manifest');
    await catalog.applyCandidate('grok_cli', '1.1.0');
    const preview = await catalog.preview({ profile: 'grok_build', protocol: 'openai_responses', model: 'grok-example' });
    expect(preview.headers).toContainEqual(expect.objectContaining({ name: 'User-Agent', value: 'grok-shell/1.1.0 (linux; x86_64) headless' }));
    expect(preview.headers).toContainEqual(expect.objectContaining({ name: 'x-grok-client-version', value: '1.1.0' }));
    await catalog.rollbackTrack('grok_cli');
    const restored = await catalog.preview({ profile: 'grok_build', protocol: 'openai_responses', model: 'grok-example' });
    expect(restored.headers).toContainEqual(expect.objectContaining({ name: 'User-Agent', value: 'grok-shell/1.0.44 (linux; x86_64)' }));
  });

  it.each([
    ['an unknown field', { schema: 1, tracks: { grok_cli: { version: '1.1.0', fingerprint: 'x' } } }, 'manifest rejected'],
    ['an unknown track', { schema: 1, tracks: { other_cli: { version: '1.1.0' } } }, 'manifest rejected'],
    ['a credential header', { schema: 1, tracks: { grok_cli: { version: '1.1.0', headers: [{ name: 'Authorization', value: 'x' }] } } }, 'managed by the provider connection'],
    ['a missing entry', { schema: 1, tracks: { codex_cli: { version: '1.1.0' } } }, 'no entry for grok_cli'],
  ])('rejects a manifest with %s', async (_name, body, message) => {
    const url = 'https://identity.example.test/manifest.json';
    const { catalog } = createCatalog({ responses: { [url]: body } });
    await catalog.setManifestUrl(url);
    const checked = await catalog.checkTrack('grok_cli', 'manifest');
    expect(checked.candidate).toBeNull();
    expect(checked.last_check?.error).toContain(message);
  });

  it('refuses a non-https manifest URL', async () => {
    const { catalog } = createCatalog();
    await expect(catalog.setManifestUrl('http://identity.example.test/m.json')).rejects.toThrow('https');
  });
});

describe('parseNpmRelease', () => {
  it('accepts only a stable release of the expected package', () => {
    expect(parseNpmRelease('@xai-official/grok', { name: '@xai-official/grok', version: '1.0.44' })).toBe('1.0.44');
    expect(() => parseNpmRelease('@xai-official/grok', { name: 'other', version: '1.0.0' })).toThrow('instead of');
    expect(() => parseNpmRelease('@xai-official/grok', { name: '@xai-official/grok', version: '1.1.0-beta.1' })).toThrow('not a stable release');
  });
});
