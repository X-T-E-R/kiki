import type { SessionMediaFile } from '@kiki/agent-core-v2/agent/media/sessionMediaStore';
import { parseImageDataUrl } from '@kiki/agent-core-v2/agent/media/image-format-policy';
import type { TranscriptAttachment } from '@kiki/transcript';
import { contentRevision } from '../transport/klient/boundedContent';

export function inlineMediaId(attachment: TranscriptAttachment, agentId: string): string | undefined {
  const source = attachment.source;
  if (source?.kind !== 'url' || !/^data:/iu.test(source.url)) return undefined;
  return `inline:${agentId}:${Buffer.from(attachment.attachmentId).toString('base64url')}:${contentRevision(source.url)}`;
}

export function inlineMediaFile(attachment: TranscriptAttachment): SessionMediaFile | undefined {
  if (attachment.source?.kind !== 'url') return undefined;
  const url = attachment.source.url;
  const comma = url.indexOf(',');
  if (!/^data:/iu.test(url) || comma < 0) return undefined;
  const parsed = parseImageDataUrl(url);
  const header = url.slice(5, comma);
  const mime = (parsed?.mimeType ?? header.split(';')[0]) || 'text/plain';
  const base64 = /;base64\s*$/iu.test(header);
  const payload = url.slice(comma + 1);
  let size = 0;
  try { for (const chunk of decodePayload(payload, base64)) size += chunk.byteLength; }
  catch { return undefined; }
  return {
    name: attachment.name ?? attachment.attachmentId, mediaType: mime, size,
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
