import {
  llmCompleteRequestSchema,
  parseAndValidateStructuredOutput,
  validateSupportedOutputSchema,
  type LlmCompleteMessage,
  type LlmCompleteRequest,
  type LlmCompleteResponse,
  type LlmCompleteStreamEvent,
} from '@kiki/protocol';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IConfigService } from '#/app/config/config';
import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import { DEFAULT_MODEL_SECTION } from '#/app/kosongConfig/configSection';
import type { IPluginModelRequests } from '#/app/plugin/pluginModelRequests';
import type { IRetainedUsageService, OperationUsageSession } from '#/app/retainedUsage/retainedUsage';
import type { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import type { ISessionManager } from '#/app/sessionManager/sessionManager';
import { Error2, ErrorCodes } from '#/errors';
import type { ContentPart, Message } from '#/kosong/contract/message';
import type { ResponseFormat, ThinkingEffort } from '#/kosong/contract/provider';
import { estimateTokens, estimateTokensForMessages } from '#/kosong/contract/tokens';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { IModelCatalog } from '#/kosong/model/catalog';
import type { IModelService } from '#/kosong/model/model';
import type { ModelRequestParams } from '#/kosong/model/modelRequester';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import { readWireContextProjection } from '#/persistence/wireContextRead';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { operationRequestIdentity, type IRequestIdentityInstallation } from '#/session/requestIdentity/requestIdentityRegistry';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';
import { sessionScopeOf, workspacePersistenceScope } from '#/workspace/sessionLifecycle/internal/addressing';
import type { LlmCompleteRunOptions, LlmCompleteUsageCallback } from './outputLayer';

export interface LlmCompleteDeps {
  readonly catalog: IModelCatalog;
  readonly sessions: ISessionIndex;
  readonly modelRequests: IPluginModelRequests;
  readonly installation: IRequestIdentityInstallation;
  readonly retainedUsage: IRetainedUsageService;
  readonly config?: IConfigService;
  readonly models?: IModelService;
  readonly sessionManager?: ISessionManager;
  readonly bootstrap?: IBootstrapService;
  readonly appendLog?: IAppendLogStore;
  readonly docs?: IAtomicDocumentStore;
  readonly storage?: IFileSystemStorageService;
  readonly cpuWorker?: ICpuWorkerService;
}

const STANDALONE_SESSION_ID = 'standalone:llm_complete';
const STANDALONE_WORKSPACE_ID = 'standalone';
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9._-]+$/u;

function validateAgentId(agentId: string): string {
  if (!SAFE_AGENT_ID_RE.test(agentId) || agentId === '.' || agentId === '..' || agentId.includes('..')) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, `Invalid context_from.agent_id: "${agentId}"`);
  }
  return agentId;
}

function toCoreParts(content: LlmCompleteMessage['content']): ContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const parts: ContentPart[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      if (block.source.kind === 'url') {
        parts.push({ type: 'image_url', imageUrl: { url: block.source.url } });
      } else if (block.source.kind === 'base64') {
        parts.push({
          type: 'image_url',
          imageUrl: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        });
      }
    }
  }
  return parts;
}

function projectContextMessages(messages: readonly ContextMessage[]): Message[] {
  const out: Message[] = [];
  for (const msg of messages) {
    if (msg.origin?.kind === 'injection') continue;
    if (msg.partial === true) continue;
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const textParts = msg.content.filter((part) => part.type === 'text' || part.type === 'image_url');
    if (textParts.length === 0) continue;
    out.push({ role: msg.role, content: textParts, toolCalls: [] });
  }
  return out;
}

function resolveDefaultModelId(deps: LlmCompleteDeps): string {
  const configured = deps.config?.get<string | undefined>(DEFAULT_MODEL_SECTION);
  if (typeof configured === 'string' && configured.trim().length > 0) return configured;
  const listed = deps.models?.list();
  if (listed !== undefined) {
    const first = Object.keys(listed)[0];
    if (first !== undefined) return first;
  }
  throw new Error2(ErrorCodes.CONFIG_INVALID, 'No model was specified and no default model is configured');
}

