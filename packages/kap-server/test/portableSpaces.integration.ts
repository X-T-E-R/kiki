import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { IConfigService } from '@kiki/agent-core-v2/app/config/config';
import { IMcpConfigStore } from '@kiki/agent-core-v2/app/mcpConfig/configStore';
import { IMemoryStore } from '@kiki/agent-core-v2/app/memory/memoryStore';
import { DEFAULT_NOTIFICATIONS_CONFIG, NotificationsConfigSchema } from '@kiki/agent-core-v2/app/notifications/configSection';
import { IRecipeService } from '@kiki/agent-core-v2/app/recipes/recipes';
import { packTarGz, unpackTarGz } from '../src/services/portableSpace/tarArchive';
import { decodeAge, encodeAge } from '../src/services/portableSpace/ageCodec';
import {
  portableSpaceApplyReceiptSchema,
  portableSpaceExportReceiptSchema,
  portableSpaceInspectResultSchema,
  portableSpaceMutateReceiptSchema,
  portableSpacePreviewResultSchema,
  portableSpaceSourcesListResponseSchema,
  syncBundleImportReceiptSchema,
  syncBundleSchema,
} from '@kiki/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const execFileAsync = promisify(execFile);
const credential = 'FAKE_TRANSFER_CREDENTIAL_DO_NOT_LOG';
const headerCredential = 'FAKE_TRANSFER_HEADER_DO_NOT_LOG';
const sourceProfile = '---\nname: transfer-helper\ndescription: An offline helper\nprompt_overrides:\n  independent:\n    files: [prompts/shared.toml]\n---\n\nKeep replies concise.\n';
const promptText = 'schema_version = 1\n[fields]\n"system.shared" = "Keep replies concise."\n';
const PLAIN = 'credentials/credentials.toml';
const SEALED = `${PLAIN}.age`;
const sourceSections = {
  providers: { sample: { type: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: credential, customHeaders: { 'x-access': headerCredential } } },
  models: { 'sample/chat': { provider: 'sample', model: 'chat', maxContextSize: 8192, promptOverrides: { main: { files: ['prompts/shared.toml'] } } } },
  prompt: { overrides: { independent: { files: ['prompts/shared.toml'] } } },
  defaultModel: 'sample/chat',
  tools: { enabled: ['Read'], disabled: ['Write'] },
  defaultPermissionMode: 'manual',
  browserControl: { connections: { bridge: { type: 'kimi-webbridge', name: 'WebBridge', enabled: false } }, allowedBrowsers: [] },
  computerControl: { enabled: false, usagePreference: 'avoid' },
  pluginSettings: { sample: { model: 'picture', plugin_key_secret: credential } },
  experimental: { desktop_search: false, native_browser: false },
  thinking: { effort: 'base', keep: 'base' },
  notifications: { ...DEFAULT_NOTIFICATIONS_CONFIG, global: { ...DEFAULT_NOTIFICATIONS_CONFIG.global, enabled: false }, credential_values: { offline: { token: credential } } },
};
const memoryFixtures = [
  { scope: { kind: 'global' } as const, id: 'm_portable_global', title: 'Portable global', body: 'Global portable memory.' },
  { scope: { kind: 'persona', personaId: 'portable-helper' } as const, id: 'm_portable_persona', title: 'Portable persona', body: 'Persona portable memory.' },
  { scope: { kind: 'workspace', workspaceId: 'prj_portable' } as const, id: 'm_portable_workspace', title: 'Portable workspace', body: 'Workspace portable memory.' },
  { scope: { kind: 'persona_workspace', personaId: 'portable-helper', workspaceId: 'prj_portable' } as const, id: 'm_portable_persona_workspace', title: 'Portable persona workspace', body: 'Persona workspace portable memory.' },
];

type Envelope<T> = { code: number; msg: string; data: T; request_id: string };
type NativeAge = { ageDecrypt(ciphertext: Uint8Array, passphrase: string): Promise<Buffer> };

let root: string;
let sourceHome: string;
let targetHome: string;
let source: RunningServer;
let target: RunningServer;
let sourceBase: string;
let targetBase: string;
let linkedProfilePath = 'agents/linked-helper.md';
let linkedRecipePath = 'recipes/linked-recipe.toml';
let linkedProfileLink: string;
let linkedRecipeLink: string;
let archivePassphrase: string;
let archivePath: string;

