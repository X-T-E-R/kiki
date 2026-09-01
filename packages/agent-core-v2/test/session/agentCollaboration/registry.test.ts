import { describe, expect, it } from 'vitest';

import {
  AgentCollaborationRegistry,
  COLLABORATION_TASK_NAME_LABEL,
} from '#/session/agentCollaboration/registry';
import type { AgentMeta, ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

describe('AgentCollaborationRegistry', () => {
  it('reserves against both the canonical and migration task-name labels', async () => {
    const agents: Record<string, AgentMeta> = {
      canonical: {
        type: 'sub',
        labels: { [COLLABORATION_TASK_NAME_LABEL]: 'canonical_name' },
      },
      legacy: {
        type: 'sub',
        labels: { externalDelegationTaskName: 'legacy_name' },
      },
    };
    const registry = new AgentCollaborationRegistry({
      ready: Promise.resolve(),
      read: async () => ({ agents }),
    } as ISessionMetadata);
    const owner = { kind: 'external' as const, delegationId: 'delegation_test' };

    await expect(registry.reserve('canonical_name', owner)).resolves.toBe(false);
    await expect(registry.reserve('legacy_name', owner)).resolves.toBe(false);
    await expect(registry.reserve('new_name', owner)).resolves.toBe(true);
  });
});
