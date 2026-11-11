import { scope, Service, type Context } from '@kiki/cordis-runtime';
import { ToolCallId } from './vendor/llm/src/brand';
import { HarnessError } from './vendor/llm/src/error';
import type { UserMessage } from './vendor/llm/src/message';
import type { ContentBlock } from './vendor/llm/src/types';

const { scopeChainOf, scopeOf, scopeTarget } = scope;
import { ToolArgsError } from './vendor/tools/src/schema';
import { validateJsonSchemaValue } from './vendor/tools/src/json-schema';
import {
  type PostToolDecision,
  type PreToolDecision,
  TOOL_ABORTED,
  TOOL_ABORTED_BEFORE_DISPATCH,
  type ToolDefinition,
  type ToolDispatchExecution,
  type ToolExecution,
  type ToolExecutionInput,
  type ToolExecutionResult,
  type ToolExecutionToken,
  ToolNotFoundError,
  ToolOutputError,
  type ToolRunContext,
} from './vendor/tools/src/index';
import { deepFreeze, type JsonValue, snapshotJsonValue } from './vendor/util-values/src/index';

import type { DshAttachmentsPort } from './hostServicesBridge';
import type { DshAgentIdentityRegistry } from './initiatorAls';
import type {
  DshBridgedToolDefinition,
  DshLiveAgentFacade,
  DshPostToolDecision,
  DshPreToolDecision,
  DshRenderedContentBlock,
} from './index';

export { ToolNotFoundError, ToolOutputError };
export type {
  ContentBlock as DshContentBlock,
  ToolDefinition as DshToolDefinition,
  ToolDispatchExecution as DshToolDispatchExecution,
  ToolExecution as DshToolExecution,
  ToolExecutionResult as DshToolResult,
};

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolRuntimeBridge;
  }
}

interface ToolLayer {
  readonly tools: Map<string, ToolDefinition>;
}

function createExecutionToken(callId: string): ToolExecutionToken {
  return Symbol(callId) as ToolExecutionToken;
}

export class ToolRuntimeBridge extends Service {
  private readonly global: ToolLayer = { tools: new Map() };
  private readonly scoped = new WeakMap<object, ToolLayer>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(
    ctx: Context,
    private readonly initiators: DshAgentIdentityRegistry,
    private readonly options: {
      readonly nativeTools?: (agent?: DshLiveAgentFacade) => readonly { name: string; timeoutMs?: number | null }[];
      readonly attachments?: () => DshAttachmentsPort | undefined;
    } = {},
  ) {
    super(ctx, 'tools');
    ctx.get('systemPrompt', false)?.tools(context => ({
      schemas: this.schemas(context.scope),
      knownNames: this.schemas(context.scope).map(schema => schema.name),
    }));
  }

  private emitUnfiltered(eventName: string, ...args: unknown[]): void {
    (this.ctx as unknown as { emit(name: string, ...payload: unknown[]): void }).emit(eventName, ...args);
  }

  private emitScoped(scopeKey: object | undefined, eventName: string, ...args: unknown[]): void {
    const carrier = scopeTarget(this, scopeKey);
    (this.ctx as unknown as { emit(thisArg: object, name: string, ...payload: unknown[]): void }).emit(
      carrier,
      eventName,
      ...args,
    );
  }

  private async runScopedWaterfall<TResult>(
    scopeKey: object | undefined,
    eventName: string,
    args: unknown[],
    terminal: () => Promise<TResult>,
  ): Promise<TResult> {
    const carrier = scopeTarget(this, scopeKey);
    return  (this.ctx as unknown as {
      waterfall(thisArg: object, name: string, ...rest: unknown[]): Promise<TResult>;
    }).waterfall(carrier, eventName, ...args, terminal);
  }

  register(definition: ToolDefinition, callerCtx: Context = this.ctx): () => void {
    if (this.disposed) throw new Error('DSH tool registry is disposed');
    if (definition.output === undefined || typeof definition.output.render !== 'function') {
      throw new TypeError(`tool "${definition.name}" must declare output { schema, render }`);
    }
    const scope = scopeOf(callerCtx);
    const layer = scope === undefined ? this.global : this.scoped.get(scope) ?? { tools: new Map() };
    if (scope !== undefined) this.scoped.set(scope, layer);
    const dispose = callerCtx.effect(() => {
      if (layer.tools.has(definition.name)) {
        throw new Error(`tool "${definition.name}" is already registered in this scope`);
      }
      layer.tools.set(definition.name, definition);
      this.emitUnfiltered('tools/change');
      return () => {
        layer.tools.delete(definition.name);
        this.emitUnfiltered('tools/change');
      };
    }, 'tools.register');
    return () => {
      void dispose();
    };
  }

