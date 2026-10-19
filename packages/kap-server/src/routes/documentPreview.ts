import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  Error2,
  ErrorCodes,
  IFileService,
  IRuntimeResolver,
  ISessionContext,
  ISessionWorkspaceContext,
  IPluginHostService,
  IPluginSettingsService,
  IPluginService,
  type Scope,
} from '@kiki/agent-core-v2';
import { ISessionMediaStore } from '@kiki/agent-core-v2/agent/media/sessionMediaStore';
import { IHostProcessService } from '@kiki/agent-core-v2/os/interface/hostProcess';
import type { DocumentPreviewRequest, DocumentPreviewResponse } from '@kiki/protocol';
import {
  documentPreviewAssetParamsSchema,
  documentPreviewRequestSchema,
  documentPreviewResponseSchema,
} from '@kiki/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { acquireSessionOperation } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { withReplyCloseSignal } from '../procedures/requestSignal';
import {
  officePageCount,
  officeScreenshotArgs,
  officeSheetNames,
  runOfficeCli,
} from '../services/documentPreview/officeCliPreview';
import {
  DocumentPreviewDependencyError,
  DocumentPreviewRequestError,
  DocumentPreviewService,
  type DocumentPreviewEngineResponse,
  type DocumentPreviewFile,
  type OfficePreviewRequest,
  type OfficePreviewResult,
} from '../services/documentPreview/documentPreviewService';

interface DocumentPreviewRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (...args: never[]) => unknown,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (...args: never[]) => unknown,
  ): unknown;
}

interface PreviewReply {
  readonly raw: {
    readonly writableFinished?: boolean;
    once(event: 'close', listener: () => void): unknown;
    off(event: 'close', listener: () => void): unknown;
  };
  type(mime: string): PreviewReply;
  header(name: string, value: string | number): PreviewReply;
  code(status: number): PreviewReply;
  send(payload: unknown): unknown;
}

interface PreviewRequest {
  readonly id: string;
  readonly params: { readonly session_id: string; readonly asset_id?: string };
  readonly body: DocumentPreviewRequest;
}

interface AssetRequest {
  readonly id: string;
  readonly params: { readonly session_id: string; readonly asset_id: string };
}

interface OpenedPreviewFile {
  readonly sessionExists: boolean;
  readonly file?: DocumentPreviewFile;
  readonly dispose: () => void | Promise<void>;
}

const MAX_OFFICE_PNG_BYTES = 8 * 1024 * 1024;
const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function registerDocumentPreviewRoutes(app: DocumentPreviewRouteHost, core: Scope): void {
  let pluginHost: IPluginHostService | undefined;
  try {
    pluginHost = core.accessor.get(IPluginHostService);
  } catch {
    pluginHost = undefined;
  }
  const host = pluginHost;
  const renderOfficeAdapter = host === undefined
    ? undefined
    : async (request: OfficePreviewRequest) => {
      const pluginState = await officePluginState(core);
      if (pluginState !== 'enabled') {
        throw new DocumentPreviewDependencyError(
          'officecli',
          pluginState === 'disabled' ? 'The kiki-office plugin is disabled.' : 'The kiki-office plugin is not installed.',
          pluginState,
        );
      }
      return renderOfficeDocument(core, request);
    };
  const service = new DocumentPreviewService({ renderOffice: renderOfficeAdapter });

  const previewRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/document-preview',
      params: z.object({ session_id: z.string().min(1) }).strict(),
      body: documentPreviewRequestSchema,
      success: { data: documentPreviewResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FILE_NOT_FOUND]: {},
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PERMISSION_DENIED]: {},
        [ErrorCode.FS_PATH_ESCAPES_SESSION]: {},
      },
      description: 'Render one bounded, read-only document preview page, sheet, or text window.',
      tags: ['files'],
      operationId: 'documentPreview',
    },
    async (req, reply) => {
      const typedReq = req as unknown as PreviewRequest;
      const typedReply = reply as unknown as PreviewReply;
      const opened = await openPreviewFile(core, typedReq.params.session_id, typedReq.body);
      if (!opened.sessionExists) {
        typedReply.code(404).send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'session not found', typedReq.id));
        return;
      }
      if (opened.file === undefined) {
        await opened.dispose();
        typedReply.code(404).send(errEnvelope(ErrorCode.FILE_NOT_FOUND, 'file not found', typedReq.id));
        return;
      }
      try {
        const result = await withReplyCloseSignal(typedReply as unknown as Parameters<typeof withReplyCloseSignal>[0], (signal) => service.preview(
          typedReq.params.session_id,
          opened.file!,
          {
            page: typedReq.body.page,
            sheet: typedReq.body.sheet,
            range: typedReq.body.range,
            offset: typedReq.body.offset,
            maxBytes: typedReq.body.max_bytes,
          },
          signal,
        ));
        typedReply.send(okEnvelope(toWireResponse(result, typedReq.params.session_id), typedReq.id));
      } catch (error) {
        sendPreviewError(typedReply, typedReq.id, opened.file, error);
      } finally {
        await opened.dispose();
      }
    },
  );
  app.post(previewRoute.path, previewRoute.options, previewRoute.handler);

  const assetRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/document-preview/assets/{asset_id}',
      params: documentPreviewAssetParamsSchema,
      rawResponse: { 200: { type: 'string', format: 'binary' } },
      errors: { [ErrorCode.FILE_NOT_FOUND]: {} },
      description: 'Load one short-lived source-generated document preview asset.',
      tags: ['files'],
      operationId: 'documentPreviewAsset',
    },
    async (req, reply) => {
      const typedReq = req as unknown as AssetRequest;
      const typedReply = reply as unknown as PreviewReply;
      const asset = service.readAsset(typedReq.params.session_id, typedReq.params.asset_id);
      if (asset === undefined) {
        typedReply.code(404).send(errEnvelope(ErrorCode.FILE_NOT_FOUND, 'preview asset not found or expired', typedReq.id));
        return;
      }
      typedReply
        .type(asset.mime)
        .header('content-length', asset.bytes.byteLength)
        .header('cache-control', 'private, max-age=600, immutable')
        .code(200)
        .send(Buffer.from(asset.bytes));
    },
  );
  app.get(assetRoute.path, assetRoute.options, assetRoute.handler);
}

