import {
  DEFAULT_SHORTCUT_PREFERENCES,
  detectShortcutConflicts,
  resetShortcutPreferences,
  resolveShortcutBindings,
  shortcutActionSchema,
  shortcutChordSchema,
  shortcutPlatformSchema,
  shortcutPreferencesSchema,
  shortcutReadQuerySchema,
  shortcutResetSchema,
  shortcutResponseSchema,
  shortcutWriteSchema,
  ErrorCode,
  type ShortcutAction,
  type ShortcutChord,
  type ShortcutPlatform,
  type ShortcutPreferences,
} from '@kiki/protocol';
import { z } from 'zod';
import { defineRoute } from '../middleware/defineRoute';
import { okEnvelope, errEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import type { IGuiStoreService } from '../services/guiStore/guiStore';

interface ShortcutRouteHost {
  get(path: string, options: { schema?: Record<string, unknown> }, handler: unknown): unknown;
  put(path: string, options: { schema?: Record<string, unknown> }, handler: unknown): unknown;
  post(path: string, options: { schema?: Record<string, unknown> }, handler: unknown): unknown;
}

const STORE_KEY = 'shortcuts.v1';
const shortcutChordListSchema = z.array(shortcutChordSchema).max(4);

function parseStoredShortcuts(
  raw: string,
  log?: { warn(obj: Record<string, unknown>, msg: string): void },
): ShortcutPreferences {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log?.warn({ err }, 'persisted shortcut preferences JSON is corrupt; falling back to defaults');
    return shortcutPreferencesSchema.parse(DEFAULT_SHORTCUT_PREFERENCES);
  }
  const strict = shortcutPreferencesSchema.safeParse(parsed);
  if (strict.success) return strict.data;
  const overrides: Partial<Record<ShortcutPlatform, Partial<Record<ShortcutAction, ShortcutChord[]>>>> = {};
  let dropped = 0;
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const rawOverrides = (parsed as Record<string, unknown>)['overrides'];
    if (rawOverrides !== null && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)) {
      for (const platform of shortcutPlatformSchema.options) {
        const rawPlatform = (rawOverrides as Record<string, unknown>)[platform];
        if (rawPlatform === undefined) continue;
        if (rawPlatform === null || typeof rawPlatform !== 'object' || Array.isArray(rawPlatform)) {
          dropped += 1;
          continue;
        }
        const validBindings: Partial<Record<ShortcutAction, ShortcutChord[]>> = {};
        for (const [action, chords] of Object.entries(rawPlatform as Record<string, unknown>)) {
          const parsedAction = shortcutActionSchema.safeParse(action);
          const parsedChords = shortcutChordListSchema.safeParse(chords);
          if (parsedAction.success && parsedChords.success) {
            validBindings[parsedAction.data] = parsedChords.data;
          } else {
            dropped += 1;
          }
        }
        if (Object.keys(validBindings).length > 0) overrides[platform] = validBindings;
      }
    }
  }
  log?.warn(
    { dropped_entries: dropped, issue_count: strict.error.issues.length },
    'persisted shortcut preferences contained invalid entries; retaining valid overrides',
  );
  return { version: 1, overrides };
}

export function registerShortcutRoutes(app: ShortcutRouteHost, store: IGuiStoreService): void {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (req?: { id: string }): Promise<ShortcutPreferences> => {
    const raw = await store.getItem(STORE_KEY);
    return raw === null
      ? shortcutPreferencesSchema.parse(DEFAULT_SHORTCUT_PREFERENCES)
      : parseStoredShortcuts(raw, req === undefined ? undefined : requestLog(req));
  };
  const response = (preferences: ShortcutPreferences, platform: ShortcutPlatform) => ({
    preferences, bindings: resolveShortcutBindings(preferences, platform), conflicts: detectShortcutConflicts(preferences, platform),
  });
  const get = defineRoute({
    method: 'GET', path: '/gui/shortcuts', querystring: shortcutReadQuerySchema,
    success: { data: shortcutResponseSchema }, description: 'Read platform-specific shortcut bindings and persisted overrides.', tags: ['gui-store'],
  }, async (req, reply) => {
    await queue;
    reply.send(okEnvelope(response(await read(req), req.query.platform), req.id));
  });
  app.get(get.path, get.options, get.handler);
  const put = defineRoute({
    method: 'PUT', path: '/gui/shortcuts', querystring: shortcutReadQuerySchema, body: shortcutWriteSchema,
    success: { data: shortcutResponseSchema }, errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Replace shortcut overrides after validating every platform. Empty binding arrays disable an action.', tags: ['gui-store'],
  }, async (req, reply) => {
    const preferences = req.body.preferences;
    const conflicts = shortcutPlatformSchema.options.flatMap((platform) => detectShortcutConflicts(preferences, platform));
    if (conflicts.length > 0) {
      reply.send({ ...errEnvelope(ErrorCode.VALIDATION_FAILED, 'Shortcut bindings conflict', req.id), details: { conflicts } });
      return;
    }
    const run = queue.then(() => store.setItem(STORE_KEY, JSON.stringify(preferences)));
    queue = run.catch(() => undefined);
    await run;
    reply.send(okEnvelope(response(preferences, req.query.platform), req.id));
  });
  app.put(put.path, put.options, put.handler);
  const reset = defineRoute({
    method: 'POST', path: '/gui/shortcuts/reset', querystring: shortcutReadQuerySchema, body: shortcutResetSchema,
    success: { data: shortcutResponseSchema }, errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Reset all overrides, one platform, or one action to shipped defaults. Conflicting partial resets do not write.', tags: ['gui-store'],
  }, async (req, reply) => {
    const run = queue.then(async () => {
      const preferences = req.body.platform === undefined && req.body.action === undefined ?
        shortcutPreferencesSchema.parse(DEFAULT_SHORTCUT_PREFERENCES) : resetShortcutPreferences(await read(req), req.body.platform, req.body.action);
      const conflicts = shortcutPlatformSchema.options.flatMap((platform) => detectShortcutConflicts(preferences, platform));
      if (conflicts.length === 0) await store.setItem(STORE_KEY, JSON.stringify(preferences));
      return { preferences, conflicts };
    });
    queue = run.catch(() => undefined);
    const { preferences, conflicts } = await run;
    if (conflicts.length > 0) {
      reply.send({ ...errEnvelope(ErrorCode.VALIDATION_FAILED, 'Shortcut reset would conflict', req.id), details: { conflicts } });
      return;
    }
    reply.send(okEnvelope(response(preferences, req.query.platform), req.id));
  });
  app.post(reset.path, reset.options, reset.handler);
}
