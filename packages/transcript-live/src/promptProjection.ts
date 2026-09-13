import { daemonFileRefFromPart, type ContentPart } from '@kiki/agent-core-v2';
import type { MessageContent } from '@kiki/protocol';

/**
 * Prompt content (engine kosong parts) → the v1 wire `messageContentSchema`
 * shape. Shared by every prompt-queue surface — the REST prompt list, the
 * `prompt.steered` session event, and the transcript prompt entity — so a
 * self-contained daemon-ref media part projects back to
 * `{ kind: 'session_media', file_id }`: neither the transient App upload nor
 * the internal `kimi-file://` URL becomes the stored read-model contract.
 */
export function projectPromptContentParts(content: readonly ContentPart[]): MessageContent[] {
  const parts: MessageContent[] = [];
  for (const part of content) {
    const daemonRef = daemonFileRefFromPart(part);
    if (daemonRef !== undefined) {
      parts.push({
        type: daemonRef.kind,
        source: { kind: 'session_media', file_id: daemonRef.ref.fileId },
      });
      continue;
    }
    if (part.type === 'text') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.imageUrl.url);
      parts.push(match === null
        ? { type: 'image', source: { kind: 'url', url: part.imageUrl.url, id: part.imageUrl.id } }
        : { type: 'image', source: { kind: 'base64', media_type: match[1]!, data: match[2]! } });
    } else if (part.type === 'video_url') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.videoUrl.url);
      parts.push(match === null
        ? { type: 'video', source: { kind: 'url', url: part.videoUrl.url, id: part.videoUrl.id } }
        : { type: 'video', source: { kind: 'base64', media_type: match[1]!, data: match[2]! } });
    }
  }
  return parts;
}
