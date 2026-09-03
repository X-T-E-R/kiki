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
  EXTERNAL_INTERACTION_NOT_OWNED_CODE,
  isExternalFailureCategory,
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
  readonly workspacePath?: string;
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
const sendInput = z.object({
  task_name: z.string().regex(/^(?!root$)[a-z0-9_]+$/),
  message: z.string().trim().min(1).max(1_000_000),
  idempotency_key: z.string().trim().min(1).optional(),
}).strict();
const interactionsInput = z.object({ cursor: z.number().int().nonnegative().optional() }).strict();
const approvalResponseInput = z.object({
  decision: z.enum(['approved', 'rejected', 'cancelled']),
  scope: z.literal('session').optional(),
  feedback: z.string().optional(),
  selected_label: z.string().optional(),
  selected_option_id: z.string().optional(),
}).strict();
const questionAnswersInput = z.record(z.string(), z.union([z.string(), z.literal(true)]));
const questionResponseInput = z.object({
  answers: questionAnswersInput,
  method: z.enum(['enter', 'space', 'number_key']).optional(),
}).strict();
const respondInput = z.discriminatedUnion('kind', [
  z.object({
    interaction_id: z.string().min(1),
    kind: z.literal('approval'),
    response: approvalResponseInput,
  }).strict(),
  z.object({
    interaction_id: z.string().min(1),
    kind: z.literal('question'),
    response: z.union([questionResponseInput, questionAnswersInput, z.null()]),
  }).strict(),
]);
const lookupInput = z.object({ dispatch_id: z.string().min(1) }).strict();
const waitInput = z
  .object({
    dispatch_id: z.string().min(1).optional(),
    timeout_s: z.number().int().nonnegative().max(600).optional(),
  })
  .strict();
