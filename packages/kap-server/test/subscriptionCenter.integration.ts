import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findBlockingUnboundModelHold,
  IAtomicDocumentStore,
  IBootstrapService,
  IConfigService,
  parseAgentFileText,
  readUnboundModelHolds,
} from '@kiki/agent-core-v2';
import { createKlient } from '@kiki/klient/http';
import {
  ErrorCode,
  evaluateSubscriptionSelection,
  formatBindingSlotTupleKey,
  portableSpaceSourcesListResponseSchema,
  portableSpaceSubscriptionSyncResultSchema,
  toggleSubscriptionScope,
  type PortableSpaceSubscriptionSelection,
} from '@kiki/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAge } from '../src/services/portableSpace/ageCodec';
import {
  computeWinnerIndex,
  type SubscriptionSourcePlanState,
} from '../src/services/portableSpace/subscriptionPlanner';
import { packTarGz } from '../src/services/portableSpace/tarArchive';
import { fetchSubscriptionArchive } from '../src/services/portableSpace/urlSubscription';
import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

function buildMultiProfilePack(options: {
  readonly implementerBody?: string;
  readonly providerOrigin?: string;
  readonly providerKey?: string;
  readonly includeExtraScope?: boolean;
} = {}): Map<string, Buffer> {
  const implementerBody = options.implementerBody ?? 'Implementer v1 instructions.';
  const providerOrigin = options.providerOrigin ?? 'https://origin-a.example.test';
  const providerKey = options.providerKey ?? 'sk-pack-a-secret-key';
  const configToml = `default_provider = "shared"
default_model = "src-fast"

[providers.shared]
type = "openai_responses"
base_url = "${providerOrigin}/v1"

[models.src-fast]
provider = "shared"
model = "src-fast-id"
max_context_size = 128000

[models.src-think]
provider = "shared"
model = "src-think-id"
max_context_size = 128000

[models.src-code]
provider = "shared"
model = "src-code-id"
max_context_size = 128000

[models."k3.1-pro"]
provider = "shared"
model = "k3.1-pro-id"
max_context_size = 128000
recipe = "lab-rec"
`;

  const credentialsToml = `[providers.shared]
api_key = "${providerKey}"
`;

  const mcpJson = JSON.stringify({
    mcpServers: {
      'config.remote-docs': {
        url: 'https://docs.example.test/mcp',
      },
    },
  });

  const files = new Map<string, Buffer>([
    ['config.toml', Buffer.from(configToml, 'utf8')],
    ['credentials/credentials.toml', Buffer.from(credentialsToml, 'utf8')],
    ['mcp.json', Buffer.from(mcpJson, 'utf8')],
    ['agents/implementer.md', Buffer.from(`---\nname: implementer\ndescription: Main implementer\nmodel_alias: src-fast\n---\n${implementerBody}\n`, 'utf8')],
    ['agents/explore.md', Buffer.from('---\nname: explore\ndescription: Fast explorer\nmodel_alias: src-fast\n---\nExplore body.\n', 'utf8')],
    ['agents/worker.md', Buffer.from('---\nname: worker\ndescription: Routine worker\nmodel_alias: src-fast\n---\nWorker body.\n', 'utf8')],
    ['agents/think.md', Buffer.from('---\nname: think\ndescription: Deep thinker\nmodel_alias: src-think\n---\nThink body.\n', 'utf8')],
    ['agents/reviewer.md', Buffer.from('---\nname: reviewer\ndescription: Independent reviewer\nmodel_alias: src-think\n---\nReviewer body.\n', 'utf8')],
    ['agents/researcher.md', Buffer.from('---\nname: researcher\ndescription: Deep researcher\nmodel_alias: src-think\n---\nResearcher body.\n', 'utf8')],
    ['agents/coder-custom.md', Buffer.from('---\nname: coder-custom\ndescription: Specialized coder\nmodel_alias: src-code\n---\nCoder body.\n', 'utf8')],
    ['recipes/lab-rec/recipe.toml', Buffer.from('schema_version = 1\nid = "lab-rec"\nname = "Lab Recipe"\nversion = "1.0.0"\n\n[prompts]\nsystem = { file = "system.md" }\n', 'utf8')],
    ['recipes/lab-rec/system.md', Buffer.from('# Lab Recipe v1\nFollow lab verification rules.\n', 'utf8')],
    ['personas/nia/persona.md', Buffer.from('---\nname: Nia\ntitle: Lab Companion\n---\nHelpful lab persona.\n', 'utf8')],
    ['personas/nia/notes.md', Buffer.from('Companion notes.\n', 'utf8')],
  ]);

  if (options.includeExtraScope) {
    files.set('AGENTS.md', Buffer.from('# Global Workspace Instructions\nCheck evidence first.\n', 'utf8'));
  }

  return files;
}

