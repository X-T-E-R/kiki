import { addUsage, emptyUsage, type TokenUsage } from '#/kosong/contract/usage';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { summarizeUsageFacts } from '#/agent/usage/usageFact';

import type { SessionUsageSummary } from './sessionIndex';

export function addSessionUsage(
  current: SessionUsageSummary | undefined,
  model: string,
  usage: TokenUsage,
  usageKnown?: boolean,
): SessionUsageSummary {
  const modelUsage = current?.byModel?.[model];
  return {
    total: current === undefined ? { ...usage } : addUsage(current.total, usage),
    byModel: {
      ...current?.byModel,
      [model]: modelUsage === undefined ? { ...usage } : addUsage(modelUsage, usage),
    },
    wireComplete: current?.wireComplete,
    accounting: current === undefined || current.accounting !== undefined ? summarizeUsageFacts([{ time: 0, model, usage, usageKnown }], current?.accounting) : undefined,
  };
}

export interface SessionUsageReplayResult {
  readonly usage?: SessionUsageSummary;
  readonly complete: boolean;
}

export async function readSessionUsageFromWires(
  log: IAppendLogStore,
  agentScopes: readonly string[],
): Promise<SessionUsageReplayResult> {
  let summary: SessionUsageSummary | undefined;
  let complete = true;
  for (const scope of agentScopes) {
    let hasRecords = false;
    try {
      for await (const record of log.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) {
        hasRecords = true;
        if (record.type !== 'usage.record') continue;
        const parsed = parseUsageRecord(record);
        if (parsed === undefined) {
          complete = false;
          continue;
        }
        summary = addSessionUsage(summary, parsed.model, parsed.usage, parsed.usageKnown);
      }
    } catch {
      complete = false;
    }
    if (!hasRecords) complete = false;
  }
  return {
    usage:
      summary === undefined
        ? complete
          ? { total: emptyUsage(), wireComplete: true }
          : undefined
        : { ...summary, wireComplete: complete ? true : undefined },
    complete,
  };
}

function parseUsageRecord(
  record: WireRecord,
): { readonly model: string; readonly usage: TokenUsage; readonly usageKnown?: boolean } | undefined {
  if (record.type !== 'usage.record' || typeof record['model'] !== 'string') return undefined;
  const usage = record['usage'];
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const fields = usage as Record<string, unknown>;
  const inputOther = parseUsageNumber(fields['inputOther']);
  const output = parseUsageNumber(fields['output']);
  const inputCacheRead = parseUsageNumber(fields['inputCacheRead']);
  const inputCacheCreation = parseUsageNumber(fields['inputCacheCreation']);
  if (
    inputOther === undefined ||
    output === undefined ||
    inputCacheRead === undefined ||
    inputCacheCreation === undefined
  ) {
    return undefined;
  }
  return {
    model: record['model'],
    usage: { inputOther, output, inputCacheRead, inputCacheCreation },
    usageKnown: typeof record['usageKnown'] === 'boolean' ? record['usageKnown'] : undefined,
  };
}

function parseUsageNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
