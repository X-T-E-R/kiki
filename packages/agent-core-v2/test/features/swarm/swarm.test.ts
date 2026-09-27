import { expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { EVENT2_REGISTRY } from '#/app/event/event2';
import { SwarmModeEnter, SwarmModeExit } from '#/features/swarm/swarmOps';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { recordingWireLog, registerTestAgentWire, registerTestEventDispatcher, restoreTestEventDispatcher, testWireScope } from '../../wire/stubs';

it('replays old swarm events and context without restoring a retired runtime control', async () => {
  const disposables = new DisposableStore();
  try {
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    const scope = testWireScope('wire', 'retired-swarm');
    registerTestAgentWire(ix, scope, { log: recordingWireLog([]), storage: ix.get(IFileSystemStorageService) });
    const dispatcher = registerTestEventDispatcher(ix);
    const states = ix.get(IAgentStateService);
    states.contributeState(contextMemoryKey);
    await restoreTestEventDispatcher(dispatcher, ix.get(IAppendLogStore), scope, [
      { type: 'swarm_mode.enter', trigger: 'manual' },
      {
        type: 'context.append_message',
        message: {
          role: 'user', content: [{ type: 'text', text: 'old swarm reminder' }],
          toolCalls: [], origin: { kind: 'injection', variant: 'swarm_mode' },
        },
      },
      { type: 'swarm_mode.exit' },
    ]);
    expect(states.get(contextMemoryKey)).toEqual([]);
    expect(states.replayableKeys().map((key) => key.name)).not.toContain('swarm');
    expect(EVENT2_REGISTRY.get('swarm_mode.enter')).toBe(SwarmModeEnter);
    expect(EVENT2_REGISTRY.get('swarm_mode.exit')).toBe(SwarmModeExit);
  } finally {
    disposables.dispose();
  }
});
