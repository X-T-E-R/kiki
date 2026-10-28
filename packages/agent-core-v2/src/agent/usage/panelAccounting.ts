import { z } from 'zod';
import { defineState } from '#/state/state';
import { FullCompactionComplete } from '#/agent/fullCompaction/compactionOps';
import { addUsage, type TokenUsage } from '#/kosong/contract/usage';
import { UsageRecord } from './usageOps';
import { usageTokenMask } from './usageFact';

interface PanelAccountingState {
  version: 2;
  knownByModelMask: Record<string, Record<string, TokenUsage>>;
  records: number;
  knownRecords: number;
  knownByModel: Record<string, TokenUsage>;
  incomplete: boolean;
  successfulCompactions: number;
}

const tokenUsageSchema = z.object({
  inputOther: z.number(),
  output: z.number(),
  inputCacheRead: z.number(),
  inputCacheCreation: z.number(),
});

const panelAccountingSchema: z.ZodType<PanelAccountingState> = z.object({
  version: z.literal(2),
  knownByModelMask: z.record(z.string(), z.record(z.string(), tokenUsageSchema)),
  records: z.number(),
  knownRecords: z.number().default(0),
  knownByModel: z.record(z.string(), tokenUsageSchema).default({}),
  incomplete: z.boolean(),
  successfulCompactions: z.number(),
});

export const panelAccountingKey = defineState('usage.panelAccounting', (): PanelAccountingState => ({
  version: 2,
  knownByModelMask: {},
  records: 0,
  knownRecords: 0,
  knownByModel: {},
  incomplete: false,
  successfulCompactions: 0,
})).replayable({ schema: panelAccountingSchema })
  .on(UsageRecord, (state, record) => {
    state.records += 1;
    const total = Object.values(record.usage).reduce((sum, value) => sum + value, 0);
    const known = record.usageKnown === true ||
      (record.usageKnown === undefined && total > 0);
    if (!known) {
      state.incomplete = true;
      return;
    }
    state.knownRecords += 1;
    const current = state.knownByModel[record.model];
    state.knownByModel[record.model] = current === undefined
      ? { ...record.usage }
      : addUsage(current, record.usage);
    const mask = String(usageTokenMask(record.usage));
    const masks = state.knownByModelMask[record.model] ?? {};
    masks[mask] = masks[mask] === undefined ? { ...record.usage } : addUsage(masks[mask], record.usage);
    state.knownByModelMask[record.model] = masks;
  })
  .on(FullCompactionComplete, (state) => { state.successfulCompactions += 1; });
