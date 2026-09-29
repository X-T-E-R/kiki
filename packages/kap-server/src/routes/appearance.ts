import { lookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';

import {
  APPEARANCE_LIMITS,
  APPEARANCE_PACK_ID_PATTERN,
  APPEARANCE_PACK_MANIFEST,
  appearancePackFiles,
  appearancePackFileParamSchema,
  appearancePackIdParamSchema,
  backgroundMediaTypeOf,
  fetchAppearanceMediaBodySchema,
  getAppearancePackResponseSchema,
  installAppearancePackQuerySchema,
  installAppearancePackResponseSchema,
  listAppearancePacksResponseSchema,
  mediaTypeMatches,
  parseAppearancePack,
  sniffBackgroundMediaType,
  type AppearancePack,
  type AppearancePackSummary,
} from '@kiki/protocol';
import type { Scope } from '@kiki/agent-core-v2';
import { z } from 'zod';

import { buildStoredZip } from '../lib/storedZip';
import { parseRangeHeader, pickHeader } from '../lib/httpRange';
import { ZipReadError, readZipEntries, type ZipFileEntry } from '../lib/zipReader';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { errEnvelope, okEnvelope } from '../protocol/envelope';
import { classify } from '../security/bindClassify';

interface AppearanceRequest {
  readonly id: string;
  readonly body: unknown;
  readonly params: unknown;
  readonly query: unknown;
  readonly headers: Record<string, unknown>;
}

interface AppearanceReply {
  type(mime: string): AppearanceReply;
  header(name: string, value: string | number): AppearanceReply;
  code(status: number): AppearanceReply;
  send(payload: unknown): unknown;
}

type AppearanceHandler = (req: AppearanceRequest, reply: AppearanceReply) => unknown;
type RouteOptions = { preHandler: unknown[]; schema?: Record<string, unknown>; bodyLimit?: number };

interface AppearanceScopedHost {
  get(path: string, options: RouteOptions, handler: AppearanceHandler): unknown;
  post(path: string, options: RouteOptions, handler: AppearanceHandler): unknown;
  delete(path: string, options: RouteOptions, handler: AppearanceHandler): unknown;
  addContentTypeParser(
    contentType: string | string[],
    options: { parseAs: 'buffer'; bodyLimit: number },
    parser: (req: unknown, body: Buffer, done: (err: Error | null, body?: unknown) => void) => void,
  ): unknown;
}

interface AppearanceRouteHost {
  register(plugin: (scoped: AppearanceScopedHost) => Promise<void>): unknown;
}

/** Where appearance packs live: `<homeDir>/themes`, the directory skin files share. */
export interface AppearanceRouteOptions {
  readonly themesDir: string;
  /** Test seam for the URL importer; production resolves through DNS. */
  readonly resolveHost?: (host: string) => Promise<readonly string[]>;
  /** Test seam for the URL importer; production uses global fetch. */
  readonly fetchImpl?: typeof fetch;
}

class PackError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const ZIP_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
const MAX_REDIRECTS = 3;

function maxBytesFor(mime: string): number {
  return mime.startsWith('video/') ? APPEARANCE_LIMITS.videoBytes : APPEARANCE_LIMITS.imageBytes;
}

function variantsOf(pack: AppearancePack): ('light' | 'dark')[] {
  const variants: ('light' | 'dark')[] = [];
  if (pack.variants.light !== undefined) variants.push('light');
  if (pack.variants.dark !== undefined) variants.push('dark');
  return variants;
}

function summaryOf(pack: AppearancePack, bytes: number): AppearancePackSummary {
  const variants = [pack.variants.light, pack.variants.dark];
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    author: pack.author,
    license: pack.license,
    variants: variantsOf(pack),
    hasSkin: variants.some((v) => v?.colors !== undefined || v?.fonts !== undefined || v?.shape !== undefined),
    hasVideo: variants.some((v) => (v?.background?.media ?? []).some((file) => backgroundMediaTypeOf(file)?.kind === 'video')),
    bytes,
  };
}