  get(name: string, scope?: object): ToolDefinition | undefined {
    const key = scope !== null && typeof scope === 'object' && 'scopeKey' in scope
      ? (scope as { scopeKey: object }).scopeKey
      : scope;
    for (const current of scopeChainOf(key)) {
      const definition = this.scoped.get(current)?.tools.get(name);
      if (definition !== undefined) return definition;
    }
    const local = this.global.tools.get(name);
    if (local !== undefined) return local;
    const agentFacade = scope !== null && typeof scope === 'object' && 'visibleTools' in scope
      ? (scope as DshLiveAgentFacade)
      : undefined;
    const hostVisible = this.options.nativeTools?.(agentFacade) ?? agentFacade?.visibleTools ?? [];
    const matchedNative = hostVisible.find(entry => entry.name === name);
    if (matchedNative !== undefined) {
      return {
        name: matchedNative.name,
        description: '',
        parameters: { type: 'object', properties: {} },
        ...(matchedNative.timeoutMs === undefined || matchedNative.timeoutMs === null
          ? {}
          : { timeoutMs: matchedNative.timeoutMs }),
        output: {
          schema: {},
          render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
        },
        execute: () => Promise.reject(new Error(`native tool "${matchedNative.name}" executes on the host pipeline`)),
      };
    }
    return undefined;
  }

  schemas(scope?: object): readonly {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    deferLoading?: true;
  }[] {
    const key = scope !== null && typeof scope === 'object' && 'scopeKey' in scope
      ? (scope as { scopeKey: object }).scopeKey
      : scope;
    const visible = new Map<string, ToolDefinition>(this.global.tools);
    for (const current of scopeChainOf(key).toReversed()) {
      for (const [name, definition] of this.scoped.get(current)?.tools ?? []) {
        visible.set(name, definition);
      }
    }
    return [...visible.values()].map(definition => ({
      name: definition.name,
      description: definition.description,
      parameters: structuredClone(definition.parameters),
      ...(definition.deferLoading === true ? { deferLoading: true as const } : {}),
    }));
  }

  bridgedDefinitions(scope?: object): readonly DshBridgedToolDefinition[] {
    const key = scope !== null && typeof scope === 'object' && 'scopeKey' in scope
      ? (scope as { scopeKey: object }).scopeKey
      : scope;
    const visible = new Map<string, ToolDefinition>(this.global.tools);
    for (const current of scopeChainOf(key).toReversed()) {
      for (const [name, definition] of this.scoped.get(current)?.tools ?? []) {
        visible.set(name, definition);
      }
    }
    return [...visible.values()].map(definition => this.toBridgedDefinition(definition));
  }

  toBridgedDefinition(definition: ToolDefinition): DshBridgedToolDefinition {
    return {
      name: definition.name,
      description: definition.description,
      inputJsonSchema: structuredClone(definition.parameters),
      outputJsonSchema: structuredClone(definition.output.schema as Record<string, unknown>),
      timeoutMs: definition.timeoutMs ?? null,
      concurrencySafe: definition.isConcurrencySafe === undefined ? undefined : definition.isConcurrencySafe({}),
      execute: (args, host) => this.track(this.initiators.withInitiator(host.agent, async () => {
        if (this.lookupRegisteredTool(definition.name, host.agent) !== definition) {
          throw new ToolNotFoundError(definition.name);
        }
        const detached = snapshotJsonValue(args);
        if (detached === undefined) throw new ToolArgsError(['arguments must be lossless JSON']);
        const signal = AbortSignal.any([host.signal, this.lifetime.signal]);
        signal.throwIfAborted();
        const callId = ToolCallId(host.toolCallId);
        return executeToolBody(definition, {
          callId,
          rootCallId: callId,
          name: definition.name,
          arguments: deepFreeze(detached),
          agent: host.agent,
          signal,
          token: createExecutionToken(callId),
          deferContext(message) {
            if (host.deferContext === undefined) throw new HarnessError('Host tool execution must provide deferContext for this tool.', 'DSH_COMPAT_MISSING_REQUIRED_SERVICE');
            for (const context of extractAdditionalContexts([message])) host.deferContext(context);
          },
          concludeTurn() {
            if (host.concludeTurn === undefined) throw new HarnessError('Host tool execution must provide concludeTurn for this tool.', 'DSH_COMPAT_MISSING_REQUIRED_SERVICE');
            host.concludeTurn();
          },
        });
      })),
      renderOutput: (args, value) => {
        const blocks = definition.output.render(args, value as any);
        return this.normalizeRenderedBlocks(blocks);
      },
      presentCall: definition.presentCall === undefined
        ? undefined
        : args => definition.presentCall!(args) as unknown as Readonly<Record<string, unknown>> | undefined,
      presentResult: definition.presentResult === undefined
        ? undefined
        : (args, value) => {
            const content = definition.output.render(args, value as any);
            const meta = definition.output.presentationMeta?.(args, value as any);
            return definition.presentResult!(args, {
              isError: false,
              content,
              ...(meta === undefined ? {} : { meta }),
            }) as unknown as Readonly<Record<string, unknown>> | undefined;
          },
    };
  }

