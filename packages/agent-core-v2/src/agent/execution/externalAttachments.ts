import { extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { AcpPromptContent as ContentBlock } from '@kiki/acp-client';
import type { ContentPart } from '#/kosong/contract/message';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import type { AgentRunRequest } from '#/session/subagent/subagent';
import { Error2, ErrorCodes } from '#/errors';
import {
  readLocalAttachmentBytes,
  statLocalAttachmentFile,
} from '#/os/backends/node-local/antigravityRuntime';

const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_PDF_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_TOTAL_NATIVE_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const AUDIO_MIME_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/mp3',
  'audio/mpeg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
]);

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/javascript',
  'application/typescript',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/x-sh',
]);

const TEXT_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.mdx', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml', '.csv', '.tsv',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.html', '.css', '.scss', '.less',
  '.py', '.rs', '.go', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs',
  '.rb', '.php', '.sh', '.bash', '.zsh', '.sql', '.graphql', '.svelte', '.vue',
  '.log', '.diff', '.patch', '.ini', '.conf',
]);

interface FileAttachmentCandidate {
  readonly fileId?: string;
  readonly uri?: string;
  readonly localPath?: string;
  readonly mimeType: string;
  readonly name: string;
  readonly size?: number;
}

export interface ResolveAcpAttachmentsOptions {
  readonly embeddedContext?: boolean;
  readonly isLocalRuntime?: boolean;
  readonly enforceAntigravityLimits?: boolean;
  readonly mediaStore?: ISessionMediaStore;
}

export interface ResolvedAcpAttachments {
  readonly blocks: ContentBlock[];
  readonly promotedParts: ReadonlySet<ContentPart>;
}

export function externalAttachments(request: AgentRunRequest): readonly ContentPart[] {
  const content = request.kind === 'prompt' ? request.input : request.kind === 'mailbox' ? request.message.content : undefined;
  return content?.filter((part) => part.type !== 'text') ?? [];
}

/** Extracts media parts and server-verified file-backed text parts that can be transmitted as native ACP attachment blocks. */
export function extractExternalAttachmentParts(content: readonly ContentPart[] | undefined): readonly ContentPart[] {
  return content?.filter((part) =>
    part.type !== 'text' ||
    part.attachment !== undefined ||
    part.resourceLink !== undefined) ?? [];
}

export function acpAttachments(parts: readonly ContentPart[]): ContentBlock[] {
  return parts.map((part): ContentBlock => {
    if (part.type !== 'image_url' && part.type !== 'audio_url') throw unsupported(part.type);
    const url = part.type === 'image_url' ? part.imageUrl.url : part.audioUrl.url;
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
    if (match === null) throw new Error2(ErrorCodes.REQUEST_INVALID, 'ACP media attachments require a staged base64 data URL');
    return { type: part.type === 'image_url' ? 'image' : 'audio', mimeType: match[1]!, data: match[2]! };
  });
}

/** Resolves multimodal ACP prompt blocks including images, audio, and (when embeddedContext is supported on a local runtime) PDF resource links and UTF-8/UTF-16 text/code resources. */
export async function resolveAcpAttachments(
  parts: readonly ContentPart[],
  options: ResolveAcpAttachmentsOptions = {},
): Promise<ContentBlock[]> {
  return (await resolveAcpAttachmentsDetailed(parts, options)).blocks;
}

