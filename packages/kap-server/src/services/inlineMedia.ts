import type { SessionMediaFile } from '@kiki/agent-core-v2/agent/media/sessionMediaStore';
import { parseImageDataUrl } from '@kiki/agent-core-v2/agent/media/image-format-policy';
import { validateImageDataUrl } from '@kiki/agent-core-v2/agent/media/image-compress';
import { isPlainAgentId, mediaUrlFromPart, type ContentRef, type ContentSource, type TranscriptAttachment, type TranscriptTurn } from '@kiki/transcript';
import { z } from 'zod';
import { contentRevision } from '../transport/klient/contentRevision';

export function inlineMediaId(attachment: TranscriptAttachment, agentId: string): string | undefined {
  const source = attachment.source;
  if (source?.kind !== 'url' || !/^data:/iu.test(source.url)) return undefined;
  return `inline:${agentId}:${Buffer.from(attachment.attachmentId).toString('base64url')}:${contentRevision(source.url)}`;
}

export function inlineToolMedia(part: unknown): { readonly kind: 'image' | 'video'; readonly url: string } | undefined {
  const media = mediaUrlFromPart(part);
  return media?.url.startsWith(`data:${media.kind}/`) ? media : undefined;
}

const inlineAddressSchema = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('frame'), id: z.string().min(1).max(256), turnId: z.string().min(1).max(256), stepId: z.string().min(1).max(256) }).strict(),
    z.object({ kind: z.literal('prompt'), id: z.string().min(1).max(256) }).strict(),
  ]),
  path: z.array(z.union([z.string().max(256), z.number().int().nonnegative()])).min(1).max(16),
}).strict();

export type InlineMediaIdentity = {
  readonly agentId: string;
  readonly revision: string;
} & (
  | { readonly kind: 'attachment'; readonly attachmentId: string }
  | { readonly kind: 'content'; readonly source: ContentSource; readonly path: ContentRef['path'] }
);

export type PublishedMediaEntityReader = (agentId: string, source: ContentSource) => Promise<unknown>;

export function parseInlineMediaIdentity(fileId: string): InlineMediaIdentity | undefined {
  const [kind, agentId, address, revision, extra] = fileId.split(':');
  if ((kind !== 'inline' && kind !== 'inline-content') || agentId === undefined || !isPlainAgentId(agentId) ||
    address === undefined || address.length > 8192 || !/^[A-Za-z0-9_-]+$/u.test(address) ||
    revision === undefined || !/^[0-9a-f]{64}$/u.test(revision) || extra !== undefined) return undefined;
  if (kind === 'inline') {
    const attachmentId = Buffer.from(address, 'base64url').toString('utf8');
    return attachmentId.length > 0 ? { kind: 'attachment', agentId, attachmentId, revision } : undefined;
  }
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(address, 'base64url').toString('utf8')); }
  catch { return undefined; }
  const parsed = inlineAddressSchema.safeParse(decoded);
  if (!parsed.success || !isInlineMediaAddress(parsed.data.source, parsed.data.path)) return undefined;
  return { kind: 'content', agentId, ...parsed.data, revision };
}

export async function openPublishedInlineMedia(fileId: string, readEntity: PublishedMediaEntityReader): Promise<SessionMediaFile | undefined> {
  const identity = parseInlineMediaIdentity(fileId);
  if (identity === undefined) return undefined;
  if (identity.kind === 'attachment') {
    const attachment = await readEntity(identity.agentId, { kind: 'attachment', id: identity.attachmentId }) as TranscriptAttachment | undefined;
    return attachment === undefined || inlineMediaId(attachment, identity.agentId) !== fileId ? undefined : inlineMediaFile(attachment);
  }
  let selected = await readEntity(identity.agentId, identity.source);
  for (const key of identity.path) {
    if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key)) return undefined;
    selected = (selected as Record<string | number, unknown>)[key];
  }
  const media = inlineToolMedia(selected);
  if (media === undefined || contentRevision(media.url) !== identity.revision) return undefined;
  const name = (selected as { name?: unknown }).name;
  return inlineDataMediaFile(media.url, typeof name === 'string' && name.length > 0 ? name : `${identity.source.id}.${media.kind}`);
}

export function projectInlineToolMedia(value: unknown, path: ContentRef['path'], source: ContentSource, entity: object, agentId: string): object | undefined {
  let frameSource = source;
  let framePath = path;
  if (source.kind === 'turn' && path[0] === 'steps' && typeof path[1] === 'number' && path[2] === 'frames' && typeof path[3] === 'number') {
    const turn = entity as TranscriptTurn;
    const step = turn.steps?.[path[1]];
    const frame = step?.frames[path[3]];
    if (frame === undefined || step === undefined) return undefined;
    frameSource = { kind: 'frame', id: frame.frameId, turnId: turn.turnId, stepId: step.stepId };
    framePath = path.slice(4);
  }
  if (!isInlineMediaAddress(frameSource, framePath)) return undefined;
  const media = inlineToolMedia(value);
  if (media === undefined) return undefined;
  const address = Buffer.from(JSON.stringify({ source: frameSource, path: framePath })).toString('base64url');
  const fileId = `inline-content:${agentId}:${address}:${contentRevision(media.url)}`;
  const name = source.kind === 'prompt' ? (value as { name?: unknown }).name : undefined;
  return { type: media.kind, source: { kind: 'session_media', file_id: fileId }, name: typeof name === 'string' ? name : undefined };
}

