import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type DocumentPreviewFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx';
export type DocumentPreviewRenderer = 'browser-pdf' | 'poppler' | 'officecli';
export type DocumentPreviewSourceKind = 'workspace' | 'session-media';

export interface DocumentPreviewFile {
  readonly sourceKind: DocumentPreviewSourceKind;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly stream: (range?: { readonly start: number; readonly end: number }) => AsyncIterable<Uint8Array>;
  readonly dispose?: () => void | Promise<void>;
}

export interface DocumentPreviewOptions {
  readonly page?: number;
  readonly sheet?: string;
  readonly range?: string;
  readonly offset?: number;
  readonly maxBytes?: number;
}

export interface DocumentPreviewSourceInfo {
  readonly kind: DocumentPreviewSourceKind;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
}

export interface DocumentPreviewAsset {
  readonly assetId: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width?: number;
  readonly height?: number;
}

export type DocumentPreviewEngineResponse =
  | {
      readonly kind: 'ready';
      readonly format: DocumentPreviewFormat;
      readonly fidelity: 'rendered';
      readonly renderer: DocumentPreviewRenderer;
      readonly source: DocumentPreviewSourceInfo;
      readonly navigation: {
        readonly kind: 'page';
        readonly page: number;
        readonly pageCount?: number;
      } | {
        readonly kind: 'sheet';
        readonly sheet?: string;
        readonly sheets?: readonly string[];
        readonly sheetIndex?: number;
        readonly sheetCount?: number;
      };
      readonly assets: readonly DocumentPreviewAsset[];
      readonly readOnly: true;
    }
  | {
      readonly kind: 'text';
      readonly format: 'text' | 'csv';
      readonly fidelity: 'source';
      readonly source: DocumentPreviewSourceInfo;
      readonly encoding: 'utf-8';
      readonly content: string;
      readonly offset: number;
      readonly nextOffset?: number;
      readonly truncated: boolean;
      readonly totalBytes: number;
      readonly readOnly: true;
    }
  | {
      readonly kind: 'unsupported';
      readonly format: string;
      readonly source: DocumentPreviewSourceInfo;
      readonly reason: 'format' | 'source_too_large' | 'remote_renderer_unavailable' | 'binary_content';
      readonly recovery: { readonly kind: 'download-original' };
      readonly readOnly: true;
    }
  | {
      readonly kind: 'missing_dependency';
      readonly dependency: 'officecli';
      readonly source: DocumentPreviewSourceInfo;
      readonly message: string;
      readonly recovery: {
        readonly kind: 'install-prerequisite';
        readonly pluginId: 'kiki-office';
        readonly prerequisiteId: 'officecli';
        readonly consentRequired: true;
        readonly pluginState: 'not-installed' | 'disabled' | 'enabled';
      };
      readonly readOnly: true;
    };

export interface OfficePreviewRequest {
  readonly path: string;
  readonly page: number;
  readonly sheet?: string;
  readonly range?: string;
  readonly signal: AbortSignal;
}

export interface OfficePreviewResult {
  readonly bytes: Uint8Array;
  readonly mime: 'image/png';
  readonly page?: number;
  readonly pageCount?: number;
  readonly sheet?: string;
  readonly sheets?: readonly string[];
  readonly sheetIndex?: number;
  readonly sheetCount?: number;
}

export interface DocumentPreviewServiceOptions {
  readonly renderOffice?: (request: OfficePreviewRequest) => Promise<OfficePreviewResult>;
  readonly pdftoppmPath?: string;
  readonly pdfinfoPath?: string;
  readonly assetTtlMs?: number;
  readonly assetByteBudget?: number;
}

export type DocumentPreviewPluginState = 'not-installed' | 'disabled' | 'enabled';

export class DocumentPreviewDependencyError extends Error {
  constructor(readonly dependency: 'officecli', message: string, readonly pluginState: DocumentPreviewPluginState = 'enabled') {
    super(message);
    this.name = 'DocumentPreviewDependencyError';
  }
}

export class DocumentPreviewRequestError extends Error {
  constructor(readonly reason: 'page_out_of_range' | 'empty_source' | 'invalid_render', message: string) {
    super(message);
    this.name = 'DocumentPreviewRequestError';
  }
}