function memoryPath(fixture: (typeof memoryFixtures)[number]): string {
  switch (fixture.scope.kind) {
    case 'global': return `memories/global/${fixture.id}.md`;
    case 'persona': return `memories/persona/${fixture.scope.personaId}/${fixture.id}.md`;
    case 'workspace': return `memories/workspace/${fixture.scope.workspaceId}/${fixture.id}.md`;
    case 'persona_workspace': return `memories/persona_workspace/${fixture.scope.personaId}__${fixture.scope.workspaceId}/${fixture.id}.md`;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function request<T>(server: RunningServer, base: string, path: string, body: unknown, schema: { parse(value: unknown): T }): Promise<T> {
  const response = await fetch(`${base}${path}`, body === undefined ? {
    headers: authHeaders(server),
  } : {
    method: 'POST',
    headers: authHeaders(server, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  } as never);
  const envelope = await response.json() as Envelope<unknown>;
  expect(response.status, envelope.msg).toBe(200);
  expect(envelope.code).toBe(0);
  expect(typeof envelope.request_id).toBe('string');
  return schema.parse(envelope.data);
}

async function failedRequest(server: RunningServer, base: string, path: string, body: unknown, status: number): Promise<Envelope<unknown>> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: authHeaders(server, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  } as never);
  const envelope = await response.json() as Envelope<unknown>;
  expect(response.status).toBe(status);
  expect(envelope.code).toBe(40001);
  expect(typeof envelope.msg).toBe('string');
  return envelope;
}

async function prepareHome(home: string, linked = false): Promise<void> {
  await mkdir(join(home, 'agents'), { recursive: true });
  await mkdir(join(home, 'prompts'), { recursive: true });
  await mkdir(join(home, 'recipes'), { recursive: true });
  await writeFile(join(home, 'prompts', 'shared.toml'), promptText);
  await writeFile(join(home, 'agents', 'transfer-helper.md'), sourceProfile);
  await writeFile(join(home, 'SYSTEM.md'), '---\nsystem_prompt_mode: append\n---\nPrefer short answers.\n');
  await writeFile(join(home, 'config.toml'), '[experimental]\ndesktop_search = false\n');
  if (linked) {
    const linkedRoot = join(root, 'linked-resources');
    const profileDir = join(linkedRoot, 'profile-dir');
    const recipeDir = join(linkedRoot, 'recipe-dir');
    await mkdir(profileDir, { recursive: true });
    await mkdir(recipeDir, { recursive: true });
    await writeFile(join(profileDir, 'linked-profile.md'), '---\nname: linked-helper\ndescription: Linked profile\n---\n\nLinked profile body.\n');
    await writeFile(join(recipeDir, 'linked-recipe.toml'), 'schema_version = 1\nname = "linked-recipe"\n');
    linkedProfileLink = join(home, 'agents', 'linked-helper.md');
    linkedRecipeLink = join(home, 'recipes', 'linked-recipe.toml');
    try {
      await symlink(join(profileDir, 'linked-profile.md'), linkedProfileLink, 'file');
      await symlink(join(recipeDir, 'linked-recipe.toml'), linkedRecipeLink, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM' && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
      await rm(linkedProfileLink, { force: true });
      await rm(linkedRecipeLink, { force: true });
      linkedProfileLink = join(home, 'agents', 'linked-profile');
      linkedRecipeLink = join(home, 'recipes', 'linked-recipe');
      linkedProfilePath = 'agents/linked-profile/linked-profile.md';
      linkedRecipePath = 'recipes/linked-recipe/linked-recipe.toml';
      await symlink(profileDir, linkedProfileLink, 'junction');
      await symlink(recipeDir, linkedRecipeLink, 'junction');
    }
    await writeFile(join(home, 'config.win32.toml'), '[thinking]\neffort = "win32"\nkeep = "win32"\n');
  }
}

async function configureSource(): Promise<void> {
  await source.core.accessor.get(IConfigService).replaceSections(sourceSections);
  const memories = source.core.accessor.get(IMemoryStore);
  for (const fixture of memoryFixtures) {
    const result = await memories.put({
      action: 'create',
      scope: fixture.scope,
      importedId: fixture.id,
      type: 'reference',
      title: fixture.title,
      body: fixture.body,
      reason: 'Portable fixture',
      source: { writer: 'import' },
      basis: { kind: 'human', note: 'Portable fixture', refs: [] },
    });
    expect(result.entry.id).toBe(fixture.id);
  }
}

async function configureTarget(): Promise<void> {
  await target.core.accessor.get(IConfigService).replaceSections({
    experimental: { desktop_search: false, native_browser: false },
    thinking: { effort: 'target', keep: 'target' },
    defaultPermissionMode: 'manual',
    providers: { sample: { type: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'TARGET_ONLY_KEY' } },
  });
}

async function mutateFile(server: RunningServer, base: string, targetEndpoint: unknown, path: string, text: string) {
  return request(server, base, '/api/spaces/portable/mutate', {
    target: targetEndpoint,
    actions: [{ op: 'writeFile', path, contentBase64: Buffer.from(text).toString('base64') }],
  }, portableSpaceMutateReceiptSchema);
}

async function gitCommand(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function nativeAge(): NativeAge {
  const require = createRequire(import.meta.url);
  return require('@kiki/auth-native') as NativeAge;
}

describe('Portable Spaces authenticated locked protocol', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'kiki-portable-spaces-'));
    sourceHome = join(root, 'source');
    targetHome = join(root, 'target');
    await prepareHome(sourceHome, true);
    await prepareHome(targetHome);
    for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('NB_SEARCH_')) vi.stubEnv(key, undefined);
    vi.stubEnv('NB_SEARCH_HOME', join(root, 'isolated-nb-search'));
    vi.stubEnv('KIKI_AGE_KEY', undefined);
    vi.stubEnv('KIKI_PACK_KEY', undefined);
    vi.stubEnv('KIKI_SPACE_PASSPHRASE', undefined);
    source = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: sourceHome, logLevel: 'silent' });
    target = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: targetHome, logLevel: 'silent' });
    sourceBase = `http://127.0.0.1:${source.port}`;
    targetBase = `http://127.0.0.1:${target.port}`;
    await configureSource();
    await configureTarget();
  }, 60_000);

  afterAll(async () => {
    await target?.close();
    await source?.close();
    vi.unstubAllEnvs();
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }, 30_000);

  it('exports native age, validates sealed plain and credential-free layouts, and guards staged plaintext', async () => {
    archivePassphrase = 'portable archive passphrase';
    archivePath = join(root, 'portable.age');
    const ageReceipt = await request(source, sourceBase, '/api/spaces/portable/export', {
      source: { kind: 'live', spaceId: 'main' },
      destination: archivePath,
      format: 'age',
      spaceMode: 'full',
      secretMode: 'sealed',
      encryption: { mode: 'passphrase', passphrase: archivePassphrase },
      includeMemories: true,
    }, portableSpaceExportReceiptSchema);
    expect(ageReceipt).toMatchObject({ destination: archivePath, format: 'age', secretMode: 'sealed', encryptionMode: 'passphrase' });
    const ageInspect = await request(source, sourceBase, '/api/spaces/portable/inspect', {
      endpoint: { kind: 'archive', path: archivePath },
      unlock: { passphrase: archivePassphrase },
    }, portableSpaceInspectResultSchema);
    expect(ageInspect).toMatchObject({ format: 'age', secretMode: 'sealed', encryptionMode: 'passphrase' });
    expect(ageInspect.items.some((item) => item.path === 'agents/transfer-helper.md')).toBe(true);
    const ciphertext = await readFile(archivePath);
    const decrypted = await nativeAge().ageDecrypt(ciphertext, archivePassphrase);
    const tarGz = Buffer.from(decrypted);
    const tar = gunzipSync(tarGz);
    expect(tar.subarray(257, 262).toString('ascii')).toBe('ustar');
    const tarPath = join(root, 'portable.tar');
    await writeFile(tarPath, tar);
    const listing = (await execFileAsync('tar', ['-tf', 'portable.tar'], { cwd: root, windowsHide: true })).stdout.split(/\r?\n/).filter(Boolean);
    expect(listing).toContain('config.toml');
    expect(listing).toContain('credentials/credentials.toml');

    const noCredentialsDir = join(root, 'no-credentials');
    const noCredentialsReceipt = await request(source, sourceBase, '/api/spaces/portable/export', {
      source: { kind: 'live', spaceId: 'main' }, destination: noCredentialsDir, format: 'dir', secretMode: 'none', includeMemories: false,
    }, portableSpaceExportReceiptSchema);
    expect(noCredentialsReceipt).toMatchObject({ format: 'dir', secretMode: 'none', encryptionMode: 'none' });
    expect(await exists(join(noCredentialsDir, PLAIN))).toBe(false);
    expect(await exists(join(noCredentialsDir, SEALED))).toBe(false);
    const noCredentialsInspect = await request(source, sourceBase, '/api/spaces/portable/inspect', { endpoint: { kind: 'dir', path: noCredentialsDir } }, portableSpaceInspectResultSchema);
    expect(noCredentialsInspect.secretMode).toBe('none');

    const plainDir = join(root, 'plain');
    const plainReceipt = await request(source, sourceBase, '/api/spaces/portable/export', {
      source: { kind: 'live', spaceId: 'main' }, destination: plainDir, format: 'dir', secretMode: 'plain', includeMemories: false,
    }, portableSpaceExportReceiptSchema);
    expect(plainReceipt.secretMode).toBe('plain');
    expect(await readFile(join(plainDir, PLAIN), 'utf8')).toContain(credential);
    expect(await readFile(join(plainDir, '.gitignore'), 'utf8')).toContain('/credentials/credentials.toml');
    const plainInspect = await request(source, sourceBase, '/api/spaces/portable/inspect', { endpoint: { kind: 'dir', path: plainDir } }, portableSpaceInspectResultSchema);
    expect(plainInspect.secretMode).toBe('plain');

    const sealedDir = join(root, 'sealed');
    const sealedPassphrase = 'sealed directory passphrase';
    const sealedReceipt = await request(source, sourceBase, '/api/spaces/portable/export', {
      source: { kind: 'live', spaceId: 'main' }, destination: sealedDir, format: 'dir', secretMode: 'sealed', encryption: { mode: 'passphrase', passphrase: sealedPassphrase }, includeMemories: false,
    }, portableSpaceExportReceiptSchema);
    expect(sealedReceipt).toMatchObject({ format: 'dir', secretMode: 'sealed', encryptionMode: 'passphrase' });
    expect(await exists(join(sealedDir, PLAIN))).toBe(false);
    expect(await exists(join(sealedDir, SEALED))).toBe(true);
    expect(await readFile(join(sealedDir, '.gitattributes'), 'utf8')).toContain(`${SEALED} binary`);
    const sealedInspect = await request(source, sourceBase, '/api/spaces/portable/inspect', { endpoint: { kind: 'dir', path: sealedDir }, unlock: { passphrase: sealedPassphrase } }, portableSpaceInspectResultSchema);
    expect(sealedInspect).toMatchObject({ secretMode: 'sealed', encryptionMode: 'passphrase' });

    const packed = join(root, 'packed.tgz');
    const unpacked = join(root, 'unpacked');
    const packedReceipt = await request(source, sourceBase, '/api/spaces/portable/pack', {
      action: 'pack', sourcePath: noCredentialsDir, destinationPath: packed, format: 'tgz', secretMode: 'none',
    }, portableSpaceExportReceiptSchema);
    expect(packedReceipt.format).toBe('tgz');
    const unpackedReceipt = await request(source, sourceBase, '/api/spaces/portable/unpack', {
      action: 'unpack', sourcePath: packed, destinationPath: unpacked,
    }, portableSpaceExportReceiptSchema);
    expect(unpackedReceipt.format).toBe('dir');
    expect(await exists(join(unpacked, 'config.toml'))).toBe(true);

    const guardDir = join(root, 'guarded-git');
    await mkdir(join(guardDir, 'credentials'), { recursive: true });
    await writeFile(join(guardDir, PLAIN), '[pool]\nfixture = "staged"\n');
    await gitCommand(guardDir, ['init', '-q']);
    await gitCommand(guardDir, ['update-index', '--add', '--', PLAIN]);
    const guardError = await failedRequest(source, sourceBase, '/api/spaces/portable/export', {
      source: { kind: 'live', spaceId: 'main' }, destination: guardDir, format: 'dir', secretMode: 'plain', includeMemories: false,
    }, 400);
    expect(guardError.msg).toBe('Refusing to write plaintext credentials: credentials/credentials.toml is tracked or staged in Git');
  }, 30_000);

  it('round-trips linked profiles recipes and four memory scopes, then applies overlay platform units', async () => {
    const fullDir = join(root, 'full-space');
    const fullReceipt = await request(source, sourceBase, '/api/spaces/portable/export', {
      source: { kind: 'live', spaceId: 'main' }, destination: fullDir, format: 'dir', secretMode: 'none', includeMemories: true,
    }, portableSpaceExportReceiptSchema);
    expect(fullReceipt.format).toBe('dir');
    expect((await lstat(linkedProfileLink)).isSymbolicLink()).toBe(true);
    expect((await lstat(linkedRecipeLink)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(fullDir, ...linkedProfilePath.split('/')), 'utf8')).toContain('Linked profile body.');
    expect(await readFile(join(fullDir, ...linkedRecipePath.split('/')), 'utf8')).toContain('linked-recipe');
    for (const fixture of memoryFixtures) expect(await exists(join(fullDir, memoryPath(fixture)))).toBe(true);
    const targetConfig = target.core.accessor.get(IConfigService);
    expect(targetConfig.inspect<Record<string, { apiKey?: string }>>('providers').userValue?.['sample']?.apiKey).toBe('TARGET_ONLY_KEY');
    const providerPreview = await request(target, targetBase, '/api/spaces/portable/preview', {
      mode: 'override', sources: [{ kind: 'dir', path: fullDir }], target: { kind: 'live', spaceId: 'main' }, domains: ['config'],
    }, portableSpacePreviewResultSchema);
    await request(target, targetBase, '/api/spaces/portable/apply', { previewToken: providerPreview.previewToken, selectedIds: providerPreview.rows.filter((row) => row.path.startsWith('models')).map((row) => row.id), createBackup: false }, portableSpaceApplyReceiptSchema);
    expect(targetConfig.inspect<Record<string, { apiKey?: string }>>('providers').userValue?.['sample']?.apiKey).toBe('TARGET_ONLY_KEY');
    const memoryPreview = await request(target, targetBase, '/api/spaces/portable/preview', {
      mode: 'replace', sources: [{ kind: 'dir', path: fullDir }], target: { kind: 'live', spaceId: 'main' }, domains: ['memories'],
    }, portableSpacePreviewResultSchema);
    expect(memoryPreview.rows.map((row) => row.path).sort()).toEqual(memoryFixtures.map(memoryPath).sort());
    await request(target, targetBase, '/api/spaces/portable/apply', { previewToken: memoryPreview.previewToken, createBackup: false }, portableSpaceApplyReceiptSchema);
    const targetMemories = target.core.accessor.get(IMemoryStore);
    for (const fixture of memoryFixtures) {
      const entry = await targetMemories.get(fixture.scope, fixture.id);
      expect(entry).toMatchObject({ id: fixture.id, body: fixture.body, source: { writer: 'import' } });
    }

    const overlayDir = join(root, 'overlay-space');
    const overlayReceipt = await request(source, sourceBase, '/api/spaces/portable/export', {
      source: { kind: 'live', spaceId: 'main' }, destination: overlayDir, format: 'dir', spaceMode: 'overlay', secretMode: 'none', unset: ['thinking.effort'], domains: ['config'], targetPlatform: 'win32', includeMemories: false,
    }, portableSpaceExportReceiptSchema);
    expect(overlayReceipt.spaceMode).toBe('overlay');
    expect(await readFile(join(overlayDir, 'overlay.toml'), 'utf8')).toContain('thinking.effort');
    expect(await exists(join(overlayDir, 'config.win32.toml'))).toBe(true);
    const overlayInspect = await request(source, sourceBase, '/api/spaces/portable/inspect', { endpoint: { kind: 'dir', path: overlayDir } }, portableSpaceInspectResultSchema);
    expect(overlayInspect).toMatchObject({ spaceMode: 'overlay', unset: ['thinking.effort'] });
    const overlayPreview = await request(target, targetBase, '/api/spaces/portable/preview', {
      mode: 'override', sources: [{ kind: 'dir', path: overlayDir }], target: { kind: 'live', spaceId: 'main' }, domains: ['config'], targetPlatform: 'win32',
    }, portableSpacePreviewResultSchema);
    expect(overlayPreview.rows.some((row) => row.path === 'thinking' && row.afterSummary?.includes('win32'))).toBe(true);
    const overlayRow = overlayPreview.rows.find((row) => row.path === 'thinking');
    expect(overlayRow).toMatchObject({ direction: 'to_target' });
    const overlayApply = await request(target, targetBase, '/api/spaces/portable/apply', { previewToken: overlayPreview.previewToken, selectedIds: overlayRow === undefined ? [] : [overlayRow.id], createBackup: false }, portableSpaceApplyReceiptSchema);
    expect(overlayApply.appliedIds).toContain(overlayRow?.id);
    expect(await target.core.accessor.get(IConfigService).get('thinking')).toMatchObject({ keep: 'win32' });
    expect(target.core.accessor.get(IConfigService).get<{ effort?: string }>('thinking').effort).toBeUndefined();
  }, 30_000);

  it('merges three-way fork edits and performs two-way zero-one-copy-zero mutations', async () => {
    const forkDir = join(root, 'fork-space');
    const forkReceipt = await request(source, sourceBase, '/api/spaces/portable/fork', {
      source: { kind: 'live', spaceId: 'main' }, destination: forkDir, format: 'dir', secretMode: 'none', domains: ['agents'], includeMemories: false,
    }, portableSpaceExportReceiptSchema);
    expect(forkReceipt.format).toBe('dir');
    const sourceEdit = sourceProfile.replace('description: An offline helper', 'description: Source helper');
    const forkEdit = sourceProfile.replace('Keep replies concise.', 'Keep replies focused.');
    await mutateFile(source, sourceBase, { kind: 'live', spaceId: 'main' }, 'agents/transfer-helper.md', sourceEdit);
    await mutateFile(source, sourceBase, { kind: 'dir', path: forkDir }, 'agents/transfer-helper.md', forkEdit);
    const forkPreview = await request(source, sourceBase, '/api/spaces/portable/preview', {
      mode: 'sync', sources: [{ kind: 'dir', path: forkDir }], target: { kind: 'live', spaceId: 'main' }, domains: ['agents'],
    }, portableSpacePreviewResultSchema);
    expect(forkPreview.hasVerifiedBase).toBe(true);
    const forkRow = forkPreview.rows.find((row) => row.path === 'agents/transfer-helper.md');
    expect(forkRow).toMatchObject({ direction: 'both', change: 'modified' });
    await request(source, sourceBase, '/api/spaces/portable/apply', { previewToken: forkPreview.previewToken, createBackup: false }, portableSpaceApplyReceiptSchema);
    const merged = await readFile(join(sourceHome, 'agents', 'transfer-helper.md'), 'utf8');
    expect(merged).toContain('description: Source helper');
    expect(merged).toContain('Keep replies focused.');

    await mutateFile(source, sourceBase, { kind: 'live', spaceId: 'main' }, 'agents/transfer-helper.md', sourceProfile);
    const zeroDir = join(root, 'zero-space');
    await request(source, sourceBase, '/api/spaces/portable/export', {
      source: { kind: 'live', spaceId: 'main' }, destination: zeroDir, format: 'dir', secretMode: 'none', domains: ['agents'], includeMemories: false,
    }, portableSpaceExportReceiptSchema);
    const one = `${sourceProfile}\nOne state.\n`;
    await mutateFile(source, sourceBase, { kind: 'live', spaceId: 'main' }, 'agents/transfer-helper.md', one);
    expect(await readFile(join(sourceHome, 'agents', 'transfer-helper.md'), 'utf8')).toContain('One state.');
    const cpReceipt = await request(source, sourceBase, '/api/spaces/portable/mutate', {
      target: { kind: 'live', spaceId: 'main' },
      actions: [{ op: 'cp', from: { kind: 'dir', path: zeroDir }, fromPath: 'agents/transfer-helper.md', toPath: 'agents/transfer-helper.md' }],
    }, portableSpaceMutateReceiptSchema);
    expect(cpReceipt.changed).toBe(true);
    expect(await readFile(join(sourceHome, 'agents', 'transfer-helper.md'), 'utf8')).toBe(sourceProfile);
  }, 30_000);

  it('reconciles encrypted forks by unit and preserves each recipient roster', async () => {
    const dir = join(root, 'fork-base-fixture');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.toml'), '[providers.demo]\ntype = "openai"\nbase_url = "https://example.test"\n[providers.obsolete]\ntype = "openai"\nbase_url = "https://obsolete.example.test"\n[models.chat]\nprovider = "demo"\nmodel = "original"\n');
    const baseText = 'Start\nSame first\nSame second\nSame third\nEnd\n';
    await writeFile(join(dir, 'AGENTS.md'), baseText);
    const device = await request(source, sourceBase, '/api/spaces/portable/sources', undefined, portableSpaceSourcesListResponseSchema);
    const a = { kind: 'archive', path: join(root, 'fork-a.kiki.age') };
    const b = { kind: 'archive', path: join(root, 'fork-b.kiki.age') };
    const encryption = { mode: 'x25519', recipients: [device.deviceRecipient] };
    await request(source, sourceBase, '/api/spaces/portable/fork', { source: { kind: 'dir', path: dir }, destination: a.path, encryption }, portableSpaceExportReceiptSchema);
    await request(source, sourceBase, '/api/spaces/portable/fork', { source: a, destination: b.path, encryption }, portableSpaceExportReceiptSchema);
    const textAction = (text: string) => ({ op: 'writeFile', path: 'AGENTS.md', contentBase64: Buffer.from(text).toString('base64') });
    await request(source, sourceBase, '/api/spaces/portable/mutate', { target: a, actions: [
      { op: 'set', key: 'providers.extra', value: { type: 'openai', base_url: 'https://extra.example.test' } },
      textAction(baseText.replace('Start', 'Start on A')),
    ] }, portableSpaceMutateReceiptSchema);
    await request(source, sourceBase, '/api/spaces/portable/mutate', { target: b, actions: [
      { op: 'set', key: 'models.chat.model', value: 'new-model' }, { op: 'unset', key: 'providers.obsolete' },
      textAction(baseText.replace('End', 'End on B')),
    ] }, portableSpaceMutateReceiptSchema);
    const preview = await request(source, sourceBase, '/api/spaces/portable/preview', { mode: 'sync', sources: [a], target: b }, portableSpacePreviewResultSchema);
    expect(preview.hasVerifiedBase).toBe(true);
    expect(preview.conflictCount).toBe(0);
    expect(preview.rows.map((row) => [row.path, row.direction])).toEqual(expect.arrayContaining([
      ['AGENTS.md', 'both'], ['providers.extra', 'to_right'], ['models.chat', 'to_left'], ['providers.obsolete', 'to_left'],
    ]));
    await request(source, sourceBase, '/api/spaces/portable/apply', { previewToken: preview.previewToken }, portableSpaceApplyReceiptSchema);
    for (const [index, endpoint] of [a, b].entries()) {
      const targetDir = join(root, `fork-converged-${index}`);
      await request(source, sourceBase, '/api/spaces/portable/unpack', { action: 'unpack', sourcePath: endpoint.path, destinationPath: targetDir }, portableSpaceExportReceiptSchema);
      expect(await readFile(join(targetDir, 'AGENTS.md'), 'utf8')).toBe(baseText.replace('Start', 'Start on A').replace('End', 'End on B'));
      expect(await readFile(join(targetDir, '.age-recipients'), 'utf8')).toContain(device.deviceRecipient);
      const config = await readFile(join(targetDir, 'config.toml'), 'utf8');
      expect(config).toContain('new-model');
      expect(config).toContain('[providers.extra]');
      expect(config).not.toContain('obsolete');
    }
  }, 30_000);

  it('rekeys the age archive and requires the new native passphrase', async () => {
    const rekeyPath = join(root, 'rekeyed.age');
    const nextPassphrase = 'portable rekeyed passphrase';
    const rekeyInspect = await request(source, sourceBase, '/api/spaces/portable/rekey', {
      target: archivePath,
      outputPath: rekeyPath,
      unlock: { passphrase: archivePassphrase },
      encryption: { mode: 'passphrase', passphrase: nextPassphrase },
    }, portableSpaceInspectResultSchema);
    expect(rekeyInspect).toMatchObject({ endpoint: { kind: 'archive', path: rekeyPath }, format: 'age', encryptionMode: 'passphrase', secretMode: 'sealed' });
    const oldPassphrase = await failedRequest(source, sourceBase, '/api/spaces/portable/inspect', { endpoint: { kind: 'archive', path: rekeyPath }, unlock: { passphrase: archivePassphrase } }, 400);
    expect(oldPassphrase.msg).toBe('Unable to decrypt portable age archive');
    const newInspect = await request(source, sourceBase, '/api/spaces/portable/inspect', { endpoint: { kind: 'archive', path: rekeyPath }, unlock: { passphrase: nextPassphrase } }, portableSpaceInspectResultSchema);
    expect(newInspect).toMatchObject({ format: 'age', encryptionMode: 'passphrase', secretMode: 'sealed' });
  }, 30_000);

  it('round-trips notifications and portable feature settings through bundle sync and Space apply', async () => {
    const from = source.core.accessor.get(IConfigService);
    const to = target.core.accessor.get(IConfigService);
    const markets = [{ id: 'portable', name: 'Portable Recipes', url: 'https://example.test/recipes.json', enabled: true }];
    await from.replaceSections({ experimental: { recipes: true, desktop_search: false }, recipes: { markets }, notifications: {
      ...DEFAULT_NOTIFICATIONS_CONFIG, global: { ...DEFAULT_NOTIFICATIONS_CONFIG.global, enabled: false }, credential_values: { source: { token: 'notification-source-token' } },
    } });
    const localNotifications = { ...DEFAULT_NOTIFICATIONS_CONFIG, credential_values: { target: { token: 'notification-target-token' } } };
    await to.replaceSections({ notifications: localNotifications, experimental: { recipes: false, desktop_search: false } });
    const bundle = await request(source, sourceBase, '/api/sync/bundle/export', { includeConfig: true, includeSkills: false, includeMemories: false }, syncBundleSchema);
    const notificationConfig = NotificationsConfigSchema.parse(bundle.portableConfig?.['notifications']);
    expect(notificationConfig).toMatchObject({ global: { enabled: false }, provider_instances: {}, channels: {}, credential_slots: {}, credential_values: {} });
    expect(bundle.portableConfig?.['experimental']).toEqual({ recipes: true });
    await request(target, targetBase, '/api/sync/bundle/import', bundle, syncBundleImportReceiptSchema);
    expect(to.get('notifications')).toMatchObject({ global: { enabled: false }, credential_values: localNotifications.credential_values });
    expect(to.get('recipes')).toEqual({ markets });
    expect(to.get('experimental')).toMatchObject({ recipes: true, desktop_search: false });

    await to.replaceSections({ notifications: localNotifications, experimental: { recipes: false, desktop_search: false }, recipes: { markets: [] } });
    const destination = join(root, 'notifications-portable');
    await request(source, sourceBase, '/api/spaces/portable/export', {
      destination, secretMode: 'none', domains: ['config'], pick: ['notifications', 'experimental', 'recipes'],
    }, portableSpaceExportReceiptSchema);
    const text = await readFile(join(destination, 'config.toml'), 'utf8');
    expect(text).not.toContain('notification-source-token');
    await request(target, targetBase, '/api/spaces/portable/apply', { createBackup: false, direct: { mode: 'override', sources: [{ kind: 'dir', path: destination }] } }, portableSpaceApplyReceiptSchema);
    expect(NotificationsConfigSchema.parse(to.get('notifications'))).toMatchObject({ global: { enabled: false }, credential_values: localNotifications.credential_values });
    expect(to.get('recipes')).toEqual({ markets });
    expect(to.get('experimental')).toMatchObject({ recipes: true, desktop_search: false });
  }, 30_000);

  it('hydrates a Recipe installation with byte-identical revision and content, preserving other target recipes', async () => {
    async function installIn(server: RunningServer, home: string, id: string) {
      const folder = join(home, 'recipes', id);
      await mkdir(folder, { recursive: true });
      const path = join(folder, 'recipe.toml');
      await writeFile(path, `schema_version = 1\nid = "${id}"\nname = "${id}"\nversion = "1.0.0"\n[prompts.system]\nfile = "body.md"\n`);
      await writeFile(join(folder, 'body.md'), `Instructions for ${id}`);
      const service = server.core.accessor.get(IRecipeService);
      const preview = await service.preview({ source: { locator: path } });
      return service.install({ preview_id: preview.preview_id, update_mode: 'pinned' });
    }
    const installed = await installIn(source, sourceHome, 'portable-recipe');
    const native = await installIn(target, targetHome, 'target-recipe');
    const sourceConfig = source.core.accessor.get(IConfigService);
    const models = sourceConfig.inspect<Record<string, Record<string, unknown>>>('models').userValue!;
    await sourceConfig.replace('models', { ...models, 'sample/chat': { ...models['sample/chat'], recipe: installed.installation_id } });
    const archive = join(root, 'recipes-portable.kiki.tgz');
    await request(source, sourceBase, '/api/spaces/portable/export', { destination: archive, domains: ['config', 'recipes'], secretMode: 'none' }, portableSpaceExportReceiptSchema);
    const files = unpackTarGz(await readFile(archive));
    const installKey = 'store/recipes/installations';
    const revisionKey = `store/recipes/revisions/${installed.revision.slice(7)}`;
    expect(files.get(installKey)?.toString()).toContain('$KIKI_HOME/recipes/portable-recipe/recipe.toml');
    expect(files.get(revisionKey)).toEqual(await readFile(join(sourceHome, revisionKey)));
    const contentKeys = [...files.keys()].filter((key) => key.startsWith('store/recipes/content/'));
    expect(contentKeys.length).toBeGreaterThan(0);
    for (const key of contentKeys) expect(files.get(key)).toEqual(await readFile(join(sourceHome, key)));

    const oldFormat = join(root, 'recipes-foreign-locators');
    await request(source, sourceBase, '/api/spaces/portable/unpack', { action: 'unpack', sourcePath: archive, destinationPath: oldFormat }, portableSpaceExportReceiptSchema);
    const records = JSON.parse(files.get(installKey)!.toString()) as Record<string, { summary: { source: { locator: string } } }>;
    records[installed.installation_id]!.summary.source.locator = 'C:\\Another\\Machine\\Recipes\\portable-recipe\\recipe.toml';
    await writeFile(join(oldFormat, installKey), JSON.stringify(records));
    await request(target, targetBase, '/api/spaces/portable/apply', { createBackup: false, direct: { mode: 'override', sources: [{ kind: 'dir', path: oldFormat }], domains: ['config', 'recipes'] } }, portableSpaceApplyReceiptSchema);
    const recipes = target.core.accessor.get(IRecipeService);
    expect((await recipes.resolve(installed.installation_id)).revision).toBe(installed.revision);
    expect((await recipes.get(installed.installation_id))?.summary.source.locator).toBe(join(targetHome, 'recipes', 'portable-recipe', 'recipe.toml'));
    expect((await recipes.resolve(native.installation_id)).revision).toBe(native.revision);
    expect(await readFile(join(targetHome, revisionKey))).toEqual(files.get(revisionKey));
    for (const key of contentKeys) expect(await readFile(join(targetHome, key))).toEqual(files.get(key));
    expect(target.core.accessor.get(IConfigService).get('models')).toMatchObject({ 'sample/chat': { recipe: installed.installation_id } });
  }, 30_000);

  it('seals GUI search credentials in both formats and restores slot records without exposing them', async () => {
    const relative = 'secrets/nb-search/gui-credentials.json';
    const sourceSlot = { provider_id: 'exa', env: 'EXA_API_KEY', binding: 'fixture-binding', value: 'fixture-gui-exa-key' };
    const targetSlot = { provider_id: 'tavily', env: 'TAVILY_API_KEY', binding: 'target-binding', value: 'fixture-target-tavily-key' };
    for (const [home, slots] of [[sourceHome, { source: sourceSlot }], [targetHome, { target: targetSlot }]] as const) {
      await mkdir(join(home, 'secrets', 'nb-search'), { recursive: true });
      await writeFile(join(home, relative), JSON.stringify({ schema_version: '1', slots }), { mode: 0o600 });
    }
    const passphrase = 'sealed nb-search test password';
    const encryption = { mode: 'passphrase', passphrase };
    const directory = join(root, 'search-gui-hybrid');
    const archive = join(root, 'search-gui.kiki.age');
    for (const destination of [directory, archive]) await request(source, sourceBase, '/api/spaces/portable/export', {
      destination, domains: ['credentials'], pick: ['nb_search_gui'], encryption, secretMode: 'sealed', gitInit: destination === directory,
    }, portableSpaceExportReceiptSchema);
    expect(await exists(join(directory, PLAIN))).toBe(false);
    expect(await exists(join(directory, relative))).toBe(false);
    const sealed = await readFile(join(directory, SEALED));
    expect(sealed.includes(sourceSlot.value)).toBe(false);
    expect((await nativeAge().ageDecrypt(sealed, passphrase)).toString()).toContain(sourceSlot.value);
    const files = unpackTarGz(await nativeAge().ageDecrypt(await readFile(archive), passphrase));
    expect(files.get(PLAIN)?.toString()).toContain(sourceSlot.value);
    expect(files.has(relative)).toBe(false);
    const preview = await request(target, targetBase, '/api/spaces/portable/preview', { mode: 'override', sources: [{ kind: 'archive', path: archive }], sourceUnlocks: [{ passphrase }], domains: ['credentials'] }, portableSpacePreviewResultSchema);
    expect(JSON.stringify(preview)).not.toContain(sourceSlot.value);
    await request(target, targetBase, '/api/spaces/portable/apply', { createBackup: false, previewToken: preview.previewToken }, portableSpaceApplyReceiptSchema);
    const destination = join(targetHome, relative);
    expect(JSON.parse(await readFile(destination, 'utf8'))).toEqual({ schema_version: '1', slots: { source: sourceSlot, target: targetSlot } });
    if (process.platform !== 'win32') {
      expect((await lstat(destination)).mode & 0o777).toBe(0o600);
      expect((await lstat(join(targetHome, 'secrets', 'nb-search'))).mode & 0o777).toBe(0o700);
    }
  }, 30_000);

  it('unpacks GNU archives without materializing requested-out credentials', async () => {
    const archive = join(root, 'gnu-archive.tgz');
    const text = 'GNU archive\n';
    const tar = gunzipSync(packTarGz(new Map([['AGENTS.md', Buffer.from(text)]])));
    tar.write('ustar  \0', 257, 'ascii');
    tar.write('12345670000\0', 345, 'ascii');
    tar.fill(32, 148, 156);
    const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    tar.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    await writeFile(archive, gzipSync(tar));
    const destination = join(root, 'gnu-unpacked');
    const receipt = await request(source, sourceBase, '/api/spaces/portable/unpack', { action: 'unpack', sourcePath: archive, destinationPath: destination, secretMode: 'none' }, portableSpaceExportReceiptSchema);
    expect(receipt.secretMode).toBe('none');
    expect(await readFile(join(destination, 'AGENTS.md'), 'utf8')).toBe(text);

    const sealed = join(root, 'nested-credentials.tgz');
    const exported = await request(source, sourceBase, '/api/spaces/portable/export', { destination: sealed, domains: ['instructions', 'credentials'], secretMode: 'sealed', encryption: { mode: 'passphrase', passphrase: 'nested fixture unlock' } }, portableSpaceExportReceiptSchema);
    expect(exported.secretMode).toBe('sealed');
    expect(unpackTarGz(await readFile(sealed)).has(SEALED)).toBe(true);
    const stripped = join(root, 'stripped-credentials');
    const unpacked = await request(source, sourceBase, '/api/spaces/portable/unpack', { action: 'unpack', sourcePath: sealed, destinationPath: stripped, secretMode: 'none' }, portableSpaceExportReceiptSchema);
    expect(unpacked.secretMode).toBe('none');
    expect(await exists(join(stripped, PLAIN))).toBe(false);
    expect(await exists(join(stripped, SEALED))).toBe(false);
  }, 30_000);

  it('deletes exact unit IDs and structured paths without removing parallel public units', async () => {
    const path = join(root, 'structured-remove');
    await mkdir(join(path, 'credentials'), { recursive: true });
    await writeFile(join(path, 'config.toml'), '[providers.openai]\ntype = "openai"\nbase_url = "https://example.test"\n');
    await writeFile(join(path, PLAIN), '[providers.openai]\napi_key = "fake-provider-key"\n[pool.main]\napi_key = "fake-pool-key"\n');
    await writeFile(join(path, 'mcp.json'), JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['fixture'] } } }));
    const endpoint = { kind: 'dir', path };
    const result = await request(source, sourceBase, '/api/spaces/portable/mutate', { target: endpoint, actions: [
      { op: 'unset', key: 'credentials:providers.openai', recordOverlayUnset: true },
      { op: 'rm', paths: ['credentials:pool.main', 'mcp.context7'] },
    ] }, portableSpaceMutateReceiptSchema);
    expect(result.changed).toBe(true);
    expect(result.inspect.unset).toEqual(['credentials:providers.openai']);
    expect(result.inspect.items.map((item) => item.id)).toEqual(['config:providers.openai']);
    expect(await exists(join(path, PLAIN))).toBe(false);
    const receiver = join(root, 'structured-remove-receiver');
    await mkdir(join(receiver, 'credentials'), { recursive: true });
    await writeFile(join(receiver, 'config.toml'), await readFile(join(path, 'config.toml')));
    await writeFile(join(receiver, PLAIN), '[providers.openai]\napi_key = "fake-target-key"\n');
    const preview = await request(source, sourceBase, '/api/spaces/portable/preview', { mode: 'override', sources: [endpoint], target: { kind: 'dir', path: receiver } }, portableSpacePreviewResultSchema);
    expect(preview.rows.map((row) => row.id)).toEqual(['credentials:providers.openai']);
    await request(source, sourceBase, '/api/spaces/portable/apply', { previewToken: preview.previewToken }, portableSpaceApplyReceiptSchema);
    expect(await exists(join(receiver, PLAIN))).toBe(false);
    expect(await readFile(join(receiver, 'config.toml'), 'utf8')).toContain('[providers.openai]');
  });

  it('shows sync summaries in left-to-right order for conflicts and one-sided rows', async () => {
    const left = join(root, 'summaries-left');
    const right = join(root, 'summaries-right');
    await mkdir(left);
    await mkdir(right);
    await writeFile(join(left, 'config.toml'), 'default_model = "left-value"\n[providers.left]\ntype = "openai"\n');
    await writeFile(join(right, 'config.toml'), 'default_model = "right-value"\n[providers.right]\ntype = "openai"\n');
    const preview = await request(source, sourceBase, '/api/spaces/portable/preview', { mode: 'sync', sources: [{ kind: 'dir', path: left }], target: { kind: 'dir', path: right } }, portableSpacePreviewResultSchema);
    expect(preview.rows).toEqual([
      expect.objectContaining({ path: 'default_model', direction: 'conflict', beforeSummary: '"left-value"', afterSummary: '"right-value"' }),
      expect.objectContaining({ path: 'providers.left', change: 'only_left', direction: 'to_right', beforeSummary: expect.any(String), afterSummary: null }),
      expect.objectContaining({ path: 'providers.right', change: 'only_right', direction: 'to_left', beforeSummary: null, afterSummary: expect.any(String) }),
    ]);
  });

  it('preserves each matched passphrase and advances verified fork ancestry through a revert', async () => {
    const left = { kind: 'archive', path: join(root, 'baseline-left.kiki.age') };
    const right = { kind: 'archive', path: join(root, 'baseline-right.kiki.age') };
    const initial = join(root, 'baseline-seed');
    const leftPassphrase = 'left-only fixture passphrase';
    const rightPassphrase = 'right-only fixture passphrase';
    await mkdir(initial);
    await writeFile(join(initial, 'config.toml'), 'default_model = "zero"\n');
    await request(source, sourceBase, '/api/spaces/portable/export', { source: { kind: 'dir', path: initial }, destination: left.path, encryption: { mode: 'passphrase', passphrase: leftPassphrase } }, portableSpaceExportReceiptSchema);
    await request(source, sourceBase, '/api/spaces/portable/fork', { source: left, sourceUnlock: { passphrase: leftPassphrase }, destination: right.path, encryption: { mode: 'passphrase', passphrase: rightPassphrase } }, portableSpaceExportReceiptSchema);
    const mutate = (value: string) => request(source, sourceBase, '/api/spaces/portable/mutate', { target: left, unlock: { passphrase: leftPassphrase }, actions: [{ op: 'set', key: 'default_model', value }] }, portableSpaceMutateReceiptSchema);
    const sync = async (leftValue: string, rightValue: string) => {
      vi.stubEnv('KIKI_AGE_PASSPHRASE', rightPassphrase);
      try {
        const preview = await request(source, sourceBase, '/api/spaces/portable/preview', { mode: 'sync', sources: [left], target: right, sourceUnlocks: [{ passphrase: leftPassphrase }], targetUnlock: { passphrase: leftPassphrase } }, portableSpacePreviewResultSchema);
        expect(preview.hasVerifiedBase).toBe(true);
        expect(preview.rows).toEqual([expect.objectContaining({ path: 'default_model', direction: 'to_right', beforeSummary: JSON.stringify(leftValue), afterSummary: JSON.stringify(rightValue) })]);
        await request(source, sourceBase, '/api/spaces/portable/apply', { previewToken: preview.previewToken }, portableSpaceApplyReceiptSchema);
      } finally { vi.stubEnv('KIKI_AGE_PASSPHRASE', undefined); }
      const a = unpackTarGz(await nativeAge().ageDecrypt(await readFile(left.path), leftPassphrase));
      const b = unpackTarGz(await nativeAge().ageDecrypt(await readFile(right.path), rightPassphrase));
      expect(b.get('config.toml')).toEqual(a.get('config.toml'));
      expect(b.get('.kiki-fork-base.json')).toEqual(a.get('.kiki-fork-base.json'));
      return JSON.parse(a.get('.kiki-fork-base.json')!.toString()) as { forkId: string };
    };
    await mutate('one');
    const first = await sync('one', 'zero');
    await mutate('zero');
    const second = await sync('zero', 'one');
    expect(second.forkId).not.toBe(first.forkId);
    expect(await readFile(join(sourceHome, '.portable-space-bases.json'), 'utf8')).toContain(second.forkId);
  }, 120_000);

  it('reads registered child Homes and preflights read-only reverse writes before writing the target', async () => {
    const path = join(root, 'registered-child');
    await mkdir(path);
    const id = 'h-portable-child';
    await writeFile(join(path, 'home.toml'), `schema = 1\nid = "${id}"\nname = "Portable child"\nbase = ${JSON.stringify(sourceHome)}\n`);
    await writeFile(join(path, 'AGENTS.md'), 'child instructions\n');
    const guiCredentials = 'secrets/nb-search/gui-credentials.json';
    await mkdir(join(path, 'secrets', 'nb-search'), { recursive: true });
    await writeFile(join(path, guiCredentials), JSON.stringify({ schema_version: '1', slots: { child: { provider_id: 'exa', env: 'EXA_API_KEY', binding: 'child-fixture', value: 'child-fixture-credential' } } }));
    await writeFile(join(sourceHome, 'homes.json'), JSON.stringify([{ id, name: 'Portable child', path }]));
    const child = { kind: 'live', spaceId: id };
    try {
      const inspect = await request(source, sourceBase, '/api/spaces/portable/inspect', { endpoint: child }, portableSpaceInspectResultSchema);
      expect(inspect.label).toBe('Portable child');
      expect(inspect.items).toContainEqual(expect.objectContaining({ path: 'AGENTS.md' }));
      expect(inspect.items).toContainEqual(expect.objectContaining({ id: 'credentials:nb_search_gui.child', masked: true }));
      expect(JSON.stringify(inspect)).not.toContain('child-fixture-credential');
      const local = { kind: 'dir', path: join(root, 'child-copy') };
      await request(source, sourceBase, '/api/spaces/portable/export', { source: child, destination: local.path, secretMode: 'none' }, portableSpaceExportReceiptSchema);
      expect(await readFile(join(local.path, 'AGENTS.md'), 'utf8')).toBe('child instructions\n');
      await writeFile(join(local.path, 'SYSTEM.md'), 'would sync to child\n');
      await writeFile(join(path, 'AGENTS.md'), 'would sync to target\n');
      const direct = { mode: 'sync', sources: [child], target: local, prefer: 'left' };
      const failure = await failedRequest(source, sourceBase, '/api/spaces/portable/apply', { direct }, 400);
      expect(failure.msg).toContain('to write its live Home');
      expect(await readFile(join(local.path, 'AGENTS.md'), 'utf8')).toBe('child instructions\n');
      expect(await exists(join(path, 'SYSTEM.md'))).toBe(false);
    } finally { await rm(join(sourceHome, 'homes.json'), { force: true }); }
  });

  it('exposes authenticated source catalog through the locked response schema', async () => {
    const catalog = await request(source, sourceBase, '/api/spaces/portable/sources', undefined, portableSpaceSourcesListResponseSchema);
    expect(catalog.deviceRecipient).toMatch(/^age1/);
    expect(catalog.items).toEqual([]);
  });

  it('registers persistent output paths and refreshes metadata on mutation and rekey', async () => {
    const oldTmp = process.env['TMPDIR'];
    const oldTemp = process.env['TEMP'];
    const oldWinTmp = process.env['TMP'];
    const excluded = join(root, '.tmp');
    await mkdir(excluded);
    vi.stubEnv('TMPDIR', excluded); vi.stubEnv('TEMP', excluded); vi.stubEnv('TMP', excluded);
    const path = join(root, 'recorded.kiki.age');
    try {
      const exported = await request(source, sourceBase, '/api/spaces/portable/export', { destination: path, secretMode: 'none', domains: ['config'] }, portableSpaceExportReceiptSchema);
      expect(exported.sourceRecord).toMatchObject({ endpoint: { kind: 'archive', path }, encryptionMode: 'x25519', spaceMode: 'full' });
      const endpoint = { kind: 'archive', path };
      const id = exported.sourceRecord!.id;
      await request(source, sourceBase, '/api/spaces/portable/mutate', { target: endpoint, actions: [{ op: 'unset', key: 'config:default_model', recordOverlayUnset: true }] }, portableSpaceMutateReceiptSchema);
      const mutated = await request(source, sourceBase, '/api/spaces/portable/sources', undefined, portableSpaceSourcesListResponseSchema);
      expect(mutated.items.find((entry) => entry.id === id)).toMatchObject({ encryptionMode: 'x25519', secretMode: 'none', spaceMode: 'overlay' });
      const passphrase = 'registry fixture password';
      await request(source, sourceBase, '/api/spaces/portable/rekey', { target: path, encryption: { mode: 'passphrase', passphrase } }, portableSpaceInspectResultSchema);
      const fork = join(root, 'recorded-fork.tgz');
      const unpacked = join(root, 'recorded-unpacked');
      const packed = join(root, 'recorded-packed.tgz');
      const forked = await request(source, sourceBase, '/api/spaces/portable/fork', { source: endpoint, sourceUnlock: { passphrase }, destination: fork, secretMode: 'none' }, portableSpaceExportReceiptSchema);
      expect(forked.sourceRecord?.endpoint).toEqual({ kind: 'archive', path: fork });
      const unpack = await request(source, sourceBase, '/api/spaces/portable/unpack', { action: 'unpack', sourcePath: fork, destinationPath: unpacked, secretMode: 'none' }, portableSpaceExportReceiptSchema);
      expect(unpack.sourceRecord?.endpoint).toEqual({ kind: 'dir', path: unpacked });
      const pack = () => request(source, sourceBase, '/api/spaces/portable/pack', { action: 'pack', sourcePath: unpacked, destinationPath: packed, secretMode: 'none' }, portableSpaceExportReceiptSchema);
      const first = await pack();
      const second = await pack();
      expect(first.sourceRecord).toMatchObject({ endpoint: { kind: 'archive', path: packed }, id: expect.any(String) });
      expect(second.sourceRecord?.id).toBe(first.sourceRecord?.id);
      const scrubbed = await request(source, sourceBase, '/api/spaces/portable/unpack', { action: 'unpack', sourcePath: path, destinationPath: join(excluded, 'staged'), secretMode: 'none', unlock: { passphrase } }, portableSpaceExportReceiptSchema);
      expect(scrubbed.sourceRecord).toBeUndefined();
      const list = await request(source, sourceBase, '/api/spaces/portable/sources', undefined, portableSpaceSourcesListResponseSchema);
      expect(list.items.filter((entry) => entry.id === id)).toEqual([expect.objectContaining({ encryptionMode: 'passphrase', secretMode: 'none', spaceMode: 'overlay', updatedAt: expect.any(String) })]);
    } finally { vi.stubEnv('TMPDIR', oldTmp); vi.stubEnv('TEMP', oldTemp); vi.stubEnv('TMP', oldWinTmp); }
  }, 50_000);

  it('scrubs MCP env values, replaces notification records and rejects a Git ignore negation', async () => {
    await source.core.accessor.get(IMcpConfigStore).add({ name: 'env-fixture', transport: 'stdio', command: 'npx', args: ['fixture'], env: { GH_PAT: 'secret-fixture-pat', NODE_ENV: 'production' } });
    await source.core.accessor.get(IMcpConfigStore).add({ name: 'custom-path-bin', transport: 'stdio', command: 'officecli-mcp', args: ['--serve'] });
    await source.core.accessor.get(IMcpConfigStore).add({ name: 'local-only', transport: 'stdio', command: '/opt/machine-local/bin/mcp', args: ['--stdio'] });
    const liveInspect = await request(source, sourceBase, '/api/spaces/portable/inspect', { endpoint: { kind: 'live', spaceId: 'main' } }, portableSpaceInspectResultSchema);
    expect(liveInspect.items.some((item) => item.id === 'mcp:custom-path-bin')).toBe(true);
    expect(liveInspect.excluded).toEqual([
      expect.objectContaining({ id: 'mcp:local-only', domain: 'mcp', path: 'mcp.local-only', reason: expect.stringContaining('machine-local') }),
    ]);
    const directory = join(root, 'scrubbed-mcp-credentials');
    const mcpExportReceipt = await request(source, sourceBase, '/api/spaces/portable/export', { destination: directory, domains: ['mcp', 'credentials'], secretMode: 'none' }, portableSpaceExportReceiptSchema);
    expect(mcpExportReceipt.excluded).toEqual([
      expect.objectContaining({ id: 'mcp:local-only', domain: 'mcp', path: 'mcp.local-only' }),
    ]);
    const mcp = await readFile(join(directory, 'mcp.json'), 'utf8');
    expect(mcp).toContain('NODE_ENV');
    expect(mcp).toContain('officecli-mcp');
    expect(mcp).not.toContain('local-only');
    expect(mcp).not.toMatch(/GH_PAT|secret-fixture-pat/);
    const targetConfig = target.core.accessor.get(IConfigService);
    await targetConfig.replace('notifications', { ...DEFAULT_NOTIFICATIONS_CONFIG, channels: { removed: {} }, provider_instances: { removed: {} }, credential_slots: { removed: {} }, credential_values: { retain: { token: 'fixture-notification-token' } } });
    const notifyDir = join(root, 'replaced-notifications');
    await mkdir(notifyDir);
    await writeFile(join(notifyDir, 'config.toml'), '[notifications.global]\nenabled = false\n[notifications.channels.present]\nk = "incoming"\n');
    await request(target, targetBase, '/api/spaces/portable/apply', { createBackup: false, direct: { mode: 'override', sources: [{ kind: 'dir', path: notifyDir }], domains: ['config'] } }, portableSpaceApplyReceiptSchema);
    expect(targetConfig.get('notifications')).toMatchObject({ channels: { present: { k: 'incoming' } }, provider_instances: {}, credential_slots: {}, credential_values: { retain: { token: 'fixture-notification-token' } } });
    expect(Object.keys(targetConfig.get<{ channels: Record<string, unknown> }>('notifications').channels)).toEqual(['present']);
    const gitDir = join(root, 'git-negates-plaintext');
    await mkdir(gitDir);
    await gitCommand(gitDir, ['init', '-q']);
    await writeFile(join(gitDir, '.gitignore'), '/credentials/credentials.toml\n!/credentials/credentials.toml\n');
    const rejected = await failedRequest(source, sourceBase, '/api/spaces/portable/export', { destination: gitDir, secretMode: 'plain', domains: ['credentials'] }, 400);
    expect(rejected.msg).toMatch(/ignor/i);
    expect(await exists(join(gitDir, PLAIN))).toBe(false);

    const nonGitPlainDir = join(root, 'plain-outside-git-localized');
    await mkdir(nonGitPlainDir);
    const oldLcAll = process.env['LC_ALL'];
    const oldLang = process.env['LANG'];
    try {
      vi.stubEnv('LC_ALL', 'zh_CN.UTF-8');
      vi.stubEnv('LANG', 'zh_CN.UTF-8');
      const plainOutsideReceipt = await request(
        source,
        sourceBase,
        '/api/spaces/portable/export',
        { destination: nonGitPlainDir, secretMode: 'plain', domains: ['credentials'] },
        portableSpaceExportReceiptSchema,
      );
      expect(plainOutsideReceipt.secretMode).toBe('plain');
      expect(await exists(join(nonGitPlainDir, PLAIN))).toBe(true);
    } finally {
      vi.stubEnv('LC_ALL', oldLcAll);
      vi.stubEnv('LANG', oldLang);
    }

    const previewSource = join(root, 'preview-retention-src');
    const previewTarget = join(root, 'preview-retention-dst');
    await mkdir(previewSource);
    await mkdir(previewTarget);
    await writeFile(join(previewSource, 'config.toml'), 'default_model = "preview-retained"\n');
    const firstPreview = await request(
      source,
      sourceBase,
      '/api/spaces/portable/preview',
      { mode: 'override', sources: [{ kind: 'dir', path: previewSource }], target: { kind: 'dir', path: previewTarget }, domains: ['config'] },
      portableSpacePreviewResultSchema,
    );
    for (let idx = 0; idx < 8; idx += 1) {
      const otherDir = join(root, `preview-other-${idx}`);
      await mkdir(otherDir);
      await request(
        source,
        sourceBase,
        '/api/spaces/portable/preview',
        { mode: 'override', sources: [{ kind: 'dir', path: previewSource }], target: { kind: 'dir', path: otherDir }, domains: ['config'] },
        portableSpacePreviewResultSchema,
      );
    }
    await request(
      source,
      sourceBase,
      '/api/spaces/portable/apply',
      { previewToken: firstPreview.previewToken, createBackup: false },
      portableSpaceApplyReceiptSchema,
    );
    expect(await readFile(join(previewTarget, 'config.toml'), 'utf8')).toContain('preview-retained');

    const authNative = createRequire(createRequire(import.meta.url).resolve('@kiki/oauth'))('@kiki/auth-native') as {
      generateX25519Keypair: () => { recipient: string; identity: string };
    };
    const keypairs = Array.from({ length: 65 }, () => authNative.generateX25519Keypair());
    const stubSync = {
      ensureDeviceKeypair: async () => keypairs[0]!,
    } as unknown as Parameters<typeof encodeAge>[3];
    const encoded65 = await encodeAge(
      Buffer.from('portable-65-recipients', 'utf8'),
      { mode: 'x25519', recipients: keypairs.map((kp) => kp.recipient) },
      [],
      stubSync,
    );
    expect(encoded65.recipients).toHaveLength(65);
    const decoded65 = await decodeAge(encoded65.bytes, { identity: keypairs[64]!.identity }, stubSync);
    expect(decoded65.bytes.toString('utf8')).toBe('portable-65-recipients');

    await expect(
      decodeAge(encoded65.bytes, { identity: keypairs[64]!.identity }, stubSync, () => {
        throw new TypeError('Portable age codec is unavailable');
      }),
    ).rejects.toThrow('Portable age codec is unavailable');

    const wrongKey = authNative.generateX25519Keypair();
    const failSync = {
      ensureDeviceKeypair: async () => wrongKey,
    } as unknown as Parameters<typeof encodeAge>[3];
    await expect(
      decodeAge(encoded65.bytes, { identity: wrongKey.identity }, failSync),
    ).rejects.toThrow('Unable to decrypt portable age archive');

    const hugeSrc = join(root, 'huge-multiline-src');
    const hugeDst = join(root, 'huge-multiline-dst');
    await mkdir(join(hugeSrc, 'agents'), { recursive: true });
    await mkdir(join(hugeDst, 'agents'), { recursive: true });
    const hugeOldText = Array.from({ length: 200_000 }, (_, i) => `o${i}`).join('\n');
    const hugeNewText = Array.from({ length: 200_000 }, (_, i) => `n${i}`).join('\n');
    await writeFile(join(hugeDst, 'agents', 'large.md'), hugeOldText, 'utf8');
    await writeFile(join(hugeSrc, 'agents', 'large.md'), hugeNewText, 'utf8');
    const hugePreview = await request(
      source,
      sourceBase,
      '/api/spaces/portable/preview',
      { mode: 'override', sources: [{ kind: 'dir', path: hugeSrc }], target: { kind: 'dir', path: hugeDst }, domains: ['agents'] },
      portableSpacePreviewResultSchema,
    );
    const hugeRow = hugePreview.rows.find((row) => row.path === 'agents/large.md');
    expect(hugeRow?.diffPreview).toBeDefined();
    expect(hugeRow!.diffPreview!.length).toBeLessThanOrEqual(16_384);
    expect(hugeRow!.diffPreview).toContain('-o0');
    expect(hugeRow!.diffPreview).toContain('+n0');
    expect(hugeRow!.diffPreview).toContain('more lines omitted');

    await request(
      source,
      sourceBase,
      '/api/spaces/portable/apply',
      { direct: { mode: 'override', sources: [{ kind: 'dir', path: hugeSrc }], target: { kind: 'dir', path: hugeDst }, domains: ['agents'] }, createBackup: false },
      portableSpaceApplyReceiptSchema,
    );
    expect(await readFile(join(hugeDst, 'agents', 'large.md'), 'utf8')).toBe(hugeNewText);
  });

});
