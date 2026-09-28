import type { Message } from '#/kosong/contract/message';
import type { Protocol } from '#/kosong/protocol/protocol';

export function projectDynamicToolSchemas(
  messages: readonly Message[],
  protocol: Protocol,
  kimiProvider: boolean,
): readonly Message[] {
  if (kimiProvider || (protocol !== 'openai' && protocol !== 'openai_responses' && protocol !== 'anthropic')) {
    return messages;
  }
  return messages.map((message) => {
    if (message.tools === undefined || message.tools.length === 0) return message;
    const { tools, ...rest } = message;
    return {
      ...rest,
      role: 'system' as const,
      content: [
        ...message.content,
        {
          type: 'text' as const,
          text: `<dynamic_tool_schemas>${JSON.stringify(tools)}</dynamic_tool_schemas>`,
        },
      ],
    };
  });
}
