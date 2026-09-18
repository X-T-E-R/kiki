import { z } from 'zod';
import { defineState } from '#/state/state';
import { FullCompactionComplete } from '#/agent/fullCompaction/compactionOps';
import { addUsage, type TokenUsage } from '#/kosong/contract/usage';
import { UsageRecord } from './usageOps';

interface PanelAccountingState {
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
  records: z.number(),
  knownRecords: z.number().default(0),
  knownByModel: z.record(z.string(), tokenUsageSchema).default({}),
  incomplete: z.boolean(),
  successfulCompactions: z.number(),
});

export const panelAccountingKey = defineState('usage.panelAccounting', (): PanelAccountingState => ({
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
  })
  .on(FullCompactionComplete, (state) => { state.successfulCompactions += 1; });
