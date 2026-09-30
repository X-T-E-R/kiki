import type { AcpPromptContent as ContentBlock } from '@kiki/acp-client';
import type { ContentPart } from '#/kosong/contract/message';
import type { AgentRunRequest } from '#/session/subagent/subagent';
import { Error2, ErrorCodes } from '#/errors';

export function externalAttachments(request: AgentRunRequest): readonly ContentPart[] {
  const content = request.kind === 'prompt' ? request.input : request.kind === 'mailbox' ? request.message.content : undefined;
  return content?.filter((part) => part.type !== 'text') ?? [];
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

export function codexAttachments(parts: readonly ContentPart[]): readonly Record<string, unknown>[] {
  return parts.map((part) => {
    if (part.type !== 'image_url') throw unsupported(part.type);
    return { type: 'image', url: part.imageUrl.url };
  });
}

function unsupported(type: string): Error2 {
  return new Error2(ErrorCodes.REQUEST_INVALID, `External harness does not support this attachment type: ${type}`);
}
