import type { TokenUsage } from '#/kosong/contract/usage';
import type { WireRecord } from '#/wire/record';

export interface UsageFact {
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
  readonly usage: TokenUsage;
  readonly byModel: Readonly<Record<string, TokenUsage>>;
  readonly records: number;
  readonly knownUsageRecords: number;
  readonly partial: boolean;
}

export function summarizeUsageFacts(records: readonly UsageFact[], previous?: UsageFactTotals): UsageFactTotals {
  const usage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, ...previous?.usage };
  const byModel = Object.fromEntries(Object.entries(previous?.byModel ?? {}).map(([key, value]) => [key, { ...value }]));
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
    for (const key of ['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation'] as const) {
      usage[key] += tokens[key];
      model[key] += tokens[key];
    }
    Object.defineProperty(byModel, record.model, { value: model, enumerable: true, configurable: true, writable: true });
  }
  return { usage, byModel, records: count, knownUsageRecords: known, partial };
}