interface AssetRecord {
  readonly sessionId: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width?: number;
  readonly height?: number;
  readonly expiresAt: number;
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'csv', 'tsv', 'json', 'jsonc', 'jsonl', 'xml', 'yml', 'yaml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'properties', 'lock', 'ts', 'tsx', 'js', 'jsx', 'mjs',
  'cjs', 'mts', 'cts', 'css', 'scss', 'less', 'html', 'htm', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs',
  'swift', 'kt', 'kts', 'm', 'mm', 'php', 'pl', 'pm', 'r', 'lua', 'sql', 'graphql',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'dockerfile', 'makefile', 'cmake',
  'mk', 'gradle',
]);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx', 'pptx']);
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const DEFAULT_TEXT_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_BROWSER_PDF_BYTES = 64 * 1024 * 1024;
const DEFAULT_ASSET_TTL_MS = 10 * 60_000;
const DEFAULT_ASSET_BYTE_BUDGET = 128 * 1024 * 1024;
const MAX_ASSETS = 256;
const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class DocumentPreviewService {
  private readonly assets = new Map<string, AssetRecord>();
  private assetBytes = 0;
  private readonly renderOffice?: (request: OfficePreviewRequest) => Promise<OfficePreviewResult>;
  private readonly pdftoppmPath: string;
  private readonly pdfinfoPath: string;
  private readonly assetTtlMs: number;
  private readonly assetByteBudget: number;

  constructor(options: DocumentPreviewServiceOptions = {}) {
    this.renderOffice = options.renderOffice;
    this.pdftoppmPath = options.pdftoppmPath ?? 'pdftoppm';
    this.pdfinfoPath = options.pdfinfoPath ?? 'pdfinfo';
    this.assetTtlMs = options.assetTtlMs ?? DEFAULT_ASSET_TTL_MS;
    this.assetByteBudget = options.assetByteBudget ?? DEFAULT_ASSET_BYTE_BUDGET;
    if (!Number.isSafeInteger(this.assetByteBudget) || this.assetByteBudget <= 0) {
      throw new Error('assetByteBudget must be a positive safe integer');
    }
  }

  async preview(
    sessionId: string,
    file: DocumentPreviewFile,
    options: DocumentPreviewOptions,
    signal: AbortSignal,
  ): Promise<DocumentPreviewEngineResponse> {
    signal.throwIfAborted();
    const source = sourceInfo(file);
    if (file.size === 0) throw new DocumentPreviewRequestError('empty_source', 'The selected file is empty.');

    const format = formatOf(file.name, file.mediaType);
    if (format === undefined) {
      const extension = extensionOf(file.name);
      if (TEXT_EXTENSIONS.has(extension) || /^text\//iu.test(file.mediaType) || file.mediaType === 'application/csv') {
        return this.previewText(file, source, extension === 'csv' || file.mediaType === 'text/csv', options, signal);
      }
      if (file.size > MAX_SOURCE_BYTES) {
        return { kind: 'unsupported', format: extension || 'binary', source, reason: 'source_too_large', recovery: { kind: 'download-original' }, readOnly: true };
      }
      return { kind: 'unsupported', format: extension || file.mediaType || 'binary', source, reason: 'format', recovery: { kind: 'download-original' }, readOnly: true };
    }

    if (file.size > MAX_SOURCE_BYTES) {
      return { kind: 'unsupported', format: extensionOf(file.name) || 'binary', source, reason: 'source_too_large', recovery: { kind: 'download-original' }, readOnly: true };
    }
    if (format === 'pdf') return this.previewPdf(sessionId, file, source, options, signal);
    if (this.renderOffice === undefined) {
      return {
        kind: 'missing_dependency',
        dependency: 'officecli',
        source,
        message: 'OfficeCLI is not enabled or installed for local document rendering.',
        recovery: { kind: 'install-prerequisite', pluginId: 'kiki-office', prerequisiteId: 'officecli', consentRequired: true, pluginState: 'not-installed' },
        readOnly: true,
      };
    }
    return this.previewOffice(sessionId, file, source, format, options, signal);
  }

  readAsset(sessionId: string, assetId: string): { readonly bytes: Uint8Array; readonly mime: string; readonly width?: number; readonly height?: number } | undefined {
    this.evictExpired();
    const record = this.assets.get(assetId);
    if (record === undefined || record.sessionId !== sessionId) return undefined;
    this.assets.delete(assetId);
    this.assets.set(assetId, record);
    return record;
  }

  private async previewText(
    file: DocumentPreviewFile,
    source: DocumentPreviewSourceInfo,
    csv: boolean,
    options: DocumentPreviewOptions,
    signal: AbortSignal,
  ): Promise<DocumentPreviewEngineResponse> {
    const offset = options.offset ?? 0;
    const maxBytes = Math.min(options.maxBytes ?? DEFAULT_TEXT_BYTES, MAX_TEXT_BYTES);
    if (offset >= file.size) {
      return { kind: 'text', format: csv ? 'csv' : 'text', fidelity: 'source', source, encoding: 'utf-8', content: '', offset, truncated: false, totalBytes: file.size, readOnly: true };
    }
    const requestedEnd = Math.min(file.size - 1, offset + maxBytes);
    const bytes = await collect(file.stream({ start: offset, end: requestedEnd }), maxBytes + 1, signal);
    const consumedBytes = utf8WindowLength(bytes, maxBytes);
    const consumedOffset = offset + consumedBytes;
    const truncated = consumedOffset < file.size;
    const contentBytes = bytes.subarray(0, consumedBytes);
    const content = new TextDecoder('utf-8', { fatal: false }).decode(contentBytes);
    if (containsBinary(contentBytes.subarray(0, Math.min(contentBytes.byteLength, 4096)))) {
      return { kind: 'unsupported', format: csv ? 'csv' : 'text', source, reason: 'binary_content', recovery: { kind: 'download-original' }, readOnly: true };
    }
    const nextOffset = truncated ? consumedOffset : undefined;
    return { kind: 'text', format: csv ? 'csv' : 'text', fidelity: 'source', source, encoding: 'utf-8', content, offset, nextOffset, truncated, totalBytes: file.size, readOnly: true };
  }

  private async previewPdf(
    sessionId: string,
    file: DocumentPreviewFile,
    source: DocumentPreviewSourceInfo,
    options: DocumentPreviewOptions,
    signal: AbortSignal,
  ): Promise<DocumentPreviewEngineResponse> {
    const page = options.page ?? 1;
    const pageCount = await this.pdfPageCount(file, signal);
    if (pageCount !== undefined && page > pageCount) throw new DocumentPreviewRequestError('page_out_of_range', `PDF page ${page} is outside 1-${pageCount}.`);
    const rendered = await runBinary(this.pdftoppmPath, ['-png', '-f', String(page), '-l', String(page), '-singlefile', '-'], file, signal, MAX_ASSET_BYTES, 60_000);
    if (rendered.spawnError === 'ENOENT') {
      if (file.size > MAX_BROWSER_PDF_BYTES) {
        return { kind: 'unsupported', format: 'pdf', source, reason: 'source_too_large', recovery: { kind: 'download-original' }, readOnly: true };
      }
      const bytes = await collect(file.stream(), MAX_BROWSER_PDF_BYTES + 1, signal);
      if (bytes.byteLength > MAX_BROWSER_PDF_BYTES) {
        return { kind: 'unsupported', format: 'pdf', source, reason: 'source_too_large', recovery: { kind: 'download-original' }, readOnly: true };
      }
      const asset = this.storeAsset(sessionId, bytes, 'application/pdf', {});
      return {
        kind: 'ready', format: 'pdf', fidelity: 'rendered', renderer: 'browser-pdf', source,
        navigation: { kind: 'page', page, pageCount }, assets: [asset], readOnly: true,
      };
    }
    if (rendered.code !== 0 || !hasPrefix(rendered.stdout, PNG_MAGIC)) {
      throw new DocumentPreviewRequestError('invalid_render', rendered.stderr || 'The PDF page could not be rendered.');
    }
    const dimensions = pngDimensions(rendered.stdout);
    const asset = this.storeAsset(sessionId, rendered.stdout, 'image/png', dimensions);
    return {
      kind: 'ready', format: 'pdf', fidelity: 'rendered', renderer: 'poppler', source,
      navigation: { kind: 'page', page, pageCount }, assets: [asset], readOnly: true,
    };
  }

  private async previewOffice(
    sessionId: string,
    file: DocumentPreviewFile,
    source: DocumentPreviewSourceInfo,
    format: Exclude<DocumentPreviewFormat, 'pdf'>,
    options: DocumentPreviewOptions,
    signal: AbortSignal,
  ): Promise<DocumentPreviewEngineResponse> {
    const page = options.page ?? 1;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kiki-document-preview-'));
    const target = path.join(directory, safeFilename(file.name, format));
    try {
      await materialize(file, target, signal);
      let rendered: OfficePreviewResult;
      try {
        rendered = await this.renderOffice!({ path: target, page, sheet: options.sheet, range: options.range, signal });
      } catch (error) {
        if (isOfficeDependencyError(error)) {
          return {
            kind: 'missing_dependency', dependency: 'officecli', source,
            message: error instanceof Error ? error.message : 'OfficeCLI is unavailable.',
            recovery: { kind: 'install-prerequisite', pluginId: 'kiki-office', prerequisiteId: 'officecli', consentRequired: true, pluginState: error instanceof DocumentPreviewDependencyError ? error.pluginState : 'enabled' },
            readOnly: true,
          };
        }
        throw error;
      }
      if (rendered.mime !== 'image/png' || !hasPrefix(rendered.bytes, PNG_MAGIC) || rendered.bytes.byteLength > MAX_ASSET_BYTES) {
        throw new DocumentPreviewRequestError('invalid_render', 'OfficeCLI did not return a bounded PNG preview.');
      }
      const asset = this.storeAsset(sessionId, rendered.bytes, rendered.mime, pngDimensions(rendered.bytes));
      if (format === 'xlsx') {
        return {
          kind: 'ready', format, fidelity: 'rendered', renderer: 'officecli', source,
          navigation: { kind: 'sheet', sheet: rendered.sheet ?? options.sheet, sheets: rendered.sheets, sheetIndex: rendered.sheetIndex, sheetCount: rendered.sheetCount ?? rendered.sheets?.length },
          assets: [asset], readOnly: true,
        };
      }
      return {
        kind: 'ready', format, fidelity: 'rendered', renderer: 'officecli', source,
        navigation: { kind: 'page', page: rendered.page ?? page, pageCount: rendered.pageCount },
        assets: [asset], readOnly: true,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async pdfPageCount(file: DocumentPreviewFile, signal: AbortSignal): Promise<number | undefined> {
    const result = await runBinary(this.pdfinfoPath, ['-'], file, signal, 128 * 1024, 15_000);
    if (result.spawnError === 'ENOENT' || result.code !== 0) return undefined;
    const match = /(?:^|\n)Pages:\s*(\d+)/iu.exec(Buffer.from(result.stdout).toString('utf8'));
    const count = match === null ? undefined : Number(match[1]);
    return count !== undefined && Number.isSafeInteger(count) && count > 0 ? count : undefined;
  }

  private storeAsset(sessionId: string, bytes: Uint8Array, mime: string, dimensions: { readonly width?: number; readonly height?: number }): DocumentPreviewAsset {
    this.evictExpired();
    if (bytes.byteLength > this.assetByteBudget) {
      throw new DocumentPreviewRequestError('invalid_render', 'Preview asset exceeds the server asset budget.');
    }
    while (this.assets.size >= MAX_ASSETS || this.assetBytes + bytes.byteLength > this.assetByteBudget) {
      if (!this.evictOldest()) break;
    }
    const assetId = randomUUID();
    this.assets.set(assetId, { sessionId, bytes, mime, width: dimensions.width, height: dimensions.height, expiresAt: Date.now() + this.assetTtlMs });
    this.assetBytes += bytes.byteLength;
    return { assetId, bytes, mime, width: dimensions.width, height: dimensions.height };
  }

  private evictOldest(): boolean {
    const oldest = this.assets.entries().next().value;
    if (oldest === undefined) return false;
    this.assets.delete(oldest[0]);
    this.assetBytes -= oldest[1].bytes.byteLength;
    return true;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, asset] of this.assets) {
      if (asset.expiresAt > now) continue;
      this.assets.delete(id);
      this.assetBytes -= asset.bytes.byteLength;
    }
  }
}

function sourceInfo(file: DocumentPreviewFile): DocumentPreviewSourceInfo {
  return { kind: file.sourceKind, name: file.name, mediaType: file.mediaType, size: file.size };
}

function extensionOf(name: string): string {
  const base = name.replaceAll('\\', '/').split('/').at(-1) ?? name;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base.toLowerCase() : base.slice(dot + 1).toLowerCase();
}

function formatOf(name: string, mediaType: string): DocumentPreviewFormat | undefined {
  const extension = extensionOf(name);
  if (DOCUMENT_EXTENSIONS.has(extension)) return extension as DocumentPreviewFormat;
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (mediaType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  return undefined;
}

function utf8WindowLength(bytes: Uint8Array, maxBytes: number): number {
  const limit = Math.min(bytes.byteLength, maxBytes);
  if (bytes.byteLength <= limit || limit === 0) return limit;
  let leadIndex = limit - 1;
  while (leadIndex >= 0 && (bytes[leadIndex]! & 0xc0) === 0x80) leadIndex -= 1;
  if (leadIndex < 0) return limit;
  const lead = bytes[leadIndex]!;
  const width = lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 0;
  if (width <= 1 || limit - leadIndex >= width) return limit;
  for (let index = leadIndex + 1; index < bytes.byteLength; index += 1) {
    if ((bytes[index]! & 0xc0) !== 0x80) return limit;
  }
  if (bytes.byteLength - leadIndex >= width) return leadIndex + width;
  return leadIndex > 0 ? leadIndex : limit;
}

function containsBinary(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte === 0 || (byte < 7 && byte !== 9 && byte !== 10 && byte !== 13)) return true;
  return false;
}

function hasPrefix(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.byteLength < prefix.byteLength) return false;
  for (let index = 0; index < prefix.byteLength; index += 1) if (bytes[index] !== prefix[index]) return false;
  return true;
}