export function isInlineMediaAddress(source: ContentSource, path: ContentRef['path']): boolean {
  return source.kind === 'frame' && source.turnId !== undefined && source.stepId !== undefined && path[0] === 'output' ||
    source.kind === 'prompt' && path.length === 2 && path[0] === 'content' && typeof path[1] === 'number' && Number.isInteger(path[1]) && path[1] >= 0;
}

export async function inlineMediaFile(attachment: TranscriptAttachment): Promise<SessionMediaFile | undefined> {
  if (attachment.source?.kind !== 'url') return undefined;
  return inlineDataMediaFile(attachment.source.url, attachment.name ?? attachment.attachmentId);
}

export async function inlineDataMediaFile(url: string, name: string): Promise<SessionMediaFile | undefined> {
  const comma = url.indexOf(',');
  if (!/^data:/iu.test(url) || comma < 0) return undefined;
  const parsed = parseImageDataUrl(url);
  const header = url.slice(5, comma);
  const mime = (parsed?.mimeType ?? header.split(';')[0]) || 'text/plain';
  const base64 = /;base64\s*$/iu.test(header);
  const payload = url.slice(comma + 1);
  let size = 0;
  const imageChunks: Uint8Array[] | undefined = mime.startsWith('image/') ? [] : undefined;
  try {
    for (const chunk of decodePayload(payload, base64)) {
      size += chunk.byteLength;
      imageChunks?.push(chunk);
    }
  } catch { return undefined; }
  if (imageChunks !== undefined) {
    const bytes = Buffer.concat(imageChunks);
    if (await validateImageDataUrl(`data:${mime};base64,${bytes.toString('base64')}`) === null) return undefined;
  }
  return {
    name, mediaType: mime, size,
    stream: async function* (range) {
      let offset = 0;
      const start = range?.start ?? 0;
      const end = range?.end ?? size - 1;
      for (const chunk of decodePayload(payload, base64)) {
        const from = Math.max(0, start - offset);
        const through = Math.min(chunk.byteLength, end - offset + 1);
        if (from < through) yield chunk.subarray(from, through);
        offset += chunk.byteLength;
        if (offset > end) break;
      }
    },
  };
}

function* percentDecoded(payload: string): Generator<Uint8Array> {
  let bytes: number[] = [];
  for (let offset = 0; offset < payload.length;) {
    if (payload[offset] === '%' && /^[0-9a-f]{2}$/iu.test(payload.slice(offset + 1, offset + 3))) {
      bytes.push(Number.parseInt(payload.slice(offset + 1, offset + 3), 16));
      offset += 3;
    } else {
      const code = payload.codePointAt(offset)!;
      if (code < 128) { bytes.push(code); offset += 1; }
      else { const character = String.fromCodePoint(code); bytes.push(...new TextEncoder().encode(character)); offset += character.length; }
    }
    if (bytes.length >= 16 * 1024) { yield Uint8Array.from(bytes); bytes = []; }
  }
  if (bytes.length > 0) yield Uint8Array.from(bytes);
}

function* decodePayload(payload: string, base64: boolean): Generator<Uint8Array> {
  if (!base64) { yield* percentDecoded(payload); return; }
  let carry = '';
  let padded = false;
  for (const chunk of percentDecoded(payload)) {
    if (chunk.some((byte) => byte > 127)) throw new Error('Invalid base64 media');
    const text = Buffer.from(chunk).toString('ascii').replaceAll(/[\t\n\r\f ]/g, '');
    if (padded && text.length > 0) throw new Error('Invalid base64 media');
    carry += text;
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(carry)) throw new Error('Invalid base64 media');
    const boundary = carry.includes('=') ? Math.floor(carry.indexOf('=') / 4) * 4 : Math.floor(carry.length / 4) * 4;
    if (boundary > 0) { yield Buffer.from(carry.slice(0, boundary), 'base64'); carry = carry.slice(boundary); }
    if (carry.includes('=') && carry.length === 4) padded = true;
  }
  if (carry.length === 1 || (carry.includes('=') && (carry.length !== 4 || !/^[A-Za-z0-9+/]{2}(?:[A-Za-z0-9+/]=|==)$/u.test(carry)))) throw new Error('Invalid base64 media');
  if (carry.length > 0) yield Buffer.from(carry, 'base64');
}
