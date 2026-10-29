/**
 * memory-upgrade-failed — the startup upgrade stopped on sources that need
 * repair. Retry sends the same operation id; this fixture then treats the
 * sources as repaired and lets the same operation complete.
 *
 * Mock data, as in memory-upgrade.scenario.mjs.
 */

import governance, { governanceSeed } from './memory-governance.scenario.mjs';
import { upgradeNamespaces } from './memory-upgrade.scenario.mjs';

const issue = (scope, key, kind) => ({ scope, key, issue: kind });

export default {
  ...governance,
  memoryGovernance: {
    ...governanceSeed,
    authority: { backend: 'legacy', mode: 'active', epoch: 2 },
    upgrade: {
      operationId: '6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8',
      namespaces: upgradeNamespaces,
      failAt: 3,
      issues: [
        issue('memory/global', 'm_deploy_workers', 'legacy_journal_head_mismatch'),
        issue('memory/global', 'm_release_owner', 'current_revision_preserved'),
        issue('memory/personas/lin-lan', '', 'legacy_inventory_incomplete'),
        issue('memory/workspaces/wd_fixture_000000000000', 'm_ws_build_cache', 'legacy_head_missing'),
        issue('memory/global', 'm_reply_language', 'duplicate_legacy_identity'),
        issue('memory/global', 'notes/2026-01.md', 'unreadable_source'),
      ],
    },
  },
};