  normalizeRenderedBlocks(blocks: readonly ContentBlock[]): readonly DshRenderedContentBlock[] {
    const attachments = this.options.attachments?.();
    return blocks.map((block): DshRenderedContentBlock => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      }
      if (block.type === 'image') {
        const dataBase64 = attachments?.readBase64?.(block.attachment.attachmentId);
        return {
          type: 'image',
          mimeType: block.attachment.mediaType,
          attachmentId: block.attachment.attachmentId,
          ...(dataBase64 === undefined ? {} : { dataBase64 }),
        };
      }
      if (block.type === 'resource_link') {
        return {
          type: 'resource_link',
          uri: block.uri,
          ...(block.name === undefined ? {} : { name: block.name }),
          ...(block.mimeType === undefined ? {} : { mimeType: block.mimeType }),
          ...(block.description === undefined ? {} : { description: block.description }),
        };
      }
      if (block.type === 'file') {
        return {
          type: 'resource_link',
          uri: `attachment://${block.attachment.attachmentId}`,
          name: block.attachment.name,
        };
      }
      return { type: 'text', text: JSON.stringify(block) };
    });
  }

  visibleTools(agent?: DshLiveAgentFacade): readonly { name: string; timeoutMs?: number | null }[] {
    const plugin = this.schemas(agent).map(schema => ({
      name: schema.name,
      timeoutMs: this.global.tools.get(schema.name)?.timeoutMs
        ?? (agent === undefined ? undefined : this.scoped.get(agent.scopeKey)?.tools.get(schema.name)?.timeoutMs)
        ?? null,
    }));
    const names = new Set(plugin.map(tool => tool.name));
    const native = this.options.nativeTools?.(agent) ?? [];
    return [...native.filter(tool => !names.has(tool.name)), ...plugin];
  }

  executionMode(exec: { name: string; arguments: unknown; agent?: DshLiveAgentFacade }): { kind: 'parallel' | 'exclusive' } {
    const tool = this.get(exec.name, exec.agent);
    try {
      return tool?.isConcurrencySafe?.(exec.arguments) === true ? { kind: 'parallel' } : { kind: 'exclusive' };
    } catch {
      return { kind: 'exclusive' };
    }
  }

  presentCall(name: string, args: unknown, agent?: DshLiveAgentFacade): Readonly<Record<string, unknown>> | undefined {
    return this.get(name, agent)?.presentCall?.(args) as unknown as Readonly<Record<string, unknown>> | undefined;
  }

  presentResult(name: string, args: unknown, result: ToolExecutionResult, agent?: DshLiveAgentFacade): Readonly<Record<string, unknown>> | undefined {
    return this.get(name, agent)?.presentResult?.(args, {
      content: result.content,
      isError: result.isError,
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    }) as unknown as Readonly<Record<string, unknown>> | undefined;
  }

  async runPreExecuteGate(input: {
    readonly callId: string;
    readonly name: string;
    readonly arguments: unknown;
    readonly agent?: DshLiveAgentFacade;
    readonly signal: AbortSignal;
  }): Promise<DshPreToolDecision> {
    const detached = snapshotJsonValue(input.arguments);
    if (detached === undefined) {
      return { action: 'deny', reason: 'arguments must be lossless JSON' };
    }
    const exec: ToolExecution = {
      callId: ToolCallId(input.callId),
      rootCallId: ToolCallId(input.callId),
      name: input.name,
      arguments: deepFreeze(detached),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      signal: input.signal,
      token: createExecutionToken(input.callId),
    };
    const run = async (): Promise<DshPreToolDecision> => {
      const gate = await this.runScopedWaterfall<PreToolDecision>(
        exec.agent?.scopeKey,
        'tools/pre-execute',
        [exec],
        async () => ({ kind: 'allow' }),
      );
      if (gate.kind === 'allow') return { action: 'allow' };
      if (gate.kind === 'deny') return { action: 'deny', reason: gate.reason };
      if (gate.kind === 'cancel') {
        return { action: 'cancel', ...(gate.reason === undefined ? {} : { reason: gate.reason }) };
      }
      const prompt = typeof gate.displayReason === 'string'
        ? gate.displayReason
        : gate.displayReason?.en ?? gate.reason;
      return { action: 'ask', ...(prompt === undefined ? {} : { prompt }) };
    };
    return input.agent === undefined ? run() : this.initiators.withInitiator(input.agent, run);
  }

  async runAroundExecute(
    input: {
      readonly callId: string;
      readonly name: string;
      readonly arguments: unknown;
      readonly agent?: DshLiveAgentFacade;
      readonly signal: AbortSignal;
    },
    invokeDownstream: (overrideSignal: AbortSignal) => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> {
    const detached = snapshotJsonValue(input.arguments) ?? {};
    const callerSignal = input.signal;
    const fusedInitial = AbortSignal.any([callerSignal, this.lifetime.signal]);
    const exec: ToolDispatchExecution = {
      callId: ToolCallId(input.callId),
      rootCallId: ToolCallId(input.callId),
      name: input.name,
      arguments: deepFreeze(detached),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      signal: fusedInitial,
      token: createExecutionToken(input.callId),
    };
    const run = async (): Promise<ToolExecutionResult> => {
      const wrapperSignal = exec.signal;
      try {
        return await this.runScopedWaterfall<ToolExecutionResult>(
          exec.agent?.scopeKey,
          'tools/execute',
          [exec],
          async () => {
            const currentSignal = exec.signal;
            const effective = currentSignal === callerSignal
              ? currentSignal
              : AbortSignal.any([callerSignal, currentSignal]);
            exec.signal = effective;
            try {
              if (effective.aborted) return abortedResult(false);
              return await invokeDownstream(effective);
            } finally {
              exec.signal = currentSignal;
            }
          },
        );
      } finally {
        exec.signal = wrapperSignal;
      }
    };
    return this.track(input.agent === undefined ? run() : this.initiators.withInitiator(input.agent, run));
  }

  async runPostExecute(input: {
    readonly callId: string;
    readonly name: string;
    readonly arguments: unknown;
    readonly agent?: DshLiveAgentFacade;
    readonly result: ToolExecutionResult;
    readonly signal: AbortSignal;
  }): Promise<{ readonly result: ToolExecutionResult; readonly decision: DshPostToolDecision }> {
    const detached = snapshotJsonValue(input.arguments) ?? {};
    const exec: ToolExecution = {
      callId: ToolCallId(input.callId),
      rootCallId: ToolCallId(input.callId),
      name: input.name,
      arguments: deepFreeze(detached),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      signal: input.signal,
      token: createExecutionToken(input.callId),
    };
    const run = async () => {
      const post = await this.runScopedWaterfall<PostToolDecision>(
        exec.agent?.scopeKey,
        'tools/post-execute',
        [exec, input.result],
        async () => ({ kind: 'accept' }),
      );
      let finalResult = input.result;
      if (post.kind === 'block') {
        finalResult = {
          isError: true,
          content: post.feedback,
          error: { message: textOf(post.feedback) },
          ...(post.additionalContexts === undefined ? {} : { additionalContexts: post.additionalContexts }),
        };
      } else {
        const mergedContexts = [
          ...(finalResult.additionalContexts ?? []),
          ...(post.additionalContexts ?? []),
        ];
        finalResult = {
          ...finalResult,
          content: post.content ?? finalResult.content,
          ...(mergedContexts.length > 0 ? { additionalContexts: mergedContexts } : {}),
        };
      }
      const additionalContexts = extractAdditionalContexts(finalResult.additionalContexts);
      return {
        result: finalResult,
        decision: { additionalContexts: additionalContexts.length > 0 ? additionalContexts : undefined },
      };
    };
    return input.agent === undefined ? run() : this.initiators.withInitiator(input.agent, run);
  }

  execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
    if (this.disposed) return Promise.resolve(errorResult(new Error('DSH tool registry is disposed')));
    return this.track(input.agent === undefined
      ? this.executeInner(input)
      : this.initiators.withInitiator(input.agent, () => this.executeInner(input)));
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.active.add(operation);
    const remove = () => { this.active.delete(operation); };
    void operation.then(remove, remove);
    return operation;
  }

  private async executeInner(input: ToolExecutionInput): Promise<ToolExecutionResult> {
    const detached = snapshotJsonValue(input.arguments);
    if (detached === undefined) return errorResult(new ToolArgsError(['arguments must be lossless JSON']));
    const deferred: UserMessage[] = [];
    let concludesTurn = false;
    const callerSignal = input.signal;
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
    const callId = ToolCallId(input.callId);
    const rootCallId = ToolCallId(input.rootCallId ?? input.callId);
    const exec: Omit<ToolRunContext, 'signal'> & { signal: AbortSignal } = {
      callId,
      rootCallId,
      name: input.name,
      arguments: deepFreeze(detached),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      signal,
      token: createExecutionToken(callId),
      deferContext: (context) => {
        deferred.push(context);
      },
      concludeTurn: () => {
        concludesTurn = true;
      },
    };
    let bodyInvoked = false;
    let result: ToolExecutionResult;
    try {
      if (signal.aborted) return this.finish(exec, abortedResult(false));
      const gate = await this.runScopedWaterfall<PreToolDecision>(
        exec.agent?.scopeKey,
        'tools/pre-execute',
        [exec],
        async () => ({ kind: 'allow' }),
      );
      let decision = gate;
      if (gate.kind === 'ask') {
        const approval = (this.ctx as unknown as {
          get(name: string): { request(req: object): Promise<string> } | undefined;
        }).get('approval');
        if (approval === undefined || exec.agent === undefined) {
          decision = {
            kind: 'deny',
            reason: gate.reason ?? `tool "${exec.name}" requires approval but no approval channel is available`,
          };
        } else {
          const outcome = await approval.request({
            agent: exec.agent,
            toolName: exec.name,
            callId: exec.callId,
            reason: gate.reason,
            displayReason: gate.displayReason,
            signal: exec.signal,
          });
          decision = outcome === 'allowed-once'
            ? { kind: 'allow' }
            : { kind: 'deny', reason: `tool "${exec.name}" was not approved (${outcome})` };
        }
      }
      if (decision.kind === 'cancel') {
        result = abortedResult(false);
      } else if (decision.kind === 'deny') {
        result = {
          isError: true,
          content: [{ type: 'text', text: `Error: ${decision.reason}` }],
          error: { message: decision.reason, ...(decision.info === undefined ? {} : { info: decision.info }) },
        };
      } else {
        const tool = this.lookupRegisteredTool(exec.name, exec.agent);
        if (tool === undefined) throw new ToolNotFoundError(exec.name);
        const wrapperSignal = exec.signal;
        result = await this.runScopedWaterfall<ToolExecutionResult>(
          exec.agent?.scopeKey,
          'tools/execute',
          [exec],
          async (): Promise<ToolExecutionResult> => {
            const currentSignal = exec.signal;
            const fused = currentSignal === callerSignal
              ? currentSignal
              : AbortSignal.any([callerSignal, currentSignal]);
            exec.signal = fused;
            try {
              if (fused.aborted) return abortedResult(false);
              bodyInvoked = true;
              const value = await executeToolBody(tool, exec);
              const meta = tool.output.presentationMeta?.(exec.arguments, value);
              return {
                isError: false,
                value,
                content: tool.output.render(exec.arguments, value),
                ...(meta === undefined ? {} : { meta }),
                ...(concludesTurn ? { concludesTurn: true as const } : {}),
              };
            } catch (error) {
              return errorResult(error);
            } finally {
              exec.signal = currentSignal;
            }
          },
        );
        exec.signal = wrapperSignal;
      }
      if (signal.aborted && !result.isError) result = abortedResult(bodyInvoked, result);
      if (deferred.length > 0 && !result.isError) {
        result = {
          ...result,
          additionalContexts: [...deferred, ...(result.additionalContexts ?? [])],
        };
      }
      const registeredTool = this.lookupRegisteredTool(exec.name, exec.agent);
      const projected = registeredTool?.projectContent?.(exec, result);
      if (projected !== undefined) result = { ...result, content: projected };
      const post = await this.runScopedWaterfall<PostToolDecision>(
        exec.agent?.scopeKey,
        'tools/post-execute',
        [exec, result],
        async () => ({ kind: 'accept' }),
      );
      if (post.kind === 'block') {
        result = {
          isError: true,
          content: post.feedback,
          error: { message: textOf(post.feedback) },
          ...(post.additionalContexts === undefined ? {} : { additionalContexts: post.additionalContexts }),
        };
      } else {
        if (Object.hasOwn(post, 'value') && Object.hasOwn(post, 'content')) {
          throw new TypeError('post-execute cannot replace both value and content');
        }
        if (Object.hasOwn(post, 'value') && post.value !== undefined) {
          if (result.isError || registeredTool === undefined) {
            throw new TypeError('post-execute cannot replace a failed or unknown result value');
          }
          const violations = validateJsonSchemaValue(registeredTool.output.schema, post.value);
          if (violations.length > 0) throw new ToolOutputError(registeredTool.name, violations);
          result = {
            ...result,
            value: post.value,
            content: registeredTool.output.render(exec.arguments, post.value),
          };
        }
        const mergedContexts = [...(result.additionalContexts ?? []), ...(post.additionalContexts ?? [])];
        result = {
          ...result,
          content: post.content ?? result.content,
          ...(mergedContexts.length > 0 ? { additionalContexts: mergedContexts } : {}),
        };
      }
      return this.finish(exec, result);
    } catch (error) {
      return this.finish(exec, errorResult(error));
    }
  }

  private lookupRegisteredTool(name: string, scope?: object): ToolDefinition | undefined {
    const key = scope !== null && typeof scope === 'object' && 'scopeKey' in scope
      ? (scope as { scopeKey: object }).scopeKey
      : scope;
    for (const current of scopeChainOf(key)) {
      const definition = this.scoped.get(current)?.tools.get(name);
      if (definition !== undefined) return definition;
    }
    return this.global.tools.get(name);
  }

  private finish(exec: ToolExecution, result: ToolExecutionResult): ToolExecutionResult {
    const finalized = this.lookupRegisteredTool(exec.name, exec.agent)?.finalizeContent?.(exec, result);
    const materialized = deepFreeze(finalized === undefined ? result : { ...result, content: finalized });
    Object.freeze(exec);
    this.emitScoped(exec.agent?.scopeKey, 'tools/result', exec, materialized);
    return materialized;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.disposal ??= Promise.resolve().then(async () => {
      this.lifetime.abort(new Error('DSH tool registry disposed'));
      await Promise.allSettled(this.active);
    });
  }
}

