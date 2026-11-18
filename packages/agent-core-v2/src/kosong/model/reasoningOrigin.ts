import {
  isToolDeclarationOnlyMessage,
  type ContentPart,
  type Message,
  type StreamedMessagePart,
  type ThinkPart,
} from '#/kosong/contract/message';
import type { Protocol } from '#/kosong/protocol/protocol';

import type { Model } from './catalog';

export type UnmarkedOpaqueReasoningPolicy = 'retain' | 'omit';

export interface ReasoningOriginDescriptor {
  readonly protocol: Protocol;
  readonly providerType?: string;
  readonly providerName: string;
  readonly baseUrl?: string;
  readonly modelName: string;
}

export interface ProjectReasoningOptions {
  readonly unmarkedOpaquePolicy?: UnmarkedOpaqueReasoningPolicy;
}

export function normalizeReasoningEndpoint(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return '';
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const pathname = parsed.pathname.replace(/\/+$/u, '');
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`;
  } catch {
    return trimmed.replace(/\/\/[^/@]+@/u, '//').replace(/\/+$/u, '');
  }
}

export function formatReasoningOrigin(
  target: Pick<Model, 'protocol' | 'providerType' | 'providerName' | 'baseUrl' | 'name'> | ReasoningOriginDescriptor,
): string {
  const modelName = 'name' in target ? target.name : target.modelName;
  return JSON.stringify([
    target.protocol,
    target.providerType ?? '',
    target.providerName,
    normalizeReasoningEndpoint(target.baseUrl),
    modelName,
  ]);
}

export function hasOpaqueReasoningPayload(part: ThinkPart): boolean {
  return (
    part.encrypted !== undefined ||
    part.redacted !== undefined ||
    (part.reasoningDetails !== undefined && part.reasoningDetails.length > 0)
  );
}

export function stampStreamPartReasoningOrigin(
  part: StreamedMessagePart,
  origin: string,
): StreamedMessagePart {
  if (part.type !== 'think' || !hasOpaqueReasoningPayload(part) || part.reasoningOrigin === origin) {
    return part;
  }
  return {
    ...part,
    reasoningOrigin: origin,
  };
}

export function stampMessageReasoningOrigin(message: Message, origin: string): Message {
  let changed = false;
  const nextContent = message.content.map((part) => {
    if (part.type !== 'think' || !hasOpaqueReasoningPayload(part) || part.reasoningOrigin === origin) {
      return part;
    }
    changed = true;
    return {
      ...part,
      reasoningOrigin: origin,
    };
  });
  if (!changed) return message;
  return {
    ...message,
    content: nextContent,
  };
}

export function stampMessageReasoningOriginInPlace(message: Message, origin: string): void {
  for (let index = 0; index < message.content.length; index += 1) {
    const part = message.content[index];
    if (part === undefined || part.type !== 'think' || !hasOpaqueReasoningPayload(part)) continue;
    if (part.reasoningOrigin === origin) continue;
    message.content[index] = {
      ...part,
      reasoningOrigin: origin,
    };
  }
}

export function projectMessagesForModelTarget(
  messages: readonly Message[],
  target: Pick<Model, 'protocol' | 'providerType' | 'providerName' | 'baseUrl' | 'name'> | string,
  options?: ProjectReasoningOptions,
): Message[] {
  const targetOrigin = typeof target === 'string' ? target : formatReasoningOrigin(target);
  const unmarkedPolicy = options?.unmarkedOpaquePolicy ?? 'retain';
  let anyChanged = false;
  const projected: Message[] = [];

  for (const message of messages) {
    if (message.role !== 'assistant' || message.content.length === 0) {
      projected.push(message);
      continue;
    }

    let messageChanged = false;
    const nextContent: ContentPart[] = [];
    for (const part of message.content) {
      if (part.type !== 'think' || !hasOpaqueReasoningPayload(part)) {
        nextContent.push(part);
        continue;
      }

      const compatible =
        part.reasoningOrigin === undefined
          ? unmarkedPolicy === 'retain'
          : part.reasoningOrigin === targetOrigin;

      if (compatible) {
        nextContent.push(part);
        continue;
      }

      messageChanged = true;
      if (part.think.trim().length > 0) {
        const stripped: ThinkPart = {
          type: 'think',
          think: part.think,
          reasoningKey: part.reasoningKey,
          hidden: part.hidden,
        };
        nextContent.push(stripped);
      }
    }

    if (!messageChanged) {
      projected.push(message);
      continue;
    }

    anyChanged = true;
    if (
      nextContent.length === 0 &&
      message.toolCalls.length === 0 &&
      !isToolDeclarationOnlyMessage(message)
    ) {
      continue;
    }
    projected.push({
      ...message,
      content: nextContent,
    });
  }

  return anyChanged ? projected : (messages as Message[]);
}
