import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createSeatKlient,
  delegationProcedureTable,
  SeatKlientError,
  type DelegationProcedureInput,
  type DelegationProcedureName,
  type SeatKlient,
} from '@moonshot-ai/klient/procedures';
import { z } from 'zod';

import {
  renderProfileCatalogEntries,
  type DispatchProfileCatalogEntry,
} from './profileCatalog';

export const EXTERNAL_INTERACTION_NOT_OWNED_CODE = 'interaction.not_owned';

const EXTERNAL_FAILURE_CATEGORIES = new Set([
  'auth_expired',
  'quota_exceeded',
  'model_not_supported',
  'network',
  'invalid_input',
  'internal',
]);

export interface KikiMcpConfig {
  readonly endpoint: string;
  readonly token: string;
  readonly delegationToken: string;
  readonly sessionId: string;
  readonly workspacePath?: string;
}

export interface KikiMcpServerOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly progressPollIntervalMs?: number;
}

interface ProgressRequestContext {
  readonly signal: AbortSignal;
  readonly _meta?: { readonly progressToken?: string | number };
  sendNotification(notification: {
    readonly method: 'notifications/progress';
    readonly params: {
      readonly progressToken: string | number;
      readonly progress: number;
      readonly message: string;
    };
  }): Promise<void>;
}

export function createKikiMcpServer(
  source: SeatKlient | KikiMcpConfig,
  options: KikiMcpServerOptions = {},
): McpServer {
  const ownsKlient = !isSeatKlient(source);
  const klient = ownsKlient
    ? createSeatKlient({ endpoint: source.endpoint, token: source.delegationToken, fetch: options.fetch })
    : source;
  const progressPollIntervalMs = Math.max(0, options.progressPollIntervalMs ?? 250);
  const server = new McpServer({ name: 'kiki-external-delegation', version: '0.1.0' });
  const closeServer = server.close.bind(server);
  let closePromise: Promise<void> | undefined;
  server.close = () => {
    closePromise ??= (async () => {
      try {
        await closeServer();
      } finally {
        if (ownsKlient) await klient.close();
      }
    })();
    return closePromise;
  };
  const tools = new Map<string, RegisteredTool>();

  (server as unknown as { createToolError(message: string): unknown }).createToolError = (message) => {
    const payload = {
      error: {
        code: 'invalid_input',
        message: validationErrorMessage(message),
        next_step: 'Fix the tool arguments and retry.',
      },
    };
    return { ...result(payload), isError: true };
  };

  const registrar = server as unknown as {
    registerTool(
      name: string,
      config: { readonly description: string; readonly inputSchema: z.ZodTypeAny },
      callback: (input: unknown, extra: unknown) => Promise<unknown>,
    ): RegisteredTool;
  };
  for (const procedure of delegationProcedureTable) {
    const codec = procedure.mcp.input as {
      readonly schema: z.ZodTypeAny;
      decode(value: unknown): unknown;
    };
    const encodeOutput = procedure.mcp.encodeOutput as (value: unknown, input: unknown) => unknown;
    const tool = registrar.registerTool(
      procedure.mcp.toolName,
      {
        description: procedure.mcp.description,
        inputSchema: codec.schema,
      },
      async (wireInput, extra) => toolResult(async () => {
        const input = codec.decode(codec.schema.parse(wireInput));
        const output = procedure.name === 'wait'
          ? await followWaitProgress(
              klient,
              input as DelegationProcedureInput<'wait'>,
              extra as ProgressRequestContext,
              progressPollIntervalMs,
            )
          : await klient.call(procedure.name, input as never);
        const normalized = procedure.name === 'result'
          ? boundResultPage(output as never, input as DelegationProcedureInput<'result'>)
          : output;
        const encoded = encodeOutput(normalized, input);
        if (procedure.name === 'profiles') updateProfileDescriptions(tools, encoded);
        return encoded;
      }),
    );
    tools.set(procedure.mcp.toolName, tool);
  }

  return server;
}