async function readPackDir(dir: string): Promise<{ pack: AppearancePack; bytes: number }> {
  const raw = await readFile(join(dir, APPEARANCE_PACK_MANIFEST), 'utf-8');
  if (raw.length > APPEARANCE_LIMITS.manifestBytes) throw new PackError(ErrorCode.VALIDATION_FAILED, 'manifest too large');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PackError(ErrorCode.VALIDATION_FAILED, 'manifest is not valid JSON');
  }
  const parsed = parseAppearancePack(json);
  if (parsed.pack === null) throw new PackError(ErrorCode.VALIDATION_FAILED, parsed.warnings[0] ?? 'invalid manifest');
  let bytes = raw.length;
  for (const file of appearancePackFiles(parsed.pack)) {
    const info = await stat(join(dir, file)).catch(() => undefined);
    if (info === undefined || !info.isFile()) throw new PackError(ErrorCode.VALIDATION_FAILED, `missing file: ${file}`);
    bytes += info.size;
  }
  return { pack: parsed.pack, bytes };
}
function checkMedia(name: string, data: Uint8Array): string {
  const declared = backgroundMediaTypeOf(name);
  if (declared === null) throw new PackError(ErrorCode.VALIDATION_FAILED, `${name}: file type not allowed`);
  if (data.byteLength > maxBytesFor(declared.mime)) throw new PackError(ErrorCode.FILE_TOO_LARGE, `${name}: file is too large`);
  if (!mediaTypeMatches(declared.mime, sniffBackgroundMediaType(data.subarray(0, 32)))) {
    throw new PackError(ErrorCode.VALIDATION_FAILED, `${name}: contents do not match the extension`);
  }
  return declared.mime;
}

function stripSingleRoot(entries: ZipFileEntry[]): ZipFileEntry[] {
  if (entries.some((entry) => entry.name === APPEARANCE_PACK_MANIFEST)) return entries;
  const roots = new Set(entries.map((entry) => entry.name.split('/')[0]));
  if (roots.size !== 1) return entries;
  const root = `${[...roots][0]}/`;
  return entries.map((entry) => ({ name: entry.name.startsWith(root) ? entry.name.slice(root.length) : entry.name, data: entry.data }));
}

/**
 * Validate a pack archive completely in memory. Only the manifest and the
 * files it names are kept; any other entry (a script, a stylesheet, a nested
 * folder) refuses the archive, so what installs is exactly what was declared.
 */
export function validatePackArchive(buffer: Buffer): { pack: AppearancePack; files: ZipFileEntry[] } {
  let entries: ZipFileEntry[];
  try {
    entries = stripSingleRoot(readZipEntries(buffer, {
      maxEntries: APPEARANCE_LIMITS.packFiles,
      maxTotalBytes: APPEARANCE_LIMITS.packBytes,
      maxEntryBytes: (name) => {
        const type = backgroundMediaTypeOf(name);
        return type === null ? APPEARANCE_LIMITS.manifestBytes : maxBytesFor(type.mime);
      },
    }));
  } catch (error) {
    throw new PackError(
      error instanceof ZipReadError && error.message.includes('too large') ? ErrorCode.FILE_TOO_LARGE : ErrorCode.VALIDATION_FAILED,
      error instanceof Error ? error.message : 'unreadable archive',
    );
  }
  const manifest = entries.find((entry) => entry.name === APPEARANCE_PACK_MANIFEST);
  if (manifest === undefined) throw new PackError(ErrorCode.VALIDATION_FAILED, `archive has no ${APPEARANCE_PACK_MANIFEST}`);
  let json: unknown;
  try {
    json = JSON.parse(manifest.data.toString('utf-8'));
  } catch {
    throw new PackError(ErrorCode.VALIDATION_FAILED, 'manifest is not valid JSON');
  }
  const parsed = parseAppearancePack(json);
  if (parsed.pack === null) throw new PackError(ErrorCode.VALIDATION_FAILED, parsed.warnings[0] ?? 'invalid manifest');
  const declared = new Set(appearancePackFiles(parsed.pack));
  const files: ZipFileEntry[] = [];
  for (const entry of entries) {
    if (entry.name === APPEARANCE_PACK_MANIFEST) continue;
    if (!declared.has(entry.name)) throw new PackError(ErrorCode.VALIDATION_FAILED, `${entry.name}: not referenced by the manifest`);
    checkMedia(entry.name, entry.data);
    files.push(entry);
    declared.delete(entry.name);
  }
  const missing = [...declared][0];
  if (missing !== undefined) throw new PackError(ErrorCode.VALIDATION_FAILED, `missing file: ${missing}`);
  return { pack: parsed.pack, files: [manifest, ...files] };
}