function pngDimensions(bytes: Uint8Array): { readonly width?: number; readonly height?: number } {
  if (bytes.byteLength < 24 || !hasPrefix(bytes, PNG_MAGIC)) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : {};
}

function safeFilename(name: string, extension: string): string {
  const base = name.replaceAll('\\', '/').split('/').at(-1) ?? 'document';
  const cleaned = base.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(-128) || 'document';
  return cleaned.toLowerCase().endsWith(`.${extension}`) ? cleaned : `${cleaned}.${extension}`;
}

async function materialize(file: DocumentPreviewFile, target: string, signal: AbortSignal): Promise<void> {
  if (file.size > MAX_SOURCE_BYTES) throw new DocumentPreviewRequestError('invalid_render', 'The document exceeds the renderer input limit.');
  const source = Readable.from(file.stream());
  let seen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.byteLength;
      if (seen > MAX_SOURCE_BYTES) {
        callback(new DocumentPreviewRequestError('invalid_render', 'The document exceeds the renderer input limit.'));
        return;
      }
      callback(null, chunk);
    },
  });
  const abort = (): void => { source.destroy(new Error('document preview cancelled')); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await pipeline(source, limiter, createWriteStream(target, { flags: 'wx' }));
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', abort);
    source.destroy();
  }
}

async function collect(source: AsyncIterable<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    signal.throwIfAborted();
    const remaining = maxBytes - total;
    if (remaining <= 0) break;
    const selected = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
    chunks.push(selected);
    total += selected.byteLength;
    if (total >= maxBytes) break;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

interface BinaryResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly spawnError?: string;
}