export function kikiMcpConfigFromEnv(env: NodeJS.ProcessEnv): KikiMcpConfig {
  const parsed = z
    .object({
      KIKI_KAP_ENDPOINT: z.string().url(),
      KIKI_KAP_TOKEN: z.string().min(1),
      KIKI_DELEGATION_TOKEN: z.string().min(1),
      KIKI_SESSION_ID: z.string().min(1),
      KIKI_WORKSPACE_PATH: z.string().min(1).refine(isAbsolute),
    })
    .parse(env);
  return {
    endpoint: parsed.KIKI_KAP_ENDPOINT.replace(/\/$/u, ''),
    token: parsed.KIKI_KAP_TOKEN,
    delegationToken: parsed.KIKI_DELEGATION_TOKEN,
    sessionId: parsed.KIKI_SESSION_ID,
    workspacePath: parsed.KIKI_WORKSPACE_PATH,
  };
}

function isSeatKlient(value: SeatKlient | KikiMcpConfig): value is SeatKlient {
  return typeof (value as { readonly call?: unknown }).call === 'function';
}

async function followWaitProgress(
  klient: SeatKlient,
  input: DelegationProcedureInput<'wait'>,
  context: ProgressRequestContext,
  pollIntervalMs: number,
): Promise<Awaited<ReturnType<SeatKlient['wait']>>> {
  const waitPromise = klient.wait(input, { signal: context.signal });
  const progressToken = context._meta?.progressToken;
  if (progressToken === undefined || input.dispatchId === undefined) return waitPromise;

  const waitSettled = { settled: true as const };
  const settlement = waitPromise.then(
    () => waitSettled,
    () => waitSettled,
  );
  let eventCursor = 0;
  let progress = 0;
  let reportedTool: string | undefined;
  const toolTitles = new Map<string, string>();

  while (true) {
    context.signal.throwIfAborted();
    const rawEvents = await Promise.race([
      settlement,
      klient.events({
        dispatchId: input.dispatchId,
        cursor: eventCursor,
        limit: 100,
        detail: 'turn',
      }),
    ]);
    if ('settled' in rawEvents) return await waitPromise;
    let currentTool: string | undefined;
    for (const item of rawEvents.items) {
      if (!('event' in item) || item.event === null || typeof item.event !== 'object') continue;
      eventCursor = Math.max(eventCursor, item.seq);
      const event = item.event as {
        readonly type?: unknown;
        readonly toolCallId?: unknown;
        readonly title?: unknown;
      };
      if (
        event.type === 'tool.call' &&
        typeof event.toolCallId === 'string' &&
        typeof event.title === 'string'
      ) {
        toolTitles.set(event.toolCallId, event.title);
        currentTool = event.title;
      } else if (event.type === 'tool.update' && typeof event.toolCallId === 'string') {
        if (typeof event.title === 'string') toolTitles.set(event.toolCallId, event.title);
        currentTool = typeof event.title === 'string'
          ? event.title
          : toolTitles.get(event.toolCallId);
      }
    }
    if (currentTool !== undefined && currentTool !== reportedTool) {
      reportedTool = currentTool;
      await context.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: ++progress,
          message: `Delegation running tool: ${currentTool}.`,
        },
      });
    }
    const delayed = await Promise.race([
      settlement,
      delay(pollIntervalMs, undefined, { signal: context.signal }),
    ]);
    if (delayed === waitSettled) return await waitPromise;
  }
}

function updateProfileDescriptions(
  tools: ReadonlyMap<string, RegisteredTool>,
  encoded: unknown,
): void {
  const profiles = z
    .object({
      profiles: z.array(z.object({
        profileName: z.string(),
        description: z.string().optional(),
        whenToUse: z.string().optional(),
        modelAlias: z.string().optional(),
        thinkingEffort: z.string().optional(),
        allowedModels: z.array(z.string()).optional(),
        alternativeModels: z.array(z.object({
          alias: z.string(),
          when: z.string(),
          thinkingEffort: z.string().optional(),
        })),
        tools: z.string().optional(),
      })),
    })
    .parse(encoded)
    .profiles as DispatchProfileCatalogEntry[];
  const rendered = renderProfileCatalogEntries(profiles);
  const catalog = rendered.length === 0 ? '' : `\n\nAvailable agent profiles:\n${rendered}`;
  for (const toolName of ['kiki_profiles', 'kiki_dispatch']) {
    const procedure = delegationProcedureTable.find((candidate) => candidate.mcp.toolName === toolName)!;
    tools.get(toolName)?.update({ description: `${procedure.mcp.description}${catalog}` });
  }
}