async function officePluginState(core: Scope): Promise<'not-installed' | 'disabled' | 'enabled'> {
  try {
    const plugin = (await core.accessor.get(IPluginService).listPlugins()).find((item) => item.id.toLowerCase() === 'kiki-office');
    if (plugin === undefined) return 'not-installed';
    return plugin.enabled && plugin.state === 'ok' ? 'enabled' : 'disabled';
  } catch {
    return 'not-installed';
  }
}

export async function renderOfficeDocument(core: Scope, request: OfficePreviewRequest): Promise<OfficePreviewResult> {
  const extension = request.path.toLowerCase().split('.').at(-1) ?? '';
  const binary = await resolveOfficeBinary(core);
  const processes = core.accessor.get(IHostProcessService);
  const out = join(dirname(request.path), 'preview.png');
  let sheets: readonly string[] | undefined;
  let pageCount: number | undefined;
  if (extension === 'xlsx') {
    const outline = await runOfficeCli(binary, ['view', request.path, 'outline', '--max-lines', '200'], request.signal, 15_000, processes);
    if (outline.spawnError === 'ENOENT') throw missingOfficeBinary();
    if (outline.code === 0) sheets = officeSheetNames(outline.stdout);
  } else {
    const stats = await runOfficeCli(binary, ['view', request.path, 'stats', '--json'], request.signal, 15_000, processes);
    if (stats.spawnError === 'ENOENT') throw missingOfficeBinary();
    if (stats.code === 0) pageCount = officePageCount(stats.stdout, extension);
    if (pageCount !== undefined && request.page > pageCount) {
      throw new DocumentPreviewRequestError('page_out_of_range', `Page ${request.page} is outside 1-${pageCount}.`);
    }
  }
  const range = extension === 'xlsx' ? sheetRange(request.sheet, request.range) : undefined;
  const rendered = await runOfficeCli(binary, officeScreenshotArgs({
    path: request.path,
    out,
    extension,
    page: request.page,
    range,
  }), request.signal, 60_000, processes);
  if (rendered.spawnError === 'ENOENT') throw missingOfficeBinary();
  if (request.signal.aborted) throw request.signal.reason instanceof Error ? request.signal.reason : new Error('Document preview cancelled');
  if (rendered.code !== 0) {
    throw new DocumentPreviewRequestError('invalid_render', clip(rendered.stderr || rendered.stdout || 'The document page could not be rendered.'));
  }
  const info = await stat(out);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_OFFICE_PNG_BYTES) {
    throw new DocumentPreviewRequestError('invalid_render', 'The document page could not be rendered.');
  }
  const bytes = new Uint8Array(await readFile(out));
  if (!hasPrefix(bytes, PNG_MAGIC)) throw new DocumentPreviewRequestError('invalid_render', 'The document page could not be rendered.');
  return {
    bytes,
    mime: 'image/png',
    page: extension === 'xlsx' ? undefined : request.page,
    pageCount,
    sheet: request.sheet ?? sheets?.[0],
    sheets,
    sheetCount: sheets?.length,
  };
}

