import { z } from 'zod';
import { ContextApplyCompaction } from '#/agent/contextMemory/contextEvents';
import { defineState } from '#/state/state';

export const contextWindowEpochKey = defineState('contextWindowEpoch', () => 0)
  .replayable({ schema: z.number().int().nonnegative() })
  .on(ContextApplyCompaction, (epoch) => epoch + 1);
