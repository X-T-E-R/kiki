import { describe, expect, it, vi } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { SessionManager } from '#/app/sessionManager/sessionManagerService';
import { Error2, ErrorCodes } from '#/errors';
import { Program } from '#/program/program';
import type { ProgramSessionControllerInput } from '#/program/programDependencies';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { RuntimeRegistry } from '#/runtime/runtimeRegistry';
import type {
  SessionArchivedEvent,
  SessionClosedEvent,
  SessionCreatedEvent,
  SessionWillCreateEvent,
} from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
import type { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

function controller(sessionId = 'session-1'): {
  readonly service: SessionLifecycleService;
  readonly handle: ISessionScopeHandle;
  readonly dispose: ReturnType<typeof vi.fn>;
} {
  const handle = { id: sessionId } as unknown as ISessionScopeHandle;
  const dispose = vi.fn();
  const willCreate = new Emitter<SessionWillCreateEvent>();
  const didCreate = new Emitter<SessionCreatedEvent>();
  const didClose = new Emitter<SessionClosedEvent>();
  const service = {
    onWillCreateSession: willCreate.event,
    onDidCreateSession: didCreate.event,
    onWillCloseSession: Event.None,
    onDidCloseSession: didClose.event,
    onDidArchiveSession: Event.None,
    onDidForkSession: Event.None,
    create: async () => {
      didCreate.fire({ sessionId, handle, source: 'startup' });
      return handle;
    },
    get: (id: string) => id === sessionId ? handle : undefined,
    list: () => [handle],
    resume: async () => handle,
    close: async (sessionId: string) => { didClose.fire({ sessionId }); },
    unload: async (sessionId: string, canCommit?: () => boolean) => {
      if (canCommit?.() === false) return false;
      didClose.fire({ sessionId, reason: 'evict' });
      return true;
    },
    archive: async () => {},
    restore: async () => handle,
    delete: async () => {},
    fork: async () => handle,
    createChild: async () => handle,
    dispose,
  } as unknown as SessionLifecycleService;
  return { service, handle, dispose };
}

async function drainMicrotasks(ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

describe('SessionManager', () => {
  it('serializes resume, close, and lifecycle critical sections per session', async () => {
    const didCreate = new Emitter<SessionCreatedEvent>();
    const didClose = new Emitter<SessionClosedEvent>();
    const handle = { id: 'session-1' } as unknown as ISessionScopeHandle;
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const order: string[] = [];
    const service = {
      onWillCreateSession: Event.None,
      onDidCreateSession: didCreate.event,
      onWillCloseSession: Event.None,
      onDidCloseSession: didClose.event,
      onDidArchiveSession: Event.None,
      onDidForkSession: Event.None,
      create: async () => handle,
      get: () => undefined,
      list: () => [],
      resume: async () => {
        order.push('resume:start');
        await resumeGate;
        didCreate.fire({ sessionId: 'session-1', handle, source: 'startup' });
        order.push('resume:end');
        return handle;
      },
      close: async () => {
        order.push('close');
        didClose.fire({ sessionId: 'session-1' });
      },
      archive: async () => {},
      restore: async () => handle,
      delete: async () => {},
      fork: async () => handle,
      createChild: async () => handle,
      dispose: () => {},
    } as unknown as SessionLifecycleService;
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);

    const resumePromise = manager.resume('session-1');
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section');
    });
    const closePromise = manager.close('session-1');
    await drainMicrotasks();
    expect(order).toEqual(['resume:start']);
    releaseResume();
    await Promise.all([resumePromise, section, closePromise]);
    expect(order).toEqual(['resume:start', 'resume:end', 'section', 'close']);
    manager.dispose();
  });

  it('holds a resume started during a lifecycle critical section', async () => {
    const fake = controller();
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const order: string[] = [];
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const resumePromise = manager.resume('session-1').then((handle) => {
      order.push('resume');
      return handle;
    });
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, resumePromise]);
    expect(order).toEqual(['section:start', 'section:end', 'resume']);
    manager.dispose();
  });

  it('serializes delete with the per-session lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { delete: () => Promise<void> }).delete = async () => {
      order.push('delete');
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const deletePromise = manager.delete('session-1');
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, deletePromise]);
    expect(order).toEqual(['section:start', 'section:end', 'delete']);
    manager.dispose();
  });

  it('fires onDidDeleteSession when the controller reports removal before failing', async () => {
    const fake = controller();
    (fake.service as unknown as {
      delete: (sessionId: string, onRemoved?: () => void) => Promise<void>;
    }).delete = async (_sessionId, onRemoved) => {
      onRemoved?.();
      throw new Error('index removal failed');
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);
    const deleted: string[] = [];
    manager.onDidDeleteSession?.((event) => deleted.push(event.sessionId));

    await expect(manager.delete('session-1')).rejects.toThrow('index removal failed');

    expect(deleted).toEqual(['session-1']);
    manager.dispose();
  });

  it('does not fire onDidDeleteSession when the controller fails before reporting removal', async () => {
    const fake = controller();
    (fake.service as unknown as {
      delete: (sessionId: string, onRemoved?: () => void) => Promise<void>;
    }).delete = async () => {
      throw new Error('session directory removal failed');
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);
    const deleted: string[] = [];
    manager.onDidDeleteSession?.((event) => deleted.push(event.sessionId));

    await expect(manager.delete('session-1')).rejects.toThrow('session directory removal failed');

    expect(deleted).toEqual([]);
    manager.dispose();
  });

  it('serializes fork of the source session with the lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { fork: () => Promise<unknown> }).fork = async () => {
      order.push('fork');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const forkPromise = manager.fork({ sourceSessionId: 'session-1' } as never);
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, forkPromise]);
    expect(order).toEqual(['section:start', 'section:end', 'fork']);
    manager.dispose();
  });

  it('serializes fork of an explicit target id with the lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { fork: () => Promise<unknown> }).fork = async () => {
      order.push('fork');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-2', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const forkPromise = manager.fork({ sourceSessionId: 'session-1', newSessionId: 'session-2' } as never);
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, forkPromise]);
    expect(order).toEqual(['section:start', 'section:end', 'fork']);
    manager.dispose();
  });

  it('serializes createChild of an explicit target id with the lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { createChild: () => Promise<unknown> }).createChild = async () => {
      order.push('createChild');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-2', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const childPromise = manager.createChild({ sourceSessionId: 'session-1', newSessionId: 'session-2' } as never);
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, childPromise]);
    expect(order).toEqual(['section:start', 'section:end', 'createChild']);
    manager.dispose();
  });

  it('serializes create with an explicit session id with the lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { create: () => Promise<unknown> }).create = async () => {
      order.push('create');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const createPromise = manager.create({ sessionId: 'session-1', workDir: '/workspace' } as never);
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, createPromise]);
    expect(order).toEqual(['section:start', 'section:end', 'create']);
    manager.dispose();
  });

  it('serializes archive with the per-session lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { archive: () => Promise<void> }).archive = async () => {
      order.push('archive');
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const archivePromise = manager.archive('session-1');
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, archivePromise]);
    expect(order).toEqual(['section:start', 'section:end', 'archive']);
    manager.dispose();
  });

  it('propagates a failed resume to the next settle until a fresh attempt supersedes', async () => {
    let fail = true;
    const fake = controller();
    (fake.service as unknown as { resume: () => Promise<unknown> }).resume = async () => {
      if (fail) throw new Error('boom');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);

    await expect(manager.resume('session-1')).rejects.toThrow('boom');
    await expect(manager.whenResumeSettled('session-1')).rejects.toThrow('boom');

    fail = false;
    await manager.resume('session-1');
    await expect(manager.whenResumeSettled('session-1')).resolves.toBeUndefined();
    manager.dispose();
  });

  it('owns one global live-session registry across workspace controllers', async () => {
    const fake = controller();
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: (workspaceId: string) => workspaceId === workspace.id ? workspace : undefined,
    } as unknown as IWorkspaceInstanceManager;
    const index = { get: async () => undefined } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);
    const created = await manager.create({ workDir: '/workspace' });
    expect(created).toBe(fake.handle);
    expect(manager.get('session-1')).toBe(fake.handle);
    expect(manager.list()).toEqual([fake.handle]);
    await manager.close('session-1');
    expect(manager.get('session-1')).toBeUndefined();
    expect(manager.list()).toEqual([]);
    manager.dispose();
  });

  it('closes every live session and retires its controller for a forced workspace close', async () => {
    const fake = controller();
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const manager = new SessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
    );

    await manager.create({ workDir: '/workspace' });
    await manager.closeWorkspace(workspace.id);

    expect(manager.get(fake.handle.id)).toBeUndefined();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
    manager.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent same-process resumes before the workspace controller resolves', async () => {
    const fake = controller('session-1');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resume = vi.fn(async () => {
      await gate;
      return fake.handle;
    });
    (fake.service as unknown as { resume: typeof resume }).resume = resume;
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: workspace.id, cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);

    const first = manager.resume('session-1');
    const second = manager.resume('session-1');
    expect(first).toBe(second);
    release();
    await expect(first).resolves.toBe(fake.handle);
    expect(resume).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it('uses the replacement Program generation for new sessions while retaining live owners', async () => {
    const first = controller('session-1');
    const second = controller('session-2');
    let generation = 'generation-1';
    const workspace = {
      id: 'workspace-1',
      program: {
        get sessionControllerGeneration() { return generation; },
        createSessionController: () => generation === 'generation-1' ? first.service : second.service,
      },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const manager = new SessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
    );

    expect(await manager.create({ workDir: '/workspace' })).toBe(first.handle);
    generation = 'generation-2';
    expect(await manager.create({ workDir: '/workspace' })).toBe(second.handle);
    expect(manager.list()).toEqual([first.handle, second.handle]);

    await manager.close('session-1');
    expect(manager.get('session-1')).toBeUndefined();
    expect(manager.get('session-2')).toBe(second.handle);
    manager.dispose();
  });

  it('retires a superseded controller that never came to own a session', async () => {
    const first = controller('session-1');
    const second = controller('session-2');
    (first.service as { create: unknown }).create = async () => {
      throw new Error('boom');
    };
    const disposeFirst = vi.fn();
    (first.service as { dispose: unknown }).dispose = disposeFirst;
    let generation = 'generation-1';
    const workspace = {
      id: 'workspace-1',
      program: {
        get sessionControllerGeneration() { return generation; },
        createSessionController: () => generation === 'generation-1' ? first.service : second.service,
      },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const manager = new SessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
    );

    await expect(manager.create({ workDir: '/workspace' })).rejects.toThrow('boom');
    expect(disposeFirst).not.toHaveBeenCalled();
    generation = 'generation-2';
    expect(await manager.create({ workDir: '/workspace' })).toBe(second.handle);
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(manager.get('session-2')).toBe(second.handle);
    manager.dispose();
    expect(disposeFirst).toHaveBeenCalledTimes(1);
  });

  it('propagates an external-delegation fork guard without polluting live state', async () => {
    const fake = controller('source-session');
    const fork = vi.fn(async () => {
      throw new Error2(
        ErrorCodes.SESSION_FORK_EXTERNAL_DELEGATION,
        'A Session with an external delegation root cannot be forked.',
      );
    });
    (fake.service as unknown as { fork: typeof fork }).fork = fork;
    const workspace = {
      id: 'workspace-1',
      program: {
        sessionControllerGeneration: 'generation-1',
        createSessionController: () => fake.service,
      },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: (workspaceId: string) => workspaceId === workspace.id ? workspace : undefined,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async (sessionId: string) => sessionId === 'source-session'
        ? { workspaceId: workspace.id, cwd: '/workspace' }
        : undefined,
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index);
    const didCreate = vi.fn();
    const didFork = vi.fn();
    const createSubscription = manager.onDidCreateSession(didCreate);
    const forkSubscription = manager.onDidForkSession(didFork);

    await expect(manager.fork({
      sourceSessionId: 'source-session',
      newSessionId: 'target-session',
    })).rejects.toMatchObject({ code: ErrorCodes.SESSION_FORK_EXTERNAL_DELEGATION });

    expect(fork).toHaveBeenCalledTimes(1);
    expect(manager.get('source-session')).toBeUndefined();
    expect(manager.get('target-session')).toBeUndefined();
    expect(manager.list()).toEqual([]);
    expect(didCreate).not.toHaveBeenCalled();
    expect(didFork).not.toHaveBeenCalled();

    createSubscription.dispose();
    forkSubscription.dispose();
    manager.dispose();
  });

  it('evicts an eligible idle session through the unload path', async () => {
    const fake = controller();
    const unload = vi.spyOn(fake.service, 'unload');
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const manager = new SessionManager(
      {
        acquire: async () => ({ instance: workspace, dispose: () => {} }),
        get: () => workspace,
      } as unknown as IWorkspaceInstanceManager,
      { get: async () => ({ workspaceId: workspace.id, cwd: '/workspace' }) } as unknown as ISessionIndex,
      {
        ready: Promise.resolve(),
        get: () => ({ idleTtlMs: 0, minIdleMs: 0, maxLiveSessions: 8, sweepIntervalMs: 300_000 }),
      } as never,
      { enabled: () => true } as never,
    );

    await manager.create({ workDir: '/workspace' });
    await expect(manager.evictIfIdle('session-1')).resolves.toBe(true);

    expect(unload).toHaveBeenCalledTimes(1);
    expect(manager.get('session-1')).toBeUndefined();
    expect(manager.residencyReport()).toMatchObject({
      liveSessions: 0,
      evictionAttempts: 1,
      evictionSuccesses: 1,
      evictionFailures: 0,
    });
    manager.dispose();
  });

  it('keeps an acquired session pinned until its lease is released', async () => {
    const fake = controller();
    const unload = vi.spyOn(fake.service, 'unload');
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const manager = new SessionManager(
      {
        acquire: async () => ({ instance: workspace, dispose: () => {} }),
        get: () => workspace,
      } as unknown as IWorkspaceInstanceManager,
      { get: async () => ({ workspaceId: workspace.id, cwd: '/workspace' }) } as unknown as ISessionIndex,
      {
        ready: Promise.resolve(),
        get: () => ({ idleTtlMs: 0, minIdleMs: 0, maxLiveSessions: 8, sweepIntervalMs: 300_000 }),
      } as never,
      { enabled: () => true } as never,
    );

    await manager.create({ workDir: '/workspace' });
    const lease = await manager.acquire('session-1', 'test');
    await expect(manager.evictIfIdle('session-1')).resolves.toBe(false);
    expect(unload).not.toHaveBeenCalled();
    expect(manager.residencyReport().pinnedSessions).toBe(1);

    lease?.dispose();
    await expect(manager.evictIfIdle('session-1')).resolves.toBe(true);
    manager.dispose();
  });
});

