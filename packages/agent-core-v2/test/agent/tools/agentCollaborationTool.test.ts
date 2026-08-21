/**
 * `agentCollaborationTool` — materialize provenance passthrough.
 *
 * Covers the F2 regression: re-materializing a cold named agent (one not in
 * the live lifecycle registry, e.g. after a server restart) must re-seed the
 * structured provenance (`delegator`, `forkedFrom`) from durable metadata
 * instead of dropping it and letting `registerAgent` overwrite it with
 * `undefined`.
 */

import { describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import {
  FollowupTaskTool,
  ListAgentsTool,
  SpawnAgentInputSchema,
  SpawnAgentTool,
} from '#/agent/tools/agent-collaboration/agentCollaborationTool';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  COLLABORATION_AGENT_TYPE_LABEL,
  COLLABORATION_TASK_NAME_LABEL,
} from '#/session/agentCollaboration/registry';

function followupTool(lifecycle: IAgentLifecycleService): FollowupTaskTool {
  return new FollowupTaskTool(
    lifecycle,
    undefined as never, // subagents
    undefined as never, // catalog
    { agentId: 'main' } as never, // scope (only `.agentId` is read)
    undefined as never, // tasks
    undefined as never, // profile
    undefined as never, // permissionMode
    undefined as never, // userTools
    undefined as never, // metadata
    undefined as never, // workspace
    undefined as never, // processRunner
    undefined as never, // log
    undefined as never, // config
    undefined as never, // flags
    undefined as never, // modelCatalog
    undefined as never, // models
    undefined as never, // protocolAdapters
    undefined as never, // collaborationRegistry
    undefined as never, // messaging
  );
}

