import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  getSkinResponseSchema,
  listSkinsResponseSchema,
  parseSkinFile,
  skinIdParamSchema,
  type ListSkinsResponse,
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

const SKIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const MAX_SKIN_BYTES = 64 * 1024;

async function readSkinJson(themesDir: string, id: string): Promise<unknown> {
  const raw = await readFile(join(themesDir, `${id}.json`), 'utf-8');
  if (raw.length > MAX_SKIN_BYTES) throw new Error('skin file too large');
  return JSON.parse(raw) as unknown;
}

export function registerSkinsRoutes(app: SkinsRouteHost, opts: SkinsRouteOptions): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/skins',
      success: { data: listSkinsResponseSchema },
      description: 'List GUI skin files in the Kiki themes directory.',
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
        if (!SKIN_ID.test(id)) {
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
        const variants: ('light' | 'dark')[] = [];
        if (parsed.skin.variants.light !== undefined) variants.push('light');
        if (parsed.skin.variants.dark !== undefined) variants.push('dark');
        items.push({
          id: parsed.skin.id ?? id,
          name: parsed.skin.name,
          ...(parsed.skin.description !== undefined
            ? { description: parsed.skin.description }
            : {}),
          ...(parsed.skin.author !== undefined ? { author: parsed.skin.author } : {}),
          variants,
        });
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
      description: 'Read one GUI skin file, with the tokens that failed validation reported.',
      tags: ['skins'],
    },
    async (req, reply) => {
      const { skin_id: skinId } = req.params as { skin_id: string };
      if (!SKIN_ID.test(skinId)) {
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