/** Resolves multimodal ACP prompt blocks and reports which pure attachment-notice text parts were promoted to native blocks. */
export async function resolveAcpAttachmentsDetailed(
  parts: readonly ContentPart[],
  options: ResolveAcpAttachmentsOptions = {},
): Promise<ResolvedAcpAttachments> {
  const blocks: ContentBlock[] = [];
  const promotedParts = new Set<ContentPart>();
  const seenFileKeys = new Set<string>();
  let totalBytes = 0;
  const enforceLimits = options.enforceAntigravityLimits === true;
  const allowEmbedded = options.embeddedContext === true && options.isLocalRuntime === true;

  for (const part of parts) {
    if (part.type === 'image_url' || part.type === 'audio_url') {
      const isImage = part.type === 'image_url';
      const limit = isImage ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_AUDIO_ATTACHMENT_BYTES;
      const media = isImage ? part.imageUrl : part.audioUrl;
      const decoded = await resolveMediaBlock(media.url, media.mimeType, media.attachment?.fileId, options.mediaStore);
      const size = decoded.byteLength;
      if (enforceLimits && (size > limit || totalBytes + size > MAX_TOTAL_NATIVE_ATTACHMENT_BYTES)) {
        throw new Error2(
          ErrorCodes.REQUEST_INVALID,
          `${isImage ? 'Image' : 'Audio'} attachment '${media.name ?? 'media'}' exceeds the Antigravity native attachment limit`,
        );
      }
      totalBytes += size;
      blocks.push({ type: isImage ? 'image' : 'audio', mimeType: decoded.mimeType, data: decoded.data });
      continue;
    }

    if (part.type !== 'text') {
      throw unsupported(part.type);
    }

    const candidates = collectTextFileCandidates(part);
    if (candidates.length === 0) continue;

    let partPromotedCount = 0;
    for (const candidate of candidates) {
      const key = candidate.localPath ?? candidate.uri ?? candidate.fileId;
      if (key !== undefined && seenFileKeys.has(key)) continue;

      const resolved = await resolveFileCandidate(candidate, {
        allowEmbedded,
        isLocalRuntime: options.isLocalRuntime === true,
        enforceLimits,
        mediaStore: options.mediaStore,
        totalBytes,
      });
      if (resolved === undefined) continue;
      if (key !== undefined) seenFileKeys.add(key);
      totalBytes += resolved.byteLength;
      blocks.push(resolved.block);
      partPromotedCount += 1;
    }

    if (partPromotedCount > 0 && isPureAttachmentNoticePart(part)) {
      promotedParts.add(part);
    }
  }

  return { blocks, promotedParts };
}

