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
import { lazyContract } from '../lazyContract.js';

export const settingsTransferContract = {
  catalog: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: settingsTransferCatalogSchema }), 'input', 'output'),
  export: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([settingsTransferExportInputSchema]), output: settingsTransferPackageSchema }), 'input', 'output'),
  preview: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([settingsTransferPreviewInputSchema]), output: settingsTransferPreviewSchema }), 'input', 'output'),
  apply: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([settingsTransferApplyInputSchema]), output: settingsTransferApplyResultSchema }), 'input', 'output'),
  cancel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([settingsTransferApplyInputSchema]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;
