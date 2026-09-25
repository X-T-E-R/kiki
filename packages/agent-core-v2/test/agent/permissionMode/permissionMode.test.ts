import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  IAgentContextInjectorService,
  type ContextInjectionProvider,
} from '#/agent/contextInjector/contextInjector';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { PermissionModeInjection } from '#/agent/permissionMode/injection/permissionModeInjection';
import {
  AgentPermissionModeService,
  PERMISSION_MODE_REMINDER_ENV,
} from '#/agent/permissionMode/permissionModeService';
import { permissionModeKey } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { stubBootstrap } from '../../app/bootstrap/stubs';
import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'permission-mode-test';

let registeredInjection:
  | {
      readonly name: string;
      readonly provider: ContextInjectionProvider;
    }
  | undefined;

function readInjection():
  | {
      readonly name: string;
      readonly provider: ContextInjectionProvider;
    }
  | undefined {
  return registeredInjection;
}

const injectorStub: IAgentContextInjectorService = {
  _serviceBrand: undefined,
  register: (name, provider) => {
    registeredInjection = { name, provider: provider as ContextInjectionProvider };
    return {
      dispose: () => {
        if (registeredInjection?.provider === provider) registeredInjection = undefined;
      },
    };
  },
  reconcileWhenIdle: async () => {},
  reconcileAtSafeBoundary: async () => {},
  reconcileAllAtSafeBoundary: async () => {},
};

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let dispatcher: IEventDispatcher;
let svc: IAgentPermissionModeService;
let reminderLive = false;
let bootstrapEnv: NodeJS.ProcessEnv;

function buildWithEnv(
  scopeKey: string,
  env: NodeJS.ProcessEnv,
): { readonly ix: TestInstantiationService; readonly service: IAgentPermissionModeService } {
  const ix2 = disposables.add(new TestInstantiationService());
  ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix2.stub(IAgentContextInjectorService, injectorStub);
  ix2.stub(IBootstrapService, stubBootstrap('/tmp/kimi-home', env));
  ix2.set(IAgentStateService, new AgentStateService());
  ix2.set(IAgentPermissionModeService, new SyncDescriptor(AgentPermissionModeService));
  const log2 = ix2.get(IAppendLogStore);
  registerTestAgentWire(ix2, testWireScope(SCOPE, scopeKey), { log: log2 });
  registerTestEventDispatcher(ix2);
  return { ix: ix2, service: ix2.get(IAgentPermissionModeService) };
}

beforeEach(() => {
  registeredInjection = undefined;
  reminderLive = false;
  bootstrapEnv = {};
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.stub(IAgentContextInjectorService, injectorStub);
  ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-home', bootstrapEnv));
  ix.set(IAgentStateService, new AgentStateService());
  ix.set(IAgentPermissionModeService, new SyncDescriptor(AgentPermissionModeService));
  log = ix.get(IAppendLogStore);
  registerTestAgentWire(ix, testWireScope(SCOPE, KEY), { log });
  dispatcher = registerTestEventDispatcher(ix);
  svc = ix.get(IAgentPermissionModeService);
});

afterEach(() => disposables.dispose());

