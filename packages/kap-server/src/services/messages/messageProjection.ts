import { parseDaemonFileUrl, type ContextMessage } from '@kiki/agent-core-v2';

import type { Message, MessageContent, MessageRole, ToolUseContent } from '../../protocol/message';

export { projectPromptContentParts } from '@kiki/transcript-live';

function deriveMessageId(sessionId: string, index: number): string {
  const padded = String(index).padStart(6, '0');
  return `msg_${sessionId}_${padded}`;
}

function toProtocolRole(role: ContextMessage['role']): MessageRole {
  return role as MessageRole;
}

function mapContentPart(part: ContextMessage['content'][number]): MessageContent {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think': {
      const sig = part.encrypted;
      return sig !== undefined
        ? { type: 'thinking', thinking: part.think, signature: sig }
        : { type: 'thinking', thinking: part.think };
    }
    case 'image_url': {
      const ref = parseDaemonFileUrl(part.imageUrl.url);
      return ref !== undefined
        ? { type: 'image', source: { kind: 'session_media', file_id: ref.fileId }, name: part.imageUrl.name }
        : { type: 'image', source: { kind: 'url', url: part.imageUrl.url, id: part.imageUrl.id }, name: part.imageUrl.name };
    }
    case 'audio_url':
      return { type: 'text', text: `[audio:${part.audioUrl.url}]` };
    case 'video_url': {
      const ref = parseDaemonFileUrl(part.videoUrl.url);
      return ref !== undefined
        ? { type: 'video', source: { kind: 'session_media', file_id: ref.fileId }, name: part.videoUrl.name }
        : { type: 'video', source: { kind: 'url', url: part.videoUrl.url, id: part.videoUrl.id }, name: part.videoUrl.name };
    }
  }
}

function buildProtocolContent(msg: ContextMessage): MessageContent[] {
  if (msg.role === 'tool') {
    if (msg.toolCallId === undefined) {
      return msg.content.map((p) => mapContentPart(p));
    }
    const hasMediaPart = msg.content.some(
      (p) => p.type === 'image_url' || p.type === 'video_url' || p.type === 'audio_url',
    );
    const output: unknown = hasMediaPart
      ? msg.content
      : msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
    const part: MessageContent =
      msg.isError === true
        ? {
            type: 'tool_result',
            tool_call_id: msg.toolCallId,
            output,
            is_error: true,
          }
        : {
            type: 'tool_result',
            tool_call_id: msg.toolCallId,
            output,
          };
    return [part];
  }

  const base = msg.content.map((p) => mapContentPart(p));

  if (msg.role === 'assistant' && msg.toolCalls.length > 0) {
    for (const call of msg.toolCalls) {
      let parsedInput: unknown = call.arguments;
      if (typeof call.arguments === 'string') {
        try {
          parsedInput = JSON.parse(call.arguments);
        } catch {
          parsedInput = call.arguments;
        }
      }
      const part: ToolUseContent = {
        type: 'tool_use',
        tool_call_id: call.id,
        tool_name: call.name,
        input: parsedInput,
      };
      base.push(part);
    }
  }

  return base;
}


export function toProtocolMessage(
  sessionId: string,
  index: number,
  msg: ContextMessage,
  sessionCreatedAtMs: number,
  createdAtMsOverride?: number,
): Message {
  const id = msg.id ?? deriveMessageId(sessionId, index);
  const role = toProtocolRole(msg.role);
  const content = buildProtocolContent(msg);
  const createdAtMs = createdAtMsOverride ?? sessionCreatedAtMs + index;
  const metadata = msg.origin !== undefined ? { origin: msg.origin } : undefined;
  return {
    id,
    session_id: sessionId,
    role,
    content,
    created_at: new Date(createdAtMs).toISOString(),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}
