import type {
  IAgentContextMemoryService,
  IAgentPromptService,
  IAgentUsageService,
  IEventBus,
  PromptHandle,
  Scope,
  TokenUsage,
} from '@kiki/agent-core-v2';
import { abortable } from '@kiki/agent-core-v2/_base/utils/abort';
import {
  parseAndValidateStructuredOutput,
  type PromptTurnResult,
  type PromptTurnUsage,
} from '@kiki/protocol';
import { IModelPricingService } from '../pricing/modelPricingService';
import type { SessionAccessStore, SessionAccessToken } from '../services/sessionAccess/store';

export interface PromptWaitObserver {
  bindPromptId(promptId: string): void;
  awaitResult(
    handle: PromptHandle,
    context: IAgentContextMemoryService,
    options: {
      readonly outputSchema?: Record<string, unknown>;
      readonly includeThinking?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<PromptTurnResult>;
  dispose(): void;
}

const MAX_SETTLED_RECEIPTS_PER_AGENT = 64;
const settledReceiptsByPromptService = new WeakMap<IAgentPromptService, Map<string, PromptTurnResult>>();
const inflightWaitByPromptService = new WeakMap<IAgentPromptService, Map<string, Promise<PromptTurnResult>>>();

function settledMapFor(promptService: IAgentPromptService): Map<string, PromptTurnResult> {
  let map = settledReceiptsByPromptService.get(promptService);
  if (map === undefined) {
    map = new Map();
    settledReceiptsByPromptService.set(promptService, map);
  }
  return map;
}

function inflightMapFor(promptService: IAgentPromptService): Map<string, Promise<PromptTurnResult>> {
  let map = inflightWaitByPromptService.get(promptService);
  if (map === undefined) {
    map = new Map();
    inflightWaitByPromptService.set(promptService, map);
  }
  return map;
}

/** Memoize a settled `wait=true` turn result so idempotent retries return the same receipt (with usage) even after compaction. */
export function rememberSettledTurnResult(
  promptService: IAgentPromptService,
  promptId: string,
  result: PromptTurnResult,
): void {
  const map = settledMapFor(promptService);
  if (map.has(promptId)) map.delete(promptId);
  map.set(promptId, result);
  while (map.size > MAX_SETTLED_RECEIPTS_PER_AGENT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Register an in-flight `wait=true` turn promise so concurrent retries share the same observer and usage accounting. */
export function trackInflightWaitResult(
  promptService: IAgentPromptService,
  promptId: string,
  promise: Promise<PromptTurnResult>,
): Promise<PromptTurnResult> {
  const inflight = inflightMapFor(promptService);
  const tracked = promise.then((result) => {
    rememberSettledTurnResult(promptService, promptId, result);
    return result;
  });
  inflight.set(promptId, tracked);
  void tracked.finally(() => {
    if (inflight.get(promptId) === tracked) inflight.delete(promptId);
  });
  return tracked;
}

function addTokenUsage(target: PromptTurnUsage, usage: TokenUsage): PromptTurnUsage {
  return {
    input_tokens: target.input_tokens + usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation,
    output_tokens: target.output_tokens + usage.output,
    cache_read_tokens: target.cache_read_tokens + usage.inputCacheRead,
    cache_creation_tokens: target.cache_creation_tokens + usage.inputCacheCreation,
  };
}

function extractTurnAssistantOutput(
  context: IAgentContextMemoryService,
  promptId: string,
  includeThinking: boolean,
): { readonly found: boolean; readonly text: string; readonly thinking: string } {
  const messages = context.get();
  let startIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    if (msg.role === 'user' && msg.id === promptId) {
      startIndex = i + 1;
      break;
    }
  }
  if (startIndex < 0) return { found: false, text: '', thinking: '' };
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  for (let i = startIndex; i < messages.length; i += 1) {
    const msg = messages[i]!;
    if (msg.role === 'user' && msg.id !== promptId && msg.origin?.kind !== 'injection') {
      break;
    }
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content) {
      if (part.type === 'text') textParts.push(part.text);
      else if (includeThinking && part.type === 'think') thinkingParts.push(part.think);
    }
  }
  return {
    found: true,
    text: textParts.join(''),
    thinking: thinkingParts.join(''),
  };
}

/** Project a settled prompt's turn output directly from agent context (for idempotent `wait=true` retries). */
export function projectSettledTurnResultFromContext(
  context: IAgentContextMemoryService,
  promptId: string,
  state: 'completed' | 'failed' | 'cancelled',
  options: {
    readonly outputSchema?: Record<string, unknown>;
    readonly includeThinking?: boolean;
    readonly error?: string;
    readonly turnId?: number;
  },
): PromptTurnResult {
  const extracted = extractTurnAssistantOutput(context, promptId, options.includeThinking === true);
  let status: PromptTurnResult['status'] = state;
  let structuredOutput: unknown;
  let error = options.error;
  if (options.outputSchema !== undefined && status === 'completed' && extracted.found) {
    const validated = parseAndValidateStructuredOutput(extracted.text, options.outputSchema);
    if (validated.ok) {
      structuredOutput = validated.value;
    } else {
      status = 'failed';
      error = validated.error;
    }
  }
  return {
    ...(options.turnId === undefined ? {} : { turn_id: options.turnId }),
    status,
    text: extracted.text,
    ...(structuredOutput === undefined ? {} : { structured_output: structuredOutput }),
    ...(options.includeThinking === true ? { thinking: extracted.thinking } : {}),
    stop_reason: status,
    ...(error === undefined ? {} : { error }),
  };
}

/** Await settlement of an already-admitted prompt via `IAgentPromptService.lookup` (for idempotent `wait=true` retries). */
export async function awaitPromptLookupResult(
  promptService: IAgentPromptService,
  events: IEventBus,
  context: IAgentContextMemoryService,
  promptId: string,
  options: {
    readonly outputSchema?: Record<string, unknown>;
    readonly includeThinking?: boolean;
    readonly signal?: AbortSignal;
  },
): Promise<PromptTurnResult> {
  const cached = settledReceiptsByPromptService.get(promptService)?.get(promptId);
  if (cached !== undefined) return cached;
  const inflight = inflightWaitByPromptService.get(promptService)?.get(promptId);
  if (inflight !== undefined) {
    return options.signal === undefined ? await inflight : await abortable(inflight, options.signal);
  }
  const readTerminal = (): PromptTurnResult | undefined => {
    const memo = settledReceiptsByPromptService.get(promptService)?.get(promptId);
    if (memo !== undefined) return memo;
    const info = promptService.lookup(promptId);
    if (info === undefined || info.phase !== 'terminal' || info.terminal === undefined) return undefined;
    const state = info.terminal.state === 'completed' || info.terminal.state === 'cancelled'
      ? info.terminal.state
      : 'failed';
    const rawTerminal = info.terminal as unknown as { readonly error?: unknown };
    const error = typeof rawTerminal.error === 'string'
      ? rawTerminal.error
      : rawTerminal.error instanceof Error
        ? rawTerminal.error.message
        : undefined;
    const projected = projectSettledTurnResultFromContext(context, promptId, state, {
      outputSchema: options.outputSchema,
      includeThinking: options.includeThinking,
      turnId: info.turnId,
      error,
    });
    rememberSettledTurnResult(promptService, promptId, projected);
    return projected;
  };
  const immediate = readTerminal();
  if (immediate !== undefined) return immediate;
  let resolveWait!: (value: PromptTurnResult) => void;
  const settledPromise = new Promise<PromptTurnResult>((resolve) => {
    resolveWait = resolve;
  });
  const sub = events.subscribe((event) => {
    if (event.type !== 'prompt.outcome_committed' && event.type !== 'turn.ended') return;
    const done = readTerminal();
    if (done !== undefined) resolveWait(done);
  });
  try {
    const rechecked = readTerminal();
    if (rechecked !== undefined) return rechecked;
    return options.signal === undefined
      ? await settledPromise
      : await abortable(settledPromise, options.signal);
  } finally {
    void sub.dispose();
  }
}

/** Charge `ksa_` token & USD cost usage for a submitted prompt's turn, independent of HTTP waiter lifetime. */
export function attachTurnBudgetCharging(
  handle: PromptHandle,
  usageService: IAgentUsageService,
  core: Scope,
  token: SessionAccessToken,
  accessStore: SessionAccessStore,
  releaseReservation?: () => void,
): void {
  let targetTurnId: number | undefined;
  const bufferedBeforeLaunch: Array<{ readonly turnId: number; readonly model: string; readonly usage: TokenUsage }> = [];
  const chargeRecord = (model: string, usage: TokenUsage): void => {
    const totalTokens = usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation + usage.output;
    let costUsd: number | undefined;
    try {
      costUsd = core.accessor.get(IModelPricingService).calculate(model, usage);
    } catch {
      costUsd = undefined;
    }
    accessStore.recordBudgetUsage(token, {
      tokens: totalTokens,
      ...(costUsd === undefined ? {} : { costUsd }),
    });
  };
  const sub = usageService.onDidRecord((recorded) => {
    const sourceTurnId = recorded.source?.type === 'turn' ? recorded.source.turnId : undefined;
    if (sourceTurnId === undefined) return;
    if (targetTurnId === undefined) {
      bufferedBeforeLaunch.push({ turnId: sourceTurnId, model: recorded.model, usage: recorded.usage });
      return;
    }
    if (sourceTurnId === targetTurnId) {
      chargeRecord(recorded.model, recorded.usage);
    }
  });
  void handle.launched.then((turn) => {
    if (turn === undefined) return;
    targetTurnId = turn.id;
    for (const entry of bufferedBeforeLaunch.splice(0)) {
      if (entry.turnId === targetTurnId) chargeRecord(entry.model, entry.usage);
    }
  }, () => undefined);
  void handle.completion.finally(() => {
    sub.dispose();
    releaseReservation?.();
  });
}

/** Observe one submitted prompt's turn execution and project its settled `PromptTurnResult`. */
export function createPromptWaitObserver(
  events: IEventBus,
  usageService: IAgentUsageService,
  includeThinking: boolean,
): PromptWaitObserver {
  let targetPromptId: string | undefined;
  let targetTurnId: number | undefined;
  const thinkingByTurnId = new Map<number, string>();
  const usageByTurnId = new Map<number, PromptTurnUsage>();
  const stopReasonByTurnId = new Map<number, string>();
  const errorByTurnId = new Map<number, string>();

  const usageSub = usageService.onDidRecord((recorded) => {
    const sourceTurnId = recorded.source?.type === 'turn' ? recorded.source.turnId : undefined;
    if (sourceTurnId === undefined) return;
    const prev = usageByTurnId.get(sourceTurnId) ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
    usageByTurnId.set(sourceTurnId, addTokenUsage(prev, recorded.usage));
  });

  const sub = events.subscribe((event) => {
    const raw = event as unknown as Record<string, unknown>;
    if (event.type === 'turn.started') {
      const pid = typeof raw['promptId'] === 'string' ? raw['promptId'] : undefined;
      const tid = typeof raw['turnId'] === 'number' ? raw['turnId'] : undefined;
      if (targetPromptId !== undefined && pid === targetPromptId && tid !== undefined) {
        targetTurnId = tid;
      }
      return;
    }
    const eventTurnId = typeof raw['turnId'] === 'number' ? raw['turnId'] : undefined;
    if (eventTurnId === undefined) return;
    if (includeThinking && event.type === 'thinking.delta') {
      const delta = typeof raw['delta'] === 'string' ? raw['delta'] : typeof raw['text'] === 'string' ? raw['text'] : '';
      if (delta.length > 0) {
        thinkingByTurnId.set(eventTurnId, (thinkingByTurnId.get(eventTurnId) ?? '') + delta);
      }
    } else if (event.type === 'turn.ended') {
      if (typeof raw['reason'] === 'string') stopReasonByTurnId.set(eventTurnId, raw['reason']);
      if (typeof raw['error'] === 'string') errorByTurnId.set(eventTurnId, raw['error']);
    }
  });

  return {
    bindPromptId(promptId: string): void {
      targetPromptId = promptId;
    },
    async awaitResult(handle, context, options): Promise<PromptTurnResult> {
      targetPromptId = handle.id;
      try {
        const turnPromise = handle.launched.then((turn) => {
          if (turn !== undefined) targetTurnId = turn.id;
        }, () => undefined);
        const completion = options.signal === undefined
          ? await handle.completion
          : await abortable(handle.completion, options.signal);
        await turnPromise;
        const turnId = targetTurnId;
        const extracted = extractTurnAssistantOutput(context, handle.id, options.includeThinking === true);
        let status: PromptTurnResult['status'] = completion.state;
        let structuredOutput: unknown;
        const resultError = completion.result?.type === 'failed'
          ? (completion.result.error instanceof Error ? completion.result.error.message : String(completion.result.error))
          : undefined;
        let error = (turnId === undefined ? undefined : errorByTurnId.get(turnId)) ?? resultError;
        if (options.outputSchema !== undefined && status === 'completed') {
          const validated = parseAndValidateStructuredOutput(extracted.text, options.outputSchema);
          if (validated.ok) {
            structuredOutput = validated.value;
          } else {
            status = 'failed';
            error = validated.error;
          }
        }
        const capturedThinking = turnId === undefined ? '' : (thinkingByTurnId.get(turnId) ?? '');
        const thinkingText = extracted.thinking.length > 0 ? extracted.thinking : capturedThinking;
        const capturedUsage = turnId === undefined ? undefined : usageByTurnId.get(turnId);
        const capturedStopReason = turnId === undefined ? undefined : stopReasonByTurnId.get(turnId);
        return {
          ...(turnId === undefined ? {} : { turn_id: turnId }),
          status,
          text: extracted.text,
          ...(structuredOutput === undefined ? {} : { structured_output: structuredOutput }),
          ...(options.includeThinking === true ? { thinking: thinkingText } : {}),
          ...(capturedUsage === undefined ? {} : { usage: capturedUsage }),
          stop_reason: capturedStopReason ?? completion.result?.type ?? completion.state,
          ...(error === undefined ? {} : { error }),
        };
      } finally {
        usageSub.dispose();
        void sub.dispose();
      }
    },
    dispose(): void {
      usageSub.dispose();
      void sub.dispose();
    },
  };
}
