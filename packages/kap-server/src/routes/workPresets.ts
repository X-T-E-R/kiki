import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { IAtomicDocumentStore, IBootstrapService, IConfigService, IFlagService, IPluginService, IPluginHostService, nonemptyMarketplaceSource, parsePluginMarketplace, readPluginMarketplace, type PluginMarketplace, type Scope } from '@kiki/agent-core-v2';
import { WORK_PRESETS_FLAG } from '../services/workPresets/flag';
import { readBundledPluginCatalog, readPublishedPluginCatalog } from '@kiki/agent-core-v2/app/plugin/defaultCatalog';
import { enableWorkPresetRequestSchema, updateWorkPresetRequestSchema, workPresetMutationResponseSchema, workPresetParamsSchema, workPresetsResponseSchema } from '@kiki/protocol';
import { defineRoute } from '../middleware/defineRoute';
import { errEnvelope, okEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';
import { WorkPresetManager, type PresetPluginSource } from '../services/workPresets/manager';

interface Host {
  get(path: string, options: { schema?: Record<string, unknown> }, handler: (...args: never[]) => unknown): unknown;
  post(path: string, options: { schema?: Record<string, unknown> }, handler: (...args: never[]) => unknown): unknown;
  patch(path: string, options: { schema?: Record<string, unknown> }, handler: (...args: never[]) => unknown): unknown;
  delete(path: string, options: { schema?: Record<string, unknown> }, handler: (...args: never[]) => unknown): unknown;
}

interface WorkPresetRouteOptions {
  readonly marketplaceUrl?: () => string | undefined;
}

function presetSources(marketplace: PluginMarketplace): ReadonlyMap<string, PresetPluginSource> {
  return new Map(marketplace.plugins.filter((entry) => entry.source !== '').map((entry) => [entry.id, { source: entry.source, sha256: entry.sha256 }]));
}

export function registerWorkPresetRoutes(app: Host, scope: Scope, options: WorkPresetRouteOptions = {}): void {
  const bootstrap = scope.accessor.get(IBootstrapService);
  let published: Promise<ReadonlyMap<string, PresetPluginSource>> | undefined;
  const sources = async (usePublished = false): Promise<ReadonlyMap<string, PresetPluginSource>> => {
    const local = bootstrap.getEnv('KIKI_WORK_PLUGIN_ROOT');
    if (local !== undefined) {
      const result = new Map<string, PresetPluginSource>();
      for (const id of ['kiki-office', 'kiki-writing', 'kiki-extract', 'kiki-work']) {
        const source = join(local, id);
        if (await access(join(source, 'kimi.plugin.json')).then(() => true, () => false)) result.set(id, { source });
      }
      return result;
    }
    if (!usePublished) return presetSources(readBundledPluginCatalog().marketplace);
    const configured = nonemptyMarketplaceSource(options.marketplaceUrl?.());
    if (configured !== undefined) {
      const { raw, location } = await readPluginMarketplace({ source: configured, workDir: process.cwd() });
      return presetSources(parsePluginMarketplace(raw, location, true));
    }
    published ??= (async () => {
      const result = await readPublishedPluginCatalog();
      if (result === undefined) throw new Error('Published plugin catalog is unavailable.');
      return presetSources(result.marketplace);
    })().catch((error) => {
      published = undefined;
      throw error;
    });
    return published;
  };
  const manager = new WorkPresetManager(scope.accessor.get(IAtomicDocumentStore), scope.accessor.get(IPluginService), scope.accessor.get(IPluginHostService), sources, bootstrap.spaceId ?? 'main');
  const errors = { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.CAPABILITY_UNSUPPORTED]: {} };
  const list = defineRoute({ method: 'GET', path: '/work-presets', success: { data: workPresetsResponseSchema }, errors,
    description: 'List available work modes and their actual plugin state in this space', tags: ['work-presets'] }, async (req, reply) => {
    await scope.accessor.get(IConfigService).ready;
    if (!scope.accessor.get(IFlagService).enabled(WORK_PRESETS_FLAG)) {
      reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, 'Work presets are not enabled in this space', req.id));
      return;
    }
    try { reply.send(okEnvelope(await manager.list(), req.id)); }
    catch (error) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, String(error), req.id)); }
  });
  app.get(list.path, list.options, list.handler as never);
  const enable = defineRoute({ method: 'POST', path: '/work-presets/{id}/enable', params: workPresetParamsSchema, body: enableWorkPresetRequestSchema,
    success: { data: workPresetMutationResponseSchema }, errors, description: 'Explicitly enable a work mode and install its missing packages with source consent', tags: ['work-presets'] }, async (req, reply) => {
    await scope.accessor.get(IConfigService).ready;
    if (!scope.accessor.get(IFlagService).enabled(WORK_PRESETS_FLAG)) {
      reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, 'Work presets are not enabled in this space', req.id));
      return;
    }
    try { reply.send(okEnvelope(await manager.enable(req.params.id, req.body.install_prerequisites), req.id)); }
    catch (error) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, String(error), req.id)); }
  });
  app.post(enable.path, enable.options, enable.handler as never);
  const update = defineRoute({ method: 'PATCH', path: '/work-presets/{id}', params: workPresetParamsSchema, body: updateWorkPresetRequestSchema,
    success: { data: workPresetMutationResponseSchema }, errors, description: 'Customize or disable one mode without changing shared plugins or session bindings', tags: ['work-presets'] }, async (req, reply) => {
    await scope.accessor.get(IConfigService).ready;
    if (!scope.accessor.get(IFlagService).enabled(WORK_PRESETS_FLAG)) {
      reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, 'Work presets are not enabled in this space', req.id));
      return;
    }
    try { reply.send(okEnvelope(await manager.update(req.params.id, req.body), req.id)); }
    catch (error) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, String(error), req.id)); }
  });
  app.patch(update.path, update.options, update.handler as never);
  const remove = defineRoute({ method: 'DELETE', path: '/work-presets/{id}', params: workPresetParamsSchema,
    success: { data: workPresetMutationResponseSchema }, errors, description: 'Remove a mode while retaining all plugins, sessions and documents', tags: ['work-presets'] }, async (req, reply) => {
    await scope.accessor.get(IConfigService).ready;
    if (!scope.accessor.get(IFlagService).enabled(WORK_PRESETS_FLAG)) {
      reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, 'Work presets are not enabled in this space', req.id));
      return;
    }
    try { reply.send(okEnvelope(await manager.remove(req.params.id), req.id)); }
    catch (error) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, String(error), req.id)); }
  });
  app.delete(remove.path, remove.options, remove.handler as never);
}
