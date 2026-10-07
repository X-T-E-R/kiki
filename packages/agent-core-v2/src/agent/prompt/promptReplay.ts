import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Event2, registerEvent2Class } from '#/app/event/event2';
import type { PromptInput, PromptTerminalResult } from './prompt';

export interface PromptLookup {
  readonly promptId: string;
  readonly phase: 'pending' | 'launched' | 'terminal';
  readonly turnId?: number;
  readonly terminal?: PromptTerminalResult;
}

export class PromptOutcomeCommitted extends Event2<{ terminal: PromptTerminalResult }> {
  declare readonly terminal: PromptTerminalResult;
  static override readonly type = 'prompt.outcome_committed';
  static override readonly durable = true;
  static override readonly schema = z.object({ terminal: z.custom<PromptTerminalResult>() });
}
registerEvent2Class(PromptOutcomeCommitted);

type PromptRequest = Pick<PromptInput, 'id' | 'message' | 'userMessageId' | 'execution' | 'appendTiming' | 'alreadyMaterialized' | 'deferredDisabledTools'> & { readonly promptId?: string };

export interface PromptRequestFingerprint {
  readonly message: string;
  readonly execution: string;
  readonly appendTiming: string;
  readonly alreadyMaterialized: string;
  readonly deferredDisabledTools: string;
  readonly userMessageId?: string;
}

/** Keeps the immutable admission hash and field hashes of the latest authorized queued request, without retaining message content. */
export interface PromptIdentity extends PromptLookup {
  readonly fingerprint: string;
  readonly currentRequest?: PromptRequestFingerprint;
}

function normalizedPromptRequest(input: PromptRequest) {
  const requestId = input.id ?? input.promptId ?? input.message.id;
  const logicalId = input.userMessageId ?? (input.alreadyMaterialized === true ? input.message.id : undefined);
  return { message: { ...input.message, id: undefined }, execution: input.execution,
    appendTiming: input.appendTiming ?? 'agent_idle', alreadyMaterialized: input.alreadyMaterialized === true,
    deferredDisabledTools: input.deferredDisabledTools,
    userMessageId: input.alreadyMaterialized === true || logicalId !== requestId ? logicalId : undefined };
}

function hashValue(value: unknown): string {
  const canonical = JSON.stringify({ value }, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
  return createHash('sha256').update(canonical).digest('hex');
}

export function promptFingerprint(input: PromptRequest): string {
  const canonical = JSON.stringify(normalizedPromptRequest(input), (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
  return createHash('sha256').update(canonical).digest('hex');
}

export function promptRequestFingerprint(input: PromptRequest): PromptRequestFingerprint {
  const request = normalizedPromptRequest(input);
  return { message: hashValue(request.message), execution: hashValue(request.execution),
    appendTiming: hashValue(request.appendTiming), alreadyMaterialized: hashValue(request.alreadyMaterialized),
    deferredDisabledTools: hashValue(request.deferredDisabledTools),
    userMessageId: request.userMessageId === undefined ? undefined : hashValue(request.userMessageId) };
}

export function updatePromptRequestFingerprint(current: PromptRequestFingerprint, input: Partial<Pick<PromptRequest, 'message' | 'execution' | 'appendTiming'>>): PromptRequestFingerprint {
  return { ...current,
    message: input.message === undefined ? current.message : hashValue({ ...input.message, id: undefined }),
    execution: input.execution === undefined ? current.execution : hashValue(input.execution),
    appendTiming: input.appendTiming === undefined ? current.appendTiming : hashValue(input.appendTiming) };
}

export function matchesPromptIdentity(identity: Pick<PromptIdentity, 'fingerprint' | 'currentRequest'>, input: PromptRequest): boolean {
  if (identity.fingerprint === promptFingerprint(input)) return true;
  if (identity.currentRequest === undefined) return false;
  const current = promptRequestFingerprint(input);
  return Object.entries(current).every(([key, value]) => identity.currentRequest?.[key as keyof PromptRequestFingerprint] === value);
}
