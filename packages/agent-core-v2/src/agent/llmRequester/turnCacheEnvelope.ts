import { createHash } from 'node:crypto';
import type { PreBaselineRequestPatch } from '#/kosong/contract/extensionHooks';
import type { Message } from '#/kosong/contract/message';
import type {
  ProviderCacheEvidence,
  RequestParams,
  ResponseFormat,
  SamplingOptions,
  ServiceTier,
  ThinkingEffort,
  ToolChoice,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { OptionalParameter } from '#/kosong/model/parameters';
import type { UnmarkedOpaqueReasoningPolicy } from '#/kosong/model/reasoningOrigin';
import type { Protocol } from '#/kosong/protocol/protocol';
import type { ResolvedRequestIdentityPolicy } from '#/kosong/requestIdentity/requestIdentityPolicy';
import type { ProjectionPolicy } from '#/agent/contextProjector/contextProjector';

export interface TurnCacheEnvelopeScope {
  readonly sessionId: string;
  readonly agentId: string;
  readonly windowEpoch: number;
  readonly modelAlias: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly protocol: Protocol;
  readonly providerName: string;
  readonly providerType?: string;
  readonly baseUrl?: string;
  readonly adapterBindingKey?: string;
  readonly endpointPresent: boolean;
  readonly endpointKey: string;
  readonly bindingRevision?: string;
  readonly toolOverrideKey: string;
  readonly activeToolPolicyKey: string;
  readonly principalKey: string;
}

export interface TurnCacheExtensionUpdate {
  readonly index: number;
  readonly message: Message;
}

export interface TurnCacheMediaReplacement {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly text: string;
}

export interface TurnCacheEnvelope {
  readonly id: string;
  readonly scope: TurnCacheEnvelopeScope;
  readonly turnId: number;
  readonly step: number;
  readonly turnKey: string;
  readonly systemPrompt: string;
  readonly anchorApplied: boolean;
  readonly cognitionRevision?: number;
  readonly bindingRevision?: string;
  readonly anchorSteps?: number;
  readonly anchorScope?: 'turn' | 'session';
  readonly tools: readonly Tool[];
  readonly toolChoice?: ToolChoice;
  readonly responseFormat?: ResponseFormat;
  readonly thinkingEffort: ThinkingEffort;
  readonly thinkingKeep?: string;
  readonly sampling?: SamplingOptions;
  readonly serviceTier?: OptionalParameter<ServiceTier>;
  readonly baseRequestParams?: RequestParams;
  readonly preBaselinePatch?: PreBaselineRequestPatch;
  readonly effectiveMaxCompletionTokens?: number;
  readonly effectiveThinkingBudget?: number;
  readonly effectiveUsedContextTokens?: number;
  readonly maxContextTokens: number;
  readonly extensionBaselineText: string;
  readonly extensionUpdates: readonly TurnCacheExtensionUpdate[];
  readonly projectionPolicy?: ProjectionPolicy;
  readonly mediaReplacements?: readonly TurnCacheMediaReplacement[];
  readonly pluginProjectionStrategy: 'passthrough' | 'tool_result_trailing_text' | 'host_auto_injections' | 'tool_result_appendix';
  readonly unmarkedOpaquePolicy: UnmarkedOpaqueReasoningPolicy;
  readonly requestIdentityPolicy: ResolvedRequestIdentityPolicy;
  readonly prefixMessageCount: number;
  readonly prefixFingerprints: readonly string[];
  readonly responseFingerprint: string;
  readonly providerMessageId?: string;
  readonly providerEvidence?: ProviderCacheEvidence;
  readonly transportGeneration: number;
  readonly settledAt: number;
}

export interface TurnCacheEnvelopeSummary {
  readonly id: string;
  readonly turnId: number;
  readonly step: number;
  readonly windowEpoch: number;
  readonly prefixMessageCount: number;
  readonly modelAlias: string;
}

export type TurnCacheEnvelopeMatchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function matchesTurnCacheEnvelopeScope(
  envelope: TurnCacheEnvelope,
  current: TurnCacheEnvelopeScope,
): TurnCacheEnvelopeMatchResult {
  const prev = envelope.scope;
  if (prev.sessionId !== current.sessionId) return { ok: false, reason: 'session_mismatch' };
  if (prev.agentId !== current.agentId) return { ok: false, reason: 'agent_mismatch' };
  if (prev.windowEpoch !== current.windowEpoch) return { ok: false, reason: 'window_epoch_changed' };
  if (prev.modelAlias !== current.modelAlias || prev.modelId !== current.modelId || prev.modelName !== current.modelName) {
    return { ok: false, reason: 'model_changed' };
  }
  if (
    prev.protocol !== current.protocol ||
    prev.providerName !== current.providerName ||
    prev.providerType !== current.providerType ||
    prev.baseUrl !== current.baseUrl
  ) {
    return { ok: false, reason: 'provider_changed' };
  }
  if (prev.adapterBindingKey !== current.adapterBindingKey) {
    return { ok: false, reason: 'adapter_changed' };
  }
  if (prev.endpointPresent !== current.endpointPresent || prev.endpointKey !== current.endpointKey) {
    return { ok: false, reason: 'endpoint_changed' };
  }
  if (prev.bindingRevision !== current.bindingRevision) {
    return { ok: false, reason: 'binding_changed' };
  }
  if (prev.toolOverrideKey !== current.toolOverrideKey || prev.activeToolPolicyKey !== current.activeToolPolicyKey) {
    return { ok: false, reason: 'tool_policy_changed' };
  }
  if (prev.principalKey !== current.principalKey) {
    return { ok: false, reason: 'principal_changed' };
  }
  return { ok: true };
}

export function fingerprintCanonicalMessage(message: Message): string {
  const normalized = {
    role: message.role,
    name: message.name,
    toolCallId: message.toolCallId,
    partial: message.partial,
    content: message.content,
    toolCalls: message.toolCalls,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function verifyEnvelopePrefix(
  envelope: TurnCacheEnvelope,
  projectedMessages: readonly Message[],
): {
  readonly inputPrefixMatched: boolean;
  readonly responsePrefixMatched: boolean;
} {
  if (projectedMessages.length < envelope.prefixMessageCount) {
    return { inputPrefixMatched: false, responsePrefixMatched: false };
  }
  for (let i = 0; i < envelope.prefixMessageCount; i += 1) {
    if (fingerprintCanonicalMessage(projectedMessages[i]!) !== envelope.prefixFingerprints[i]) {
      return { inputPrefixMatched: false, responsePrefixMatched: false };
    }
  }
  const responsePrefixMatched =
    projectedMessages.length > envelope.prefixMessageCount &&
    fingerprintCanonicalMessage(projectedMessages[envelope.prefixMessageCount]!) === envelope.responseFingerprint;
  return { inputPrefixMatched: true, responsePrefixMatched };
}

export interface CompactionBudgetResolution {
  readonly mode: 'locked' | 'size_degraded' | 'overflow';
  readonly maxCompletionTokens?: number;
  readonly thinkingBudgetOverride?: number;
}

export function resolveCompactionBudget(input: {
  readonly protocol: Protocol;
  readonly maxContextTokens: number;
  readonly estimatedInputTokens: number;
  readonly lockedMaxCompletionTokens?: number;
  readonly lockedThinkingBudget?: number;
  readonly hasAnthropicBudgetThinking: boolean;
  readonly fallbackMaxCompletionTokens?: number;
}): CompactionBudgetResolution {
  const targetMax = input.lockedMaxCompletionTokens ?? input.fallbackMaxCompletionTokens;
  if (input.maxContextTokens <= 0) {
    return {
      mode: 'locked',
      maxCompletionTokens: targetMax,
      thinkingBudgetOverride: input.lockedThinkingBudget,
    };
  }
  const remaining = input.maxContextTokens - input.estimatedInputTokens;
  if (input.hasAnthropicBudgetThinking) {
    if (remaining <= 1024) {
      return { mode: 'overflow' };
    }
    if (targetMax !== undefined && targetMax <= 1024) {
      return { mode: 'overflow' };
    }
    if (targetMax === undefined || remaining >= targetMax) {
      return {
        mode: 'locked',
        maxCompletionTokens: targetMax,
        thinkingBudgetOverride:
          input.lockedThinkingBudget !== undefined && targetMax !== undefined
            ? Math.min(input.lockedThinkingBudget, targetMax - 1)
            : input.lockedThinkingBudget,
      };
    }
    const degradedMax = Math.max(1025, Math.min(targetMax, remaining));
    const baseBudget = input.lockedThinkingBudget ?? degradedMax - 1;
    return {
      mode: 'size_degraded',
      maxCompletionTokens: degradedMax,
      thinkingBudgetOverride: Math.max(1024, Math.min(baseBudget, degradedMax - 1)),
    };
  }
  if (targetMax === undefined) {
    return {
      mode: 'locked',
      maxCompletionTokens: undefined,
    };
  }
  if (remaining <= 0) {
    return {
      mode: 'size_degraded',
      maxCompletionTokens: targetMax,
    };
  }
  if (remaining >= targetMax) {
    return {
      mode: 'locked',
      maxCompletionTokens: targetMax,
    };
  }
  return {
    mode: 'size_degraded',
    maxCompletionTokens: Math.max(1, Math.min(targetMax, remaining)),
  };
}

export function isForcedToolChoice(
  toolChoice: ToolChoice | undefined,
  requestParams?: RequestParams,
): boolean {
  if (toolChoice === 'required') return true;
  if (typeof toolChoice === 'object' && toolChoice !== null) return true;
  const raw = requestParams?.['tool_choice'];
  if (raw === 'required' || raw === 'any') return true;
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === 'required' || trimmed === 'any') return true;
  }
  return false;
}

export function captureMediaReplacements(
  unmodified: readonly Message[],
  projected: readonly Message[],
): readonly TurnCacheMediaReplacement[] {
  const replacements: TurnCacheMediaReplacement[] = [];
  const limit = Math.min(unmodified.length, projected.length);
  for (let m = 0; m < limit; m += 1) {
    const before = unmodified[m]!.content;
    const after = projected[m]!.content;
    const partLimit = Math.min(before.length, after.length);
    for (let p = 0; p < partLimit; p += 1) {
      const b = before[p]!;
      const a = after[p]!;
      if (
        (b.type === 'image_url' || b.type === 'audio_url' || b.type === 'video_url') &&
        a.type === 'text'
      ) {
        replacements.push({ messageIndex: m, partIndex: p, text: a.text });
      }
    }
  }
  return replacements;
}

export function applyMediaReplacements(
  messages: readonly Message[],
  replacements: readonly TurnCacheMediaReplacement[] | undefined,
): readonly Message[] {
  if (replacements === undefined || replacements.length === 0) return messages;
  const byMessage = new Map<number, Map<number, string>>();
  for (const r of replacements) {
    let inner = byMessage.get(r.messageIndex);
    if (inner === undefined) {
      inner = new Map();
      byMessage.set(r.messageIndex, inner);
    }
    inner.set(r.partIndex, r.text);
  }
  let changed = false;
  const out = messages.map((msg, mIdx) => {
    const map = byMessage.get(mIdx);
    if (map === undefined) return msg;
    let msgChanged = false;
    const content = msg.content.map((part, pIdx) => {
      const replacementText = map.get(pIdx);
      if (
        replacementText === undefined ||
        (part.type !== 'image_url' && part.type !== 'audio_url' && part.type !== 'video_url')
      ) {
        return part;
      }
      changed = true;
      msgChanged = true;
      return { type: 'text' as const, text: replacementText };
    });
    return msgChanged ? { ...msg, content } : msg;
  });
  return changed ? out : messages;
}
