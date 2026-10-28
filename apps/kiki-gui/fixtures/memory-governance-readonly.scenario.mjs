/**
 * memory-governance-readonly — the governed store switched to its read-only
 * recovery copy: everything reads, nothing writes, and Resume editing sends
 * the exact recovery id and epoch shown.
 */

import governance, { governanceSeed } from './memory-governance.scenario.mjs';

export default {
  ...governance,
  memoryGovernance: {
    ...governanceSeed,
    authority: { backend: 'sqlite', mode: 'readonly', epoch: 4, recoveryId: '2b9a3c3e-0b7c-4d1e-9a51-7f0c1d2e3f40' },
  },
};