function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  if (classify(address) !== 'public') return false;
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 100 && b !== undefined && b >= 64 && b <= 127 || a !== undefined && a >= 224) return false;
    return true;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPublicAddress(lower.slice(7));
  return !(lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff'));
}

async function defaultResolveHost(host: string): Promise<readonly string[]> {
  return (await lookup(host, { all: true })).map((entry) => entry.address);
}

/**
 * Fetch one remote background under the media policy: https only, every hop
 * resolved and refused unless all its addresses are public, no credentials
 * sent, the declared and streamed size capped, and the bytes type-sniffed.
 */
export async function fetchRemoteMedia(
  url: string,
  resolveHost: (host: string) => Promise<readonly string[]> = defaultResolveHost,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Buffer; mime: string; name: string }> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== 'https:') throw new PackError(ErrorCode.VALIDATION_FAILED, 'only https URLs can be imported');
    if (current.username !== '' || current.password !== '') throw new PackError(ErrorCode.VALIDATION_FAILED, 'URLs with credentials are refused');
    const host = current.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) !== 0 ? [host] : await resolveHost(host).catch(() => []);
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
      throw new PackError(ErrorCode.VALIDATION_FAILED, 'the address is not on the public internet');
    }
    const response = await fetchImpl(current, {
      redirect: 'manual',
      credentials: 'omit',
      headers: { accept: 'image/*,video/*' },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) throw new PackError(ErrorCode.VALIDATION_FAILED, 'redirect without a location');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || response.body === null) throw new PackError(ErrorCode.FS_PATH_NOT_FOUND, `the server answered ${response.status}`);
    const declaredType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const limit = maxBytesFor(declaredType.startsWith('video/') ? 'video/' : 'image/');
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > limit) throw new PackError(ErrorCode.FILE_TOO_LARGE, 'the file is too large');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > limit) throw new PackError(ErrorCode.FILE_TOO_LARGE, 'the file is too large');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const mime = sniffBackgroundMediaType(bytes.subarray(0, 32));
    if (mime === null) throw new PackError(ErrorCode.VALIDATION_FAILED, 'not a supported image or video');
    if (bytes.byteLength > maxBytesFor(mime)) throw new PackError(ErrorCode.FILE_TOO_LARGE, 'the file is too large');
    const name = decodeURIComponent(current.pathname.split('/').at(-1) ?? '') || 'background';
    return { bytes, mime, name: name.slice(0, 200) };
  }
  throw new PackError(ErrorCode.VALIDATION_FAILED, 'too many redirects');
}
async function listPacks(themesDir: string): Promise<z.infer<typeof listAppearancePacksResponseSchema>> {
  const items: AppearancePackSummary[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const entries = await readdir(themesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((item) => item.isDirectory()).map((item) => item.name).sort()) {
    if (!APPEARANCE_PACK_ID_PATTERN.test(entry)) continue;
    const dir = join(themesDir, entry);
    if ((await stat(join(dir, APPEARANCE_PACK_MANIFEST)).catch(() => undefined)) === undefined) continue;
    try {
      const { pack, bytes } = await readPackDir(dir);
      if (pack.id !== entry) {
        skipped.push({ file: `${entry}/`, reason: `manifest id "${pack.id}" does not match the folder name` });
        continue;
      }
      items.push(summaryOf(pack, bytes));
    } catch (error) {
      skipped.push({ file: `${entry}/`, reason: error instanceof Error ? error.message : 'unreadable' });
    }
  }
  return { items, directory: themesDir, skipped };
}

async function installPack(themesDir: string, buffer: Buffer, replace: boolean): Promise<{ pack: AppearancePackSummary; replaced: boolean }> {
  const { pack, files } = validatePackArchive(buffer);
  const target = join(themesDir, pack.id);
  const exists = (await stat(target).catch(() => undefined)) !== undefined;
  if (exists && !replace) throw new PackError(ErrorCode.FS_ALREADY_EXISTS, `a pack named "${pack.id}" is already installed`);
  await mkdir(themesDir, { recursive: true });
  const staging = join(themesDir, `.install-${randomBytes(6).toString('hex')}`);
  await mkdir(staging);
  try {
    for (const file of files) await writeFile(join(staging, file.name), file.data);
    if (exists) await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  const bytes = files.reduce((sum, file) => sum + file.data.byteLength, 0);
  return { pack: summaryOf(pack, bytes), replaced: exists };
}

function sendError(reply: AppearanceReply, req: AppearanceRequest, error: unknown): void {
  if (error instanceof PackError) {
    reply.send(errEnvelope(error.code, error.message, req.id));
    return;
  }
  if ((error as { code?: unknown }).code === 'ENOENT') {
    reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, 'appearance pack not found', req.id));
    return;
  }
  reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, error instanceof Error ? error.message : 'appearance request failed', req.id));
}
/**
 * Register the appearance-pack and background-import routes. The zip body
 * parser is scoped to this plugin, so no other route starts accepting
 * archives.
 */
