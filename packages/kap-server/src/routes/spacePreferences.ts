import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IBootstrapService, IConfigRegistry, IConfigService, ILogService, type Scope } from '@kiki/agent-core-v2';
import { readSpaceHome } from '@kiki/agent-core-v2/app/bootstrap/spaceHome';
import {
  spaceDetailParamsSchema, spaceDetailSchema, spacePlanRequestSchema, spacePreviewSchema,
  spaceApplyRequestSchema, spaceMutationResponseSchema, spacePreferenceImportSchema,
  spacePreferenceImportResponseSchema, spaceUndoRequestSchema,
} from '@kiki/protocol';
import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { SpacePreferencesStore } from '../services/spacePreferences/store';

function pathIdentity(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

interface Host {
  get(path: string, options: { schema?: Record<string, unknown> }, handler: (...args: never[]) => unknown): unknown;
  post(path: string, options: { schema?: Record<string, unknown> }, handler: (...args: never[]) => unknown): unknown;
  addHook?(name: 'onClose', handler: () => Promise<void>): unknown;
}
export function registerSpacePreferenceRoutes(app: Host, scope: Scope): SpacePreferencesStore {
  const bootstrap = scope.accessor.get(IBootstrapService);
  const main = bootstrap.baseHomeDir ?? bootstrap.homeDir;
  const config = scope.accessor.get(IConfigService);
  const log = scope.accessor.get(ILogService);
  const store = new SpacePreferencesStore(scope.accessor.get(IConfigRegistry), bootstrap.homeDir, config);
  const ready = store.captureRuntime(bootstrap.homeDir, main);
  let runtimeUpdates = ready;
  let runtimeUpdateQueued = false;
  const configChanges = config.onDidChangeConfiguration(() => {
    if (runtimeUpdateQueued) return;
    runtimeUpdateQueued = true;
    runtimeUpdates = runtimeUpdates.then(async () => {
      runtimeUpdateQueued = false;
      await store.refreshRuntimeConfig();
    }).catch((error: unknown) => {
      runtimeUpdateQueued = false;
      log.error('space configuration runtime snapshot failed', { error });
    });
  });
  app.addHook?.('onClose', async () => { configChanges.dispose(); await runtimeUpdates.catch(() => undefined); await store.close(); });
  async function target(id: string, write: boolean): Promise<string> {
    if (bootstrap.spaceId !== undefined) {
      if (id === bootstrap.spaceId) {
        const current = readSpaceHome(bootstrap.homeDir).space;
        if (current?.id !== id || current.baseHomeDir === undefined || pathIdentity(current.baseHomeDir) !== pathIdentity(main)) throw new Error('Current space identity changed; reopen it before changing settings');
        return bootstrap.homeDir;
      }
      if (id === 'main' && !write) return main;
      throw new Error('This backend can only change its own space');
    }
    if (id === 'main') return main;
    const records = JSON.parse(await readFile(join(main, 'homes.json'), 'utf8')) as { id: string; path: string }[];
    const record = records.find((entry) => entry.id === id);
    if (record === undefined) throw new Error('Space is not registered');
    const space = readSpaceHome(record.path).space;
    if (space?.id !== id || space.baseHomeDir === undefined || pathIdentity(space.baseHomeDir) !== pathIdentity(main)) throw new Error('Registered space identity changed');
    return record.path;
  }
  async function canPushToMain(): Promise<boolean> {
    if (bootstrap.spaceId === undefined) return true;
    const contents = await readFile(join(main, 'homes.json'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '[]'; throw error; });
    const records = JSON.parse(contents) as { id: string; path: string }[];
    return records.some((record) => record.id === bootstrap.spaceId && pathIdentity(record.path) === pathIdentity(bootstrap.homeDir));
  }
  const detail = defineRoute({ method: 'GET', path: '/homes/{id}/settings', params: spaceDetailParamsSchema,
    success: { data: spaceDetailSchema }, errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Read complete saved space selections, resource origins, preferences and pending runtime changes', tags: ['homes'] }, async (req, reply) => {
    try { await ready; reply.send(okEnvelope(await store.detail(await target(req.params.id, false), main), req.id)); }
    catch (error) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, String(error), req.id)); }
  });
  app.get(detail.path, detail.options, detail.handler as never);
  const preview = defineRoute({ method: 'POST', path: '/homes/{id}/settings/preview', params: spaceDetailParamsSchema,
    body: spacePlanRequestSchema, success: { data: spacePreviewSchema }, errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Preview explicit follow, fixed, edit, exclusion or push-to-main without writing any files', tags: ['homes'] }, async (req, reply) => {
    try { await ready; reply.send(okEnvelope(await store.preview(await target(req.params.id, true), main, req.body), req.id)); }
    catch (error) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, String(error), req.id)); }
  });
  app.post(preview.path, preview.options, preview.handler as never);
  const apply = defineRoute({ method: 'POST', path: '/homes/{id}/settings/apply', params: spaceDetailParamsSchema,
    body: spaceApplyRequestSchema, success: { data: spaceMutationResponseSchema }, errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Publish only selected preview rows after checking both spaces and required dependencies', tags: ['homes'] }, async (req, reply) => {
    try { await ready; reply.send(okEnvelope(await store.apply(await target(req.params.id, true), main, req.body.token, req.body.selected, await canPushToMain()), req.id)); }
    catch (error) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, String(error), req.id)); }
  });
  app.post(apply.path, apply.options, apply.handler as never);
  const undo = defineRoute({ method: 'POST', path: '/homes/{id}/settings/undo', params: spaceDetailParamsSchema,
    body: spaceUndoRequestSchema, success: { data: spaceMutationResponseSchema }, errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Undo the most recent non-secret operation only while its written versions still match', tags: ['homes'] }, async (req, reply) => {
    try { await ready; reply.send(okEnvelope(await store.undo(await target(req.params.id, true), main, req.body.undo_id, await canPushToMain()), req.id)); }
    catch (error) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, String(error), req.id)); }
  });
  app.post(undo.path, undo.options, undo.handler as never);
  const migrate = defineRoute({ method: 'POST', path: '/homes/{id}/settings/import-preferences', params: spaceDetailParamsSchema,
    body: spacePreferenceImportSchema, success: { data: spacePreferenceImportResponseSchema }, errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Import old device preferences only when space authority is absent; later caches cannot overwrite it', tags: ['homes'] }, async (req, reply) => {
    try { await ready; reply.send(okEnvelope(await store.importPreferences(await target(req.params.id, true), main, req.body), req.id)); }
    catch (error) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, String(error), req.id)); }
  });
  app.post(migrate.path, migrate.options, migrate.handler as never);
  return store;
}