async function resolveContextFrom(
  deps: LlmCompleteDeps,
  contextFrom: NonNullable<LlmCompleteRequest['context_from']>,
  signal: AbortSignal,
  preloadedContextMessages?: readonly ContextMessage[],
): Promise<{ readonly messages: Message[]; readonly usageSession: OperationUsageSession }> {
  const agentId = validateAgentId(contextFrom.agent_id ?? MAIN_AGENT_ID);
  const summary = await deps.sessions.get(contextFrom.session_id, undefined, signal);
  if (preloadedContextMessages !== undefined) {
    const now = Date.now();
    const usageSession: OperationUsageSession = summary ?? {
      id: contextFrom.session_id,
      workspaceId: STANDALONE_WORKSPACE_ID,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    return { messages: projectContextMessages(preloadedContextMessages), usageSession };
  }
  const live = deps.sessionManager?.get(contextFrom.session_id);
  if (live !== undefined) {
    const agent = live.accessor.get(IAgentLifecycleService).get(agentId);
    if (agent === undefined && agentId !== MAIN_AGENT_ID) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, `agent ${agentId} does not exist in session ${contextFrom.session_id}`);
    }
    const contextMessages = agent === undefined ? [] : agent.accessor.get(IAgentContextMemoryService).get();
    const now = Date.now();
    const usageSession: OperationUsageSession = summary ?? {
      id: contextFrom.session_id,
      workspaceId: STANDALONE_WORKSPACE_ID,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    return { messages: projectContextMessages(contextMessages), usageSession };
  }
  if (summary === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${contextFrom.session_id} does not exist`);
  }
  if (deps.cpuWorker === undefined || deps.appendLog === undefined || deps.storage === undefined || deps.bootstrap === undefined) {
    throw new Error2(ErrorCodes.INTERNAL, 'Cold context projection dependencies are unavailable');
  }
  const sessionScope = sessionScopeOf(
    workspacePersistenceScope(deps.bootstrap.scope('sessions'), summary.workspaceId),
    summary.id,
  );
  if (agentId !== MAIN_AGENT_ID) {
    const meta = await deps.docs?.get<SessionMeta>(sessionScope, 'state.json');
    if (meta?.agents?.[agentId] === undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, `agent ${agentId} does not exist in session ${contextFrom.session_id}`);
    }
  }
  const agentKey = `agents/${agentId}/${AGENT_WIRE_RECORD_KEY}`;
  const fileSize = await deps.storage.size(sessionScope, agentKey);
  if (fileSize === undefined) {
    return { messages: [], usageSession: summary };
  }
  const cpuWorker = deps.cpuWorker;
  const projection = await readWireContextProjection(
    (operation, options) => cpuWorker.request(operation, options),
    deps.appendLog,
    deps.storage,
    sessionScope,
    agentKey,
    signal,
  );
  return {
    messages: projectContextMessages(projection.transcript.logicalEntries),
    usageSession: summary,
  };
}

function toWireUsage(usage: TokenUsage | undefined): LlmCompleteResponse['usage'] {
  if (usage === undefined) return undefined;
  return {
    input_tokens: usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation,
    output_tokens: usage.output,
    cache_read_tokens: usage.inputCacheRead,
    cache_creation_tokens: usage.inputCacheCreation,
  };
}

function normalizeRunOptions(
  options?: LlmCompleteUsageCallback | LlmCompleteRunOptions,
): LlmCompleteRunOptions {
  if (typeof options === 'function') return { onUsage: options };
  return options ?? {};
}

export async function* streamLlmComplete(
  deps: LlmCompleteDeps,
  raw: LlmCompleteRequest,
  signal: AbortSignal,
  options?: LlmCompleteUsageCallback | LlmCompleteRunOptions,
): AsyncIterable<LlmCompleteStreamEvent> {
  const { onUsage, preloadedContextMessages } = normalizeRunOptions(options);
  let text = '';
  let thinking = '';
  let lastUsage: TokenUsage | undefined;
  let stopReason: string | undefined;
  try {
    const input = llmCompleteRequestSchema.parse(raw);
    if (input.output_schema !== undefined) {
      const schemaIssues = validateSupportedOutputSchema(input.output_schema);
      if (schemaIssues.length > 0) {
        throw new Error2(
          ErrorCodes.REQUEST_INVALID,
          `Unsupported output_schema: ${schemaIssues.map((i) => `${i.path || '$'}: ${i.message}`).join('; ')}`,
        );
      }
    }
    signal.throwIfAborted();
    const modelId = input.model ?? resolveDefaultModelId(deps);
    const requester = deps.catalog.getRequester(modelId);
    const now = Date.now();
    let usageSession: OperationUsageSession = {
      id: STANDALONE_SESSION_ID,
      workspaceId: STANDALONE_WORKSPACE_ID,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    const contextMessages: Message[] = [];
    if (input.context_from !== undefined) {
      const projected = await resolveContextFrom(deps, input.context_from, signal, preloadedContextMessages);
      contextMessages.push(...projected.messages);
      usageSession = projected.usageSession;
    }
    const requestMessages: Message[] = [
      ...contextMessages,
      ...input.messages.map((msg): Message => ({
        role: msg.role,
        content: toCoreParts(msg.content),
        toolCalls: [],
      })),
    ];
    const systemPrompt = input.system ?? '';
    const responseFormat: ResponseFormat | undefined = input.output_schema === undefined
      ? undefined
      : { type: 'json_schema', jsonSchema: { name: 'output', schema: input.output_schema, strict: true } };
    const window = requester.model.maxContextSize;
    const outputBudget = input.max_tokens === undefined
      ? undefined
      : Math.min(input.max_tokens, requester.model.maxOutputSize ?? Infinity);
    const inputTokensEstimate = estimateTokens(systemPrompt) + estimateTokensForMessages(requestMessages);
    const requestId = crypto.randomUUID();
    const logicalSessionId = input.context_from?.session_id ?? STANDALONE_SESSION_ID;
    const logicalAgentId = input.context_from?.agent_id ?? MAIN_AGENT_ID;
    signal.throwIfAborted();
    yield { type: 'started', model: requester.model.id };
    const params: ModelRequestParams = {
      cacheKey: `llm-complete:${logicalSessionId}:${requestId}`,
      maxCompletionTokens: outputBudget,
      maxContextTokens: window,
      usedContextTokens: inputTokensEstimate,
      usedContextTokensTrusted: outputBudget !== undefined,
      thinkingEffort: input.thinking === undefined ? undefined : (input.thinking ?? 'off') as ThinkingEffort,
    };
    const source = deps.modelRequests.request(
      requester,
      { systemPrompt, messages: requestMessages, tools: [], responseFormat },
      signal,
      params,
      'llm_complete',
      {
        sessionId: logicalSessionId,
        agentId: logicalAgentId,
        snapshot: async ({ turnKey, logicalIdKind, turnIndex }) => operationRequestIdentity({
          installationId: await deps.installation.get(),
          sessionId: logicalSessionId,
          agentId: logicalAgentId,
          turnKey,
          logicalIdKind,
          turnIndex,
        }),
        recordUsage: (usage, usageKnown) => {
          try {
            onUsage?.({ model: requester.model.name, usage });
          } catch {}
          return deps.retainedUsage.recordOperation(usageSession, {
            time: Date.now(),
            model: requester.model.name,
            agentId: logicalAgentId,
            provider: requester.model.providerName,
            modelAlias: requester.model.id,
            executorId: 'native',
            requestKind: 'llm_complete',
            usage,
            usageKnown,
          });
        },
      },
    );
    for await (const event of source) {
      if (event.type === 'attempt.discarded') {
        text = '';
        thinking = '';
        yield { type: 'reset' };
      } else if (event.type === 'usage') {
        lastUsage = event.usage;
      } else if (event.type === 'part') {
        if (event.part.type === 'text') {
          text += event.part.text;
          yield { type: 'delta', text: event.part.text };
        } else if (event.part.type === 'think') {
          thinking += event.part.think;
          if (input.include_thinking === true) {
            yield { type: 'thinking_delta', text: event.part.think };
          }
        }
      } else if (event.type === 'finish') {
        stopReason = event.providerFinishReason;
        const finishText = event.message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('');
        if (finishText.length > 0 || text.length === 0) text = finishText;
        const finishThinking = event.message.content
          .filter((part) => part.type === 'think')
          .map((part) => part.think)
          .join('');
        if (finishThinking.length > 0) thinking = finishThinking;
      }
    }
    signal.throwIfAborted();
    let structuredOutput: unknown;
    if (input.output_schema !== undefined) {
      const validated = parseAndValidateStructuredOutput(text, input.output_schema);
      if (!validated.ok) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, validated.error);
      }
      structuredOutput = validated.value;
    }
    yield {
      type: 'completed',
      model: requester.model.id,
      text,
      structured_output: structuredOutput,
      thinking: input.include_thinking === true ? thinking : undefined,
      stop_reason: stopReason,
      usage: toWireUsage(lastUsage),
    };
  } catch (error) {
    if (signal.aborted) {
      yield { type: 'cancelled' };
    } else {
      yield {
        type: 'failed',
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string } | null)?.code,
      };
    }
  }
}

export async function runLlmComplete(
  deps: LlmCompleteDeps,
  raw: LlmCompleteRequest,
  signal: AbortSignal,
  options?: LlmCompleteUsageCallback | LlmCompleteRunOptions,
): Promise<LlmCompleteResponse> {
  for await (const event of streamLlmComplete(deps, raw, signal, options)) {
    if (event.type === 'completed') {
      return {
        model: event.model,
        text: event.text,
        structured_output: event.structured_output,
        thinking: event.thinking,
        stop_reason: event.stop_reason,
        usage: event.usage,
      };
    }
    if (event.type === 'failed') {
      throw new Error2((event.code as typeof ErrorCodes[keyof typeof ErrorCodes] | undefined) ?? ErrorCodes.INTERNAL, event.message);
    }
    if (event.type === 'cancelled') {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Completion request was cancelled');
    }
  }
  throw new Error2(ErrorCodes.INTERNAL, 'Completion stream ended without a terminal event');
}