function boundResultPage(
  page: Awaited<ReturnType<SeatKlient['result']>>,
  input: DelegationProcedureInput<'result'>,
): Awaited<ReturnType<SeatKlient['result']>> {
  const maxBytes = Math.min(input.limit ?? 65_536, 65_536);
  const { text, consumed } = utf8PagePrefix(page.text, maxBytes, page.nextCursor !== undefined);
  if (consumed === page.text.length) return page;
  return { ...page, text, nextCursor: (input.cursor ?? 0) + consumed };
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
      if (second < 0xdc00 || second > 0xdfff) throw invalidResponseError();
      width = 2;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw invalidResponseError();
    }
    const symbol = value.slice(consumed, consumed + width);
    const symbolBytes = Buffer.byteLength(symbol, 'utf8');
    if (bytes + symbolBytes > maxBytes) break;
    bytes += symbolBytes;
    consumed += width;
  }
  return { text: value.slice(0, consumed), consumed };
}

function result(data: unknown) {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text, 'utf8') > 1_048_576) {
    throw new KikiMcpEdgeError(
      'response_too_large',
      'Kiki delegation response exceeds the MCP frame limit.',
      'Request a smaller page and retry.',
    );
  }
  return { content: [{ type: 'text' as const, text }], structuredContent: data as Record<string, unknown> };
}

async function toolResult(produce: () => Promise<unknown>) {
  try {
    return result(await produce());
  } catch (error) {
    const payload = {
      error:
        error instanceof KikiMcpEdgeError
          ? { code: error.code, message: error.message, next_step: error.nextStep }
          : error instanceof SeatKlientError
            ? seatKlientFailure(error)
            : error instanceof z.ZodError
              ? {
                  code: 'invalid_input',
                  message: error.issues.map((issue) => issue.message).join('; '),
                  next_step: 'Fix the tool arguments and retry.',
                }
              : {
                  code: 'internal',
                  message: 'Kiki delegation request failed.',
                  next_step: 'Retry; if it keeps failing, ask the operator to inspect the Kiki server.',
                },
    };
    return { ...result(payload), isError: true };
  }
}

function seatKlientFailure(error: SeatKlientError) {
  const failureCode = readFailureCode(error.details);
  const code = error.code === 40101 ? 'authentication_failed' : failureCode ?? 'request_rejected';
  return {
    code,
    message: safeRemoteMessage(error.message),
    next_step: failureNextStep(code),
  };
}

function readFailureCode(details: unknown): string | undefined {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const code = (details as { readonly failure_code?: unknown }).failure_code;
  return typeof code === 'string' &&
    (EXTERNAL_FAILURE_CATEGORIES.has(code) || code === EXTERNAL_INTERACTION_NOT_OWNED_CODE)
    ? code
    : undefined;
}

function failureNextStep(code: string): string {
  if (code === 'auth_expired') return 'Ask the operator to re-authenticate the provider, then retry.';
  if (code === 'quota_exceeded') return 'Retry after the provider quota or rate limit resets.';
  if (code === 'model_not_supported') return 'Choose an admitted model or ask the operator to update the profile.';
  if (code === 'network') return 'Retry after checking provider and network availability.';
  if (code === 'invalid_input') return 'Fix the request input and retry.';
  if (code === EXTERNAL_INTERACTION_NOT_OWNED_CODE) {
    return 'Call kiki_interactions to refresh the pending requests before responding again.';
  }
  return 'Retry; if it keeps failing, ask the operator to inspect the Kiki server.';
}

function validationErrorMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 500);
}

function safeRemoteMessage(message: string): string {
  if (/token|authorization|bearer|\\|\/\//iu.test(message)) return 'Kiki delegation request failed.';
  return message.slice(0, 500);
}

function invalidResponseError(): KikiMcpEdgeError {
  return new KikiMcpEdgeError(
    'invalid_response',
    'Kiki delegation endpoint returned invalid Unicode.',
    'Retry from the returned cursor; if it persists, ask the operator to inspect the Kiki server.',
  );
}

class KikiMcpEdgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextStep: string,
  ) {
    super(message);
    this.name = 'KikiMcpEdgeError';
  }
}
