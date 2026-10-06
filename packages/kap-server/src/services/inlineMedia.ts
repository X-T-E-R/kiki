import type { SessionMediaFile } from '@kiki/agent-core-v2/agent/media/sessionMediaStore';
import { parseImageDataUrl } from '@kiki/agent-core-v2/agent/media/image-format-policy';
import { validateImageDataUrl } from '@kiki/agent-core-v2/agent/media/image-compress';
import type { ContentRef, ContentSource, TranscriptAttachment, TranscriptTurn } from '@kiki/transcript';
import { contentRevision } from '../transport/klient/contentRevision';

export function inlineMediaId(attachment: TranscriptAttachment, agentId: string): string | undefined {
  const source = attachment.source;
  if (source?.kind !== 'url' || !/^data:/iu.test(source.url)) return undefined;
  return `inline:${agentId}:${Buffer.from(attachment.attachmentId).toString('base64url')}:${contentRevision(source.url)}`;
}

export function inlineToolMedia(part: unknown): { kind: 'image' | 'video'; url: string } | undefined {
  if (part === null || typeof part !== 'object' || Array.isArray(part)) return undefined;
  const value = part as Record<string, unknown>;
  for (const kind of ['image', 'video'] as const) {
    if (value['type'] === `${kind}_url`) {
      for (const key of [`${kind}Url`, `${kind}_url`]) {
        const container = value[key] as { url?: unknown } | undefined;
        if (typeof container?.url === 'string' && container.url.startsWith(`data:${kind}/`)) return { kind, url: container.url };
      }
    }
    if (value['type'] === kind) {
      const source = value['source'] as { kind?: unknown; url?: unknown; media_type?: unknown; data?: unknown } | undefined;
      if (source?.kind === 'url' && typeof source.url === 'string' && source.url.startsWith(`data:${kind}/`)) return { kind, url: source.url };
      if (source?.kind === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string' && source.media_type.startsWith(`${kind}/`))
        return { kind, url: `data:${source.media_type};base64,${source.data}` };
    }
  }
  return undefined;
}

export function projectInlineToolMedia(value: unknown, path: ContentRef['path'], source: ContentSource, entity: object, agentId: string): object | undefined {
  if (source.kind === 'prompt' && (entity as { status?: string }).status !== 'completed') return undefined;
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
  return { type: media.kind, source: { kind: 'session_media', file_id: fileId } };
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
