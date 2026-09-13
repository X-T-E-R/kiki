import { z } from 'zod';
import { defineState } from '#/state/state';
import { FullCompactionComplete } from '#/agent/fullCompaction/compactionOps';
import { UsageRecord } from './usageOps';

const panelAccountingSchema = z.object({
  records: z.number(),
  incomplete: z.boolean(),
  successfulCompactions: z.number(),
});

export const panelAccountingKey = defineState('usage.panelAccounting', () => ({
  records: 0,
  incomplete: false,
  successfulCompactions: 0,
})).replayable({ schema: panelAccountingSchema })
  .on(UsageRecord, (state, record) => {
    state.records += 1;
    const total = Object.values(record.usage).reduce((sum, value) => sum + value, 0);
    if (record.usageKnown === false || (record.usageKnown === undefined && total === 0)) {
      state.incomplete = true;
    }
  })
  .on(FullCompactionComplete, (state) => { state.successfulCompactions += 1; });