async function resolveOfficeBinary(core: Scope): Promise<string> {
  const fallback = process.platform === 'win32' ? 'officecli.exe' : 'officecli';
  try {
    const values = await core.accessor.get(IPluginSettingsService).forExecution('kiki-office');
    const configured = values['officecliPath'];
    if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim();
  } catch {
    return fallback;
  }
  return fallback;
}

function missingOfficeBinary(): DocumentPreviewDependencyError {
  return new DocumentPreviewDependencyError('officecli', 'OfficeCLI is not installed.', 'enabled');
}

function sheetRange(sheet: string | undefined, range: string | undefined): string {
  if (sheet === undefined) return range ?? 'A1:Z50';
  if (range === undefined) return `${sheet}!A1:Z50`;
  return range.includes('!') ? range : `${sheet}!${range}`;
}

function clip(value: string): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length > 0 ? text.slice(0, 400) : 'The document page could not be rendered.';
}

function hasPrefix(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.byteLength < prefix.byteLength) return false;
  for (let index = 0; index < prefix.byteLength; index += 1) if (bytes[index] !== prefix[index]) return false;
  return true;
}

export function toWireResponse(value: DocumentPreviewEngineResponse, sessionId: string): DocumentPreviewResponse {
  if (value.kind === 'ready') {
    return {
      kind: 'ready',
      format: value.format,
      fidelity: value.fidelity,
      renderer: value.renderer,
      source: {
        kind: value.source.kind,
        name: value.source.name,
        media_type: value.source.mediaType,
        size: value.source.size,
      },
      navigation: value.navigation.kind === 'page'
        ? { kind: 'page', page: value.navigation.page, page_count: value.navigation.pageCount }
        : {
            kind: 'sheet',
            sheet: value.navigation.sheet,
            sheets: value.navigation.sheets === undefined || value.navigation.sheets.length === 0 ? undefined : [...value.navigation.sheets],
            sheet_index: value.navigation.sheetIndex !== undefined && value.navigation.sheetIndex > 0 ? value.navigation.sheetIndex : undefined,
            sheet_count: value.navigation.sheetCount !== undefined && value.navigation.sheetCount > 0 ? value.navigation.sheetCount : undefined,
          },
      assets: value.assets.map((asset) => ({
        asset_id: asset.assetId,
        mime: asset.mime,
        width: asset.width,
        height: asset.height,
        url: `/api/sessions/${encodeURIComponent(sessionId)}/document-preview/assets/${encodeURIComponent(asset.assetId)}`,
      })),
      read_only: true,
    };
  }
  if (value.kind === 'text') {
    return {
      kind: 'text', format: value.format, fidelity: value.fidelity,
      source: { kind: value.source.kind, name: value.source.name, media_type: value.source.mediaType, size: value.source.size },
      encoding: value.encoding, content: value.content, offset: value.offset, next_offset: value.nextOffset,
      truncated: value.truncated, total_bytes: value.totalBytes, read_only: true,
    };
  }
  if (value.kind === 'unsupported') {
    return {
      kind: 'unsupported', format: value.format,
      source: { kind: value.source.kind, name: value.source.name, media_type: value.source.mediaType, size: value.source.size },
      reason: value.reason, recovery: { kind: 'download-original' }, read_only: true,
    };
  }
  return {
    kind: 'missing_dependency', dependency: value.dependency,
    source: { kind: value.source.kind, name: value.source.name, media_type: value.source.mediaType, size: value.source.size },
    message: value.message,
    recovery: { kind: 'install-prerequisite', plugin_id: value.recovery.pluginId, prerequisite_id: value.recovery.prerequisiteId, consent_required: true, plugin_state: value.recovery.pluginState },
    read_only: true,
  };
}

function sendPreviewError(reply: PreviewReply, requestId: string, file: DocumentPreviewFile, error: unknown): void {
  if (error instanceof DocumentPreviewDependencyError) {
    reply.send(okEnvelope(toWireResponse({
      kind: 'missing_dependency', dependency: error.dependency,
      source: { kind: file.sourceKind, name: file.name, mediaType: file.mediaType, size: file.size },
      message: error.message,
      recovery: { kind: 'install-prerequisite', pluginId: 'kiki-office', prerequisiteId: 'officecli', consentRequired: true, pluginState: error.pluginState },
      readOnly: true,
    }, ''), requestId));
    return;
  }
  if (error instanceof DocumentPreviewRequestError) {
    reply.code(400).send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, requestId));
    return;
  }
  if (error instanceof Error2) {
    const code = error.code === ErrorCodes.OS_FS_PERMISSION_DENIED ? ErrorCode.FS_PERMISSION_DENIED :
      error.code === ErrorCodes.OS_FS_NOT_FOUND ? ErrorCode.FS_PATH_NOT_FOUND : ErrorCode.INTERNAL_ERROR;
    reply.code(code === ErrorCode.INTERNAL_ERROR ? 500 : 400).send(errEnvelope(code, error.message, requestId));
    return;
  }
  reply.code(500).send(errEnvelope(ErrorCode.INTERNAL_ERROR, error instanceof Error ? error.message : 'document preview failed', requestId));
}

