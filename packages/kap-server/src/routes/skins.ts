import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { IPluginService, type PluginTheme, type Scope } from '@kiki/agent-core-v2';
import {
  PLUGIN_SKIN_ID_PATTERN,
  SKIN_ID_PATTERN,
  getSkinResponseSchema,
  listSkinsResponseSchema,
  parseSkinFile,
  skinIdParamSchema,
  type GetSkinResponse,
  type ListSkinsResponse,
  type SkinFile,
  type SkinPluginOrigin,
  type SkinSummary,
} from '@kiki/protocol';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';

interface SkinsRouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params?: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface SkinsRouteOptions {
  /** Absolute themes directory; `<homeDir>/themes` in production. */
  readonly themesDir: string;
}

const MAX_SKIN_BYTES = 64 * 1024;

interface PluginSkin {
  readonly id: string;
  readonly origin: SkinPluginOrigin;
  readonly file: SkinFile;
}

async function readSkinJson(themesDir: string, id: string): Promise<unknown> {
  const raw = await readFile(join(themesDir, `${id}.json`), 'utf-8');
  if (raw.length > MAX_SKIN_BYTES) throw new Error('skin file too large');
  return JSON.parse(raw) as unknown;
}

function declaredVariants(file: SkinFile): ('light' | 'dark')[] {
  const variants: ('light' | 'dark')[] = [];
  if (file.variants.light !== undefined) variants.push('light');
  if (file.variants.dark !== undefined) variants.push('dark');
  return variants;
}

function pluginSkinId(pluginId: string, themeId: string): string {
  return `${pluginId}:${themeId}`;
}

function pluginSkinOf(
  pluginId: string,
  version: string | undefined,
  theme: PluginTheme,
): PluginSkin {
  const id = pluginSkinId(pluginId, theme.id);
  return { id, origin: { id: pluginId, version }, file: { ...theme.file, id } };
}

async function enabledPluginSkins(core: Scope): Promise<readonly PluginSkin[]> {
  const plugins = core.accessor.get(IPluginService);
  const installed = (await plugins.listPlugins()).filter(
    (plugin) => plugin.enabled && plugin.state === 'ok',
  );
  const skins: PluginSkin[] = [];
  for (const plugin of installed) {
    const info = await plugins.getPluginInfo({ id: plugin.id });
    for (const theme of info.manifest?.kiki?.themes ?? []) {
      skins.push(pluginSkinOf(info.id, info.version, theme));
    }
  }
  return skins;
}

async function enabledPluginSkinsOrEmpty(
  core: Scope,
  skipped: { file: string; reason: string }[],
): Promise<readonly PluginSkin[]> {
  try {
    return await enabledPluginSkins(core);
  } catch (error) {
    skipped.push({
      file: 'plugins',
      reason: `plugin themes unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
    });
    return [];
  }
}

async function findPluginSkin(
  core: Scope,
  pluginId: string,
  themeId: string,
): Promise<PluginSkin | undefined> {
  const plugins = core.accessor.get(IPluginService);
  const enabled = (await plugins.listPlugins()).some(
    (plugin) => plugin.id === pluginId && plugin.enabled && plugin.state === 'ok',
  );
  if (!enabled) return undefined;
  const info = await plugins.getPluginInfo({ id: pluginId });
  const theme = (info.manifest?.kiki?.themes ?? []).find((entry) => entry.id === themeId);
  return theme === undefined ? undefined : pluginSkinOf(info.id, info.version, theme);
}

function pluginSkinSummary(skin: PluginSkin): SkinSummary {
  return {
    id: skin.id,
    name: skin.file.name,
    description: skin.file.description,
    author: skin.file.author,
    variants: declaredVariants(skin.file),
    plugin: skin.origin,
  };
}

export function registerSkinsRoutes(
  app: SkinsRouteHost,
  core: Scope,
  opts: SkinsRouteOptions,
): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/skins',
      success: { data: listSkinsResponseSchema },
      description:
        'List the GUI skins the server serves: skin files in the Kiki themes directory plus the themes of enabled plugins.',
      tags: ['skins'],
    },
    async (req, reply) => {
      const items: SkinSummary[] = [];
      const skipped: { file: string; reason: string }[] = [];
      let entries: string[] = [];
      try {
        const dir = await readdir(opts.themesDir, { withFileTypes: true });
        entries = dir.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map((entry) => entry.name);
      } catch {
        entries = [];
      }
      for (const file of entries.sort()) {
        const id = file.slice(0, -'.json'.length);
        if (!SKIN_ID_PATTERN.test(id)) {
          skipped.push({ file, reason: 'filename is not a valid skin id' });
          continue;
        }
        let parsed;
        try {
          parsed = parseSkinFile(await readSkinJson(opts.themesDir, id), id);
        } catch (error) {
          skipped.push({ file, reason: error instanceof Error ? error.message : 'unreadable' });
          continue;
        }
        if (parsed.skin === null) {
          skipped.push({ file, reason: parsed.warnings[0] ?? 'not a kiki-skin file' });
          continue;
        }
        items.push({
          id: parsed.skin.id ?? id,
          name: parsed.skin.name,
          description: parsed.skin.description,
          author: parsed.skin.author,
          variants: declaredVariants(parsed.skin),
        });
      }
      const pluginSkins = await enabledPluginSkinsOrEmpty(core, skipped);
      for (const skin of pluginSkins.toSorted((a, b) => a.id.localeCompare(b.id))) {
        items.push(pluginSkinSummary(skin));
      }
      const data: ListSkinsResponse = { items, directory: opts.themesDir, skipped };
      reply.send(okEnvelope(data, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<SkinsRouteHost['get']>[2]);

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/skins/:skin_id',
      params: skinIdParamSchema,
      success: { data: getSkinResponseSchema },
      errors: { [ErrorCode.FS_PATH_NOT_FOUND]: {} },
      description:
        'Read one GUI skin, with the tokens that failed validation reported. Plugin skins are read from the enabled plugin that contributed them.',
      tags: ['skins'],
    },
    async (req, reply) => {
      const { skin_id: skinId } = req.params as { skin_id: string };
      if (PLUGIN_SKIN_ID_PATTERN.test(skinId)) {
        const separator = skinId.indexOf(':');
        const pluginId = skinId.slice(0, separator);
        const themeId = skinId.slice(separator + 1);
        const skin = await findPluginSkin(core, pluginId, themeId);
        if (skin === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.FS_PATH_NOT_FOUND,
              `plugin skin not found: ${pluginId}:${themeId}`,
              req.id,
            ),
          );
          return;
        }
        const data: GetSkinResponse = { skin: skin.file, warnings: [], plugin: skin.origin };
        reply.send(okEnvelope(data, req.id));
        return;
      }
      if (!SKIN_ID_PATTERN.test(skinId)) {
        reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, 'skin not found', req.id));
        return;
      }
      let parsed;
      try {
        parsed = parseSkinFile(await readSkinJson(opts.themesDir, skinId), skinId);
      } catch {
        reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, 'skin not found', req.id));
        return;
      }
      if (parsed.skin === null) {
        reply.send(
          errEnvelope(
            ErrorCode.FS_PATH_NOT_FOUND,
            parsed.warnings[0] ?? 'not a kiki-skin file',
            req.id,
          ),
        );
        return;
      }
      reply.send(okEnvelope({ skin: parsed.skin, warnings: [...parsed.warnings] }, req.id));
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<SkinsRouteHost['get']>[2]);
}
