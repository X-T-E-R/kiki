import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const sessionInitContract = {
  generateAgentsMd: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: noResult }), 'input', 'output'),
  cancelInit: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;
