/**
 * memory-upgrade — a file store that Kiki upgrades to SQLite on its own at
 * startup. Each status read advances it one step: discovery, one scope per
 * read, validation, then the governed store with the same entries.
 *
 * Mock data: the fixture stands in for the startup upgrade in kap-server
 * (routes/memory.ts `GET authority`, `POST authority/retry`).
 */

import governance, { governanceSeed } from './memory-governance.scenario.mjs';

export const upgradeNamespaces = ['memory/global', 'memory/personas/lin-lan', 'memory/workspaces/wd_fixture_000000000000'];

export default {
  ...governance,
  memoryGovernance: {
    ...governanceSeed,
    authority: { backend: 'legacy', mode: 'active', epoch: 2 },
    upgrade: { operationId: '6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8', namespaces: upgradeNamespaces },
  },
};
