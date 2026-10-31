import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { isSendMessageCapabilityAdmitted, isSendMessageToolActive } from '#/agent/toolPolicy/sendMessageAdmission';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { AgentToolPolicyService } from '#/agent/toolPolicy/toolPolicyService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import type { CapabilityChoice, OptionalCapabilityId } from '#/app/optionalCapability/admit';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

const disposables = new DisposableStore();
afterEach(() => disposables.clear());

function policy(options: {
  admit?: (id: OptionalCapabilityId) => boolean;
  approval?: 'auto' | 'off';
  disabledToolGroups?: ProfileData['disabledToolGroups'];
  disallowedTools?: readonly string[];
  workspaceDisabledTools?: readonly string[];
  snapshot?: boolean;
  withPolicy?: boolean;
  deliveryMode?: 'reply' | 'message';
  sendChoice?: CapabilityChoice;
}) {
  const ix = disposables.add(new TestInstantiationService());
  const admit = vi.fn((id: OptionalCapabilityId) => {
    const admitted = options.admit?.(id) ?? true;
    return { admitted, reason: admitted ? 'admitted' as const : 'default_off' as const };
  });
  if (options.withPolicy !== false) {
    ix.stub(IOptionalCapabilityPolicy, {
      admit,
      choice: () => options.sendChoice ?? 'inherit',
      globalState: () => ({ allowed: true, hostLocked: false, defaultOn: false, origin: 'default', unresolved: false }),
      retain() {},
      release() {},
      load: async () => {},
    });
  }
  ix.stub(ISessionContext, { sessionId: 's1', workspaceId: 'w' });
  ix.stub(ISessionDeliveryService, { effectiveMode: () => options.deliveryMode ?? 'reply' });
  ix.stub(ICapabilitySnapshotService, { toolAvailable: () => options.snapshot ?? true });
  ix.stub(IAgentScopeContext, { agentId: 'main' });
  const data = vi.fn((): ProfileData => ({
    modelCapabilities: { image_in: false, video_in: false, audio_in: false, thinking: false, tool_use: true, max_context_tokens: 128_000 },
    thinkingLevel: 'off',
    systemPrompt: '',
    disabledToolGroups: options.disabledToolGroups,
    disallowedTools: options.disallowedTools,
  }));
  ix.stub(IAgentProfileService, { data });
  ix.stub(IConfigService, { get: <T>() => ({ approval: options.approval ?? 'auto' }) as T });
  ix.stub(ISessionToolPolicy, { disabledTools: () => [] });
  ix.stub(ISessionToolPolicyGate, { disabledTools: options.workspaceDisabledTools ?? [] });
  ix.stub(IAgentToolExecutorService, { registerToolCallGuard: () => ({ dispose() {} }) });
  ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
  ix.set(IAgentToolPolicyService, new SyncDescriptor(AgentToolPolicyService));
  return { sut: ix.get(IAgentToolPolicyService), admit, data };
}

describe('optional capability tool gate', () => {
  it('shares one profile read inside a snapshot and reads fresh state after it', () => {
    const { sut, data } = policy({});
    data.mockClear();
    const inside = sut.withSnapshot(() => [
      sut.isToolActive('Bash'),
      sut.withSnapshot(() => sut.isToolActive('WebSearch')),
      sut.isToolActiveForDisclosure('Read'),
    ]);
    expect(inside).toEqual([true, true, true]);
    expect(data).toHaveBeenCalledTimes(1);
    sut.isToolActive('Bash');
    sut.isToolActive('Bash');
    expect(data).toHaveBeenCalledTimes(3);
  });

  it('drops the snapshot when the evaluation throws', () => {
    const { sut, data } = policy({});
    expect(() => sut.withSnapshot(() => { sut.isToolActive('Bash'); throw new Error('boom'); })).toThrow('boom');
    data.mockClear();
    sut.isToolActive('Bash');
    sut.isToolActive('Bash');
    expect(data).toHaveBeenCalledTimes(2);
  });

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

  it('opens SendMessage for a session choice or message delivery but lets explicit off and hard deny win', () => {
    const opened = policy({ admit: () => true, deliveryMode: 'reply', sendChoice: 'on' });
    expect(opened.sut.isToolActive('SendMessage')).toBe(true);
    const persona = policy({ admit: () => false, deliveryMode: 'message' });
    expect(persona.sut.isToolActive('SendMessage')).toBe(true);
    const off = policy({ admit: () => false, deliveryMode: 'message', sendChoice: 'off' });
    expect(off.sut.isToolActive('SendMessage')).toBe(false);
    const denied = policy({ admit: () => false, deliveryMode: 'message', disallowedTools: ['SendMessage'] });
    expect(denied.sut.isToolActive('SendMessage')).toBe(false);
    const workspaceDenied = policy({ admit: () => false, deliveryMode: 'message', workspaceDisabledTools: ['SendMessage'] });
    expect(workspaceDenied.sut.isToolActive('SendMessage')).toBe(false);
  });

  it('fails closed when the SendMessage policy or guard dependency is unavailable', () => {
    const delivery = { effectiveMode: () => 'message' as const };
    const accessor = { get: (id: unknown) => id === ISessionDeliveryService ? delivery : undefined } as never;
    expect(isSendMessageCapabilityAdmitted(accessor)).toBe(false);
    expect(isSendMessageToolActive(accessor)).toBe(false);
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
