import { z } from 'zod';
import {
  settingsTransferApplyInputSchema,
  settingsTransferApplyResultSchema,
  settingsTransferCatalogSchema,
  settingsTransferExportInputSchema,
  settingsTransferPackageSchema,
  settingsTransferPreviewInputSchema,
  settingsTransferPreviewSchema,
} from '@kiki/protocol';
import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const settingsTransferContract = {
  catalog: { input: z.tuple([]), output: settingsTransferCatalogSchema },
  export: { input: z.tuple([settingsTransferExportInputSchema]), output: settingsTransferPackageSchema },
  preview: { input: z.tuple([settingsTransferPreviewInputSchema]), output: settingsTransferPreviewSchema },
  apply: { input: z.tuple([settingsTransferApplyInputSchema]), output: settingsTransferApplyResultSchema },
  cancel: { input: z.tuple([settingsTransferApplyInputSchema]), output: noResult },
} satisfies ServiceContract;
