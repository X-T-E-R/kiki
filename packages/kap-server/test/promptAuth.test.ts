import {
  IAgentProfileService,
  IAuthSummaryService,
  IConfigService,
  IModelService,
  ISessionAgentProfileCatalog,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
} from '@kiki/agent-core-v2';
import { IAdhocEndpointVault, AdhocEndpointVault } from '@kiki/agent-core-v2/session/adhocEndpoint/adhocEndpointVault';
import { adhocEndpointModelId, boundEndpointSchema } from '@kiki/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensurePromptAuthReady } from '../src/lib/promptAuth';

const CURRENT_PROFILE = 'frontend';
const ENV_KEY = 'PROMPT_AUTH_ENDPOINT_KEY';
const ENDPOINT_INPUT = {
  provider_type: 'openai',
  base_url: 'https://current.example.test/v1',
  model: 'current-model',
} as const;

function createEndpointVault() {
  const vault = new AdhocEndpointVault();
  const endpoint = vault.bind({ ...ENDPOINT_INPUT, api_key: 'synthetic-current-key' });
  return { vault, endpoint };
}

function createHarness(options: {
  readonly endpoint?: ReturnType<typeof boundEndpointSchema.parse>;
  readonly profileName?: string;
  readonly modelAlias?: string;
  readonly executorId?: string;
  readonly driver?: 'external';
  readonly fileProfile?: import('@kiki/agent-core-v2').AgentProfile;
  readonly catalogProfiles?: readonly import('@kiki/agent-core-v2').AgentProfile[];
  readonly vault?: AdhocEndpointVault;
} = {}) {
  const endpoint = options.endpoint;
  const profile = {
    data: () => ({
      endpoint,
      profileName: options.profileName ?? CURRENT_PROFILE,
      modelAlias: options.modelAlias ?? (endpoint === undefined ? 'current-catalog-model' : adhocEndpointModelId(endpoint)),
      executorId: options.executorId ?? 'native',
      driver: options.driver,
      execution: undefined,
    }),
    getModel: () => options.modelAlias ?? (endpoint === undefined ? 'current-catalog-model' : adhocEndpointModelId(endpoint)),
    resolveFile: vi.fn(async () => options.fileProfile),
  } as unknown as IAgentProfileService;
  const authSummary = { ensureReady: vi.fn(async () => undefined) };
  const catalog = {
    ready: Promise.resolve(),
    get: (name: string) => options.catalogProfiles?.find((candidate) => candidate.name === name),
    getDefault: () => options.catalogProfiles?.[0],
  };
  const config = { reload: vi.fn(async () => undefined), get: vi.fn(() => undefined) };
  const models = { resolveId: (model: string) => model };
  const accessor = {
    get: (token: unknown) => {
      if (token === IAgentProfileService) return profile;
      if (token === IAuthSummaryService) return authSummary;
      if (token === IConfigService) return config;
      if (token === IModelService) return models;
      throw new Error('Unexpected agent service lookup');
    },
  } as unknown as IAgentScopeHandle['accessor'];
  const session = {
    accessor: {
      get: (token: unknown) => {
        if (token === IAdhocEndpointVault) return options.vault ?? new AdhocEndpointVault();
        if (token === ISessionAgentProfileCatalog) return catalog;
        throw new Error('Unexpected session service lookup');
      },
    },
  } as unknown as ISessionScopeHandle;
  return { accessor, session, profile, authSummary, catalog };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ensurePromptAuthReady with bound ad-hoc endpoints', () => {
  it('validates the frozen endpoint for an explicit echo of the current profile', async () => {
    const { vault, endpoint } = createEndpointVault();
    const harness = createHarness({ endpoint, vault });

    await expect(ensurePromptAuthReady(harness.session, harness.accessor, { profile: CURRENT_PROFILE })).resolves.toBeUndefined();

    expect(harness.authSummary.ensureReady).not.toHaveBeenCalled();
  });

  it('validates the frozen endpoint for an unchanged native execution echo', async () => {
    const { vault, endpoint } = createEndpointVault();
    const harness = createHarness({ endpoint, vault });

    await expect(ensurePromptAuthReady(harness.session, harness.accessor, { execution: { executor: 'native' } })).resolves.toBeUndefined();

    expect(harness.authSummary.ensureReady).not.toHaveBeenCalled();
  });

  it('validates the frozen endpoint when the requested model is its derived identity', async () => {
    const { vault, endpoint } = createEndpointVault();
    const harness = createHarness({ endpoint, vault });

    await expect(ensurePromptAuthReady(harness.session, harness.accessor, { model: adhocEndpointModelId(endpoint) })).resolves.toBeUndefined();

    expect(harness.authSummary.ensureReady).not.toHaveBeenCalled();
  });

  it('validates the selected endpoint-backed profile-file environment credential', async () => {
    vi.stubEnv(ENV_KEY, 'synthetic-file-endpoint-key');
    const selectedProfile = {
      name: 'evaluation-file',
      executor: 'native',
      modelAlias: 'unrelated-catalog-model',
      endpoint: { ...ENDPOINT_INPUT, base_url: 'https://file.example.test/v1', api_key_env: ENV_KEY },
    } as unknown as import('@kiki/agent-core-v2').AgentProfile;
    const harness = createHarness({ fileProfile: selectedProfile, vault: new AdhocEndpointVault() });

    await expect(ensurePromptAuthReady(harness.session, harness.accessor, {
      execution: { executor: 'native', profile_file: 'profiles/evaluation.md' },
    })).resolves.toBeUndefined();

    expect(harness.profile.resolveFile).toHaveBeenCalledWith('profiles/evaluation.md');
    expect(harness.authSummary.ensureReady).not.toHaveBeenCalled();
  });

  it('validates a newly selected catalog profile-file endpoint with its environment credential', async () => {
    vi.stubEnv(ENV_KEY, 'synthetic-catalog-endpoint-key');
    const { vault, endpoint } = createEndpointVault();
    const selectedEndpoint = { ...ENDPOINT_INPUT, base_url: 'https://catalog-file.example.test/v1', api_key_env: ENV_KEY };
    const selectedProfile = {
      name: 'evaluation-file',
      sourcePath: 'profiles/evaluation.md',
      executor: 'native',
      modelAlias: 'unrelated-catalog-model',
      endpoint: selectedEndpoint,
    } as unknown as import('@kiki/agent-core-v2').AgentProfile;
    const harness = createHarness({ endpoint, vault, catalogProfiles: [selectedProfile] });

    await expect(ensurePromptAuthReady(harness.session, harness.accessor, { profile: 'evaluation-file' })).resolves.toBeUndefined();
    await expect(ensurePromptAuthReady(harness.session, harness.accessor, {
      execution: { executor: 'native', profile: 'evaluation-file', overrides: { model: adhocEndpointModelId(selectedEndpoint) } },
    })).resolves.toBeUndefined();

    expect(harness.authSummary.ensureReady).not.toHaveBeenCalled();
  });

  it('uses explicit catalog auth before resolving credentials for a discarded endpoint', async () => {
    const selectedProfile = {
      name: 'selected-endpoint',
      sourcePath: 'profiles/selected-endpoint.md',
      executor: 'native',
      modelAlias: 'profile-model',
      endpoint: { provider_type: 'openai', base_url: 'https://endpoint.example.test/v1', model: 'endpoint-model' },
    } as unknown as import('@kiki/agent-core-v2').AgentProfile;
    const harness = createHarness({ catalogProfiles: [selectedProfile] });

    await expect(ensurePromptAuthReady(harness.session, harness.accessor, {
      execution: { executor: 'native', profile: 'selected-endpoint', overrides: { model: 'explicit-catalog' } },
    })).resolves.toBeUndefined();

    expect(harness.authSummary.ensureReady).toHaveBeenCalledWith('explicit-catalog');
    harness.authSummary.ensureReady.mockClear();
    await expect(ensurePromptAuthReady(harness.session, harness.accessor, {
      execution: { executor: 'native', profile: 'selected-endpoint', overrides: { model: null } },
    })).resolves.toBeUndefined();
    expect(harness.authSummary.ensureReady).toHaveBeenCalledWith('profile-model');
  });

  it('retains catalog-model and external-executor auth behavior for changed targets', async () => {
    const { vault, endpoint } = createEndpointVault();
    const catalogProfile = {
      name: 'catalog-target',
      executor: 'native',
      modelAlias: 'catalog-model',
    } as unknown as import('@kiki/agent-core-v2').AgentProfile;
    const harness = createHarness({ endpoint, vault, catalogProfiles: [catalogProfile] });

    await ensurePromptAuthReady(harness.session, harness.accessor, { profile: 'catalog-target' });
    expect(harness.authSummary.ensureReady).toHaveBeenCalledWith('catalog-model');

    harness.authSummary.ensureReady.mockClear();
    await ensurePromptAuthReady(harness.session, harness.accessor, { model: 'other-catalog-model' });
    expect(harness.authSummary.ensureReady).toHaveBeenCalledWith('other-catalog-model');

    harness.authSummary.ensureReady.mockClear();
    await ensurePromptAuthReady(harness.session, harness.accessor, { execution: { executor: 'native', overrides: { model: null } } });
    expect(harness.authSummary.ensureReady).toHaveBeenCalledWith(undefined);

    harness.authSummary.ensureReady.mockClear();
    await expect(ensurePromptAuthReady(harness.session, harness.accessor, { execution: { executor: 'external' } })).resolves.toBeUndefined();
    expect(harness.authSummary.ensureReady).not.toHaveBeenCalled();
  });

  it('fails a cold literal credential without consulting global auth', async () => {
    const endpoint = boundEndpointSchema.parse({
      ...ENDPOINT_INPUT,
      credential: { kind: 'ephemeral', secretRef: 'cold-session-secret-ref' },
    });
    const harness = createHarness({ endpoint, vault: new AdhocEndpointVault() });

    await expect(ensurePromptAuthReady(harness.session, harness.accessor, { profile: CURRENT_PROFILE }))
      .rejects.toMatchObject({ message: expect.stringContaining('credential_unavailable') });

    expect(harness.authSummary.ensureReady).not.toHaveBeenCalled();
  });
});