function seedLocalHomeConfig(homeDir: string): Promise<void> {
  const localConfig = `default_provider = "local"
default_model = "local-alpha"

[providers.local]
type = "openai_responses"
base_url = "https://local.example.test/v1"

[models.local-alpha]
provider = "local"
model = "local-alpha-id"
max_context_size = 128000

[models.local-beta]
provider = "local"
model = "local-beta-id"
max_context_size = 128000
`;
  const localCredentials = `[providers.local]
api_key = "sk-local-user-key"
`;
  return mkdir(join(homeDir, 'credentials'), { recursive: true })
    .then(() =>
      Promise.all([
        writeFile(join(homeDir, 'config.toml'), localConfig, 'utf8'),
        writeFile(join(homeDir, 'credentials', 'credentials.toml'), localCredentials, 'utf8'),
      ]),
    )
    .then(() => undefined);
}

describe('Subscription Center v1 backend, protocol, klient & multi-source invariants', () => {
  const tempDirs: string[] = [];
  const runningServers: RunningServer[] = [];
  let httpServer: Server;
  let httpBaseUrl = '';

  const routes = new Map<string, { body: Buffer; etag: string; unsolicited304?: boolean }>();

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const entry = routes.get(path);
      if (entry === undefined) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      if (entry.unsolicited304) {
        res.statusCode = 304;
        res.end();
        return;
      }
      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string' && inm.trim() === entry.etag) {
        res.statusCode = 304;
        res.setHeader('etag', entry.etag);
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('etag', entry.etag);
      res.end(entry.body);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const addr = httpServer.address();
    if (addr === null || typeof addr === 'string') throw new Error('Failed to bind test HTTP server');
    httpBaseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await Promise.all(runningServers.map((srv) => srv.close().catch(() => undefined)));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
  }, 60_000);

  async function bootIsolatedServer(withLocalModels = true): Promise<{
    readonly homeDir: string;
    readonly server: RunningServer;
    readonly baseUrl: string;
    readonly klient: ReturnType<typeof createKlient>;
  }> {
    const homeDir = await mkdtemp(join(tmpdir(), 'kiki-sub-center-'));
    tempDirs.push(homeDir);
    if (withLocalModels) {
      await seedLocalHomeConfig(homeDir);
    }
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir,
      hostIdentity: TEST_HOST_IDENTITY,
      allowLoopbackSubscriptions: true,
    });
    runningServers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const klient = createKlient({ endpoint: baseUrl, token: server.localOwnerToken });
    return { homeDir, server, baseUrl, klient };
  }

  it('defines portable error codes cleanly and rejects unsolicited 304 responses', async () => {
    expect(ErrorCode.PORTABLE_UNLOCK_REQUIRED).toBe(40109);
    expect(ErrorCode.PORTABLE_NOT_FOUND).toBe(40428);
    expect(ErrorCode.PORTABLE_PREVIEW_STALE).toBe(40951);
    expect(ErrorCode.PORTABLE_PREVIEW_EXPIRED).toBe(41004);

    routes.set('/unsolicited-304.tgz', { body: Buffer.alloc(0), etag: '"v1"', unsolicited304: true });
    await expect(
      fetchSubscriptionArchive(`${httpBaseUrl}/unsolicited-304.tgz`, { allowLoopback: true }),
    ).rejects.toThrow(/304/i);
  });

  it('enforces local-owner auth, zero-write read-only preview, passphrase unlock 40109, 40428 not_found, legacy vs center-v1 views, and bare DELETE', async () => {
    const { homeDir, baseUrl, klient } = await bootIsolatedServer(false);
    const packFiles = buildMultiProfilePack();
    const rawTgz = packTarGz(packFiles);
    const lockedAge = (await encodeAge(rawTgz, { mode: 'passphrase', passphrase: 'lab-passphrase-123' }, [], undefined as never)).bytes;
    routes.set('/plain.tgz', { body: rawTgz, etag: '"plain-v1"' });
    routes.set('/locked.age', { body: lockedAge, etag: '"locked-v1"' });

    const unauthRes = await fetch(`${baseUrl}/api/spaces/portable/sources`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(unauthRes.status).toBe(401);
    const unauthBody = await unauthRes.json() as { code: number };
    expect(unauthBody.code).toBe(40101);

    const preview = await klient.rest!.portableSpaces.previewSubscribe({
      source: { kind: 'url', url: `${httpBaseUrl}/plain.tgz` },
    });
    expect(preview.allowedPolicies).toEqual(['auto', 'manual', 'once']);
    expect(preview.items.some((item) => item.id === 'mcp:config%2Eremote-docs')).toBe(true);
    expect(existsSync(join(homeDir, 'sync-device-key.json'))).toBe(false);
    expect(existsSync(join(homeDir, 'portable-spaces.json'))).toBe(false);

    await expect(
      klient.rest!.portableSpaces.previewSubscribe({
        source: { kind: 'url', url: `${httpBaseUrl}/locked.age` },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PORTABLE_UNLOCK_REQUIRED });

    await expect(
      klient.rest!.portableSpaces.previewSubscribe({
        source: { kind: 'url', url: `${httpBaseUrl}/locked.age` },
        unlock: { passphrase: 'wrong-passphrase' },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PORTABLE_UNLOCK_REQUIRED });

    const unlockedPreview = await klient.rest!.portableSpaces.previewSubscribe({
      source: { kind: 'url', url: `${httpBaseUrl}/locked.age` },
      unlock: { passphrase: 'lab-passphrase-123' },
    });
    expect(unlockedPreview.allowedPolicies).toEqual(['manual', 'once']);
    expect(unlockedPreview.encryptionMode).toBe('passphrase');

    await expect(
      klient.rest!.portableSpaces.removeSource('nonexistent-source-id'),
    ).rejects.toMatchObject({ code: ErrorCode.PORTABLE_NOT_FOUND });

    const legacyList = await klient.rest!.portableSpaces.listSources();
    expect(portableSpaceSourcesListResponseSchema.parse(legacyList).items).toEqual([]);
    expect('orderRevisionBySpace' in legacyList).toBe(false);

    const centerList = await klient.rest!.portableSpaces.listSources({ view: 'center-v1' });
    expect(centerList.orderRevision).toBeTruthy();

    const registered = await klient.rest!.portableSpaces.registerSource({
      endpoint: { kind: 'url', url: `${httpBaseUrl}/plain.tgz` },
      label: 'Encoded Test',
    });
    const removedBare = await klient.rest!.portableSpaces.removeSource(registered.id);
    expect(removedBare).toEqual({ removed: true });

    await expect(
      klient.rest!.portableSpaces.apply({
        direct: {
          mode: 'merge',
          sources: [{ kind: 'url', url: `${httpBaseUrl}/plain.tgz` }],
          target: { kind: 'live', spaceId: 'main' },
        },
        createBackup: false,
      }),
    ).rejects.toThrow(/Subscription Center/i);

    const inspected = await klient.rest!.portableSpaces.inspect({
      endpoint: { kind: 'url', url: `${httpBaseUrl}/plain.tgz` },
    });
    expect(inspected.items.length).toBeGreaterThan(0);

    const exportPath = join(homeDir, 'exported-dir');
    const exported = await klient.rest!.portableSpaces.exportSpace({
      source: { kind: 'live', spaceId: 'main' },
      destination: exportPath,
      format: 'dir',
      spaceMode: 'full',
      secretMode: 'none',
      sessions: { mode: 'none' },
      includeMemories: false,
    });
    expect(exported.format).toBe('dir');

    const previewedDir = await klient.rest!.portableSpaces.preview({
      mode: 'merge',
      sources: [{ kind: 'dir', path: exportPath }],
      target: { kind: 'live', spaceId: 'main' },
    });
    expect(previewedDir.previewToken).toBeTruthy();

    const packedTgz = join(homeDir, 'packed.tgz');
    await klient.rest!.portableSpaces.pack({ sourcePath: exportPath, destinationPath: packedTgz, format: 'tgz' });
    const unpackedDir = join(homeDir, 'unpacked');
    await klient.rest!.portableSpaces.unpack({ sourcePath: packedTgz, destinationPath: unpackedDir });
    const forkedDir = join(homeDir, 'forked');
    await klient.rest!.portableSpaces.fork({
      source: { kind: 'dir', path: exportPath },
      destination: forkedDir,
      format: 'dir',
      overlay: false,
      secretMode: 'none',
      includeMemories: false,
    });
    const deltaPath = join(homeDir, 'delta.tgz');
    await klient.rest!.portableSpaces.delta({
      source: { kind: 'dir', path: exportPath },
      since: { kind: 'dir', path: forkedDir },
      destination: deltaPath,
      format: 'tgz',
      sessions: { mode: 'none' },
    });
    const mutated = await klient.rest!.portableSpaces.mutate({
      target: { kind: 'dir', path: forkedDir },
      actions: [{ op: 'set', key: 'thinking', value: true }],
    });
    expect(mutated.changed).toBe(true);
    const rekeyedPath = join(homeDir, 'rekeyed.age');
    const rekeyed = await klient.rest!.portableSpaces.rekey({
      target: packedTgz,
      outputPath: rekeyedPath,
      encryption: { mode: 'passphrase', passphrase: 'rekey-passphrase' },
    });
    expect(rekeyed.encryptionMode).toBe('passphrase');
    const recipientsUpdated = await klient.rest!.portableSpaces.addRecipient({
      recipient: legacyList.deviceRecipient,
      label: 'Self Device',
    });
    expect(recipientsUpdated.knownRecipients.some((r) => r.recipient === legacyList.deviceRecipient)).toBe(true);
  });

  it('supports grouped model bindings, per-profile overrides, explicit defer with persistent unbound holds, ETag prompt updates preserving local aliases, once import, and 304 catalog revalidation', async () => {
    const { homeDir, server, klient } = await bootIsolatedServer(true);
    const v1Files = buildMultiProfilePack({ implementerBody: 'Implementer v1 guidance.' });
    routes.set('/team-pack.tgz', { body: packTarGz(v1Files), etag: '"team-v1"' });

    const preview = await klient.rest!.portableSpaces.previewSubscribe({
      source: { kind: 'url', url: `${httpBaseUrl}/team-pack.tgz` },
    });

    const selectionWithoutModels: PortableSpaceSubscriptionSelection = toggleSubscriptionScope(
      preview,
      preview.defaultSelection,
      'models_providers',
      false,
    );

    const unresolvedEval = evaluateSubscriptionSelection(preview, selectionWithoutModels, {});
    expect(unresolvedEval.canConfirmInitial).toBe(false);
    const unresolvedGroups = unresolvedEval.groupedActionableSlots.filter((group) => group.hasUnresolved);
    expect(unresolvedGroups.length).toBe(3);

    const groupBySourceModel = new Map(unresolvedGroups.map((group) => [group.sourceModelId, group]));
    expect(groupBySourceModel.has('src-fast')).toBe(true);
    expect(groupBySourceModel.has('src-think')).toBe(true);
    expect(groupBySourceModel.has('src-code')).toBe(true);
    expect(groupBySourceModel.get('src-fast')!.slots.length).toBe(3);
    expect(groupBySourceModel.get('src-think')!.slots.length).toBe(3);
    expect(groupBySourceModel.get('src-code')!.slots.length).toBe(1);

    await expect(
      klient.rest!.portableSpaces.subscribe({
        previewToken: preview.previewToken,
        syncPolicy: 'auto',
        selection: selectionWithoutModels,
        createBackup: false,
      }),
    ).rejects.toMatchObject({ code: 40001 });
    expect(existsSync(join(homeDir, 'agents', 'implementer.md'))).toBe(false);

    const coderTupleKey = formatBindingSlotTupleKey('agents:agents/coder-custom%2Emd', 'src-code');
    const exploreTupleKey = formatBindingSlotTupleKey('agents:agents/explore%2Emd', 'src-fast');
    const resolvedBindings = {
      modelBindings: {
        'src-fast': 'local-alpha',
        'src-think': 'local-beta',
      },
      unitModelBindings: {
        [exploreTupleKey]: 'local-beta',
      },
      unmappedModelPolicy: 'defer' as const,
      deferredSlotIds: [coderTupleKey],
    };
    expect(evaluateSubscriptionSelection(preview, selectionWithoutModels, resolvedBindings).canConfirmInitial).toBe(true);

    const commit = await klient.rest!.portableSpaces.subscribe({
      previewToken: preview.previewToken,
      label: 'Team Pack',
      syncPolicy: 'auto',
      selection: selectionWithoutModels,
      ...resolvedBindings,
      createBackup: false,
    });
    expect(commit.kind).toBe('subscription');
    if (commit.kind !== 'subscription') throw new Error('Expected subscription commit');
    expect(commit.source.label).toBe('Team Pack');

    const implText = await readFile(join(homeDir, 'agents', 'implementer.md'), 'utf8');
    const implParsed = parseAgentFileText({ path: 'agents/implementer.md', text: implText, source: 'user' });
    expect(implParsed.modelAlias).toBe('local-alpha');
    expect(implText).toContain('Implementer v1 guidance.');

    const exploreText = await readFile(join(homeDir, 'agents', 'explore.md'), 'utf8');
    const exploreParsed = parseAgentFileText({ path: 'agents/explore.md', text: exploreText, source: 'user' });
    expect(exploreParsed.modelAlias).toBe('local-beta');

    const documents = server.core.accessor.get(IAtomicDocumentStore);
    const bootstrapInfo = server.core.accessor.get(IBootstrapService);
    const holdsDoc = await readUnboundModelHolds(documents, bootstrapInfo);
    expect(findBlockingUnboundModelHold(holdsDoc, 'profile', 'coder-custom', 'src-code')).toMatchObject({
      targetKind: 'profile',
      targetName: 'coder-custom',
      sourceModelId: 'src-code',
    });

    await expect(
      klient.rest!.portableSpaces.subscribe({
        previewToken: preview.previewToken,
        syncPolicy: 'auto',
        selection: selectionWithoutModels,
        ...resolvedBindings,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PORTABLE_PREVIEW_EXPIRED });

    const v2Files = buildMultiProfilePack({ implementerBody: 'Implementer v2 refreshed prompt!' });
    routes.set('/team-pack.tgz', { body: packTarGz(v2Files), etag: '"team-v2"' });

    const synced = await klient.rest!.portableSpaces.syncSubscription(
      commit.source.id,
      { force: false, createBackup: false },
      { view: 'center-v1' },
    );
    expect(synced.status).toBe('updated');
    const implTextV2 = await readFile(join(homeDir, 'agents', 'implementer.md'), 'utf8');
    expect(implTextV2).toContain('Implementer v2 refreshed prompt!');
    const implParsedV2 = parseAgentFileText({ path: 'agents/implementer.md', text: implTextV2, source: 'user' });
    expect(implParsedV2.modelAlias).toBe('local-alpha');

    const legacyResub = await klient.rest!.portableSpaces.subscribe({
      url: `${httpBaseUrl}/team-pack.tgz`,
      createBackup: false,
    });
    expect(portableSpaceSubscriptionSyncResultSchema.parse(legacyResub).status).toBe('updated');
    const implAfterLegacyResub = await readFile(join(homeDir, 'agents', 'implementer.md'), 'utf8');
    const implParsedLegacy = parseAgentFileText({ path: 'agents/implementer.md', text: implAfterLegacyResub, source: 'user' });
    expect(implParsedLegacy.modelAlias).toBe('local-alpha');
    expect(server.core.accessor.get(IConfigService).get<Record<string, unknown>>('models')?.['src-fast']).toBeUndefined();

    const configSvc = server.core.accessor.get(IConfigService);
    const baselineModels = { ...(configSvc.get<Record<string, unknown>>('models') ?? {}) };
    await configSvc.set('models', {
      'src-code': {
        provider: 'local',
        model: 'src-code-local-id',
        maxContextSize: 128000,
      },
    });

    const synced304Deferred = await klient.rest!.portableSpaces.syncSubscription(
      commit.source.id,
      { force: false },
      { view: 'center-v1' },
    );
    expect(synced304Deferred.status).toBe('not_modified');
    expect(synced304Deferred.kind === 'subscription' && synced304Deferred.source.needsReconcile).toBe(true);

    await configSvc.replace('models', baselineModels);
    const v3Files = buildMultiProfilePack({ implementerBody: 'Implementer v3 reset reconcile!' });
    routes.set('/team-pack.tgz', { body: packTarGz(v3Files), etag: '"team-v3"' });
    const syncedReset = await klient.rest!.portableSpaces.syncSubscription(
      commit.source.id,
      { force: false, createBackup: false },
      { view: 'center-v1' },
    );
    expect(syncedReset.status).toBe('updated');
    expect(syncedReset.kind === 'subscription' && syncedReset.source.needsReconcile).toBe(false);

    const currentModels = { ...(configSvc.get<Record<string, unknown>>('models') ?? {}) };
    delete currentModels['local-beta'];
    await configSvc.replace('models', currentModels);
    expect(configSvc.get<Record<string, unknown>>('models')?.['local-beta']).toBeUndefined();

    const synced304 = await klient.rest!.portableSpaces.syncSubscription(
      commit.source.id,
      { force: false },
      { view: 'center-v1' },
    );
    expect(synced304.status).toBe('not_modified');
    expect(synced304.kind === 'subscription' && synced304.source.needsReconcile).toBe(true);

    const onceArchivePath = join(homeDir, 'once-local.tgz');
    await writeFile(onceArchivePath, packTarGz(v1Files));
    const oncePreview = await klient.rest!.portableSpaces.previewSubscribe({
      source: { kind: 'archive', path: onceArchivePath },
    });
    expect(oncePreview.allowedPolicies).toEqual(['once']);
    const onceSelection: PortableSpaceSubscriptionSelection = {
      version: 1,
      enabledScopes: ['personas'],
      excludedIds: [],
      includedIds: [],
      includeCredentials: false,
    };
    const onceCommit = await klient.rest!.portableSpaces.subscribe({
      previewToken: oncePreview.previewToken,
      syncPolicy: 'once',
      selection: onceSelection,
      createBackup: false,
    });
    expect(onceCommit.kind).toBe('once');
    expect(onceCommit.status).toBe('imported');
    const centerAfterOnce = await klient.rest!.portableSpaces.listSources({ view: 'center-v1' });
    expect(centerAfterOnce.items.length).toBe(1);
  });

  it('enforces H/L priority, atomic reorder, offline credential-safe relinquishment, online peer takeover, and locally rotated key preservation', async () => {
    const { homeDir, server, klient } = await bootIsolatedServer(true);
    const packA = buildMultiProfilePack({
      providerOrigin: 'https://origin-a.example.test',
      providerKey: 'sk-source-a-key',
      implementerBody: 'Implementer from Source A',
    });
    const packB = buildMultiProfilePack({
      providerOrigin: 'https://origin-b.example.test',
      providerKey: 'sk-source-b-key',
      implementerBody: 'Implementer from Source B',
    });
    routes.set('/source-a.tgz', { body: packTarGz(packA), etag: '"a-v1"' });
    routes.set('/source-b.tgz', { body: packTarGz(packB), etag: '"b-v1"' });

    const prevA = await klient.rest!.portableSpaces.previewSubscribe({
      source: { kind: 'url', url: `${httpBaseUrl}/source-a.tgz` },
    });
    const commitA = await klient.rest!.portableSpaces.subscribe({
      previewToken: prevA.previewToken,
      label: 'Source A',
      syncPolicy: 'manual',
      selection: prevA.defaultSelection,
      createBackup: false,
    });
    if (commitA.kind !== 'subscription') throw new Error('Expected subscription A');

    const prevB = await klient.rest!.portableSpaces.previewSubscribe({
      source: { kind: 'url', url: `${httpBaseUrl}/source-b.tgz` },
    });
    const commitB = await klient.rest!.portableSpaces.subscribe({
      previewToken: prevB.previewToken,
      label: 'Source B',
      syncPolicy: 'manual',
      selection: prevB.defaultSelection,
      createBackup: false,
    });
    if (commitB.kind !== 'subscription') throw new Error('Expected subscription B');

    const configSvc = server.core.accessor.get(IConfigService);
    const providersInitial = configSvc.get<Record<string, { baseUrl?: string }>>('providers');
    expect(providersInitial?.['shared']?.baseUrl).toBe('https://origin-a.example.test/v1');

    const centerBefore = await klient.rest!.portableSpaces.listSources({ view: 'center-v1' });
    const orderRev = centerBefore.orderRevision;

    await expect(
      klient.rest!.portableSpaces.reorderSources({
        spaceId: 'main',
        orderedIds: [commitB.source.id, commitA.source.id],
        expectedOrderRevision: 'stale-order-rev',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PORTABLE_PREVIEW_STALE });

    const reordered = await klient.rest!.portableSpaces.reorderSources({
      spaceId: 'main',
      orderedIds: [commitB.source.id, commitA.source.id],
      expectedOrderRevision: orderRev,
    });
    expect(reordered.orderedIds).toEqual([commitB.source.id, commitA.source.id]);

    const restoredOrder = await klient.rest!.portableSpaces.reorderSources({
      spaceId: 'main',
      orderedIds: [commitA.source.id, commitB.source.id],
      expectedOrderRevision: reordered.orderRevision,
    });
    expect(restoredOrder.orderedIds).toEqual([commitA.source.id, commitB.source.id]);

    const removePreviewA = await klient.rest!.portableSpaces.previewRemoveSource(commitA.source.id);
    expect(removePreviewA.impact.pendingReconcileIds).toContain('config:providers.shared');
    expect(removePreviewA.impact.pendingReconcileIds).toContain('credentials:providers.shared');

    const removedA = await klient.rest!.portableSpaces.removeReviewedSource(commitA.source.id, {
      previewToken: removePreviewA.previewToken,
      purgeManaged: true,
      impactDigest: removePreviewA.impactDigest,
      createBackup: false,
    });
    expect(removedA.removed).toBe(true);
    expect(removedA.impact.pendingReconcileIds).toContain('config:providers.shared');

    const providersAfterOfflineRemove = configSvc.get<Record<string, { baseUrl?: string }>>('providers');
    expect(providersAfterOfflineRemove?.['shared']?.baseUrl).toBe('https://origin-a.example.test/v1');
    const credsAfterOfflineRemove = await readFile(join(homeDir, 'credentials', 'credentials.toml'), 'utf8');
    expect(credsAfterOfflineRemove).toContain('sk-source-a-key');

    const centerPendingB = await klient.rest!.portableSpaces.listSources({ view: 'center-v1' });
    const bState = centerPendingB.items.find((item) => item.id === commitB.source.id)!;
    expect(bState.needsReconcile).toBe(true);

    const bSyncedOnline = await klient.rest!.portableSpaces.syncSubscription(
      commitB.source.id,
      { force: false, createBackup: false },
      { view: 'center-v1' },
    );
    expect(bSyncedOnline.status).toBe('updated');
    const providersAfterBTakeover = configSvc.get<Record<string, { baseUrl?: string }>>('providers');
    expect(providersAfterBTakeover?.['shared']?.baseUrl).toBe('https://origin-b.example.test/v1');
    const credsAfterBTakeover = await readFile(join(homeDir, 'credentials', 'credentials.toml'), 'utf8');
    expect(credsAfterBTakeover).toContain('sk-source-b-key');

    const prevC = await klient.rest!.portableSpaces.previewSubscribe({
      source: { kind: 'url', url: `${httpBaseUrl}/source-a.tgz` },
    });
    const commitC = await klient.rest!.portableSpaces.subscribe({
      previewToken: prevC.previewToken,
      label: 'Source C',
      syncPolicy: 'manual',
      selection: prevC.defaultSelection,
      createBackup: false,
    });
    if (commitC.kind !== 'subscription') throw new Error('Expected subscription C');

    const removePreviewB = await klient.rest!.portableSpaces.previewRemoveSource(commitB.source.id);
    await klient.rest!.portableSpaces.removeReviewedSource(commitB.source.id, {
      previewToken: removePreviewB.previewToken,
      purgeManaged: true,
      impactDigest: removePreviewB.impactDigest,
      createBackup: false,
    });

    const rotatedCreds = (await readFile(join(homeDir, 'credentials', 'credentials.toml'), 'utf8')).replace('sk-source-b-key', 'sk-user-locally-rotated-key');
    await writeFile(join(homeDir, 'credentials', 'credentials.toml'), rotatedCreds, 'utf8');

    await klient.rest!.portableSpaces.syncSubscription(
      commitC.source.id,
      { force: false, createBackup: false },
      { view: 'center-v1' },
    );
    const credsAfterRotatedSync = await readFile(join(homeDir, 'credentials', 'credentials.toml'), 'utf8');
    expect(credsAfterRotatedSync).toContain('sk-user-locally-rotated-key');
    const providersAfterRotatedSync = configSvc.get<Record<string, { baseUrl?: string }>>('providers');
    expect(providersAfterRotatedSync?.['shared']?.baseUrl).toBe('https://origin-b.example.test/v1');
  });

  it('computes in-memory winner index across 16 sources x 1,000 overlapping units in under 10ms', () => {
    const sources: SubscriptionSourcePlanState[] = [];
    for (let s = 0; s < 16; s++) {
      const declared: string[] = [];
      for (let u = 0; u < 1000; u++) {
        declared.push(`agents:agents/agent-${(u + s * 37) % 1200}%2Emd`);
      }
      sources.push({
        id: `src-${s}`,
        label: `Source ${s}`,
        enabled: s % 5 !== 4,
        priority: s,
        syncPolicy: 'auto',
        bindingChoices: {},
        managedIds: s === 0 ? declared.slice(0, 600) : [],
        appliedExpectedHashes: {},
        declaredUnitIds: declared,
        baseGeneration: 1,
        pendingTransfers: [],
        preservedLocalIds: [],
      });
    }

    computeWinnerIndex(sources);

    const startNs = process.hrtime.bigint();
    const index = computeWinnerIndex(sources);
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;

    expect(index.winnerByUnitId.size).toBe(1200);
    expect(elapsedMs).toBeLessThan(10);
  });

  it('previews and selectively imports the real lab-base-pack.tgz when present on disk', async () => {
    const labPackPath = 'E:/kiki-wt/.tmp/lab-kiki-pack/lab-base-pack.tgz';
    if (!existsSync(labPackPath)) return;

    const { homeDir, klient } = await bootIsolatedServer(true);
    const labBytes = await readFile(labPackPath);
    routes.set('/lab-base-pack.tgz', { body: labBytes, etag: '"lab-e2e-v1"' });

    const preview = await klient.rest!.portableSpaces.previewSubscribe({
      source: { kind: 'url', url: `${httpBaseUrl}/lab-base-pack.tgz` },
    });
    expect(preview.items.length).toBeGreaterThan(10);
    expect(preview.items.some((item) => item.scope === 'extensions_search' && item.id.includes('kiki-office'))).toBe(true);

    const withoutModels = toggleSubscriptionScope(preview, preview.defaultSelection, 'models_providers', false);
    const initialEval = evaluateSubscriptionSelection(preview, withoutModels, {});
    const selectiveWithoutBlocked: PortableSpaceSubscriptionSelection = {
      ...withoutModels,
      excludedIds: [...new Set([...withoutModels.excludedIds, ...initialEval.blockedByItemId.keys()])],
    };
    const evalRes = evaluateSubscriptionSelection(preview, selectiveWithoutBlocked, {});
    const modelBindings: Record<string, string> = {};
    const deferredSlotIds: string[] = [];
    for (const slot of evalRes.actionableSlots) {
      if (slot.slot.eligibleOptionIndices.length === 0) {
        if (slot.slot.required) expect(slot.slot.restrictionNote).toBeTruthy();
        deferredSlotIds.push(slot.slot.tupleKey);
      } else {
        const chosenIdx = slot.slot.eligibleOptionIndices[0]!;
        const chosenModelId = preview.localModelOptions[chosenIdx]?.id;
        if (chosenModelId !== undefined) {
          modelBindings[slot.slot.sourceModelId] = chosenModelId;
        }
      }
    }
    const labBindings = {
      modelBindings,
      ...(deferredSlotIds.length > 0 ? { unmappedModelPolicy: 'defer' as const, deferredSlotIds } : {}),
    };
    const verifiedEval = evaluateSubscriptionSelection(preview, selectiveWithoutBlocked, labBindings);
    expect(verifiedEval.canConfirmInitial).toBe(true);

    const commit = await klient.rest!.portableSpaces.subscribe({
      previewToken: preview.previewToken,
      label: 'Lab Pack Selective',
      syncPolicy: 'manual',
      selection: selectiveWithoutBlocked,
      ...labBindings,
      createBackup: false,
    });
    expect(commit.kind).toBe('subscription');
    expect(commit.appliedIds.length).toBeGreaterThan(5);
    expect(existsSync(join(homeDir, 'agents'))).toBe(true);

    const cleanHome = await bootIsolatedServer(false);
    const applyReceipt = await cleanHome.klient.rest!.portableSpaces.apply({
      direct: {
        mode: 'merge',
        sources: [{ kind: 'archive', path: labPackPath }],
        target: { kind: 'live', spaceId: 'main' },
      },
      createBackup: false,
    });
    expect(applyReceipt.appliedIds.length).toBeGreaterThan(20);
    expect(existsSync(join(cleanHome.homeDir, 'agents', 'explore.md'))).toBe(true);
    expect(existsSync(join(cleanHome.homeDir, 'agents', 'reviewer.md'))).toBe(true);
    expect(existsSync(join(cleanHome.homeDir, 'extensions.toml'))).toBe(true);
  });
});
