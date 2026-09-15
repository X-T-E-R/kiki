import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { ContentPart } from '#/kosong/contract/message';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ExecutableToolResult } from '#/tool/toolContract';

import { compressImageContentParts, gateImageFormatParts } from '#/agent/media/image-compress';
import {
  buildUnsupportedImageNotice,
  decodeBase64Prefix,
  isModelAcceptedImageMime,
  parseImageDataUrl,
  resolveEffectiveImageMime,
} from '#/agent/media/image-format-policy';
import { persistOriginalImage } from '#/agent/media/image-originals';
import { buildDaemonFileUrl, mediaExtensionForMime } from '#/agent/media/mediaRef';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import type { MCPContentBlock, MCPToolResult } from '#/mcpCore/types';

export interface McpOutputOptions {
  readonly signal?: AbortSignal;
  readonly attachmentStore?: ISessionMediaStore;
  readonly originalsDir?: string;
  readonly telemetry?: ITelemetryService;
  readonly providerType?: string;
}

export const MCP_MAX_BINARY_PART_BYTES = 10 * 1024 * 1024;
const MCP_MAX_BINARY_PART_CHARS = Math.ceil((MCP_MAX_BINARY_PART_BYTES * 4) / 3);
const MCP_MAX_INLINE_NOTICES_CHARS = 4096;

const TEXT_EXTENSION_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
});

function binaryPartTooLargeNotice(kind: 'image' | 'audio' | 'video', urlLength: number): string {
  const approxMb = ((urlLength * 3) / 4 / (1024 * 1024)).toFixed(1);
  const capMb = String(MCP_MAX_BINARY_PART_BYTES / (1024 * 1024));
  return `[${kind}_url dropped: ~${approxMb} MB exceeds ${capMb} MB per-part limit. Try a smaller resource.]`;
}

function droppedBlockNotice(reason: string): ContentPart {
  return { type: 'text', text: `[MCP content dropped: ${reason}]` };
}