const pageInput = lookupInput.extend({ cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const eventsInput = pageInput.extend({ detail: z.enum(['lifecycle', 'turn']).optional() }).strict();
const transcriptInput = pageInput.extend({ detail: z.enum(['text', 'items']).optional() }).strict();
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
const turnEventPage = z.object({
  items: z.array(z.object({
    seq: z.number().int().nonnegative(),
    event: z.object({
      type: z.string(),
      toolCallId: z.string().optional(),
      title: z.string().optional(),
      status: z.string().optional(),
    }).passthrough(),
  }).passthrough()),
}).passthrough();
const waitView = z.object({
  waitStatus: z.enum(['completed', 'timed_out', 'no_items', 'interaction_pending']),
  dispatch: dispatchView.optional(),
  interactions: z.array(z.object({
    interactionId: z.string(),
    kind: z.enum(['approval', 'question']),
    taskName: z.string(),
  }).passthrough()),
}).passthrough();
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

const KIKI_LIST_DESCRIPTION = 'List owned children and continuations.';
const KIKI_PROFILES_DESCRIPTION =
  'List named agent profiles (whenToUse, models, tools). Clients may cache this catalog.';
const INTERACTION_PENDING_NEXT_STEP =
  'Call kiki_interactions to inspect pending requests, call kiki_respond to answer each one, then call kiki_wait again.';
const KIKI_DISPATCH_DESCRIPTION =
  'Dispatch main-agent work or one stable named child asynchronously. '
  + 'task_name (named children only) must be lowercase [a-z0-9_] and must not be "root" '
  + '(uppercase letters, hyphens, and other scripts are rejected). '
  + 'Exact model_alias and thinking_effort bindings apply only when the named child is first created.';
const KIKI_WAIT_DESCRIPTION =
  'Wait for one owned dispatch or the next owned dispatch to finish or request an external interaction response. '
  + 'Honor the client timeout budget (Cursor ≈ 60 s → timeout_s ≤ 45).';

export function createKikiMcpServer(config: KikiMcpConfig, options: KikiMcpServerOptions = {}): McpServer {
  const pinnedConfig = Object.freeze({ ...config });
  const client = new ExternalDelegationRestClient(pinnedConfig, options.fetch ?? globalThis.fetch);
  const progressPollIntervalMs = Math.max(0, options.progressPollIntervalMs ?? 250);
  const binding = Object.freeze({
    version: 1,
    sessionId: pinnedConfig.sessionId,
    workspacePath: pinnedConfig.workspacePath,
  });
  const server = new McpServer({ name: 'kiki-external-delegation', version: '0.1.0' });

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

  let dispatchTool: RegisteredTool;
  const profilesTool = server.registerTool(
    'kiki_profiles',
    { description: KIKI_PROFILES_DESCRIPTION, inputSchema: emptyInput },
    async () =>
      toolResult(async () => {
        const root = await client.call('list', {});
        const catalog = profileCatalogEntries(root);
        const rendered = renderProfileCatalogEntries(catalog);
        updateProfileCatalogDescriptions(profilesTool, dispatchTool, rendered);
        return { profiles: catalog, binding };
      }),
  );
  server.registerTool(
    'kiki_list',
    { description: KIKI_LIST_DESCRIPTION, inputSchema: emptyInput },
    async () =>
      toolResult(async () => {
        const root = await client.call('list', {});
        return bindList(root, binding);
      }),
  );
  dispatchTool = server.registerTool(
    'kiki_dispatch',
    {
      description: KIKI_DISPATCH_DESCRIPTION,
      inputSchema: dispatchInput,
    },
    async (input) =>
      toolResult(async () => {
        const parsed = dispatchInput.parse(input);
        const dispatchKey = parsed.dispatch_key ?? randomUUID();
        const dispatched = await client.call('dispatch', { ...parsed, dispatch_key: dispatchKey });
        return withDispatchReceipt(dispatched, dispatchKey);
      }),
  );
  server.registerTool(
    'kiki_continue',
    { description: 'Continue an owned terminal main or named-child dispatch.', inputSchema: continueInput },
    async (input) =>
      toolResult(async () => {
        const parsed = continueInput.parse(input);
        const dispatchKey = parsed.dispatch_key ?? randomUUID();
        const dispatched = await client.call('continue', { ...parsed, dispatch_key: dispatchKey });
        return withDispatchReceipt(dispatched, dispatchKey);
      }),
  );
  server.registerTool(
    'kiki_send',
    { description: 'Queue a message for an owned named child at its next run boundary.', inputSchema: sendInput },
    async (input) =>
      toolResult(async () => {
        const parsed = sendInput.parse(input);
        const idempotencyKey = parsed.idempotency_key ?? randomUUID();
        const acceptance = await client.call<Record<string, unknown>>('send', {
          ...parsed,
          idempotency_key: idempotencyKey,
        });
        return { ...acceptance, idempotency_key: idempotencyKey };
      }),
  );
  server.registerTool(
    'kiki_interactions',
    {
      description: 'List pending approvals and questions from owned children for external answering with kiki_respond.',
      inputSchema: interactionsInput,
    },
    async (input) => toolResult(() => client.call('interactions', interactionsInput.parse(input))),
  );
  server.registerTool(
    'kiki_respond',
    {
      description: 'Answer an owned child approval or question on behalf of the external caller.',
      inputSchema: respondInput,
    },
    async (input) => toolResult(() => client.call('respond', respondInput.parse(input))),
  );
  server.registerTool(
    'kiki_status',
    { description: 'Read status for an owned dispatch handle.', inputSchema: lookupInput },
    async (input) => toolResult(() => client.call('status', lookupInput.parse(input))),
  );
  server.registerTool(
    'kiki_wait',
    {
      description: KIKI_WAIT_DESCRIPTION,
      inputSchema: waitInput,
    },
    async (input, extra) =>
      toolResult(async () => {
        const parsed = waitInput.parse(input);
        const waited = await followWaitProgress(
          client,
          parsed,
          extra,
          progressPollIntervalMs,
        );
        return withWaitGuidance(waited);
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
    { description: 'Read lifecycle or turn-detail events for an owned dispatch.', inputSchema: eventsInput },
    async (input) => toolResult(() => client.call('events', eventsInput.parse(input))),
  );
  server.registerTool(
    'kiki_transcript',
    { description: 'Read text or structured transcript items for an owned dispatch.', inputSchema: transcriptInput },
    async (input) => toolResult(() => client.call('transcript', transcriptInput.parse(input))),
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

  async call<T = unknown>(
    action: string,
    body: unknown,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
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
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        },
      );
    } catch {
      throw new KikiMcpEdgeError(
        'endpoint_unavailable',
        'Kiki delegation endpoint is unavailable.',
        'Check that Kiki is running and the configured endpoint is reachable, then retry.',
      );
    }
    if (!response.ok) throw httpStatusError(response.status);
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new KikiMcpEdgeError(
        'invalid_response',
        'Kiki delegation endpoint returned an invalid response.',
        'Retry; if the response stays invalid, ask the operator to inspect the Kiki server.',
      );
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
      const failureCode = readFailureCode(parsed.details);
      const code = failureCode ?? 'request_rejected';
      throw new KikiMcpEdgeError(
        code,
        safeRemoteMessage(parsed.msg),
        failureNextStep(code),
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

async function followWaitProgress(
  client: ExternalDelegationRestClient,
  input: z.infer<typeof waitInput>,
  context: ProgressRequestContext,
  pollIntervalMs: number,
): Promise<unknown> {
  const waitPromise = client.call(
    'wait',
    input,
    waitRequestTimeoutMs(input.timeout_s),
    context.signal,
  );
  const progressToken = context._meta?.progressToken;
  if (progressToken === undefined || input.dispatch_id === undefined) return waitPromise;

  const waitSettled = Symbol('wait-settled');
  let pollController: AbortController | undefined;
  const abortPoll = (): void => {
    pollController?.abort();
  };
  const settlement = waitPromise.then(
    () => { abortPoll(); return waitSettled; },
    () => { abortPoll(); return waitSettled; },
  );
  context.signal.addEventListener('abort', abortPoll, { once: true });
  let eventCursor = 0;
  let progress = 0;
  let reportedTool: string | undefined;
  const toolTitles = new Map<string, string>();

  try {
    while (true) {
      context.signal.throwIfAborted();
      pollController = new AbortController();
      const rawEvents = await Promise.race([
        settlement,
        client.call(
          'events',
          {
            dispatch_id: input.dispatch_id,
            cursor: eventCursor,
            limit: 100,
            detail: 'turn',
          },
          30_000,
          pollController.signal,
        ),
      ]);
      if (rawEvents === waitSettled) return await waitPromise;
      pollController = undefined;
      const events = turnEventPage.parse(rawEvents);
      let currentTool: string | undefined;
      for (const item of events.items) {
        eventCursor = Math.max(eventCursor, item.seq);
        const event = item.event;
        if (event.type === 'tool.call' && event.toolCallId !== undefined && event.title !== undefined) {
          toolTitles.set(event.toolCallId, event.title);
          currentTool = event.title;
        } else if (event.type === 'tool.update' && event.toolCallId !== undefined) {
          if (event.title !== undefined) toolTitles.set(event.toolCallId, event.title);
          currentTool = event.title ?? toolTitles.get(event.toolCallId);
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
  } finally {
    context.signal.removeEventListener('abort', abortPoll);
    abortPoll();
  }
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
      next_step: `Call kiki_wait with dispatch_id "${dispatch.dispatchId}" to block until done. If it returns interaction_pending, ${INTERACTION_PENDING_NEXT_STEP}`,
      continue_hint: continueHint,
    },
  };
}

function withWaitGuidance(value: unknown): Record<string, unknown> {
  const waited = waitView.parse(value);
  return waited.waitStatus === 'interaction_pending'
    ? { ...waited, next_step: INTERACTION_PENDING_NEXT_STEP }
    : waited;
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
  profilesTool: RegisteredTool,
  dispatchTool: RegisteredTool,
  rendered: string,
): void {
  const catalog = rendered.length === 0 ? '' : `\n\nAvailable agent profiles:\n${rendered}`;
  profilesTool.update({ description: `${KIKI_PROFILES_DESCRIPTION}${catalog}` });
  dispatchTool.update({ description: `${KIKI_DISPATCH_DESCRIPTION}${catalog}` });
}

function bindList(
  root: unknown,
  binding: Readonly<{ version: 1; sessionId: string; workspacePath?: string }>,
): Record<string, unknown> {
  const parsed = z
    .object({
      children: z.array(z.unknown()).optional(),
      continuations: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .parse(asRootObject(root));
  return {
    children: parsed.children ?? [],
    continuations: parsed.continuations ?? [],
    binding,
  };
}

function asRootObject(root: unknown): Record<string, unknown> {
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new KikiMcpEdgeError(
      'invalid_response',
      'Kiki delegation endpoint returned an invalid response.',
      'Retry; if the response stays invalid, ask the operator to inspect the Kiki server.',
    );
  }
  return root as Record<string, unknown>;
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
          : error instanceof z.ZodError
            ? {
                code: 'invalid_input',
                message: zodErrorMessage(error),
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

function zodErrorMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ');
}

function validationErrorMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500);
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

function httpStatusError(status: number): KikiMcpEdgeError {
  if (status === 401) {
    return new KikiMcpEdgeError(
      'authentication_failed',
      'Kiki delegation authentication failed.',
      'Ask the operator to verify the bearer and delegation tokens, then retry.',
    );
  }
  if (status === 404) {
    return new KikiMcpEdgeError(
      'endpoint_not_found',
      'Kiki delegation endpoint was not found.',
      'Ask the operator to verify the endpoint, session binding, and delegation feature flag.',
    );
  }
  if (status >= 500) {
    return new KikiMcpEdgeError(
      'server_error',
      'Kiki delegation server failed to process the request.',
      'Retry; if it keeps failing, ask the operator to inspect the Kiki server logs.',
    );
  }
  return new KikiMcpEdgeError(
    'transport_rejected',
    `Kiki delegation endpoint rejected the request with HTTP ${String(status)}.`,
    'Check the request and server configuration, then retry.',
  );
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
        throw new KikiMcpEdgeError(
          'invalid_response',
          'Kiki delegation endpoint returned invalid Unicode.',
          'Retry from the returned cursor; if it persists, ask the operator to inspect the Kiki server.',
        );
      }
      width = 2;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new KikiMcpEdgeError(
        'invalid_response',
        'Kiki delegation endpoint returned invalid Unicode.',
        'Retry from the returned cursor; if it persists, ask the operator to inspect the Kiki server.',
      );
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

function readFailureCode(details: unknown): string | undefined {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const code = (details as { readonly failure_code?: unknown }).failure_code;
  return typeof code === 'string' &&
    (isExternalFailureCategory(code) || code === EXTERNAL_INTERACTION_NOT_OWNED_CODE)
    ? code
    : undefined;
}