async function runBinary(
  command: string,
  args: readonly string[],
  file: DocumentPreviewFile,
  signal: AbortSignal,
  maxBytes: number,
  timeoutMs: number,
): Promise<BinaryResult> {
  return new Promise<BinaryResult>((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const source = Readable.from(file.stream());
    const stdout: Uint8Array[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => { finish(new Error(`Document renderer timed out after ${timeoutMs}ms`)); }, timeoutMs);
    const abort = (): void => { finish(signal.reason instanceof Error ? signal.reason : new Error('Document preview cancelled')); };
    const finish = (error?: Error, result?: BinaryResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      source.destroy();
      child.stdin.destroy();
      if (error !== undefined) { child.kill(); reject(error); return; }
      resolve(result!);
    };
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') finish(undefined, { code: -1, stdout: new Uint8Array(), stderr: error.message, spawnError: 'ENOENT' });
      else finish(error);
    });
    child.stdout.on('data', (chunk: Uint8Array) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxBytes) { finish(new Error('Document renderer output exceeded the preview budget')); return; }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Uint8Array) => { stderr = `${stderr}${Buffer.from(chunk).toString('utf8')}`.slice(-8192); });
    child.stdin.on('error', () => undefined);
    source.on('error', (error) => { finish(error instanceof Error ? error : new Error(String(error))); });
    child.on('close', (code) => { finish(undefined, { code: code ?? -1, stdout: joinBytes(stdout, stdoutBytes), stderr }); });
    if (signal.aborted) abort();
    else source.pipe(child.stdin);
  });
}

function joinBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function isOfficeDependencyError(error: unknown): boolean {
  if (error instanceof DocumentPreviewDependencyError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error) ?? 'OfficeCLI error';
  return ['ENGINE_MISSING', 'VERSION_MISMATCH', 'PLATFORM_UNSUPPORTED'].includes(code) || /OfficeCLI|not enabled|not installed|prerequisite/iu.test(message);
}