export function convertMCPContentBlock(
  block: MCPContentBlock,
  providerType?: string,
): ContentPart {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }

  if (block.type === 'image' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'image/png';
    return {
      type: 'image_url',
      imageUrl: { url: `data:${mimeType};base64,${block.data}` },
    };
  }

  if (block.type === 'audio' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'audio/mpeg';
    return {
      type: 'audio_url',
      audioUrl: { url: `data:${mimeType};base64,${block.data}` },
    };
  }

  if (block.type === 'resource' && typeof block.resource === 'object' && block.resource !== null) {
    const res = block.resource;
    if (typeof res.text === 'string') {
      return { type: 'text', text: res.text };
    }
    if (typeof res.blob === 'string') {
      const mimeType = res.mimeType ?? 'application/octet-stream';
      if (mimeType.startsWith('image/')) {
        return {
          type: 'image_url',
          imageUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      if (mimeType.startsWith('audio/')) {
        return {
          type: 'audio_url',
          audioUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      if (mimeType.startsWith('video/')) {
        return {
          type: 'video_url',
          videoUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      const approxMb = ((res.blob.length * 3) / 4 / (1024 * 1024)).toFixed(1);
      return droppedBlockNotice(
        `resource blob with unsupported mimeType "${mimeType}" (~${approxMb} MB, uri: ${res.uri}) was not delivered.`,
      );
    }
    return droppedBlockNotice(`resource (uri: ${res.uri}) carried no text or blob payload.`);
  }

  if (block.type === 'resource_link' && typeof block.uri === 'string') {
    const mimeType = block.mimeType ?? 'application/octet-stream';
    if (mimeType.startsWith('image/')) {
      if (!isModelAcceptedImageMime(mimeType, providerType)) {
        return {
          type: 'text',
          text: buildUnsupportedImageNotice(mimeType, block.uri, providerType),
        };
      }
      return { type: 'image_url', imageUrl: { url: block.uri } };
    }
    if (mimeType.startsWith('audio/')) {
      return { type: 'audio_url', audioUrl: { url: block.uri } };
    }
    if (mimeType.startsWith('video/')) {
      return { type: 'video_url', videoUrl: { url: block.uri } };
    }
    return droppedBlockNotice(
      `resource_link with unsupported mimeType "${mimeType}" was not delivered. Fetch it directly if needed: ${block.uri}`,
    );
  }

  return droppedBlockNotice(`content block of unsupported type "${block.type}" was not delivered.`);
}

export async function mcpResultToExecutableOutput(
  result: MCPToolResult,
  qualifiedToolName: string,
  options: McpOutputOptions = {},
): Promise<ExecutableToolResult> {
  options.signal?.throwIfAborted();
  const converted: ContentPart[] = [];
  const attachmentNotices: string[] = [];
  const preservedUrls = new Set<string>();
  let omittedAttachment = false;

  const preserveInlineMedia = async (url: string): Promise<void> => {
    options.signal?.throwIfAborted();
    if (preservedUrls.has(url)) return;
    const parsed = parseImageDataUrl(url);
    if (parsed === null) return;
    preservedUrls.add(url);
    const mimeType = parsed.mimeType.startsWith('image/')
      ? resolveEffectiveImageMime(parsed.mimeType, decodeBase64Prefix(parsed.base64))
      : parsed.mimeType;
    attachmentNotices.push(await preserveAttachment(parsed.base64, mimeType, options));
  };

  for (const block of result.content) {
    options.signal?.throwIfAborted();
    const part = convertMCPContentBlock(block, options.providerType);
    const gated = gateImageFormatParts([part], options.providerType);
    converted.push(...gated);
    if (part.type === 'image_url' && gated[0]?.type === 'text') {
      omittedAttachment = true;
      await preserveInlineMedia(part.imageUrl.url);
      continue;
    }
    const blob = droppedResourceBlob(block);
    if (blob !== undefined) {
      omittedAttachment = true;
      attachmentNotices.push(await preserveAttachment(blob.blob, blob.mimeType, options));
    }
  }

  const wrapped = wrapMediaOnly(converted, qualifiedToolName);
  const hasUsableContent = converted.some((part) =>
    part.type === 'text' ? part.text.trim().length > 0 : true,
  );
  const structuredExtras: Record<string, unknown> = {};
  if (result.structuredContent !== undefined && !hasUsableContent) {
    structuredExtras['structuredContent'] = result.structuredContent;
  }
  if (result._meta !== undefined) {
    const meta = stripReservedMetaKeys(result._meta);
    if (meta !== undefined) {
      structuredExtras['_meta'] = meta;
    }
  }
  if (Object.keys(structuredExtras).length > 0) {
    const serialized = serializeStructuredExtras(structuredExtras);
    if (serialized !== undefined) {
      wrapped.push({
        type: 'text',
        text: `\n<mcp-result-extras>\n${serialized}\n</mcp-result-extras>`,
      });
    }
  }

  const compressed = await compressImageContentParts(wrapped, {
    providerType: options.providerType,
    telemetry:
      options.telemetry === undefined
        ? undefined
        : { client: options.telemetry, source: 'mcp_tool_result' },
    annotate: {
      persistOriginal: (bytes, mimeType) =>
        persistOriginalImage(
          bytes,
          mimeType,
          options.originalsDir === undefined ? {} : { dir: options.originalsDir },
        ),
    },
  });
  const capped = await applyBinaryPartCap(compressed.parts, preserveInlineMedia);
  const output = collapseSingleText(capped.parts);
  const details = await attachmentDetails(
    [...compressed.captions, ...attachmentNotices],
    options,
  );
  const spillSuffix = [...capped.notices, details.suffix]
    .filter((notice) => notice.length > 0)
    .join('\n');
  const base = {
    output,
    note: details.content.length > 0 ? details.content : undefined,
    truncated: capped.truncated || omittedAttachment ? (true as const) : undefined,
    spill: spillSuffix.length > 0 ? { suffix: spillSuffix } : undefined,
  };
  return result.isError ? { ...base, isError: true } : base;
}

function droppedResourceBlob(
  block: MCPContentBlock,
): { readonly blob: string; readonly mimeType: string } | undefined {
  if (block.type !== 'resource' || typeof block.resource !== 'object' || block.resource === null) {
    return undefined;
  }
  const res = block.resource;
  if (typeof res.text === 'string' || typeof res.blob !== 'string') return undefined;
  const mimeType = res.mimeType ?? 'application/octet-stream';
  if (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('video/')
  ) {
    return undefined;
  }
  return { blob: res.blob, mimeType };
}

async function attachmentDetails(
  notices: readonly string[],
  options: McpOutputOptions,
): Promise<{ readonly content: string; readonly suffix: string }> {
  options.signal?.throwIfAborted();
  const content = [...new Set(notices)].join('\n');
  if (content.length <= MCP_MAX_INLINE_NOTICES_CHARS) return { content, suffix: content };
  try {
    const store = options.attachmentStore;
    if (store === undefined) throw new Error('Session attachment storage is unavailable');
    const saved = await saveAttachment(
      Buffer.from(content, 'utf8'),
      'text/plain',
      store,
      options.signal,
    );
    const pointer = [
      `MCP attachment details saved at: ${JSON.stringify(saved.path)}`,
      `Attachment details reference: ${JSON.stringify(saved.reference)}`,
      'Pass the saved path to Read to retrieve every original attachment reference and compression detail from this call.',
    ].join('\n');
    return { content: pointer, suffix: pointer };
  } catch {
    options.signal?.throwIfAborted();
    return { content, suffix: content };
  }
}

async function preserveAttachment(
  base64: string,
  mimeType: string,
  options: McpOutputOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  const name = JSON.stringify(mimeType);
  try {
    const store = options.attachmentStore;
    if (store === undefined) throw new Error('Session attachment storage is unavailable');
    const compact = base64.replaceAll(/\s/g, '');
    const bytes = Buffer.from(compact, 'base64');
    const canonical = bytes.toString('base64');
    if (canonical !== compact && canonical.replace(/=+$/, '') !== compact) {
      throw new Error('Invalid base64 attachment');
    }
    const saved = await saveAttachment(bytes, mimeType, store, options.signal);
    return attachmentNotice(saved, mimeType, bytes.length);
  } catch (error) {
    options.signal?.throwIfAborted();
    return (
      `Original attachment could not be saved (${name}): ` +
      `${error instanceof Error ? error.message : String(error)}. ` +
      'No readable original path is available; original attachment preservation is incomplete. ' +
      'Do not repeat the MCP call automatically.'
    );
  }
}

interface SavedAttachment {
  readonly path: string;
  readonly reference: string;
}

function attachmentNotice(saved: SavedAttachment, mimeType: string, size: number): string {
  return [
    `Original attachment saved at: ${JSON.stringify(saved.path)}`,
    `Attachment reference: ${JSON.stringify(saved.reference)}`,
    `MIME: ${JSON.stringify(mimeType)}; size: ${String(size)} bytes. ` +
      'Pass the saved path to Read or ReadMediaFile to inspect the original.',
  ].join('\n');
}

async function saveAttachment(
  bytes: Uint8Array,
  mimeType: string,
  store: ISessionMediaStore,
  signal?: AbortSignal,
): Promise<SavedAttachment> {
  signal?.throwIfAborted();
  const mime = mimeType.split(';')[0]!.trim().toLowerCase();
  const hash = createHash('sha256').update(mime).update('\0').update(bytes).digest('hex');
  const ext =
    mime === 'application/pdf'
      ? '.pdf'
      : mime === 'image/svg+xml'
        ? bytes[0] === 0x1f && bytes[1] === 0x8b
          ? '.svgz'
          : '.svg'
        : (mediaExtensionForMime(mime) ?? TEXT_EXTENSION_BY_MIME[mime] ?? '.bin');
  const fileId = `f_mcp_${hash}`;
  const path = await store.materialize({
    fileId,
    size: bytes.length,
    name: `attachment${ext}`,
    mimeType: mime,
    stream: () => Readable.from([bytes]),
    signal,
  });
  signal?.throwIfAborted();
  if (path === undefined) {
    throw new Error('Session attachment storage rejected the attachment');
  }
  return { path, reference: buildDaemonFileUrl(fileId) };
}

function serializeStructuredExtras(extras: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(extras).replaceAll('</mcp-result-extras>', '');
  } catch {
    return undefined;
  }
}

function stripReservedMetaKeys(
  meta: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!isReservedMetaKey(key)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isReservedMetaKey(key: string): boolean {
  const slash = key.indexOf('/');
  if (slash <= 0) return false;
  const labels = key.slice(0, slash).split('.');
  return labels.some(
    (label, i) =>
      (label === 'modelcontextprotocol' || label === 'mcp') && i < labels.length - 1,
  );
}

function wrapMediaOnly(parts: readonly ContentPart[], qualifiedToolName: string): ContentPart[] {
  const hasMedia = parts.some(
    (p) => p.type === 'image_url' || p.type === 'audio_url' || p.type === 'video_url',
  );
  const hasNonEmptyText = parts.some((p) => p.type === 'text' && p.text.length > 0);
  if (!hasMedia || hasNonEmptyText) return [...parts];
  return [
    { type: 'text', text: `<mcp_tool_result name="${qualifiedToolName}">` },
    ...parts,
    { type: 'text', text: '</mcp_tool_result>' },
  ];
}

async function applyBinaryPartCap(
  parts: readonly ContentPart[],
  preserve: (url: string) => Promise<void>,
): Promise<{
  readonly parts: ContentPart[];
  readonly truncated: boolean;
  readonly notices: string[];
}> {
  let truncated = false;
  const out: ContentPart[] = [];
  const notices: string[] = [];

  for (const part of parts) {
    if (part.type === 'text' || part.type === 'think') {
      out.push(part);
      continue;
    }

    const url =
      part.type === 'image_url'
        ? part.imageUrl.url
        : part.type === 'audio_url'
          ? part.audioUrl.url
          : part.videoUrl.url;
    if (url.length > MCP_MAX_BINARY_PART_CHARS) {
      await preserve(url);
      const kind =
        part.type === 'image_url' ? 'image' : part.type === 'audio_url' ? 'audio' : 'video';
      const notice = binaryPartTooLargeNotice(kind, url.length);
      out.push({ type: 'text', text: notice });
      notices.push(notice);
      truncated = true;
      continue;
    }
    out.push(part);
  }

  return { parts: out, truncated, notices };
}

function collapseSingleText(parts: readonly ContentPart[]): string | ContentPart[] {
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }
  return [...parts];
}
