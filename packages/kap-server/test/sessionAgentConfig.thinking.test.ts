import {
  IAgentExecutionService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  type ISessionScopeHandle,
} from '@kiki/agent-core-v2';
import { sessionAgentConfigPartialSchema } from '@kiki/agent-core-v2/app/sessionLegacy/sessionProtocol';
import { describe, expect, it } from 'vitest';

import { applySessionAgentConfig } from '../src/routes/sessionAgentConfig';

interface ProfileData {
  profileName?: string;
  thinkingLevel?: string;
  modelAlias?: string;
  personaId?: string;
  persona?: { definition: { id: string } };
  personaOverrides?: { profile?: string; model?: string; thinking?: string };
  execution?: {
    selection: { executor: string; profile?: string; overrides?: { model?: string; thinking?: string | null } };
    effective: { permission_mode?: 'manual' };
  };
}

function harness(data: ProfileData, executionState: 'idle' | 'running' = 'idle') {
  const calls = {
    bind: [] as Array<Record<string, unknown>>,
    setThinking: [] as string[],
    restore: 0,
    permission: [] as string[],
  };
  const profile = {
    data: () => data,
    bind: async (input: Record<string, unknown>) => { calls.bind.push(input); },
    setThinking: (level: string) => { calls.setThinking.push(level); },
    restoreDefaultThinking: () => { calls.restore += 1; },
    setModel: async () => undefined,
    update: () => undefined,
  };
  const agent = {
    accessor: {
      get(id: unknown): unknown {
        if (id === IAgentProfileService) return profile;
        if (id === IAgentExecutionService) return { status: () => ({ state: executionState }) };
        if (id === IAgentPermissionModeService) return {
          setMode: () => undefined,
          setModeAndBroadcast: (mode: string) => { calls.permission.push(mode); },
        };
        throw new Error('unexpected agent service');
      },
    },
  };
  const session = {
    accessor: {
      get(id: unknown): unknown {
        if (id === IAgentLifecycleService) return { create: async () => agent };
        throw new Error('unexpected session service');
      },
    },
  } as unknown as ISessionScopeHandle;
  return { session, calls };
}

describe('applySessionAgentConfig thinking null', () => {
  it('rejects an empty effort and accepts an explicit null clear', () => {
    expect(sessionAgentConfigPartialSchema.safeParse({ thinking: '' }).success).toBe(false);
    expect(sessionAgentConfigPartialSchema.parse({ thinking: null }).thinking).toBeNull();
    expect(sessionAgentConfigPartialSchema.parse({}).thinking).toBeUndefined();
  });

  it('restores the default when null arrives with no execution binding', async () => {
    const { session, calls } = harness({ profileName: 'agent', thinkingLevel: 'high' });
    await applySessionAgentConfig(session, { thinking: null });
    expect(calls.restore).toBe(1);
    expect(calls.bind).toEqual([]);
    expect(calls.setThinking).toEqual([]);
  });

  it('keeps the current effort when thinking is omitted', async () => {
    const { session, calls } = harness({ profileName: 'agent', thinkingLevel: 'high' });
    await applySessionAgentConfig(session, { profile: 'agent' });
    expect(calls.restore).toBe(0);
    expect(calls.bind).toEqual([]);
    expect(calls.setThinking).toEqual([]);
  });

  it('pins a concrete effort without clearing it', async () => {
    const { session, calls } = harness({ profileName: 'agent', thinkingLevel: 'high' });
    await applySessionAgentConfig(session, { thinking: 'low' });
    expect(calls.setThinking).toEqual(['low']);
    expect(calls.restore).toBe(0);
    expect(calls.bind).toEqual([]);
  });

  it('does not copy the old effort onto a new profile when null clears the pin', async () => {
    const { session, calls } = harness({
      profileName: 'agent',
      thinkingLevel: 'high',
      modelAlias: 'kimi-code/kimi-for-coding',
      personaId: 'sample',
      persona: { definition: { id: 'sample' } },
      personaOverrides: { thinking: 'high', model: 'kimi-code/kimi-for-coding' },
    });
    await applySessionAgentConfig(session, { profile: 'reviewer', thinking: null });
    expect(calls.bind).toEqual([expect.objectContaining({
      profile: 'reviewer',
      thinking: null,
      strictThinking: false,
      personaOverrides: { profile: 'reviewer', model: 'kimi-code/kimi-for-coding' },
    })]);
    expect(calls.bind[0]?.['personaOverrides']).not.toHaveProperty('thinking');
    expect(calls.setThinking).toEqual([]);
    expect(calls.restore).toBe(0);
  });

  it('keeps the current effort when a profile change omits thinking', async () => {
    const { session, calls } = harness({ profileName: 'agent', thinkingLevel: 'high', modelAlias: 'raw' });
    await applySessionAgentConfig(session, { profile: 'reviewer' });
    expect(calls.bind).toEqual([expect.objectContaining({ profile: 'reviewer', thinking: 'high', strictThinking: false })]);
    expect(calls.restore).toBe(0);
  });

  it('clears an execution override with null and does not rebuild the engine', async () => {
    const selection = { executor: 'native', profile: 'agent', overrides: { model: 'raw', thinking: 'high' } };
    const { session, calls } = harness({
      profileName: 'agent',
      thinkingLevel: 'high',
      execution: { selection, effective: {} },
    });
    await applySessionAgentConfig(session, { profile: 'agent', thinking: null });
    expect(calls.setThinking).toEqual([]);
    expect(calls.restore).toBe(0);
    expect(calls.bind).toEqual([{
      execution: { executor: 'native', profile: 'agent', overrides: { model: 'raw', thinking: null } },
      model: undefined,
      thinking: null,
    }]);
  });

  it('refuses an execution clear while the agent is busy', async () => {
    const selection = { executor: 'native', profile: 'agent', overrides: { thinking: 'high' } };
    const { session, calls } = harness({
      profileName: 'agent',
      execution: { selection, effective: {} },
    }, 'running');
    await expect(applySessionAgentConfig(session, { profile: 'agent', thinking: null })).rejects.toThrow(/idle agent/);
    expect(calls.bind).toEqual([]);
    expect(calls.restore).toBe(0);
  });
});

describe('applySessionAgentConfig live permissions', () => {
  it.each(['native', 'example-acp'])('updates a running %s permission mode without rebinding its execution', async (executor) => {
    const selection = { executor, profile: 'agent', overrides: { model: 'example/model', thinking: 'high' } };
    const { session, calls } = harness({ profileName: 'agent', execution: { selection, effective: {} } }, 'running');
    await applySessionAgentConfig(session, { permission_mode: 'yolo' });
    expect(calls.permission).toEqual(['yolo']);
    expect(calls.bind).toEqual([]);
    expect(calls.setThinking).toEqual([]);
    expect(calls.restore).toBe(0);
  });
});