/** Removes only promoted synthetic attachment-notice substrings from the assembled prompt while preserving host prefixes and user prose. */
export function promptTextWithoutPromotedAttachments(
  content: readonly ContentPart[] | undefined,
  promotedParts: ReadonlySet<ContentPart>,
  fallbackPrompt: string,
): string {
  if (content === undefined || promotedParts.size === 0) return fallbackPrompt;
  let stripped = fallbackPrompt;
  for (const part of content) {
    if (part.type !== 'text' || !promotedParts.has(part) || part.text.length === 0) continue;
    const index = stripped.indexOf(part.text);
    if (index < 0) continue;
    const end = index + part.text.length;
    if (stripped[end] === '\n' && (index === 0 || stripped[index - 1] === '\n')) {
      stripped = `${stripped.slice(0, index)}${stripped.slice(end + 1)}`;
    } else if (end === stripped.length && index > 0 && stripped[index - 1] === '\n') {
      stripped = stripped.slice(0, index - 1);
    } else {
      stripped = `${stripped.slice(0, index)}${stripped.slice(end)}`;
    }
  }
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

export function codexAttachments(parts: readonly ContentPart[]): readonly Record<string, unknown>[] {
  return parts.map((part) => {
    if (part.type !== 'image_url') throw unsupported(part.type);
    return { type: 'image', url: part.imageUrl.url };
  });
}

function collectTextFileCandidates(part: Extract<ContentPart, { type: 'text' }>): FileAttachmentCandidate[] {
  if (part.attachment === undefined && part.resourceLink === undefined) return [];
  const mimeType = normalizeMime(part.attachment?.mimeType ?? part.resourceLink?.mimeType ?? '');
  const name = part.attachment?.name ?? part.resourceLink?.name ?? resourceFileName(part.resourceLink?.uri) ?? 'attachment';
  return [{
    fileId: part.attachment?.fileId,
    uri: part.resourceLink?.uri,
    mimeType,
    name,
    size: part.attachment?.size ?? part.resourceLink?.size,
  }];
}

function isPureAttachmentNoticePart(part: Extract<ContentPart, { type: 'text' }>): boolean {
  if (part.attachment === undefined && part.resourceLink === undefined) return false;
  const trimmed = part.text.trim();
  return trimmed.length === 0 || /^\[?Attached\s+(?:file|image|audio|video)\b/i.test(trimmed);
}

async function resolveFileCandidate(
  candidate: FileAttachmentCandidate,
  context: {
    readonly allowEmbedded: boolean;
    readonly isLocalRuntime: boolean;
    readonly enforceLimits: boolean;
    readonly mediaStore: ISessionMediaStore | undefined;
    readonly totalBytes: number;
  },
): Promise<{ readonly block: ContentBlock; readonly byteLength: number } | undefined> {
  if (AUDIO_MIME_TYPES.has(candidate.mimeType)) {
    const bytes = await readAttachmentBytes(
      candidate.fileId,
      candidate.uri,
      candidate.localPath,
      MAX_AUDIO_ATTACHMENT_BYTES,
      context.mediaStore,
      context.isLocalRuntime,
    );
    if (bytes === undefined) return undefined;
    if (bytes.byteLength > MAX_AUDIO_ATTACHMENT_BYTES || context.totalBytes + bytes.byteLength > MAX_TOTAL_NATIVE_ATTACHMENT_BYTES) {
      if (context.enforceLimits) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, `Audio attachment '${candidate.name}' exceeds the Antigravity 20 MiB audio / 50 MiB total limit`);
      }
      return undefined;
    }
    return {
      byteLength: bytes.byteLength,
      block: { type: 'audio', mimeType: candidate.mimeType, data: Buffer.from(bytes).toString('base64') },
    };
  }

  if (!context.allowEmbedded) return undefined;

  const isPdf = candidate.mimeType === 'application/pdf' ||
    extname(candidate.name).toLowerCase() === '.pdf' ||
    (candidate.localPath !== undefined && extname(candidate.localPath).toLowerCase() === '.pdf');
  if (isPdf) {
    const localPath = candidate.localPath ?? await resolveLocalPath(candidate.fileId, candidate.uri, context.mediaStore);
    if (localPath === undefined) return undefined;
    const info = await statLocalAttachmentFile(localPath);
    if (info === undefined) return undefined;
    const size = info.size;
    if (size > MAX_PDF_ATTACHMENT_BYTES || context.totalBytes + size > MAX_TOTAL_NATIVE_ATTACHMENT_BYTES) {
      return undefined;
    }
    return {
      byteLength: size,
      block: {
        type: 'resource_link',
        uri: pathToFileURL(localPath).href,
        name: candidate.name,
        mimeType: 'application/pdf',
        size,
      },
    };
  }

  const isText = candidate.mimeType.startsWith('text/') ||
    TEXT_MIME_TYPES.has(candidate.mimeType) ||
    TEXT_FILE_EXTENSIONS.has(extname(candidate.name).toLowerCase()) ||
    (candidate.localPath !== undefined && TEXT_FILE_EXTENSIONS.has(extname(candidate.localPath).toLowerCase()));
  if (!isText) return undefined;

  const localPath = candidate.localPath ?? await resolveLocalPath(candidate.fileId, candidate.uri, context.mediaStore);
  const bytes = await readAttachmentBytes(
    candidate.fileId,
    candidate.uri,
    localPath,
    MAX_TEXT_ATTACHMENT_BYTES,
    context.mediaStore,
    true,
  );
  if (bytes === undefined) return undefined;
  if (bytes.byteLength > MAX_TEXT_ATTACHMENT_BYTES || context.totalBytes + bytes.byteLength > MAX_TOTAL_NATIVE_ATTACHMENT_BYTES) {
    return undefined;
  }
  const decoded = decodeTextBytes(bytes, candidate.name);
  const uri = localPath !== undefined
    ? pathToFileURL(localPath).href
    : candidate.uri ?? `kiki-attachment:///${encodeURIComponent(candidate.name)}`;
  return {
    byteLength: bytes.byteLength,
    block: {
      type: 'resource',
      resource: {
        uri,
        mimeType: candidate.mimeType || 'text/plain',
        text: decoded,
      },
    },
  };
}