async function executeToolBody(tool: ToolDefinition, exec: ToolRunContext): Promise<JsonValue> {
  const value = snapshotJsonValue(await tool.execute(exec.arguments, exec) as JsonValue | undefined);
  if (value === undefined) throw new ToolOutputError(tool.name, ['value is not lossless JSON']);
  const violations = validateJsonSchemaValue(tool.output.schema, value);
  if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
  return value;
}

export function extractAdditionalContexts(
  messages: readonly UserMessage[] | undefined,
): readonly { readonly text: string; readonly variant?: string }[] {
  if (messages === undefined || messages.length === 0) return [];
  return messages
    .map((msg) => {
      const text = msg.content
        .filter((part): part is Extract<ContentBlock, { type: 'text' }> => part.type === 'text')
        .map(part => part.text)
        .join('\n');
      const variant = typeof msg.source?.kind === 'string' ? msg.source.kind : undefined;
      return {
        text,
        ...(variant === undefined ? {} : { variant }),
      };
    })
    .filter(item => item.text.length > 0);
}

function errorResult(error: unknown): ToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error);
  const info = error instanceof HarnessError
    ? { name: error.name, code: error.code }
    : { name: error instanceof Error ? error.name : 'Error', code: 'TOOL_ERROR' };
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message, info },
  };
}

function abortedResult(bodyInvoked: boolean, prior?: ToolExecutionResult): ToolExecutionResult {
  const code = bodyInvoked ? TOOL_ABORTED : TOOL_ABORTED_BEFORE_DISPATCH;
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${code}` }],
    error: { message: code, info: { name: 'AbortError', code } },
    ...(prior?.additionalContexts === undefined ? {} : { additionalContexts: prior.additionalContexts }),
  };
}

function textOf(content: readonly ContentBlock[]): string {
  return content.map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n');
}
