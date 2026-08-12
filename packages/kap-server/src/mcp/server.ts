/**
 * Kiki MCP edge — narrow stdio-facing tools over the external-delegation REST facade.
 *
 * Keeps endpoint, bearer token, dedicated delegation token, and Session
 * identity in operator configuration, validates every tool input with strict
 * Zod schemas, and returns matching text JSON and `structuredContent`
 * projections.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface KikiMcpConfig {
  readonly endpoint: string;
  readonly token: string;
  readonly delegationToken: string;
  readonly sessionId: string;
}

export interface KikiMcpServerOptions {
  readonly fetch?: typeof globalThis.fetch;
}

const dispatchInput = z
  .object({
    target: z.enum(['main', 'named']),
    task_name: z.string().regex(/^(?!root$)[a-z0-9_]+$/).optional(),
    profile_name: z.string().trim().min(1).optional(),
    model_alias: z.string().trim().min(1).optional(),
    thinking_effort: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).max(1_000_000),
  })
  .superRefine((value, ctx) => {
    if (
      value.target === 'main' &&
      (value.task_name !== undefined ||
        value.profile_name !== undefined ||
        value.model_alias !== undefined ||
        value.thinking_effort !== undefined)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Named-child fields require target named.' });
    }
  })
  .strict();
const continueInput = z.object({ dispatch_id: z.string().min(1), message: z.string().trim().min(1).max(1_000_000) }).strict();
const lookupInput = z.object({ dispatch_id: z.string().min(1) }).strict();
const pageInput = lookupInput.extend({ cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const resultInput = lookupInput.extend({ cursor: z.number().int().nonnegative().optional(), max_bytes: z.number().int().min(4).max(65_536).optional() }).strict();
const emptyInput = z.object({}).strict();

export function createKikiMcpServer(config: KikiMcpConfig, options: KikiMcpServerOptions = {}): McpServer {
  const client = new ExternalDelegationRestClient(config, options.fetch ?? globalThis.fetch);
  const server = new McpServer({ name: 'kiki-external-delegation', version: '0.1.0' });

  server.registerTool(
    'kiki_list',
    { description: 'List admitted main/named dispatchables and owned continuations.', inputSchema: emptyInput },
    async () => toolResult(client.call('list', {})),
  );
  server.registerTool(
    'kiki_dispatch',
    { description: 'Dispatch main-agent work or one stable named child asynchronously. Exact model_alias and thinking_effort bindings apply only when the named child is first created.', inputSchema: dispatchInput },
    async (input) => toolResult(client.call('dispatch', dispatchInput.parse(input))),
  );
  server.registerTool(
    'kiki_continue',
    { description: 'Continue an owned terminal main or named-child dispatch.', inputSchema: continueInput },
    async (input) => toolResult(client.call('continue', continueInput.parse(input))),
  );
  server.registerTool(
    'kiki_status',
    { description: 'Read status for an owned dispatch handle.', inputSchema: lookupInput },
    async (input) => toolResult(client.call('status', lookupInput.parse(input))),
  );
  server.registerTool(
    'kiki_result',
    { description: 'Read a UTF-8-bounded result page for an owned dispatch.', inputSchema: resultInput },
    async (input) => {
      const parsed = resultInput.parse(input);
      return toolResult(
        client
          .call<Record<string, unknown> & { text?: unknown; nextCursor?: unknown }>('result', {
            dispatch_id: parsed.dispatch_id,
            cursor: parsed.cursor,
            limit: 16_384,
          })
          .then((page) => boundUtf8Page(page, parsed.cursor ?? 0, parsed.max_bytes ?? 65_536)),
      );
    },
  );
  server.registerTool(
    'kiki_events',
    { description: 'Read a bounded event page for an owned dispatch.', inputSchema: pageInput },
    async (input) => toolResult(client.call('events', pageInput.parse(input))),
  );
  server.registerTool(
    'kiki_transcript',
    { description: 'Read a bounded transcript page for an owned dispatch.', inputSchema: pageInput },
    async (input) => toolResult(client.call('transcript', pageInput.parse(input))),
  );
  server.registerTool(
    'kiki_cancel',
    { description: 'Idempotently cancel an owned active dispatch.', inputSchema: lookupInput },
    async (input) => toolResult(client.call('cancel', lookupInput.parse(input))),
  );

  return server;
}

export function kikiMcpConfigFromEnv(env: NodeJS.ProcessEnv): KikiMcpConfig {
  const parsed = z
    .object({
      KIKI_KAP_ENDPOINT: z.string().url(),
      KIKI_KAP_TOKEN: z.string().min(1),
      KIKI_DELEGATION_TOKEN: z.string().min(1),
      KIKI_SESSION_ID: z.string().min(1),
    })
    .parse(env);
  return {
    endpoint: parsed.KIKI_KAP_ENDPOINT.replace(/\/$/, ''),
    token: parsed.KIKI_KAP_TOKEN,
    delegationToken: parsed.KIKI_DELEGATION_TOKEN,
    sessionId: parsed.KIKI_SESSION_ID,
  };
}

class ExternalDelegationRestClient {
  constructor(
    private readonly config: KikiMcpConfig,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  async call<T = unknown>(action: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.config.endpoint}/api/v2/sessions/${encodeURIComponent(this.config.sessionId)}/external-delegation/${action}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.token}`,
            'content-type': 'application/json',
            'x-kiki-delegation-token': this.config.delegationToken,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new KikiMcpEdgeError('endpoint_unavailable', 'Kiki delegation endpoint is unavailable.');
    }
    if (!response.ok) throw new KikiMcpEdgeError('transport_rejected', 'Kiki delegation endpoint rejected the request.');
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new KikiMcpEdgeError('invalid_response', 'Kiki delegation endpoint returned an invalid response.');
    }
    const parsed = z
      .object({ code: z.number(), msg: z.string(), data: z.unknown().optional() })
      .passthrough()
      .parse(envelope);
    if (parsed.code !== 0) throw new KikiMcpEdgeError('request_rejected', safeRemoteMessage(parsed.msg));
    return parsed.data as T;
  }
}

function result(data: unknown) {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text, 'utf8') > 1_048_576) {
    throw new KikiMcpEdgeError('response_too_large', 'Kiki delegation response exceeds the MCP frame limit.');
  }
  return { content: [{ type: 'text' as const, text }], structuredContent: data as Record<string, unknown> };
}

async function toolResult(promise: Promise<unknown>) {
  try {
    return result(await promise);
  } catch (error) {
    const payload = {
      error: {
        code: error instanceof KikiMcpEdgeError ? error.code : 'internal',
        message: error instanceof KikiMcpEdgeError ? error.message : 'Kiki delegation request failed.',
      },
    };
    return { ...result(payload), isError: true };
  }
}

class KikiMcpEdgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'KikiMcpEdgeError';
  }
}

function boundUtf8Page<T extends Record<string, unknown> & { text?: unknown; nextCursor?: unknown }>(
  page: T,
  cursor: number,
  maxBytes: number,
): T {
  if (typeof page.text !== 'string') return page;
  const { text, consumed } = utf8PagePrefix(
    page.text,
    maxBytes,
    page.nextCursor !== undefined,
  );
  if (consumed === page.text.length) return page;
  return { ...page, text, nextCursor: cursor + consumed };
}

function utf8PagePrefix(
  value: string,
  maxBytes: number,
  backendHasMore: boolean,
): { text: string; consumed: number } {
  let bytes = 0;
  let consumed = 0;
  while (consumed < value.length) {
    const first = value.charCodeAt(consumed);
    let width = 1;
    if (first >= 0xd800 && first <= 0xdbff) {
      if (consumed + 1 === value.length && backendHasMore) break;
      const second = value.charCodeAt(consumed + 1);
      if (second < 0xdc00 || second > 0xdfff) {
        throw new KikiMcpEdgeError('invalid_response', 'Kiki delegation endpoint returned invalid Unicode.');
      }
      width = 2;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new KikiMcpEdgeError('invalid_response', 'Kiki delegation endpoint returned invalid Unicode.');
    }
    const symbol = value.slice(consumed, consumed + width);
    const symbolBytes = Buffer.byteLength(symbol, 'utf8');
    if (bytes + symbolBytes > maxBytes) break;
    bytes += symbolBytes;
    consumed += width;
  }
  return { text: value.slice(0, consumed), consumed };
}

function safeRemoteMessage(message: string): string {
  if (/token|authorization|bearer|\\|\/\//i.test(message)) return 'Kiki delegation request failed.';
  return message.slice(0, 500);
}
