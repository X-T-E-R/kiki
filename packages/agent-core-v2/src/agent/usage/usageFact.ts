import { z } from 'zod';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { WireRecord } from '#/wire/record';

export interface UsageFact {
  readonly usageScope?: 'session' | 'turn';
  readonly executorId?: string;
  readonly invalid?: boolean;
  readonly upstreamModelId?: string;
  readonly sourceAgentId?: string;
  readonly time: number;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly usageKnown?: boolean;
  readonly turnId?: number;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly provider?: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
}

export function normalizeUsageFact(raw: WireRecord, sourceAgentId?: string): UsageFact | undefined {
  const usage = raw['usage'];
  const model = raw['model'];
  if (typeof raw.time !== 'number' || !Number.isFinite(raw.time) || raw.time < 0) return undefined;
  if (typeof model !== 'string' || model.length === 0) return undefined;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const value = usage as Record<string, unknown>;
  const inputOther = nonnegativeFinite(value['inputOther']);
  const output = nonnegativeFinite(value['output']);
  const inputCacheRead = nonnegativeFinite(value['inputCacheRead']);
  const inputCacheCreation = nonnegativeFinite(value['inputCacheCreation']);
  const invalid = inputOther === undefined || output === undefined || inputCacheRead === undefined || inputCacheCreation === undefined;
  const usageKnown = raw['usageKnown'];
  if (usageKnown !== undefined && typeof usageKnown !== 'boolean') return undefined;
  const turnId = raw['turnId'];
  return {
    time: raw.time,
    model,
    upstreamModelId: optionalString(raw['upstreamModelId']),
    usageScope: raw['usageScope'] === 'session' || raw['usageScope'] === 'turn' ? raw['usageScope'] : undefined,
    executorId: optionalString(raw['executorId']),
    sourceAgentId,
    invalid: invalid || undefined,
    usage: invalid ? { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } : { inputOther: inputOther ?? 0, output: output ?? 0, inputCacheRead: inputCacheRead ?? 0, inputCacheCreation: inputCacheCreation ?? 0 },
    usageKnown,
    turnId: typeof turnId === 'number' && Number.isInteger(turnId) && turnId >= 0 ? turnId : undefined,
    agentId: optionalString(raw['agentId']),
    parentAgentId: optionalString(raw['parentAgentId']),
    provider: optionalString(raw['provider']),
    modelAlias: optionalString(raw['modelAlias']),
    profileName: optionalString(raw['profileName']),
  };
}

function nonnegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface UsageFactTotals {
  readonly version?: 2;
  readonly usage: TokenUsage;
  readonly byModel: Readonly<Record<string, TokenUsage>>;
  readonly byModelMask?: Readonly<Record<string, Readonly<Record<string, TokenUsage>>>>;
  readonly records: number;
  readonly knownUsageRecords: number;
  readonly partial: boolean;
}

export function summarizeUsageFacts(records: readonly UsageFact[], previous?: UsageFactTotals): UsageFactTotals {
  const usage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, ...previous?.usage };
  const byModel = Object.fromEntries(Object.entries(previous?.byModel ?? {}).map(([key, value]) => [key, { ...value }]));
  const byModelMask = Object.fromEntries(Object.entries(previous?.byModelMask ?? {}).map(([model, masks]) => [model, Object.fromEntries(Object.entries(masks).map(([mask, value]) => [mask, { ...value }]))]));
  let count = previous?.records ?? 0;
  let known = previous?.knownUsageRecords ?? 0;
  let partial = previous?.partial ?? false;
  for (const record of records) {
    if (record.invalid) { partial = true; continue; }
    count++;
    const tokens = record.usage;
    const reported = tokens.inputOther + tokens.output + tokens.inputCacheRead + tokens.inputCacheCreation;
    if (record.usageKnown === false || (record.usageKnown === undefined && reported === 0)) { partial = true; continue; }
    known++;
    const model = Object.hasOwn(byModel, record.model) ? byModel[record.model]! : { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
    const mask = String(usageTokenMask(tokens));
    const masks = Object.hasOwn(byModelMask, record.model) ? byModelMask[record.model]! : {};
    const masked = masks[mask] ?? { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
    for (const key of ['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation'] as const) {
      usage[key] += tokens[key];
      model[key] += tokens[key];
      masked[key] += tokens[key];
    }
    masks[mask] = masked;
    Object.defineProperty(byModelMask, record.model, { value: masks, enumerable: true, configurable: true, writable: true });
    Object.defineProperty(byModel, record.model, { value: model, enumerable: true, configurable: true, writable: true });
  }
  return { version: 2, usage, byModel, byModelMask, records: count, knownUsageRecords: known, partial };
}

export function usageTokenMask(usage: TokenUsage): number {
  return Number(usage.inputOther !== 0) | Number(usage.output !== 0) << 1 | Number(usage.inputCacheRead !== 0) << 2 | Number(usage.inputCacheCreation !== 0) << 3;
}

const accountingTokenSchema = z.object({ inputOther: z.number().nonnegative(), output: z.number().nonnegative(), inputCacheRead: z.number().nonnegative(), inputCacheCreation: z.number().nonnegative() });
export const usageFactTotalsSchema = z.object({ version: z.literal(2), usage: accountingTokenSchema, byModel: z.record(z.string(), accountingTokenSchema), byModelMask: z.record(z.string(), z.record(z.string(), accountingTokenSchema)), records: z.number().int().nonnegative(), knownUsageRecords: z.number().int().nonnegative(), partial: z.boolean() });
