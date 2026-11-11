import { describe, expect, it } from 'vitest';

import { IInstantiationService, type ServiceIdentifier, type ServicesAccessor } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { AsyncEmitter, Emitter, Event } from '#/_base/event';
import { IAgentLifecycleService, type AgentWillSealTranscriptEvent } from '#/session/agentLifecycle/agentLifecycle';
import { ICordisRuntimeService } from '#/app/cordisRuntime/cordisRuntime';
import { CordisRuntimeService } from '#/app/cordisRuntime/cordisRuntimeService';
import { IPluginExtensionPortRegistry } from '#/app/plugin/extensionSlots';

function scopeHandle(id: string, container: InstantiationService): IAgentScopeHandle {
  const accessor: ServicesAccessor = { get: <T>(key: ServiceIdentifier<T>) => container.invokeFunction(access => access.get(key)) };
  return { id, kind: 'agent', accessor, dispose: () => container.dispose() };
}

it('revokes in the same dispose stack and drains child Cordis before parent through real scope Ledgers', async () => {
  const test = new TestInstantiationService(new ServiceCollection(), true);
  const cleanup = new DisposableStore();
  const runtime = test.createInstance(CordisRuntimeService);
  cleanup.add(runtime);
  const session = test.createChild(new ServiceCollection()) as InstantiationService;
  const created = new Emitter<IAgentScopeHandle>();
  const removing = new Emitter<string>();
  const sealing = new AsyncEmitter<AgentWillSealTranscriptEvent>();
  test.stub(IAgentLifecycleService, { onWillCreate: created.event, onWillRemove: removing.event, onWillSealTranscript: sealing.event,
    onDidCreate: Event.None, onDidDispose: Event.None, list: () => [] } as unknown as IAgentLifecycleService);
  runtime.attachSession({ sessionId: 'session-a', readSeed: <T>(id: ServiceIdentifier<T>) => session.invokeFunction(a => a.get(id)),
    contributeSeed: (id, value) => { session.provide(id, value); },
    onSessionDispose: dispose => { session.anchorKernelEntry(dispose, 'test-session'); } });
  cleanup.add(runtime.attachAgentLifecycle('session-a', session.invokeFunction(a => a.get(IAgentLifecycleService))));
  const agent = session.createChild(new ServiceCollection()) as InstantiationService;
  const handle = scopeHandle('main', agent);
  created.fire(handle);
  const order: string[] = [];
  let parentLive = true;
  const parent = runtime.mountInProcessPlugin({ pluginId: 'session-provider', scope: { sessionId: 'session-a' }, declaredSlots: [],
    plugin: ctx => { ctx.provide('session.resource', 'live'); ctx.effect(() => async () => { order.push('session'); parentLive = false; }); } });
  const child = runtime.mountInProcessPlugin({ pluginId: 'agent-consumer', scope: { sessionId: 'session-a', agentId: 'main' }, declaredSlots: [],
    plugin: ctx => { ctx.on('check', () => { order.push('event'); }); ctx.effect(() => async () => {
      order.push('agent-start'); await Promise.resolve(); expect(parentLive).toBe(true); expect(ctx.get('session.resource')).toBe('live'); order.push('agent-end');
    }); } });
  await Promise.all([parent.ready, child.ready]);
  const gate = runtime.admissionGateForAgent('session-a', 'main')!;
  const target = runtime.scopeTargetForAgent('session-a', 'main', {});
  const closing = session.dispose();
  expect(gate.revoked).toBe(true);
  runtime.rootContext.emit('check', {}, target);
  expect(order).not.toContain('event');
  await closing;
  expect(order).toEqual(['agent-start', 'agent-end', 'session']);
  expect(runtime.sessionScopeKey('session-a')).toBeUndefined();
  await cleanup.dispose();
  await test.dispose();
});

describe('Cordis extension-port availability', () => {
  it('publishes and retracts the host port using the live DI reference', async () => {
    const test = new TestInstantiationService(new ServiceCollection(), true);
    const runtime = test.createInstance(CordisRuntimeService);
    test.stub(ICordisRuntimeService, runtime);
    const ports = {};
    const supplied = test.provide(IPluginExtensionPortRegistry, ports as IPluginExtensionPortRegistry);
    expect(runtime.rootContext.get('kiki.extensionPorts')).toBe(ports);
    await supplied.dispose();
    expect(runtime.rootContext.get('kiki.extensionPorts')).toBeUndefined();
    await runtime.dispose();
    await test.dispose();
  });
});

it('keeps a replacement generation mounted when the previous handle is disposed again', async () => {
  const test = new TestInstantiationService(new ServiceCollection(), true);
  const runtime = test.createInstance(CordisRuntimeService);
  try {
    const first = runtime.mountInProcessPlugin({ pluginId: 'replaceable', declaredSlots: [], plugin: () => {} });
    await first.ready;
    await first.dispose();
    const second = runtime.mountInProcessPlugin({ pluginId: 'replaceable', declaredSlots: [], plugin: () => {} });
    await second.ready;
    await first.dispose();
    expect(second.phase).toBe('active');
    expect(runtime.listMountedPlugins()).toMatchObject([{ pluginId: 'replaceable', generation: 2 }]);
  } finally {
    await runtime.dispose();
    await test.dispose();
  }
});