export function registerAppearanceRoutes(app: AppearanceRouteHost, _core: Scope, opts: AppearanceRouteOptions): void {
  const { themesDir } = opts;
  app.register(async (scoped) => {
    scoped.addContentTypeParser(ZIP_TYPES, { parseAs: 'buffer', bodyLimit: APPEARANCE_LIMITS.packBytes }, (_req, body, done) => {
      done(null, body);
    });

    const list = defineRoute(
      {
        method: 'GET',
        path: '/appearance/packs',
        success: { data: listAppearancePacksResponseSchema },
        description: 'List installed appearance packs (folders holding kiki-pack.json in the themes directory).',
        tags: ['skins'],
      },
      async (req, reply) => {
        reply.send(okEnvelope(await listPacks(themesDir), req.id));
      },
    );
    scoped.get(list.path, list.options, list.handler as unknown as AppearanceHandler);

    const get = defineRoute(
      {
        method: 'GET',
        path: '/appearance/packs/{pack_id}',
        params: appearancePackIdParamSchema,
        success: { data: getAppearancePackResponseSchema },
        errors: { [ErrorCode.FS_PATH_NOT_FOUND]: {}, [ErrorCode.VALIDATION_FAILED]: {} },
        description: 'Read one installed appearance pack manifest.',
        tags: ['skins'],
      },
      async (req, reply) => {
        const { pack_id: packId } = req.params;
        try {
          const { pack, bytes } = await readPackDir(join(themesDir, packId));
          reply.send(okEnvelope({ pack, bytes }, req.id));
        } catch (error) {
          sendError(reply as unknown as AppearanceReply, req as unknown as AppearanceRequest, error);
        }
      },
    );
    scoped.get(get.path, get.options, get.handler as unknown as AppearanceHandler);

    const file = defineRoute(
      {
        method: 'GET',
        path: '/appearance/packs/{pack_id}/files/{file}',
        params: appearancePackFileParamSchema,
        rawResponse: { 200: { type: 'string', format: 'binary' }, 206: { type: 'string', format: 'binary' } },
        description: 'Download one media file an installed pack declares. Files the manifest does not name are never served.',
        tags: ['skins'],
      },
      async (req, reply) => {
        const r = reply as unknown as AppearanceReply;
        const { pack_id: packId, file: name } = req.params;
        try {
          const dir = join(themesDir, packId);
          const { pack } = await readPackDir(dir);
          const mime = backgroundMediaTypeOf(name)?.mime;
          if (!appearancePackFiles(pack).includes(name) || mime === undefined) {
            throw new PackError(ErrorCode.FS_PATH_NOT_FOUND, 'file not found');
          }
          const data = await readFile(join(dir, name));
          const etag = `"${packId}-${name}-${data.byteLength}"`;
          r.type(mime)
            .header('accept-ranges', 'bytes')
            .header('etag', etag)
            .header('cache-control', 'private, max-age=3600')
            .header('x-content-type-options', 'nosniff')
            .header('content-security-policy', "default-src 'none'; sandbox");
          if (pickHeader(req.headers, 'range') === undefined && pickHeader(req.headers, 'if-none-match') === etag) {
            r.code(304).send(null);
            return;
          }
          const range = parseRangeHeader(pickHeader(req.headers, 'range'), data.byteLength);
          if (range !== null) {
            r.header('content-range', `bytes ${range.start}-${range.end}/${data.byteLength}`).code(206).send(data.subarray(range.start, range.end + 1));
            return;
          }
          r.code(200).send(data);
        } catch (error) {
          r.code(404);
          sendError(r, req as unknown as AppearanceRequest, error);
        }
      },
    );
    scoped.get(file.path, file.options, file.handler as unknown as AppearanceHandler);
    const install = defineRoute(
      {
        method: 'POST',
        path: '/appearance/packs',
        querystring: installAppearancePackQuerySchema,
        success: { data: installAppearancePackResponseSchema },
        errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.FILE_TOO_LARGE]: {}, [ErrorCode.FS_ALREADY_EXISTS]: {} },
        consumes: ZIP_TYPES,
        description: 'Install an appearance pack from a zip body. The archive is validated in full before anything is written.',
        tags: ['skins'],
      },
      async (req, reply) => {
        const body = (req as unknown as AppearanceRequest).body;
        if (!Buffer.isBuffer(body)) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'send the pack as an application/zip body', req.id));
          return;
        }
        try {
          const replace = (req as unknown as { query: { replace?: string } }).query.replace === 'true';
          reply.send(okEnvelope(await installPack(themesDir, body, replace), req.id));
        } catch (error) {
          sendError(reply as unknown as AppearanceReply, req as unknown as AppearanceRequest, error);
        }
      },
    );
    scoped.post(install.path, { ...install.options, bodyLimit: APPEARANCE_LIMITS.packBytes }, install.handler as unknown as AppearanceHandler);

    const remove = defineRoute(
      {
        method: 'DELETE',
        path: '/appearance/packs/{pack_id}',
        params: appearancePackIdParamSchema,
        success: { data: z.object({ removed: z.boolean() }) },
        errors: { [ErrorCode.FS_PATH_NOT_FOUND]: {} },
        description: 'Delete an installed appearance pack folder. Only folders holding a pack manifest can be removed.',
        tags: ['skins'],
      },
      async (req, reply) => {
        const { pack_id: packId } = req.params;
        const dir = join(themesDir, packId);
        if ((await stat(join(dir, APPEARANCE_PACK_MANIFEST)).catch(() => undefined)) === undefined) {
          reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, 'appearance pack not found', req.id));
          return;
        }
        await rm(dir, { recursive: true, force: true });
        reply.send(okEnvelope({ removed: true }, req.id));
      },
    );
    scoped.delete(remove.path, remove.options, remove.handler as unknown as AppearanceHandler);

    const exportRoute = defineRoute(
      {
        method: 'GET',
        path: '/appearance/packs/{pack_id}/export',
        params: appearancePackIdParamSchema,
        rawResponse: { 200: { type: 'string', format: 'binary' } },
        description: 'Download an installed pack as a zip holding its manifest and declared files.',
        tags: ['skins'],
      },
      async (req, reply) => {
        const r = reply as unknown as AppearanceReply;
        const { pack_id: packId } = req.params;
        try {
          const dir = join(themesDir, packId);
          const { pack } = await readPackDir(dir);
          const names = [APPEARANCE_PACK_MANIFEST, ...appearancePackFiles(pack)];
          const entries = await Promise.all(names.map(async (name) => ({ name, data: await readFile(join(dir, name)) })));
          r.type('application/zip')
            .header('content-disposition', `attachment; filename="${packId}.kiki-pack.zip"`)
            .code(200)
            .send(buildStoredZip(entries));
        } catch (error) {
          r.code(404);
          sendError(r, req as unknown as AppearanceRequest, error);
        }
      },
    );
    scoped.get(exportRoute.path, exportRoute.options, exportRoute.handler as unknown as AppearanceHandler);

    const fetchRoute = defineRoute(
      {
        method: 'POST',
        path: '/appearance/fetch',
        body: fetchAppearanceMediaBodySchema,
        rawResponse: { 200: { type: 'string', format: 'binary' } },
        description: 'Import one background image or video from a public https URL. Returns the bytes; nothing is stored on the server.',
        tags: ['skins'],
      },
      async (req, reply) => {
        const r = reply as unknown as AppearanceReply;
        try {
          const { bytes, mime, name } = await fetchRemoteMedia(req.body.url, opts.resolveHost, opts.fetchImpl);
          r.type(mime)
            .header('x-kiki-media-name', encodeURIComponent(name))
            .header('x-content-type-options', 'nosniff')
            .code(200)
            .send(bytes);
        } catch (error) {
          r.code(422);
          sendError(r, req as unknown as AppearanceRequest, error);
        }
      },
    );
    scoped.post(fetchRoute.path, fetchRoute.options, fetchRoute.handler as unknown as AppearanceHandler);
  });
}
