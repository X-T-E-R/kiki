import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IConfigService, type Scope } from '@kiki/agent-core-v2';
import { modelGenerationMigrationApplyResponseSchema, modelGenerationMigrationPreviewSchema } from '@kiki/protocol';

import { ErrorCode } from '../src/protocol/error-codes';
import { registerConfigRoutes } from '../src/routes/config';
import { startServer, type RunningServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const original = [
  '# secret sk-not-for-migration-response',
  '[models."short.alias"]',
  'provider = "acme"',
  'model = "remote"',
  'max_completion_tokens = 8192',
  '[models."short.alias".request_params]',
  'temperature = 0.3',
  '',
].join('\n');

interface Envelope<T> { readonly code: number; readonly data: T; readonly msg: string }

describe('explicit model generation migration REST', () => {
  let server: RunningServer | undefined;
  let home: string;
  let base: string;
  let configPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-model-migration-'));
    configPath = join(home, 'config.toml');
    await writeFile(configPath, original, 'utf-8');
    server = await startServer({ homeDir: home, hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function post(path: string, body: unknown): Promise<Envelope<unknown>> {
    const res = await authedFetch(server!, base, `/api/config/model-generation-migration/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return res.json() as Promise<Envelope<unknown>>;
  }

  async function preview(): Promise<ReturnType<typeof modelGenerationMigrationPreviewSchema.parse>> {
    const res = await authedFetch(server!, base, '/api/config/model-generation-migration');
    expect(res.status).toBe(200);
    const payload = await res.json() as Envelope<unknown>;
    expect(payload.code).toBe(0);
    expect(JSON.stringify(payload)).not.toContain('sk-not-for-migration-response');
    return modelGenerationMigrationPreviewSchema.parse(payload.data);
  }

  it('allows read-only preview with external config while refusing apply and restore', async () => {
    await server!.close();
    server = await startServer({ homeDir: home, configPath, configReadOnly: true, hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    const before = await readFile(configPath, 'utf-8');
    const view = await preview();
    expect(view.changes.length).toBeGreaterThan(0);
    expect((await post('apply', { revision: view.revision, confirmed: true })).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect((await post('restore', { revision: view.revision, backup_key: 'config.toml.generation-backup-123e4567-e89b-42d3-a456-426614174000', confirmed: true })).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await readFile(configPath, 'utf-8')).toBe(before);
    expect((await readdir(home)).filter((name) => name.includes('.generation-backup-'))).toEqual([]);
  });

  it('does not recover an orphaned temp config during read-only GET or rejected POSTs', async () => {
    await server!.close();
    await rm(configPath);
    const orphan = `${configPath}.tmp.2147483647.dead`;
    await writeFile(orphan, original, 'utf-8');
    server = await startServer({ homeDir: home, configPath, configReadOnly: true, hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    const before = await readdir(home);
    const response = await authedFetch(server, base, '/api/config/model-generation-migration');
    expect(response.status).toBe(200);
    expect((await response.json() as Envelope<unknown>).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect((await post('apply', { revision: '0'.repeat(64), confirmed: true })).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect((await post('restore', { revision: '0'.repeat(64), backup_key: 'config.toml.generation-backup-123e4567-e89b-42d3-a456-426614174000', confirmed: true })).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect((await readdir(home)).filter((name) => name.startsWith('config.toml')))
      .toEqual(before.filter((name) => name.startsWith('config.toml')));
    expect(await readFile(orphan, 'utf8')).toBe(original);
    expect((await readdir(home)).includes('config.toml')).toBe(false);
  });

  it('requires bearer auth; GET is read-only and hides original text and secrets', async () => {
    const unauthorized = await fetch(`${base}/api/config/model-generation-migration`);
    expect(unauthorized.status).toBe(401);
    const backups = () => readdir(home).then((names) => names.filter((name) => name.includes('.generation-backup-')));
    expect(await backups()).toEqual([]);
    const result = await preview();
    expect(result.changes).toEqual([{ model_id: 'short.alias', fields: ['temperature', 'max_completion_tokens'] }]);
    expect(result.backups).toEqual([]);
    expect(await backups()).toEqual([]);
    expect(await readFile(configPath, 'utf-8')).toBe(original);
    expect((await post('apply', { revision: result.revision, confirmed: false })).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await backups()).toEqual([]);
    expect(await readFile(configPath, 'utf-8')).toBe(original);
  });

  it('requires fresh preview, writes byte-exact backup only after confirmation and restores independently', async () => {
    const first = await preview();
    const changed = `${original}\n[other]\nvalue = 7\n`;
    await writeFile(configPath, changed, 'utf-8');
    expect((await post('apply', { revision: first.revision, confirmed: true })).code).toBe(ErrorCode.CONFIG_REVISION_CONFLICT);
    expect(await readFile(configPath, 'utf-8')).toBe(changed);
    const second = await preview();
    const appliedPayload = await post('apply', { revision: second.revision, confirmed: true });
    expect(appliedPayload.code).toBe(0);
    expect(JSON.stringify(appliedPayload)).not.toContain('sk-not-for-migration-response');
    const applied = modelGenerationMigrationApplyResponseSchema.parse(appliedPayload.data);
    expect(await readFile(join(home, applied.backup_key), 'utf-8')).toBe(changed);
    const migrated = await readFile(configPath, 'utf-8');
    expect(migrated).toContain('temperature = 0.3');
    expect(migrated).toContain('max_completion_tokens = 8192');
    expect((await preview()).backups).toContain(applied.backup_key);
    expect((await post('restore', { revision: applied.revision, backup_key: applied.backup_key, confirmed: false })).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect((await post('restore', { revision: applied.revision, backup_key: '../../credentials.toml', confirmed: true })).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await readFile(configPath, 'utf-8')).toBe(migrated);
    const restored = await post('restore', { revision: applied.revision, backup_key: applied.backup_key, confirmed: true });
    expect(restored.code).toBe(0);
    expect(await readFile(configPath, 'utf-8')).toBe(changed);
    expect((await post('restore', { revision: applied.revision, backup_key: applied.backup_key, confirmed: true })).code).toBe(ErrorCode.CONFIG_REVISION_CONFLICT);
  });

  it('refuses stale restore after another writer edits migrated config', async () => {
    const first = await preview();
    const applied = modelGenerationMigrationApplyResponseSchema.parse((await post('apply', { revision: first.revision, confirmed: true })).data);
    const concurrent = `${await readFile(configPath, 'utf-8')}\n[other]\nvalue = 8\n`;
    await writeFile(configPath, concurrent, 'utf-8');
    expect((await post('restore', { revision: applied.revision, backup_key: applied.backup_key, confirmed: true })).code).toBe(ErrorCode.CONFIG_REVISION_CONFLICT);
    expect(await readFile(configPath, 'utf-8')).toBe(concurrent);
    expect(await readFile(join(home, applied.backup_key), 'utf-8')).toBe(original);
  });
});

describe('model migration preview failure classification', () => {
  it('distinguishes an unavailable preview capability from an unreadable config', async () => {
    type RouteHost = Parameters<typeof registerConfigRoutes>[0];
    type GetHandler = Parameters<RouteHost['get']>[2];
    const invoke = async (config: object): Promise<Envelope<unknown>> => {
      const routes = new Map<string, GetHandler>();
      const host = {
        get: (path: string, _options: unknown, handler: GetHandler) => { routes.set(path, handler); },
        post: () => {},
      } as RouteHost;
      const core = { accessor: { get: (key: unknown) => {
        if (key === IConfigService) return config;
        throw new Error('unexpected service');
      } } } as unknown as Scope;
      registerConfigRoutes(host, core);
      let result: unknown;
      await routes.get('/config/model-generation-migration')!({ id: 'preview-id' }, { send: (payload) => { result = payload; } });
      return result as Envelope<unknown>;
    };
    expect(await invoke({})).toMatchObject({ code: ErrorCode.INTERNAL_ERROR, msg: expect.stringContaining('unavailable') });
    expect(await invoke({ previewModelGenerationMigration: async () => { throw new Error('invalid config with SECRET_VALUE'); } }))
      .toMatchObject({ code: ErrorCode.VALIDATION_FAILED, msg: expect.stringContaining('invalid configuration') });
    expect(await invoke({ previewModelGenerationMigration: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } }))
      .toMatchObject({ code: ErrorCode.INTERNAL_ERROR, msg: expect.stringContaining('EACCES') });
  });
});
