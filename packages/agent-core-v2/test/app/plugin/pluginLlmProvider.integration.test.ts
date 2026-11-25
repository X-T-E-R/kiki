import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _clearScopedRegistryForTests,
  registerScopedService,
  ScopeActivation,
  type ScopeSeed,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IAuthSummaryService, IOAuthService } from '#/app/auth/auth';
import { AuthSummaryService } from '#/app/auth/authService';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import type { Event2 } from '#/app/event/event2';
import { IFlagService } from '#/app/flag/flag';
import { ModelCatalogChanged } from '#/app/kosongConfig/discovery';
import { extractZip } from '#/app/plugin/archive';
import { IPluginExtensionPortRegistry } from '#/app/plugin/extensionSlots';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginHostService, PluginHostService } from '#/app/plugin/pluginHostService';
import {
  IPluginLlmDirectoryService,
  PluginLlmDirectoryService,
} from '#/app/plugin/pluginLlmDirectory';
import { PluginService } from '#/app/plugin/pluginService';
import { IPluginSettingsService, PluginSettingsService } from '#/app/plugin/pluginSettingsService';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { PluginUsageService } from '#/app/pluginUsage/pluginUsageService';
import { IRequestIdentityCatalog } from '#/app/requestIdentity/requestIdentityCatalog';
import { LifecycleScope } from '#/app/scopes';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import {
  APIContextOverflowError,
  APIStatusError,
  hasExplicitRetryVeto,
  isAbortError,
} from '#/kosong/contract/errors';
import { generate } from '#/kosong/contract/generate';
import { createToolMessage, createUserMessage, type ThinkPart, type ToolCall } from '#/kosong/contract/message';
import { IModelCatalog } from '#/kosong/model/catalog';
import { ModelCatalog } from '#/kosong/model/catalogService';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IModelService } from '#/kosong/model/model';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';
import { ModelService } from '#/kosong/model/modelService';
import { IRequestAdmission } from '#/kosong/model/requestAdmission';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import { IProviderService } from '#/kosong/provider/provider';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { projectProfileModelMenu } from '#/session/subagent/modelCatalogProjection';
import { AdhocEndpointVault } from '#/session/adhocEndpoint/adhocEndpointVault';

import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubProviderService } from '../provider/stubs';