describe('SessionManager controller retirement', () => {
  function runtime(generation: string): FakeRuntime {
    return Object.assign(
      new FakeRuntime(
        { workspaceId: 'workspace', runtimeId: 'local', generation },
        { capabilities: ['fs', 'process', 'watch'] },
      ),
      { fs: {}, process: {}, watch: {} },
    ) as FakeRuntime;
  }

  function liveProgram(drainTimeoutMs: number): {
    readonly registry: RuntimeRegistry;
    readonly program: Program;
    readonly controllers: { readonly service: SessionLifecycleService; readonly dispose: ReturnType<typeof vi.fn> }[];
  } {
    const registry = new RuntimeRegistry('workspace', drainTimeoutMs);
    const controllers: { readonly service: SessionLifecycleService; readonly dispose: ReturnType<typeof vi.fn> }[] = [];
    let nextSession = 0;
    const program = new Program(
      'workspace',
      registry,
      {
        _serviceBrand: undefined,
        workspaceId: 'workspace',
        cwd: '/workspace',
        source: 'local',
        meta: {
          id: 'workspace',
          name: 'workspace',
          root: '/workspace',
          createdAt: 0,
          lastOpenedAt: 0,
        },
        persistenceScope: 'sessions/workspace',
      },
      {
        agentProfiles: { entries: () => [] },
        createSessionController: (input: ProgramSessionControllerInput) => {
          const didCreate = new Emitter<SessionCreatedEvent>();
          const didClose = new Emitter<SessionClosedEvent>();
          const didArchive = new Emitter<SessionArchivedEvent>();
          const live = new Map<string, ISessionScopeHandle>();
          const dispose = vi.fn(() => {
            input.onDispose();
            didCreate.dispose();
            didClose.dispose();
            didArchive.dispose();
          });
          const service = {
            onWillCreateSession: Event.None,
            onDidCreateSession: didCreate.event,
            onWillCloseSession: Event.None,
            onDidCloseSession: didClose.event,
            onDidArchiveSession: didArchive.event,
            onDidForkSession: Event.None,
            create: async () => {
              nextSession += 1;
              const sessionId = `session-${nextSession}`;
              const handle = { id: sessionId } as unknown as ISessionScopeHandle;
              live.set(sessionId, handle);
              didCreate.fire({ sessionId, handle, source: 'startup' });
              return handle;
            },
            get: (sessionId: string) => live.get(sessionId),
            list: () => [...live.values()],
            resume: async () => undefined,
            close: async (sessionId: string) => {
              if (live.delete(sessionId)) didClose.fire({ sessionId });
            },
            archive: async (sessionId: string) => {
              if (live.delete(sessionId)) didArchive.fire({ sessionId });
            },
            restore: async () => undefined,
            delete: async () => {},
            fork: async () => {
              throw new Error('fork not supported');
            },
            createChild: async () => {
              throw new Error('createChild not supported');
            },
            dispose,
          } as unknown as SessionLifecycleService;
          controllers.push({ service, dispose });
          return service;
        },
      } as never,
    );
    const createGeneration = vi.fn(() => {
      const lease = registry.acquire(program.binding, ['fs', 'process', 'watch']);
      const id = lease.runtime.identity.generation;
      const behavior = {
        ready: Promise.resolve(),
        dispose: () => {},
      };
      const catalog = {
        listSkills: () => [],
        listInvocableSkills: () => [],
        getSkippedByPolicy: () => [],
        getSkillRoots: () => [],
      };
      return {
        id,
        lease,
        state: behavior,
        dirs: behavior,
        fs: behavior,
        watch: behavior,
        git: behavior,
        instructions: { ...behavior, snapshot: {} },
        mcpConfig: { ...behavior, servers: () => ({}) },
        mcp: behavior,
        trust: { ...behavior, isTrusted: () => false },
        skills: { ...behavior, catalog },
        agentProfiles: behavior,
        userAgentProfiles: behavior,
        pluginAgentProfiles: behavior,
        explicitAgentProfiles: behavior,
        extraAgentProfiles: behavior,
        disposables: [behavior],
        ready: false,
        failed: false,
        references: 1,
        retired: false,
      };
    });
    (program as unknown as { createGeneration: typeof createGeneration }).createGeneration = createGeneration;
    return { registry, program, controllers };
  }

  function managerFor(program: Program): SessionManager {
    const workspace = { id: 'workspace', program } as unknown as WorkspaceInstance;
    const workspaces = {
      acquire: async () => ({ instance: workspace, dispose: () => {} }),
      get: (workspaceId: string) => workspaceId === workspace.id ? workspace : undefined,
    } as unknown as IWorkspaceInstanceManager;
    return new SessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
    );
  }

  it('releases the superseded program generation once its last session closes, before the drain timeout', async () => {
    const { registry, program, controllers } = liveProgram(60_000);
    const first = runtime('one');
    const registration = registry.register(first);
    await program.ready;
    const manager = managerFor(program);

    const handleOne = await manager.create({ workDir: '/workspace' });
    const replacement = registration.replace(runtime('two'));
    await Promise.resolve();
    const handleTwo = await manager.create({ workDir: '/workspace' });
    expect(manager.list()).toEqual([handleOne, handleTwo]);
    expect(first.disposed).toBe(false);

    await manager.close(handleOne.id);
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(controllers[1]!.dispose).not.toHaveBeenCalled();
    await replacement;
    expect(first.disposed).toBe(true);
    expect(manager.get(handleTwo.id)).toBe(handleTwo);

    manager.dispose();
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(controllers[1]!.dispose).toHaveBeenCalledTimes(1);
    program.dispose();
    await registry.dispose();
  });

  it('retires an idle current-generation controller and rebuilds it for the next session', async () => {
    const { registry, program, controllers } = liveProgram(50);
    registry.register(runtime('one'));
    await program.ready;
    const manager = managerFor(program);

    const first = await manager.create({ workDir: '/workspace' });
    expect(controllers).toHaveLength(1);
    await manager.close(first.id);
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);

    const second = await manager.create({ workDir: '/workspace' });
    expect(controllers).toHaveLength(2);
    expect(manager.get(second.id)).toBe(second);

    manager.dispose();
    expect(controllers[1]!.dispose).toHaveBeenCalledTimes(1);
    program.dispose();
    await registry.dispose();
  });
});
