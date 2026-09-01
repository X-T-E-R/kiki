/**
 * Kiki MCP edge — narrow stdio-facing tools over the external-delegation REST facade.
 *
 * Keeps endpoint, bearer token, dedicated delegation token, and Session
 * identity in operator configuration, validates every tool input with strict
 * Zod schemas, and returns matching text JSON and `structuredContent`
 * projections.
 */

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  renderProfileCatalogEntries,
  type DispatchProfileCatalogEntry,
} from '@moonshot-ai/agent-core-v2';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

export interface KikiMcpConfig {
  readonly endpoint: string;
  readonly token: string;
  readonly delegationToken: string;
  readonly sessionId: string;
  readonly workspacePath: string;
}

export interface KikiMcpServerOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly progressPollIntervalMs?: number;
}

const dispatchInput = z
  .object({
    target: z.enum(['main', 'named']),
    task_name: z
      .string()
      .regex(/^(?!root$)[a-z0-9_]+$/, 'task_name must be lowercase [a-z0-9_] and must not be "root"')
      .optional(),
    profile_name: z.string().trim().min(1).optional(),
    model_alias: z.string().trim().min(1).optional(),
    thinking_effort: z.string().trim().min(1).optional(),
    dispatch_key: z.string().trim().min(1).optional(),
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
const continueInput = z
  .object({
    dispatch_id: z.string().min(1),
    dispatch_key: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).max(1_000_000),
  })
  .strict();
const lookupInput = z.object({ dispatch_id: z.string().min(1) }).strict();
const waitInput = z
  .object({
    dispatch_id: z.string().min(1).optional(),
    timeout_s: z.number().int().nonnegative().max(600).optional(),
  })
  .strict();
const pageInput = lookupInput.extend({ cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const resultInput = lookupInput.extend({ cursor: z.number().int().nonnegative().optional(), max_bytes: z.number().int().min(4).optional() }).strict();
const emptyInput = z.object({}).strict();
const dispatchStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
const dispatchView = z
  .object({
    dispatchId: z.string().min(1),
    target: z.enum(['main', 'named']),
    taskName: z.string().optional(),
    actualProfile: z.string().optional(),
    profileName: z.string().optional(),
    status: dispatchStatus,
  })
  .passthrough();
const eventPage = z
  .object({
    items: z.array(
      z
        .object({
          seq: z.number().int().nonnegative(),
          type: z.enum(['queued', 'started', 'completed', 'failed', 'cancelled', 'interrupted']),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const transcriptPage = z
  .object({
    items: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          role: z.enum(['user', 'assistant', 'system', 'tool']),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const profileCatalogEntry = z.object({
  profileName: z.string().min(1),
  description: z.string().optional(),
  whenToUse: z.string().optional(),
  modelAlias: z.string().optional(),
  thinkingEffort: z.string().optional(),
  allowedModels: z.array(z.string()).optional(),
  alternativeModels: z.array(z.object({
    alias: z.string().min(1),
    when: z.string(),
    thinkingEffort: z.string().optional(),
  })),
  tools: z.string().optional(),
});
const delegationRoot = z.object({
  dispatchables: z.array(z.object({ kind: z.enum(['main', 'named']) }).passthrough()),
}).passthrough();

/**
 * Stable external failure taxonomy mirrored from
 * `agent-core-v2/src/session/externalDelegation/externalDelegation.ts`
 * (`ExternalFailureCategory`). The stdio edge stays dependency-light instead of
 * importing the core barrel, so keep the two lists in sync — an unknown code
 * degrades to the generic `request_rejected` edge error, never to a leak.
 */
const EXTERNAL_FAILURE_CATEGORIES = new Set([
  'auth_expired',
  'quota_exceeded',
  'model_not_supported',
  'network',
  'invalid_input',
  'internal',
]);
const KIKI_LIST_DESCRIPTION = 'List admitted main/named dispatchables and owned continuations.';
const KIKI_DISPATCH_DESCRIPTION =
  'Dispatch main-agent work or one stable named child asynchronously. '
  + 'task_name (named children only) must be lowercase [a-z0-9_] and must not be "root" '
  + '(uppercase letters, hyphens, and other scripts are rejected). '
  + 'Exact model_alias and thinking_effort bindings apply only when the named child is first created.';

export function createKikiMcpServer(config: KikiMcpConfig, options: KikiMcpServerOptions = {}): McpServer {
  const pinnedConfig = Object.freeze({ ...config });
  const client = new ExternalDelegationRestClient(pinnedConfig, options.fetch ?? globalThis.fetch);
  const progressPollIntervalMs = Math.max(0, options.progressPollIntervalMs ?? 250);
  const binding = Object.freeze({
    version: 1,
    workspacePath: pinnedConfig.workspacePath,
    sessionId: pinnedConfig.sessionId,
  });
  const server = new McpServer({ name: 'kiki-external-delegation', version: '0.1.0' });

  // The SDK validates tool input against `inputSchema` before invoking the
  // handler and reports a failure as a bare `{ isError: true, content }` with
  // no classification. Re-shape that path onto the edge's structured
  // `{ error: { code, message } }` contract so an invalid tool call reads as
  // `invalid_input` (carrying the schema hint, e.g. the task_name rule) rather
  // than an opaque MCP protocol error.
  (server as unknown as { createToolError(message: string): unknown }).createToolError = (message) => {
    const payload = { error: { code: 'invalid_input', message: validationErrorMessage(message) } };
    return { ...result(payload), isError: true };
  };

  let dispatchTool: RegisteredTool;
  const listTool = server.registerTool(
    'kiki_list',
    { description: KIKI_LIST_DESCRIPTION, inputSchema: emptyInput },
    async () =>
      toolResult(async () => {
        const root = await client.call('list', {});
        const catalog = profileCatalogEntries(root);
        const rendered = renderProfileCatalogEntries(catalog);
        updateProfileCatalogDescriptions(listTool, dispatchTool, rendered);
        return bindRoot(root, binding);
      }),
  );
  dispatchTool = server.registerTool(
    'kiki_dispatch',
    {
      description: KIKI_DISPATCH_DESCRIPTION,
      inputSchema: dispatchInput,
    },
    async (input, extra) =>
      toolResult(async () => {
        const parsed = dispatchInput.parse(input);
        const dispatchKey = parsed.dispatch_key ?? randomUUID();
        const dispatched = await client.call('dispatch', { ...parsed, dispatch_key: dispatchKey });
        const observed = await followDelegationProgress(
          client,
          dispatched,
          extra,
          progressPollIntervalMs,
        );
        return withDispatchReceipt(observed, dispatchKey);
      }),
  );
  server.registerTool(
    'kiki_continue',
    { description: 'Continue an owned terminal main or named-child dispatch.', inputSchema: continueInput },
    async (input, extra) =>
      toolResult(async () => {
        const parsed = continueInput.parse(input);
        const dispatchKey = parsed.dispatch_key ?? randomUUID();
        const dispatched = await client.call('continue', { ...parsed, dispatch_key: dispatchKey });
        const observed = await followDelegationProgress(
          client,
          dispatched,
          extra,
          progressPollIntervalMs,
        );
        return withDispatchReceipt(observed, dispatchKey);
      }),
  );
  server.registerTool(
    'kiki_status',
    { description: 'Read status for an owned dispatch handle.', inputSchema: lookupInput },
    async (input) => toolResult(() => client.call('status', lookupInput.parse(input))),
  );
  server.registerTool(
    'kiki_wait',
    { description: 'Wait for one owned dispatch or the next owned dispatch to finish.', inputSchema: waitInput },
    async (input) =>
      toolResult(() => {
        const parsed = waitInput.parse(input);
        return client.call('wait', parsed, waitRequestTimeoutMs(parsed.timeout_s));
      }),
  );
  server.registerTool(
    'kiki_result',
    { description: 'Read a UTF-8-bounded result page for an owned dispatch.', inputSchema: resultInput },
    async (input) =>
      toolResult(() => {
        const parsed = resultInput.parse(input);
        const maxBytes = Math.min(parsed.max_bytes ?? 65_536, 65_536);
        return client
          .call<Record<string, unknown> & { text?: unknown; nextCursor?: unknown }>('result', {
            dispatch_id: parsed.dispatch_id,
            cursor: parsed.cursor,
            limit: maxBytes,
          })
          .then((page) => boundUtf8Page(page, parsed.cursor ?? 0, maxBytes));
      }),
  );
  server.registerTool(
    'kiki_events',
    { description: 'Read a bounded event page for an owned dispatch.', inputSchema: pageInput },
    async (input) => toolResult(() => client.call('events', pageInput.parse(input))),
  );
  server.registerTool(
    'kiki_transcript',
    { description: 'Read a bounded transcript page for an owned dispatch.', inputSchema: pageInput },
    async (input) => toolResult(() => client.call('transcript', pageInput.parse(input))),
  );
  server.registerTool(
    'kiki_cancel',
    { description: 'Idempotently cancel an owned active dispatch.', inputSchema: lookupInput },
    async (input) => toolResult(() => client.call('cancel', lookupInput.parse(input))),
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
      KIKI_WORKSPACE_PATH: z.string().min(1).refine(isAbsolute),
    })
    .parse(env);
  return {
    endpoint: parsed.KIKI_KAP_ENDPOINT.replace(/\/$/, ''),
    token: parsed.KIKI_KAP_TOKEN,
    delegationToken: parsed.KIKI_DELEGATION_TOKEN,
    sessionId: parsed.KIKI_SESSION_ID,
    workspacePath: parsed.KIKI_WORKSPACE_PATH,
  };
}

class ExternalDelegationRestClient {
  constructor(
    private readonly config: Readonly<KikiMcpConfig>,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  async call<T = unknown>(action: string, body: unknown, timeoutMs = 30_000): Promise<T> {
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
          signal: AbortSignal.timeout(timeoutMs),
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
      .object({
        code: z.number(),
        msg: z.string(),
        data: z.unknown().optional(),
        details: z.unknown().optional(),
      })
      .passthrough()
      .parse(envelope);
    if (parsed.code !== 0) {
      // A server-side classification travels in `details.failure_code`; the
      // message itself is the domain-owned category description, so it can be
      // surfaced verbatim (safeRemoteMessage stays as belt-and-braces).
      const failureCode = readFailureCode(parsed.details);
      throw new KikiMcpEdgeError(
        failureCode ?? 'request_rejected',
        safeRemoteMessage(parsed.msg),
      );
    }
    return parsed.data as T;
  }
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

async function followDelegationProgress(
  client: ExternalDelegationRestClient,
  initial: unknown,
  context: ProgressRequestContext,
  pollIntervalMs: number,
): Promise<unknown> {
  const progressToken = context._meta?.progressToken;
  if (progressToken === undefined) return initial;

  let dispatch = dispatchView.parse(initial);
  let eventCursor = 0;
  let transcriptCursor = 0;
  let toolCallCount = 0;
  let progress = 0;
  let turnStarted = false;
  const notify = (message: string) =>
    context.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, progress: ++progress, message },
    });

  if (dispatch.status === 'running') {
    turnStarted = true;
    await notify(progressMessage('started', toolCallCount));
  } else if (isTerminalDispatchStatus(dispatch.status)) {
    await notify(progressMessage(dispatch.status, toolCallCount));
    return dispatch;
  }

  while (true) {
    context.signal.throwIfAborted();
    const [rawEvents, rawTranscript] = await Promise.all([
      client.call('events', { dispatch_id: dispatch.dispatchId, cursor: eventCursor, limit: 100 }),
      client.call('transcript', { dispatch_id: dispatch.dispatchId, cursor: transcriptCursor, limit: 50 }),
    ]);
    const events = eventPage.parse(rawEvents);
    const transcript = transcriptPage.parse(rawTranscript);
    let terminal = false;

    for (const event of events.items) {
      eventCursor = Math.max(eventCursor, event.seq);
      if (event.type === 'started' && !turnStarted) {
        turnStarted = true;
        await notify(progressMessage('started', toolCallCount));
      }
      if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled' || event.type === 'interrupted') {
        terminal = true;
      }
    }

    const newToolCalls = transcript.items.filter((item) => item.role === 'tool').length;
    const lastTranscriptItem = transcript.items.at(-1);
    if (lastTranscriptItem !== undefined) transcriptCursor = lastTranscriptItem.index + 1;
    if (newToolCalls > 0) {
      toolCallCount += newToolCalls;
      await notify(progressMessage('running', toolCallCount));
    }

    if (terminal) {
      dispatch = dispatchView.parse(
        await client.call('status', { dispatch_id: dispatch.dispatchId }),
      );
      await notify(progressMessage(dispatch.status, toolCallCount));
      return dispatch;
    }

    await delay(pollIntervalMs, undefined, { signal: context.signal });
  }
}

function isTerminalDispatchStatus(status: z.infer<typeof dispatchStatus>): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
}

function progressMessage(
  status: 'started' | z.infer<typeof dispatchStatus>,
  toolCallCount: number,
): string {
  const toolCalls = `${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'} completed`;
  return status === 'started'
    ? `Delegation turn started (${toolCalls}).`
    : `Delegation ${status} (${toolCalls}).`;
}

function withDispatchReceipt(value: unknown, dispatchKey: string): Record<string, unknown> {
  const dispatch = dispatchView.parse(value);
  const continueHint = dispatch.target === 'named'
    ? `Call kiki_dispatch with task_name "${dispatch.taskName}" and a new message to reuse this agent with its memory.`
    : `Call kiki_continue with dispatch_id "${dispatch.dispatchId}" and a new message to continue this agent with its memory.`;
  return {
    ...dispatch,
    dispatch_key: dispatchKey,
    receipt: {
      dispatch_id: dispatch.dispatchId,
      dispatch_key: dispatchKey,
      task_name: dispatch.taskName,
      actual_profile: dispatch.actualProfile,
      status: dispatch.status,
      next_step: `Call kiki_wait with dispatch_id "${dispatch.dispatchId}" to block until done, or call kiki_events to poll.`,
      continue_hint: continueHint,
    },
  };
}

function waitRequestTimeoutMs(timeoutSeconds: number | undefined): number {
  return (timeoutSeconds ?? 30) * 1_000 + 5_000;
}

function profileCatalogEntries(root: unknown): DispatchProfileCatalogEntry[] {
  const parsed = delegationRoot.parse(root);
  return parsed.dispatchables.flatMap((dispatchable) =>
    dispatchable.kind === 'named' ? [profileCatalogEntry.parse(dispatchable)] : [],
  );
}

function updateProfileCatalogDescriptions(
  listTool: RegisteredTool,
  dispatchTool: RegisteredTool,
  rendered: string,
): void {
  const catalog = rendered.length === 0 ? '' : `\n\nAvailable agent profiles:\n${rendered}`;
  listTool.update({ description: `${KIKI_LIST_DESCRIPTION}${catalog}` });
  dispatchTool.update({ description: `${KIKI_DISPATCH_DESCRIPTION}${catalog}` });
}

function bindRoot(
  root: unknown,
  binding: Readonly<{ version: 1; workspacePath: string; sessionId: string }>,
): Record<string, unknown> {
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new KikiMcpEdgeError(
      'invalid_response',
      'Kiki delegation endpoint returned an invalid response.',
    );
  }
  return { ...(root as Record<string, unknown>), binding };
}

function result(data: unknown) {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text, 'utf8') > 1_048_576) {
    throw new KikiMcpEdgeError('response_too_large', 'Kiki delegation response exceeds the MCP frame limit.');
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
          ? { code: error.code, message: error.message }
          : error instanceof z.ZodError
            ? { code: 'invalid_input', message: zodErrorMessage(error) }
            : { code: 'internal', message: 'Kiki delegation request failed.' },
    };
    return { ...result(payload), isError: true };
  }
}

/** Render the Zod issues as a single hint so an invalid tool call reads as validation feedback, not an internal failure. */
function zodErrorMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ');
}

/** Sanitize a schema-validation message surfaced to the MCP client. */
function validationErrorMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500);
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

/** Read a trusted failure classification off a REST error envelope, if any. */
function readFailureCode(details: unknown): string | undefined {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const code = (details as { readonly failure_code?: unknown }).failure_code;
  return typeof code === 'string' && EXTERNAL_FAILURE_CATEGORIES.has(code) ? code : undefined;
}