async function buildZip(entries: readonly { path: string; data: Buffer | string }[]): Promise<Buffer> {
  const zip = new ZipFile();
  for (const entry of entries) {
    zip.addBuffer(typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data, entry.path);
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const FIXTURE_PLUGIN_ENTRY = `
const observedDataDirs = {};

export function handlePanelRequest(action, _args, ctx) {
  observedDataDirs.panel = ctx.dataDir;
  if (action === 'inspect-data-dirs') {
    return { ...observedDataDirs };
  }
  return { ok: true, dataDir: ctx.dataDir };
}

export function register(api) {
  let signedIn = false;
  let quotaRevision = 'rev-1';
  let refreshCount = 0;
  let lastRequestSummary = null;
  let abortedStreamCount = 0;

  let providerHandle;
  let quotaHandle;

  providerHandle = api.registerLlmProvider(
    {
      schemaVersion: 1,
      id: 'acme-bridge',
      label: 'Acme Bridge',
      panelId: 'accounts',
      defaultModels: [],
    },
    {
      async describe(ctx) {
        observedDataDirs.describe = ctx.dataDir;
        if (!signedIn) {
          return {
            readiness: 'auth_required',
            statusText: 'Sign in via Acme Bridge panel',
            models: [],
          };
        }
        return {
          readiness: 'ready',
          statusText: 'Connected',
          accountSummary: 'alice@example.test',
          models: [
            {
              id: 'acme-bridge/alpha-1',
              wireModel: 'alpha-1-wire',
              displayName: 'Acme Alpha 1',
              maxContextSize: 200000,
              maxOutputSize: 16384,
              capabilities: ['thinking', 'image_in'],
              supportEfforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
            },
          ],
        };
      },
      async forceRefreshAuth(ctx) {
        observedDataDirs.forceRefreshAuth = ctx.dataDir;
        refreshCount += 1;
        return true;
      },
      async *stream(req, ctx) {
        observedDataDirs.stream = ctx.dataDir;
        const lastUser = [...req.history].reverse().find((m) => m.role === 'user');
        const userText = lastUser
          ? lastUser.content.filter((p) => p.type === 'text').map((p) => p.text).join('')
          : '';
        const hasDeferredToolsMessage = req.history.some((m) => Array.isArray(m.tools) && m.tools.length > 0);
        lastRequestSummary = {
          wireModel: req.wireModel,
          toolCount: req.tools.length,
          hasDeferredToolsMessage,
          textBytes: Buffer.byteLength(userText, 'utf8'),
          effort: req.options?.thinking?.effort,
        };

        if (userText === '__OVERFLOW__') {
          yield {
            type: 'error',
            failure: {
              kind: 'context_overflow',
              message: 'prompt exceeds window',
              retryable: false,
              requestDispatched: false,
            },
          };
          return;
        }

        if (userText === '__AUTH_RETRY__') {
          if (refreshCount === 0) {
            yield {
              type: 'error',
              failure: {
                kind: 'auth',
                status: 401,
                message: 'token expired',
                retryable: true,
                requestDispatched: false,
              },
            };
            return;
          }
          yield { type: 'sent' };
          yield { type: 'part', part: { type: 'text', text: 'refreshed-ok:' + refreshCount } };
          yield {
            type: 'finish',
            result: {
              id: 'msg-after-refresh',
              traceId: 'trace-refresh',
              usage: null,
              finishReason: 'completed',
              rawFinishReason: 'stop',
            },
          };
          return;
        }

        if (userText === '__NON_RETRYABLE__') {
          yield {
            type: 'error',
            failure: {
              kind: 'http',
              status: 503,
              message: 'hard veto',
              retryable: false,
              requestDispatched: true,
            },
          };
          return;
        }

        if (userText === '__HANG_ABORT__') {
          yield { type: 'sent' };
          yield { type: 'part', part: { type: 'text', text: 'partial-before-abort' } };
          await new Promise((resolve) => {
            if (ctx.signal.aborted) {
              abortedStreamCount += 1;
              resolve();
              return;
            }
            ctx.signal.addEventListener('abort', () => {
              abortedStreamCount += 1;
              resolve();
            }, { once: true });
          });
          return;
        }

        if (userText === '__BENCH_CHUNKS__') {
          yield { type: 'sent' };
          for (let i = 0; i < 200; i += 1) {
            yield { type: 'part', part: { type: 'text', text: 'c' + i + ' ' } };
          }
          yield {
            type: 'finish',
            result: {
              id: 'msg-bench',
              usage: { inputOther: 10, output: 200 },
              finishReason: 'completed',
              rawFinishReason: 'stop',
            },
          };
          return;
        }

        if (userText === '__TOOL_AND_VAULT__') {
          yield { type: 'sent' };
          yield { type: 'part', part: { type: 'think', think: 'planning call', encrypted: 'enc-sig-1' } };
          yield {
            type: 'part',
            part: {
              type: 'function',
              id: 'call_vault_1',
              name: 'AgentRun',
              arguments: JSON.stringify({
                description: 'run endpoint',
                prompt: 'hi',
                endpoint: {
                  base_url: 'https://eval.example.test/v1',
                  model: 'eval-1',
                  api_key: 'sk-secret-value-never-leak',
                },
              }),
              extras: { thoughtSignature: 'sig-xyz' },
            },
          };
          yield {
            type: 'finish',
            result: {
              id: 'msg-tool',
              traceId: 'trace-tool',
              usage: { inputOther: 120, inputCacheRead: 40, output: 30 },
              finishReason: 'tool_calls',
              rawFinishReason: 'tool_use',
            },
          };
          return;
        }

        yield { type: 'sent' };
        yield { type: 'part', part: { type: 'text', text: JSON.stringify(lastRequestSummary) } };
        yield {
          type: 'finish',
          result: {
            id: 'msg-echo',
            usage: { inputOther: 50, output: 25 },
            finishReason: 'completed',
            rawFinishReason: 'stop',
          },
        };
      },
    },
  );

  quotaHandle = api.registerProviderQuotaSource(
    {
      schemaVersion: 1,
      id: 'acme-quota',
      providerId: 'acme-bridge',
      label: 'Acme Bridge Quota',
      panelId: 'accounts',
    },
    {
      async listTargets(ctx) {
        observedDataDirs.listTargets = ctx.dataDir;
        if (!signedIn) return [];
        return [
          {
            id: 'acct-primary',
            label: 'Acme (Alice)',
            accountLabel: 'alice@example.test',
            revision: quotaRevision,
            active: true,
          },
        ];
      },
      async read(_targetId, ctx) {
        observedDataDirs.read = ctx.dataDir;
        return {
          ok: true,
          meters: [
            {
              id: 'model-alpha',
              label: 'Alpha 1',
              unit: 'percent',
              scope: 'model',
              used: 20,
              limit: 100,
              remaining: 80,
              status: 'ready',
            },
          ],
        };
      },
    },
  );

  api.registerTool(
    {
      schemaVersion: 1,
      name: 'acme_sign_in',
      description: 'Toggle fixture auth state',
      parameters: { type: 'object', properties: { signedIn: { type: 'boolean' }, quotaRevision: { type: 'string' } } },
    },
    async (args) => {
      signedIn = args.signedIn !== false;
      if (typeof args.quotaRevision === 'string') {
        quotaRevision = args.quotaRevision;
      }
      providerHandle.invalidate();
      quotaHandle.invalidate();
      return {
        output: JSON.stringify({ signedIn, quotaRevision, abortedStreamCount }),
      };
    },
  );
}
`;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('pure-plugin LLM provider & quota E2E', () => {
  let homeDir: string;
  let host: ScopedTestHost | undefined;
  let configText = '';

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    homeDir = await mkdtemp(join(tmpdir(), 'kiki-plugin-llm-e2e-'));
    configText = 'default_model = ""\n';
    await writeFile(join(homeDir, 'config.toml'), configText, 'utf8');
  });

  afterEach(async () => {
    await host?.dispose();
    host = undefined;
    _clearScopedRegistryForTests();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('installs a neutral .zip plugin, handles live auth invalidation, streaming/tools/vault/16MiB/errors/abort/latency, subagent projection, and clean withdrawal without touching config.toml', async () => {
    const zipPath = join(homeDir, 'acme-bridge-plugin.zip');
    const manifest = {
      name: 'acme-bridge-plugin',
      version: '1.0.0',
      description: 'Neutral test fixture LLM provider plugin',
      'x-kiki': {
        engines: { kiki: '>=0.4.4' },
        entry: './entry.mjs',
        permissions: { uiPanel: true },
        tools: [
          {
            schemaVersion: 1,
            name: 'acme_sign_in',
            description: 'Toggle fixture auth state',
            parameters: { type: 'object', properties: { signedIn: { type: 'boolean' }, quotaRevision: { type: 'string' } } },
          },
        ],
        panels: [
          {
            schemaVersion: 1,
            id: 'accounts',
            label: 'Acme Accounts',
            path: './panel.html',
            slot: 'settings',
          },
        ],
        llmProviders: [
          {
            schemaVersion: 1,
            id: 'acme-bridge',
            label: 'Acme Bridge',
            panelId: 'accounts',
            defaultModels: [],
          },
        ],
        providerQuotaSources: [
          {
            schemaVersion: 1,
            id: 'acme-quota',
            providerId: 'acme-bridge',
            label: 'Acme Bridge Quota',
            panelId: 'accounts',
          },
        ],
      },
    };
    const zipBytes = await buildZip([
      { path: 'kimi.plugin.json', data: JSON.stringify(manifest, null, 2) },
      { path: 'entry.mjs', data: FIXTURE_PLUGIN_ENTRY },
      { path: 'panel.html', data: '<!doctype html><html><body>Acme Panel</body></html>' },
    ]);
    await writeFile(zipPath, zipBytes);
    const extractedRoot = await extractZip(zipBytes, join(homeDir, 'extracted-plugin'));

    const emittedEvents: Event2[] = [];
    const configData: Record<string, unknown> = { models: {}, providers: {}, defaultModel: '' };

    registerScopedService(LifecycleScope.App, IFileSystemStorageService, FileStorageService, ScopeActivation.OnDemand);
    registerScopedService(LifecycleScope.App, IAtomicDocumentStore, JsonAtomicDocumentStore, ScopeActivation.OnDemand);
    registerScopedService(LifecycleScope.App, IPluginSettingsService, PluginSettingsService, ScopeActivation.OnDemand);
    registerScopedService(LifecycleScope.App, IPluginUsageService, PluginUsageService, ScopeActivation.OnDemand);
    registerScopedService(LifecycleScope.App, IPluginService, PluginService, ScopeActivation.OnDemand);
    registerScopedService(LifecycleScope.App, IPluginLlmDirectoryService, PluginLlmDirectoryService, ScopeActivation.OnScopeCreated);
    registerScopedService(LifecycleScope.App, IPluginHostService, PluginHostService, ScopeActivation.OnScopeCreated);
    registerScopedService(LifecycleScope.App, IModelService, ModelService, ScopeActivation.OnDemand);
    registerScopedService(LifecycleScope.App, IModelCatalog, ModelCatalog, ScopeActivation.OnDemand);
    registerScopedService(LifecycleScope.App, IAuthSummaryService, AuthSummaryService, ScopeActivation.OnDemand);

    const providers = stubProviderService();
    const stubs: ScopeSeed = [
      stubPair(ILogService, stubLog()),
      stubPair(IBootstrapService, stubBootstrap(homeDir, {})),
      stubPair(IProviderService, providers),
      stubPair(IOAuthService, {
        _serviceBrand: undefined,
        onDidChange: () => ({ dispose() {} }),
        list: () => [],
        get: () => undefined,
        has: () => false,
        getStatus: () => ({ authenticated: false, state: 'unauthenticated' }),
        getAccessToken: async () => { throw new Error('unused'); },
        forceRefresh: async () => { throw new Error('unused'); },
        invalidateAccessToken: () => {},
        signOut: async () => {},
        listConfiguredMethods: () => [],
      } as unknown as IOAuthService),
      stubPair(IConfigService, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        reload: async () => {},
        onDidChange: () => ({ dispose() {} }),
        onDidSectionChange: () => ({ dispose() {} }),
        get: () => configData,
        getSection: (key: string) => configData[key],
        replace: async () => { throw new Error('config.toml must never be mutated by plugin providers'); },
        updateSection: async () => { throw new Error('config.toml must never be mutated by plugin providers'); },
        patch: async () => { throw new Error('config.toml must never be mutated by plugin providers'); },
      } as unknown as IConfigService),
      stubPair(IEventService, {
        _serviceBrand: undefined,
        publish: (ev: Event2) => { emittedEvents.push(ev); },
        onDidPublish: () => ({ dispose() {} }),
      } as unknown as IEventService),
      stubPair(IFlagService, {
        _serviceBrand: undefined,
        enabled: () => false,
        onDidChange: () => ({ dispose() {} }),
      } as unknown as IFlagService),
      stubPair(ISkillDiscovery, {
        _serviceBrand: undefined,
        discover: async () => ({ skills: [], skipped: [], scannedRoots: [], scannedDirectories: [] }),
      } satisfies ISkillDiscovery),
      stubPair(IPluginExtensionPortRegistry, {
        _serviceBrand: undefined,
        register: () => ({ dispose() {} }),
      } as unknown as IPluginExtensionPortRegistry),
      stubPair(IRequestIdentityCatalog, {
        _serviceBrand: undefined,
        list: () => [],
        get: () => undefined,
      } as unknown as IRequestIdentityCatalog),
      stubPair(ISessionIndex, {
        _serviceBrand: undefined,
        listRecent: async () => [],
      } as unknown as ISessionIndex),
      stubPair(ISessionManager, {
        _serviceBrand: undefined,
        listLive: () => [],
      } as unknown as ISessionManager),
      stubPair(IModelOAuthTokens, {
        _serviceBrand: undefined,
        hasCachedAccessToken: () => false,
        resolveTokenProvider: () => undefined,
      } as unknown as IModelOAuthTokens),
      stubPair(IProtocolAdapterRegistry, {
        _serviceBrand: undefined,
        get: () => undefined,
        list: () => [],
      } as unknown as IProtocolAdapterRegistry),
      stubPair(IHostRequestHeaders, {
        _serviceBrand: undefined,
        headers: () => ({}),
        thirdPartyHeaders: () => ({}),
      } as unknown as IHostRequestHeaders),
      stubPair(IRequestAdmission, {
        _serviceBrand: undefined,
        acquire: async () => ({ release() {} }),
      } as unknown as IRequestAdmission),
    ];

    host = createScopedTestHost(stubs);
    const pluginService = host.app.accessor.get(IPluginService);
    const pluginHost = host.app.accessor.get(IPluginHostService);
    const llmDir = host.app.accessor.get(IPluginLlmDirectoryService);
    const modelService = host.app.accessor.get(IModelService);
    const modelCatalog = host.app.accessor.get(IModelCatalog);
    const authSummary = host.app.accessor.get(IAuthSummaryService);
    const configService = host.app.accessor.get(IConfigService);

    modelService.loadAll({}, undefined);
    await llmDir.waitForManifestIndex();
    expect(llmDir.listProviders()).toEqual([]);

    const plan = await pluginService.previewPlugin({ source: extractedRoot });
    await pluginService.installPlugin({ source: extractedRoot, fingerprint: plan.fingerprint, consent: true });
    await waitForCondition(() => llmDir.getProvider('acme-bridge') !== undefined);

    const initialProvider = await llmDir.ensureProviderDescribed('acme-bridge');
    expect(initialProvider?.readiness).toBe('auth_required');
    expect(initialProvider?.models).toEqual([]);

    await expect(authSummary.ensureReady('acme-bridge/alpha-1')).rejects.toThrow();

    const providersBefore = await modelCatalog.listProviders();
    const acmeBefore = providersBefore.find((p) => p.id === 'acme-bridge');
    expect(acmeBefore).toMatchObject({
      id: 'acme-bridge',
      type: 'plugin',
      label: 'Acme Bridge',
      status: 'unconfigured',
      plugin: {
        plugin_id: 'acme-bridge-plugin',
        panel_id: 'accounts',
        readiness: 'auth_required',
        model_count: 0,
      },
    });

    await pluginHost.execute(
      'acme-bridge-plugin',
      'acme_sign_in',
      { signedIn: true },
      new AbortController().signal,
    );
    await waitForCondition(() => llmDir.getProvider('acme-bridge')?.readiness === 'ready');

    const described = await llmDir.ensureProviderDescribed('acme-bridge');
    expect(described?.readiness).toBe('ready');
    expect(described?.accountSummary).toBe('alice@example.test');
    expect(described?.models.map((m) => m.id)).toEqual(['acme-bridge/alpha-1']);
    expect(emittedEvents.some((e) => e instanceof ModelCatalogChanged)).toBe(true);

    expect(modelService.list()).toEqual({});
    expect(Object.keys(modelService.listEffective?.() ?? {})).toContain('acme-bridge/alpha-1');
    expect(modelService.resolveId('acme-bridge/alpha-1')).toBe('acme-bridge/alpha-1');

    const catalogModels = await modelCatalog.listModels();
    const alphaCatalog = catalogModels.find((m) => m.id === 'acme-bridge/alpha-1');
    expect(alphaCatalog).toMatchObject({
      id: 'acme-bridge/alpha-1',
      provider_id: 'acme-bridge',
      remote_id: 'alpha-1-wire',
      effective_protocol: 'plugin',
      protocol_source: 'plugin',
      max_context_size: 200000,
    });

    await expect(authSummary.ensureReady('acme-bridge/alpha-1')).resolves.toBeUndefined();

    const menu = projectProfileModelMenu(
      { name: 'implementer', executor: 'native' },
      modelService,
      configService,
      'sub',
    );
    expect(menu.effectiveModelAliases).toContain('acme-bridge/alpha-1');

    const modelSpec = modelCatalog.get('acme-bridge/alpha-1');
    expect(modelSpec.protocol).toBe('plugin');
    expect(modelSpec.pluginOwner).toMatchObject({ pluginId: 'acme-bridge-plugin', providerId: 'acme-bridge' });

    const chatProvider = llmDir.createChatProvider('acme-bridge', 'acme-bridge/alpha-1', 'alpha-1-wire');
    expect(chatProvider).toBeDefined();

    const vault = new AdhocEndpointVault();
    const toolResult = await generate(
      chatProvider!,
      'system prompt',
      [{ name: 'AgentRun', description: 'Run subagent', parameters: { type: 'object' } }],
      [
        createUserMessage('__TOOL_AND_VAULT__'),
        { ...createToolMessage('prev_1', 'loaded'), tools: [{ name: 'DynamicTool', description: 'Deferred tool', parameters: { type: 'object' } }] },
      ],
      undefined,
      {
        thinking: { effort: 'high' },
        toolCallIngress: (call: ToolCall) => vault.scrub('agent-main', call),
      },
    );
    expect(toolResult.id).toBe('msg-tool');
    expect(toolResult.traceId).toBe('trace-tool');
    expect(toolResult.finishReason).toBe('tool_calls');
    expect(toolResult.rawFinishReason).toBe('tool_use');
    expect(toolResult.usage).toEqual({ inputOther: 120, inputCacheRead: 40, inputCacheCreation: 0, output: 30 });
    const thinkPart = (toolResult.message.content as readonly unknown[]).find((p) => (p as ThinkPart).type === 'think') as ThinkPart;
    expect(thinkPart).toEqual({ type: 'think', think: 'planning call', encrypted: 'enc-sig-1' });
    expect(toolResult.message.toolCalls).toHaveLength(1);
    const scrubbedCall = toolResult.message.toolCalls![0]!;
    expect(scrubbedCall.extras).toEqual({ thoughtSignature: 'sig-xyz' });
    expect(scrubbedCall.arguments).not.toContain('sk-secret-value-never-leak');
    expect(scrubbedCall.arguments).toContain('[REDACTED]');
    const secretRef = vault.claim('agent-main', 'call_vault_1');
    expect(secretRef).toBeDefined();
    expect(vault.read(secretRef!)).toBe('sk-secret-value-never-leak');

    const bigPayload = 'A'.repeat(17 * 1024 * 1024);
    const bigResult = await generate(
      chatProvider!,
      'sys',
      [],
      [
        { ...createToolMessage('sel_1', 'ok'), tools: [{ name: 'DeferredX', description: 'desc', parameters: { type: 'object' } }] },
        createUserMessage(bigPayload),
      ],
    );
    const parsedBig = JSON.parse(
      typeof bigResult.message.content === 'string'
        ? bigResult.message.content
        : bigResult.message.content.filter((p) => p.type === 'text').map((p) => p.text).join(''),
    ) as { textBytes: number; hasDeferredToolsMessage: boolean; wireModel: string };
    expect(parsedBig.textBytes).toBe(17 * 1024 * 1024);
    expect(parsedBig.hasDeferredToolsMessage).toBe(true);
    expect(parsedBig.wireModel).toBe('alpha-1-wire');

    await expect(
      generate(chatProvider!, 'sys', [], [createUserMessage('__OVERFLOW__')]),
    ).rejects.toBeInstanceOf(APIContextOverflowError);

    try {
      await generate(chatProvider!, 'sys', [], [createUserMessage('__NON_RETRYABLE__')]);
      expect.unreachable('expected non-retryable status error');
    } catch (error) {
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(503);
      expect(hasExplicitRetryVeto(error)).toBe(true);
    }

    const requester = modelCatalog.getRequester('acme-bridge/alpha-1');
    const authRetryEvents: string[] = [];
    for await (const ev of requester.request(
      {
        systemPrompt: 'sys',
        tools: [],
        messages: [createUserMessage('__AUTH_RETRY__')],
      },
      undefined,
      {
        attribution: {
          logicalRequestId: 'req-auth-retry-1',
          purpose: 'connectivity_probe',
          waitBudget: { waitedMs: 0 },
        },
      },
    )) {
      if (ev.type === 'part' && ev.part.type === 'text') {
        authRetryEvents.push(ev.part.text);
      }
    }
    expect(authRetryEvents.join('')).toBe('refreshed-ok:1');

    const abortCtrl = new AbortController();
    let sawPartial = false;
    const abortPromise = generate(
      chatProvider!,
      'sys',
      [],
      [createUserMessage('__HANG_ABORT__')],
      {
        onMessagePart: (part) => {
          if (part.type === 'text' && part.text.includes('partial-before-abort')) {
            sawPartial = true;
            abortCtrl.abort();
          }
        },
      },
      { signal: abortCtrl.signal },
    );
    await expect(abortPromise).rejects.toSatisfy((err: unknown) => isAbortError(err));
    expect(sawPartial).toBe(true);

    const chunkGapsMs: number[] = [];
    let lastChunkAt = 0;
    const benchResult = await generate(
      chatProvider!,
      'sys',
      [],
      [createUserMessage('__BENCH_CHUNKS__')],
      {
        onMessagePart: (part) => {
          if (part.type !== 'text') return;
          const now = performance.now();
          if (lastChunkAt > 0) chunkGapsMs.push(now - lastChunkAt);
          lastChunkAt = now;
        },
      },
    );
    expect(benchResult.finishReason).toBe('completed');
    expect(benchResult.rawFinishReason).toBe('stop');
    const sortedGaps = [...chunkGapsMs].sort((a, b) => a - b);
    const p50 = percentile(sortedGaps, 50);
    const p95 = percentile(sortedGaps, 95);
    const maxGap = sortedGaps[sortedGaps.length - 1] ?? 0;
    process.stdout.write(
      `[plugin-llm-stream-latency] chunks=${chunkGapsMs.length} p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${maxGap.toFixed(3)}ms\n`,
    );
    expect(chunkGapsMs.length).toBeGreaterThanOrEqual(190);
    expect(p50).toBeLessThan(2);

    const quotaSources = llmDir.listQuotaSources();
    expect(quotaSources).toHaveLength(1);
    const quotaTargets = await quotaSources[0]!.runtime.listTargets();
    expect(quotaTargets).toEqual([
      { id: 'acct-primary', label: 'Acme (Alice)', accountLabel: 'alice@example.test', revision: 'rev-1', active: true },
    ]);
    const quotaReading = await quotaSources[0]!.runtime.read('acct-primary');
    expect(quotaReading.ok).toBe(true);
    if (quotaReading.ok) {
      expect(quotaReading.meters[0]).toMatchObject({ id: 'model-alpha', scope: 'model', remaining: 80 });
    }

    const expectedDataDir = join(homeDir, 'plugins', 'data', 'acme-bridge-plugin');
    const observed = await pluginHost.requestPanel(
      'acme-bridge-plugin',
      'accounts',
      'inspect-data-dirs',
      {},
      new AbortController().signal,
    ) as Record<string, string>;
    for (const key of ['describe', 'stream', 'forceRefreshAuth', 'listTargets', 'read', 'panel']) {
      expect(observed[key]).toBe(expectedDataDir);
      expect(observed[key]!.replace(/\\/g, '/').endsWith('/plugins/data/acme-bridge-plugin')).toBe(true);
    }

    await pluginService.setPluginEnabled({ id: 'acme-bridge-plugin', enabled: false });
    await waitForCondition(() => llmDir.listProviders().length === 0);
    expect(llmDir.listProviders()).toEqual([]);
    expect(llmDir.listQuotaSources()).toEqual([]);
    expect(modelService.listEffective?.() ?? {}).toEqual({});
    expect((await modelCatalog.listProviders()).some((p) => p.id === 'acme-bridge')).toBe(false);

    const finalConfig = await readFile(join(homeDir, 'config.toml'), 'utf8');
    expect(finalConfig).toBe(configText);
  }, 30_000);
});
