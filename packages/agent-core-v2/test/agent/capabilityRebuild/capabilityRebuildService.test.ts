import { afterEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentCapabilityRebuildService } from '#/agent/capabilityRebuild/capabilityRebuild';
import { AgentCapabilityRebuildService } from '#/agent/capabilityRebuild/capabilityRebuildService';
import { IAgentContextInjectorService, type ContextInjectionProvider } from '#/agent/contextInjector/contextInjector';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionDeliveryService } from '#/session/delivery/delivery';

let disposables: DisposableStore;
let ix: TestInstantiationService;

afterEach(async () => {
  await disposables.dispose();
});

describe('AgentCapabilityRebuildService', () => {
  it('rebuilds when SendMessage admission changes and keeps explicit off closed in message mode', async () => {
    let choice: 'on' | 'off' | 'inherit' = 'off';
    let provider: ContextInjectionProvider | undefined;
    const activate = vi.fn(async () => {});
    const refreshSystemPrompt = vi.fn(async () => {});
    const refreshMemorySnapshot = vi.fn(async () => {});
    const refresh = vi.fn(() => ({ memory: false, thread: false }));
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(ICapabilitySnapshotService, {
          _serviceBrand: undefined,
          ready: Promise.resolve(),
          memoryAvailable: () => true,
          threadEnabled: () => true,
          anySessionThreadEnabled: () => true,
          toolAvailable: () => true,
          refresh,
        });
        reg.definePartialInstance(ISessionContext, { sessionId: 's1', workspaceId: 'w1' });
        reg.definePartialInstance(ISessionDeliveryService, { effectiveMode: () => 'message' });
        reg.definePartialInstance(IAgentScopeContext, { agentId: 'main' });
        reg.definePartialInstance(IAgentProfileService, {
          refreshSystemPrompt,
          refreshMemorySnapshot,
        });
        reg.definePartialInstance(IAgentToolActivationService, { activate });
        reg.definePartialInstance(IOptionalCapabilityPolicy, {
          admit: (id) => id === 'send_message'
            ? { admitted: choice === 'on', reason: choice === 'on' ? 'admitted' : 'default_off' }
            : { admitted: true, reason: 'admitted' },
          choice: () => choice,
          globalState: () => ({ allowed: true, hostLocked: false, defaultOn: false, origin: 'default', unresolved: false }),
          load: async () => {},
        });
        reg.definePartialInstance(IAgentContextInjectorService, {
          register: <D = unknown>(_name: string, next: ContextInjectionProvider<D>) => {
            provider = next as unknown as ContextInjectionProvider;
            return toDisposable(() => { provider = undefined; });
          },
          reconcileWhenIdle: async () => {},
          reconcileAtSafeBoundary: async () => {},
          reconcileAllAtSafeBoundary: async () => {},
        });
        reg.define(IAgentCapabilityRebuildService, AgentCapabilityRebuildService);
      },
    });

    ix.get(IAgentCapabilityRebuildService);
    expect(provider).toBeDefined();
    await provider!({} as never);
    expect(activate).not.toHaveBeenCalled();

    choice = 'on';
    await provider!({} as never);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenCalledOnce();
    expect(refreshSystemPrompt).toHaveBeenCalledOnce();

    choice = 'off';
    await provider!({} as never);
    expect(activate).toHaveBeenCalledTimes(2);
  });
});
