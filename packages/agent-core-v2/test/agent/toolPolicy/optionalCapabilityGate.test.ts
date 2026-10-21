import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { AgentToolPolicyService } from '#/agent/toolPolicy/toolPolicyService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import type { OptionalCapabilityId } from '#/app/optionalCapability/admit';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

const disposables = new DisposableStore();
afterEach(() => disposables.clear());

function policy(options: {
  admit?: (id: OptionalCapabilityId) => boolean;
  approval?: 'auto' | 'off';
  disabledToolGroups?: ProfileData['disabledToolGroups'];
  snapshot?: boolean;
  withPolicy?: boolean;
}) {
  const ix = disposables.add(new TestInstantiationService());
  const admit = vi.fn((id: OptionalCapabilityId) => ({ admitted: options.admit?.(id) ?? true, reason: 'admitted' as const }));
  if (options.withPolicy !== false) {
    ix.stub(IOptionalCapabilityPolicy, { admit, retain() {}, release() {} });
  }
  ix.stub(ISessionContext, { sessionId: 's1', workspaceId: 'w' });
  ix.stub(ICapabilitySnapshotService, { toolAvailable: () => options.snapshot ?? true });
  ix.stub(IAgentScopeContext, { agentId: 'main' });
  ix.stub(IAgentProfileService, { data: (): ProfileData => ({
    modelCapabilities: { image_in: false, video_in: false, audio_in: false, thinking: false, tool_use: true, max_context_tokens: 128_000 },
    thinkingLevel: 'off',
    systemPrompt: '',
    disabledToolGroups: options.disabledToolGroups,
  }) });
  ix.stub(IConfigService, { get: <T>() => ({ approval: options.approval ?? 'auto' }) as T });
  ix.stub(ISessionToolPolicy, { disabledTools: () => [] });
  ix.stub(ISessionToolPolicyGate, { disabledTools: [] });
  ix.stub(IAgentToolExecutorService, { registerToolCallGuard: () => ({ dispose() {} }) });
  ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
  ix.set(IAgentToolPolicyService, new SyncDescriptor(AgentToolPolicyService));
  return { sut: ix.get(IAgentToolPolicyService), admit };
}

describe('optional capability tool gate', () => {
  it('hides web tools when this session is not admitted and keeps Bash on the existing policy', () => {
    const { sut, admit } = policy({ admit: (id) => id !== 'web' });
    expect(sut.isToolActive('WebSearch')).toBe(false);
    expect(sut.isToolActive('FetchURL')).toBe(false);
    expect(sut.isToolActiveForDisclosure('WebSearch')).toBe(false);
    expect(sut.isToolActive('Bash')).toBe(true);
    expect(admit).toHaveBeenCalledWith('web', { sessionId: 's1', workspaceId: 'w', agentId: 'main' });
    expect(admit.mock.calls.some(([id]) => id === undefined)).toBe(false);
  });

  it('still applies a web group deny after admission', () => {
    const { sut } = policy({ admit: () => true, disabledToolGroups: ['web'] });
    expect(sut.isToolActive('WebSearch')).toBe(false);
    expect(sut.isToolActive('FetchURL')).toBe(false);
    expect(sut.isToolActive('Read')).toBe(true);
  });

  it('keeps MemoryWrite behind approval after admission', () => {
    const open = policy({ admit: () => true, approval: 'auto' });
    expect(open.sut.isToolActive('MemoryWrite')).toBe(true);
    const closed = policy({ admit: () => true, approval: 'off' });
    expect(closed.sut.isToolActive('MemoryWrite')).toBe(false);
    expect(closed.sut.isToolActive('MemoryRead')).toBe(true);
  });

  it('lets an admission replace the snapshot for web and leaves Bash on the snapshot', () => {
    const admitted = policy({ admit: () => true, snapshot: false });
    expect(admitted.sut.isToolActive('WebSearch')).toBe(true);
    expect(admitted.sut.isToolActive('FetchURL')).toBe(true);
    expect(admitted.sut.isToolActive('Bash')).toBe(false);
    const absent = policy({ withPolicy: false, snapshot: false });
    expect(absent.sut.isToolActive('WebSearch')).toBe(false);
    expect(absent.admit).not.toHaveBeenCalled();
  });
});
