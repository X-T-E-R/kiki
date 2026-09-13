import { z } from 'zod';

import { wsOperations, type WsOperationDefinition } from './ws-control';

const ASYNCAPI_VERSION = '3.1.0';
const DEFAULT_TITLE = 'Kimi Code WebSocket API';
const DEFAULT_VERSION = '0.1.0';
const DEFAULT_SERVER_HOST = 'localhost';
const DEFAULT_WS_PATH = '/api/ws';
const CHANNEL_ID = 'kimiCodeWebSocket';
const ASYNCAPI_OPERATIONS: readonly WsOperationDefinition[] = wsOperations;

export interface AsyncApiDocumentOptions {
  readonly title?: string;
  readonly version?: string;
  readonly serverHost?: string;
  readonly serverProtocol?: 'ws' | 'wss';
  readonly wsPath?: string;
  /** Project terminal operations only when the exposure policy enables them. */
  readonly enableTerminals?: boolean;
}

export function createAsyncApiDocument(
  options: AsyncApiDocumentOptions = {},
): Record<string, unknown> {
  const title = options.title ?? DEFAULT_TITLE;
  const version = options.version ?? DEFAULT_VERSION;
  const serverHost = options.serverHost ?? DEFAULT_SERVER_HOST;
  const serverProtocol = options.serverProtocol ?? 'ws';
  const wsPath = options.wsPath ?? DEFAULT_WS_PATH;
  const operations = options.enableTerminals === false
    ? ASYNCAPI_OPERATIONS.filter((operation) => !operation.type.startsWith('terminal_'))
    : ASYNCAPI_OPERATIONS;
  const messages = buildMessages(operations);
  const channelMessages = Object.fromEntries(
    Object.keys(messages).map((id) => [id, { $ref: `#/components/messages/${id}` }]),
  );

  return {
    asyncapi: ASYNCAPI_VERSION,
    info: {
      title,
      version,
      description:
        'WebSocket protocol for Kimi Code daemon control frames, acknowledgements, system frames, and session event streaming.',
    },
    defaultContentType: 'application/json',
    servers: {
      local: {
        host: serverHost,
        protocol: serverProtocol,
        pathname: wsPath,
        description: 'Kimi Code daemon WebSocket endpoint.',
      },
    },
    channels: {
      [CHANNEL_ID]: {
        address: wsPath,
        servers: [{ $ref: '#/servers/local' }],
        messages: channelMessages,
      },
    },
    operations: {
      receiveClientMessages: {
        action: 'receive',
        channel: { $ref: `#/channels/${CHANNEL_ID}` },
        messages: operationMessageRefs(operations, 'client_to_server'),
      },
      sendServerMessages: {
        action: 'send',
        channel: { $ref: `#/channels/${CHANNEL_ID}` },
        messages: [
          ...operationMessageRefs(operations, 'server_to_client'),
          ...ackMessageRefs(operations),
        ],
      },
    },
    components: {
      messages,
    },
  };
}

function buildMessages(operations: readonly WsOperationDefinition[]): Record<string, unknown> {
  const messages: Record<string, unknown> = {};
  for (const operation of operations) {
    const id = messageId(operation.type);
    messages[id] = asyncApiMessage(operation.type, operation.description, operation.messageSchema);
    if (operation.ackSchema !== undefined) {
      const ackId = `${id}_ack`;
      messages[ackId] = asyncApiMessage(
        `${operation.type}.ack`,
        `Acknowledgement for ${operation.type}.`,
        operation.ackSchema,
      );
    }
  }
  return messages;
}

function operationMessageRefs(
  operations: readonly WsOperationDefinition[],
  direction: WsOperationDefinition['direction'],
): Array<{ $ref: string }> {
  return operations
    .filter((operation) => operation.direction === direction)
    .map((operation) => ({ $ref: `#/components/messages/${messageId(operation.type)}` }));
}

function ackMessageRefs(
  operations: readonly WsOperationDefinition[],
): Array<{ $ref: string }> {
  return operations
    .filter((operation) => operation.ackSchema !== undefined)
    .map((operation) => ({ $ref: `#/components/messages/${messageId(operation.type)}_ack` }));
}

function asyncApiMessage(
  name: string,
  summary: string,
  schema: z.ZodTypeAny,
): Record<string, unknown> {
  return {
    name,
    title: titleFromName(name),
    summary,
    contentType: 'application/json',
    payload: jsonSchema(schema),
  };
}

function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const converted = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete converted['$schema'];
  return converted;
}

function messageId(type: string): string {
  return type.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function titleFromName(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