async function readRecords(): Promise<WireRecord[]> {
  await dispatcher.flush();
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

async function runRegisteredInjection(): Promise<string | undefined> {
  const provider = registeredInjection?.provider;
  if (provider === undefined) throw new Error('expected permission mode injection provider');
  const content = await provider({
    injectedPositions: reminderLive ? [0] : [],
    lastInjectedAt: reminderLive ? 0 : null,
    isNewTurn: true,
  });
  if (typeof content !== 'string' && content !== undefined) {
    throw new Error('expected permission mode injection provider to return text');
  }
  if (content !== undefined) reminderLive = true;
  return content;
}

function spliceReminderOut(): void {
  reminderLive = false;
}

describe('AgentPermissionModeService (wire-backed)', () => {
  it('setMode updates mode and fires onDidChangeMode with mode/previousMode', () => {
    const changes: { mode: PermissionMode; previousMode: PermissionMode }[] = [];
    disposables.add(
      svc.onDidChangeMode((ctx) => {
        changes.push({ mode: ctx.mode, previousMode: ctx.previousMode });
      }),
    );

    expect(svc.mode).toBe('auto');

    svc.setMode('auto');
    expect(changes).toEqual([]);

    svc.setMode('manual');
    expect(svc.mode).toBe('manual');
    expect(changes).toEqual([{ mode: 'manual', previousMode: 'auto' }]);

    svc.setMode('manual');
    expect(changes).toEqual([{ mode: 'manual', previousMode: 'auto' }]);
  });

  it('enforces a persistent mode ceiling across later mode changes', () => {
    svc.setMode('yolo');
    svc.setModeCeiling('manual');
    expect(svc.mode).toBe('manual');

    svc.setMode('yolo');
    expect(svc.mode).toBe('manual');

    svc.setModeCeiling('auto');
    svc.setMode('yolo');
    expect(svc.mode).toBe('auto');
  });

  it('dispatch persists a flat { type, mode } record (no payload key)', async () => {
    svc.setMode('auto');

    const records = await readRecords();
    expect(records).toEqual([
      { type: 'permission.set_mode', mode: 'auto', time: expect.any(Number) },
    ]);
    expect('payload' in records[0]!).toBe(false);
  });

  it('persists an explicitly configured mode', async () => {
    svc.setMode('manual');

    expect(await readRecords()).toEqual([
      { type: 'permission.set_mode', mode: 'manual', time: expect.any(Number) },
    ]);
  });

  it('registers auto-mode reminder injection through the injection service', async () => {
    expect(registeredInjection?.name).toBe('permission_mode');

    svc.setMode('manual');
    await runRegisteredInjection();
    expect(await runRegisteredInjection()).toBeUndefined();

    svc.setMode('auto');
    const autoReminder = await runRegisteredInjection();
    expect(autoReminder).toContain('Auto permission mode is active');
    expect(autoReminder).toContain('ExitPlanMode is also approved automatically');
    expect(await runRegisteredInjection()).toBeUndefined();

    svc.setMode('manual');
    expect(await runRegisteredInjection()).toContain('Auto permission mode is no longer active');
  });

  it('re-announces auto mode after the live reminder is spliced out (compaction / undo)', async () => {
    svc.setMode('auto');
    expect(await runRegisteredInjection()).toContain('Auto permission mode is active');
    expect(await runRegisteredInjection()).toBeUndefined();

    spliceReminderOut();
    expect(await runRegisteredInjection()).toContain('Auto permission mode is active');
    expect(await runRegisteredInjection()).toBeUndefined();
  });

  it('announces nothing after compaction when the current mode carries no reminder', async () => {
    svc.setMode('manual');
    await runRegisteredInjection();
    expect(await runRegisteredInjection()).toBeUndefined();

    spliceReminderOut();
    expect(await runRegisteredInjection()).toBeUndefined();
  });

  it('re-announces auto mode on a fresh instance even with a live reminder in history (restore)', async () => {
    svc.setMode('auto');

    let restoredProvider: ContextInjectionProvider | undefined;
    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IAgentContextInjectorService, {
      _serviceBrand: undefined,
      register: (_name, provider) => {
        restoredProvider = provider as ContextInjectionProvider;
        return { dispose: () => {} };
      },
    });
    ix2.set(IAgentStateService, new AgentStateService());
    disposables.add(ix2.createInstance(PermissionModeInjection, svc));
    if (restoredProvider === undefined) throw new Error('expected restored provider');

    const run = () =>
      restoredProvider!({
        injectedPositions: [3],
        lastInjectedAt: 3,
        isNewTurn: true,
      });

    expect(await run()).toContain('Auto permission mode is active');
    expect(await run()).toBeUndefined();
    svc.setMode('manual');
    expect(await run()).toContain('Auto permission mode is no longer active');
  });

  it('replay rebuilds mode from a persisted record on a fresh dispatcher (silent)', async () => {
    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log2 = ix2.get(IAppendLogStore);
    registerTestAgentWire(ix2, testWireScope(SCOPE, 'permission-mode-replay'), {
      log: log2,
    });
    const fresh = registerTestEventDispatcher(ix2);
    const freshState = ix2.get(IAgentStateService);
    freshState.contributeState(permissionModeKey);

    await restoreTestEventDispatcher(
      fresh,
      log2,
      testWireScope(SCOPE, 'permission-mode-replay'),
      [{ type: 'permission.set_mode', mode: 'auto' }],
    );

    expect(freshState.get(permissionModeKey)).toBe('auto');

    const written: WireRecord[] = [];
    for await (const record of log2.read<WireRecord>(testWireScope(SCOPE, 'permission-mode-replay'), AGENT_WIRE_RECORD_KEY)) {
      written.push(record);
    }
    expect(written[0]).toMatchObject({ type: 'metadata' });
    expect(written.slice(1)).toEqual([{ type: 'permission.set_mode', mode: 'auto' }]);
  });

  it('skips the auto-mode reminder injection when the reminder env is disabled', () => {
    registeredInjection = undefined;
    const { service } = buildWithEnv('permission-mode-reminder-off', {
      [PERMISSION_MODE_REMINDER_ENV]: '0',
    });

    expect(registeredInjection).toBeUndefined();
    service.setMode('auto');
    expect(service.mode).toBe('auto');
    expect(registeredInjection).toBeUndefined();
  });

  it('keeps the auto-mode reminder injection when the reminder env enables it explicitly', () => {
    registeredInjection = undefined;
    buildWithEnv('permission-mode-reminder-on', { [PERMISSION_MODE_REMINDER_ENV]: '1' });

    expect(readInjection()?.name).toBe('permission_mode');
  });
});