async function settleReleases(releases: readonly (() => void | Promise<void>)[]): Promise<void> {
  const settled = await Promise.allSettled(releases.map((release) => Promise.resolve(release())));
  const errors = settled.flatMap((item) => item.status === 'rejected' ? [item.reason] : []);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'document preview release failed');
}

async function openPreviewFile(core: Scope, sessionId: string, request: DocumentPreviewRequest): Promise<OpenedPreviewFile> {
  const operation = await acquireSessionOperation(core, sessionId, 'document-preview');
  if (operation.handle === undefined) return { sessionExists: false, dispose: () => operation.dispose() };
  if (request.source.kind === 'session-media') {
    const opened = await operation.handle.accessor.get(ISessionMediaStore).open(request.source.file_id);
    if (opened !== undefined) return { sessionExists: true, file: { ...opened, sourceKind: 'session-media', name: request.source.name ?? opened.name, mediaType: request.source.media_type ?? opened.mediaType }, dispose: () => operation.dispose() };
    try {
      const uploaded = await core.accessor.get(IFileService).get(request.source.file_id);
      return {
        sessionExists: true,
        file: {
          sourceKind: 'session-media', name: request.source.name ?? uploaded.meta.name,
          mediaType: request.source.media_type ?? uploaded.meta.media_type, size: uploaded.meta.size,
          stream: async function* (range) { for await (const chunk of uploaded.stream(range)) yield chunk as Uint8Array; },
        },
        dispose: () => operation.dispose(),
      };
    } catch {
      await operation.dispose();
      return { sessionExists: true, dispose: () => {} };
    }
  }

  const context = operation.handle.accessor.get(ISessionContext);
  const workspace = operation.handle.accessor.get(ISessionWorkspaceContext);
  const runtimeId = request.source.runtime_id ?? 'local';
  const lease = core.accessor.get(IRuntimeResolver).acquire({ workspaceId: context.workspaceId, runtimeId }, ['fs']);
  try {
    const runtime = lease.runtime;
    const fs = runtime.fs;
    if (fs === undefined) throw new Error(`runtime ${runtimeId} has no filesystem capability`);
    const mapped = runtime.workspace.mapRoots({ workDir: workspace.workDir, additionalDirs: workspace.additionalDirs });
    const candidate = runtime.path.isAbsolute(request.source.path)
      ? runtime.path.resolve(request.source.path)
      : runtime.path.resolve(mapped.workDir, request.source.path);
    const resolved = await fs.realpath(candidate);
    if (!within(runtime, mapped, resolved)) {
      throw new Error2(ErrorCodes.OS_FS_PERMISSION_DENIED, `path escapes the session workspace: ${request.source.path}`);
    }
    const stat = await fs.stat(resolved);
    if (!stat.isFile) throw new Error2(ErrorCodes.OS_FS_NOT_FOUND, `not a regular file: ${request.source.path}`);
    const name = basename(resolved);
    const mediaType = mimeOf(name);
    return {
      sessionExists: true,
      file: {
        sourceKind: 'workspace', name, mediaType, size: stat.size,
        stream: async function* (range) {
          let offset = range?.start ?? 0;
          let remaining = range === undefined ? stat.size : range.end - range.start + 1;
          while (remaining > 0) {
            const chunk = await fs.readBytes(resolved, Math.min(64 * 1024, remaining), offset);
            if (chunk.byteLength === 0) break;
            yield chunk;
            offset += chunk.byteLength;
            remaining -= chunk.byteLength;
          }
        },
      },
      dispose: () => settleReleases([() => lease.dispose(), () => operation.dispose()]),
    };
  } catch (error) {
    try {
      await settleReleases([() => lease.dispose(), () => operation.dispose()]);
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], 'document preview release failed', { cause: error });
    }
    throw error;
  }
}

function within(runtime: { readonly path: { resolve(path: string): string; relative(from: string, to: string): string; isAbsolute(path: string): boolean } }, roots: { readonly workDir: string; readonly additionalDirs?: readonly string[] }, target: string): boolean {
  return [roots.workDir, ...(roots.additionalDirs ?? [])].some((root) => {
    const rel = runtime.path.relative(runtime.path.resolve(root), target);
    return rel === '' || (!rel.startsWith('..') && !runtime.path.isAbsolute(rel));
  });
}

function mimeOf(name: string): string {
  const extension = name.toLowerCase().split('.').at(-1) ?? '';
  const values: Record<string, string> = {
    pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  };
  return values[extension] ?? 'application/octet-stream';
}