async function resolveMediaBlock(
  url: string,
  fallbackMime: string | undefined,
  fileId: string | undefined,
  mediaStore: ISessionMediaStore | undefined,
): Promise<{ readonly mimeType: string; readonly data: string; readonly byteLength: number }> {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (match !== null) {
    const data = match[2]!;
    return {
      mimeType: normalizeMime(match[1]!),
      data,
      byteLength: base64DecodedLength(data),
    };
  }
  if (fileId !== undefined && mediaStore !== undefined) {
    const read = await mediaStore.read(fileId);
    if (read !== undefined) {
      return {
        mimeType: normalizeMime(fallbackMime ?? 'application/octet-stream'),
        data: Buffer.from(read.data).toString('base64'),
        byteLength: read.data.byteLength,
      };
    }
  }
  throw new Error2(ErrorCodes.REQUEST_INVALID, 'ACP media attachments require a staged base64 data URL');
}

async function resolveLocalPath(
  fileId: string | undefined,
  uri: string | undefined,
  mediaStore: ISessionMediaStore | undefined,
): Promise<string | undefined> {
  if (fileId !== undefined && mediaStore !== undefined) {
    const displayPath = await mediaStore.resolveDisplayPath(fileId).catch(() => undefined);
    if (displayPath !== undefined && displayPath.length > 0 && await statLocalAttachmentFile(displayPath) !== undefined) {
      return displayPath;
    }
    const opened = await mediaStore.open(fileId).catch(() => undefined);
    if (opened?.path !== undefined && opened.path.length > 0 && await statLocalAttachmentFile(opened.path) !== undefined) {
      return opened.path;
    }
  }
  if (uri !== undefined && /^file:\/\//i.test(uri)) {
    try {
      const parsed = new URL(uri);
      if (parsed.hostname && parsed.hostname !== 'localhost') return undefined;
      return fileURLToPath(parsed);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function readAttachmentBytes(
  fileId: string | undefined,
  uri: string | undefined,
  directPath: string | undefined,
  maxBytes: number,
  mediaStore: ISessionMediaStore | undefined,
  allowLocalFile: boolean,
): Promise<Uint8Array | undefined> {
  if (fileId !== undefined && mediaStore !== undefined) {
    const stored = await mediaStore.read(fileId).catch(() => undefined);
    if (stored !== undefined) return stored.data;
  }
  if (!allowLocalFile) return undefined;
  const localPath = directPath ?? await resolveLocalPath(fileId, uri, mediaStore);
  if (localPath === undefined) return undefined;
  return readLocalAttachmentBytes(localPath, maxBytes);
}

function decodeTextBytes(bytes: Uint8Array, name: string): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe
    ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff
      ? 'utf-16be'
      : 'utf-8';
  let decoded: string;
  try {
    decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error2(ErrorCodes.REQUEST_INVALID, `Attachment '${name}' is not valid ${encoding.toUpperCase()} text`);
  }
  if (decoded.includes('\0')) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, `Attachment '${name}' contains binary data`);
  }
  return decoded;
}

function base64DecodedLength(encoded: string): number {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

function normalizeMime(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function resourceFileName(uri: string | undefined): string | undefined {
  if (uri === undefined) return undefined;
  const lastSlash = Math.max(uri.lastIndexOf('/'), uri.lastIndexOf('\\'));
  const segment = lastSlash >= 0 ? uri.slice(lastSlash + 1) : uri;
  try {
    return decodeURIComponent(segment) || undefined;
  } catch {
    return segment || undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function unsupported(type: string): Error2 {
  return new Error2(ErrorCodes.REQUEST_INVALID, `External harness does not support this attachment type: ${type}`);
}