function listTool(
  lifecycle: IAgentLifecycleService,
  tasks: { getTask(taskId: string): { status: string } | undefined },
  metadata: { read(): Promise<unknown> },
): ListAgentsTool {
  return new ListAgentsTool(
    lifecycle,
    undefined as never,
    undefined as never,
    { agentId: 'main' } as never,
    tasks as never,
    undefined as never,
    undefined as never,
    undefined as never,
    metadata as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

function materialize(tool: FollowupTaskTool) {
  return (
    tool as unknown as {
      materialize(record: unknown): Promise<IAgentScopeHandle>;
    }
  ).materialize.bind(tool);
}

describe('agent collaboration tool materialize', () => {
  it('re-seeds delegator and forkedFrom when re-creating a cold agent', async () => {
    const create = vi.fn(async () => ({ id: 'agent-7' }) as IAgentScopeHandle);
    const lifecycle = {
      _serviceBrand: undefined,
      get: () => undefined,
      create,
    } as unknown as IAgentLifecycleService;

    await materialize(followupTool(lifecycle))({
      agentId: 'agent-7',
      meta: {
        homedir: '/tmp/agents/agent-7',
        type: 'sub',
        parentAgentId: 'main',
        delegator: { kind: 'agent', agentId: 'main' },
        forkedFrom: 'agent-3',
        labels: { task: 'coder' },
      },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-7',
        delegator: { kind: 'agent', agentId: 'main' },
        forkedFrom: 'agent-3',
      }),
    );
  });

  it('preserves an external delegator ref on cold materialize', async () => {
    const create = vi.fn(async () => ({ id: 'agent-8' }) as IAgentScopeHandle);
    const lifecycle = {
      _serviceBrand: undefined,
      get: () => undefined,
      create,
    } as unknown as IAgentLifecycleService;

    await materialize(followupTool(lifecycle))({
      agentId: 'agent-8',
      meta: {
        type: 'independent',
        delegator: { kind: 'external', delegationId: 'deleg-1' },
        forkedFrom: undefined,
        labels: {},
      },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        delegator: { kind: 'external', delegationId: 'deleg-1' },
        forkedFrom: undefined,
      }),
    );
  });

  it('returns the live handle without re-creating when the agent exists', async () => {
    const create = vi.fn();
    const live = { id: 'agent-7' } as IAgentScopeHandle;
    const lifecycle = {
      _serviceBrand: undefined,
      get: () => live,
      create,
    } as unknown as IAgentLifecycleService;

    const result = await materialize(followupTool(lifecycle))({
      agentId: 'agent-7',
      meta: { labels: {} },
    });

    expect(result).toBe(live);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('agent collaboration compatibility fixes', () => {
  it('accepts nonblank fork_turns at the schema layer for actionable runtime rejection', () => {
    expect(
      SpawnAgentInputSchema.safeParse({
        task_name: 'worker',
        message: 'Investigate',
        fork_turns: 'all',
      }).success,
    ).toBe(true);
    expect(
      SpawnAgentInputSchema.safeParse({
        task_name: 'worker',
        message: 'Investigate',
        fork_turns: '   ',
      }).success,
    ).toBe(false);
  });

  it('rejects a scoped alias excluded by the caller allowlist', async () => {
    const publicProfile = normalizeAgentProfile({
      name: 'writer',
      definitionId: 'public-writer',
      systemPrompt: () => 'PUBLIC',
    });
    const scopedProfile = normalizeAgentProfile({
      name: 'writer',
      definitionId: 'private-writer',
      systemPrompt: () => 'PRIVATE',
    });
    const snapshot = {
      publicProfiles: new Map([['writer', publicProfile]]),
      defaultProfile: publicProfile,
      routes: new Map(),
      scopedBindings: new Map([
        [
          'parent-definition',
          new Map([
            [
              'writer',
              {
                parentDefinitionId: 'parent-definition',
                alias: 'writer',
                source: './_private/writer.md',
                lease: { name: 'writer', source: './_private/writer.md' },
                status: 'ready' as const,
                sourceDefinitionId: 'private-writer',
                profile: scopedProfile,
              },
            ],
          ]),
        ],
      ]),
      sourceDefinitions: new Map([['private-writer', scopedProfile]]),
      dependencyIndex: new Map(),
      diagnostics: [],
    };
    const catalog = {
      ready: Promise.resolve(),
      get: (name: string) => snapshot.publicProfiles.get(name),
      getDefault: () => publicProfile,
      list: () => [...snapshot.publicProfiles.values()],
      snapshot: () => snapshot,
      resolveSelection: () => ({ profile: publicProfile, baseProfile: publicProfile }),
    };
    const tool = new SpawnAgentTool(
      { create: vi.fn() } as never,
      undefined as never,
      catalog as never,
      { agentId: 'main' } as never,
      { list: () => [] } as never,
      {
        data: () => ({
          profileName: 'parent',
          profileDefinitionId: 'parent-definition',
          modelAlias: 'model',
          subagents: [],
        }),
      } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { get: () => undefined } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { release: () => {} } as never,
      undefined as never,
    );

    const result = await tool.run(
      { task_name: 'writer_task', message: 'Write', agent_type: 'writer' },
      { toolCallId: 'call-1', signal: new AbortController().signal } as never,
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('not allowed');
  });

  it('reports a missing latest task as unknown instead of errored', async () => {
    const lifecycle = { _serviceBrand: undefined } as IAgentLifecycleService;
    const tool = listTool(
      lifecycle,
      { getTask: () => undefined },
      {
        read: async () => ({
          agents: {
            'agent-7': {
              type: 'sub',
              labels: {
                parentAgentId: 'main',
                [COLLABORATION_TASK_NAME_LABEL]: 'worker',
                [COLLABORATION_AGENT_TYPE_LABEL]: 'coder',
              },
            },
          },
        }),
      },
    );

    const result = await tool.run();

    expect(typeof result.output).toBe('string');
    if (typeof result.output !== 'string') throw new Error('expected JSON text output');
    expect(JSON.parse(result.output)).toEqual({
      agents: [
        {
          task_name: 'worker',
          agent_id: 'agent-7',
          agent_type: 'coder',
          status: 'unknown',
        },
      ],
    });
  });
});
