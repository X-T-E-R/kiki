import { beforeEach, describe, expect, it } from 'vitest';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  Scope,
  _clearScopedRegistryForTests,
  createAppScope,
  registerScopedService,
} from '#/_base/di/scope';

interface IAppSvc {
  tag: 'app';
}
interface ISessionSvc {
  app: IAppSvc;
  tag: 'session';
}
interface IAgentSvc {
  session: ISessionSvc;
  app: IAppSvc;
  tag: 'agent';
}

const IAppSvc = createDecorator<IAppSvc>('tree-app');
const ISessionSvc = createDecorator<ISessionSvc>('tree-session');
const IAgentSvc = createDecorator<IAgentSvc>('tree-agent');

class AppSvc implements IAppSvc {
  tag = 'app' as const;
}
class SessionSvc implements ISessionSvc {
  tag = 'session' as const;
  constructor(@IAppSvc public readonly app: IAppSvc) {}
}
class AgentSvc implements IAgentSvc {
  tag = 'agent' as const;
  constructor(
    @ISessionSvc public readonly session: ISessionSvc,
    @IAppSvc public readonly app: IAppSvc,
  ) {}
}

describe('Scope tree', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.App, IAppSvc, AppSvc);
    registerScopedService(LifecycleScope.Session, ISessionSvc, SessionSvc);
    registerScopedService(LifecycleScope.Agent, IAgentSvc, AgentSvc);
  });

  function buildTree(): { app: Scope; session: Scope; agent: Scope } {
    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 's1');
    const agent = session.createChild(LifecycleScope.Agent, 'main');
    return { app, session, agent };
  }

  it('waits for the complete ledger of an independently disposing child scope', async () => {
    const { app, session } = buildTree();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    session.ledger.register(async () => { events.push('start'); await gate; events.push('end'); }, 'finalizer');
    const childClose = session.dispose();
    expect(session.dispose()).toBe(childClose);
    let settled = false;
    const parentClose = Promise.resolve(app.dispose()).then(() => { settled = true; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const observed = { settled, events: [...events] };
    release();
    await Promise.all([childClose, parentClose]);
    expect(observed).toEqual({ settled: false, events: ['start'] });
    expect(events).toEqual(['start', 'end']);
    expect(app.children.size).toBe(0);
  });

  it('each scope resolves its own layer service', async () => {
    const { app, session, agent } = buildTree();
    expect(app.accessor.get(IAppSvc).tag).toBe('app');
    expect(session.accessor.get(ISessionSvc).tag).toBe('session');
    expect(agent.accessor.get(IAgentSvc).tag).toBe('agent');
    await app.dispose();
  });

  it('child resolves ancestor services via createChild fallback', async () => {
    const { app, session, agent } = buildTree();
    const sessionSvc = session.accessor.get(ISessionSvc);
    const agentSvc = agent.accessor.get(IAgentSvc);
    expect(sessionSvc.app.tag).toBe('app');
    expect(agentSvc.session.tag).toBe('session');
    expect(agentSvc.app.tag).toBe('app');
    expect(agentSvc.app).toBe(app.accessor.get(IAppSvc));
    await app.dispose();
  });

  it('parent cannot resolve a child-layer service', async () => {
    const { app, session } = buildTree();
    expect(() => app.accessor.get(ISessionSvc)).toThrow();
    expect(() => session.accessor.get(IAgentSvc)).toThrow();
    await app.dispose();
  });

  it('children map tracks created child scopes', async () => {
    const { app, session, agent } = buildTree();
    expect(app.children.get('s1')).toBe(session);
    expect(session.children.get('main')).toBe(agent);
    await app.dispose();
  });

  it('rejects a child whose kind is not strictly greater', async () => {
    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 's1');
    expect(() => session.createChild(LifecycleScope.Session, 's2')).toThrow(/greater/);
    expect(() => session.createChild(LifecycleScope.App, 'c2')).toThrow(/greater/);
    await app.dispose();
  });

  it('rejects duplicate child ids within a parent', async () => {
    const app = createAppScope();
    app.createChild(LifecycleScope.Session, 's1');
    expect(() => app.createChild(LifecycleScope.Session, 's1')).toThrow(/already has a child/);
    await app.dispose();
  });

  it('dispose tears down children before the parent (C→B→A)', async () => {
    const events: string[] = [];
    interface ITagged extends IDisposable {
      tag: string;
    }
    const IA = createDecorator<ITagged>('tree-dispose-A');
    const IB = createDecorator<ITagged>('tree-dispose-B');
    const IC = createDecorator<ITagged>('tree-dispose-C');
    _clearScopedRegistryForTests();
    class A implements ITagged {
      tag = 'A';
      dispose(): void { events.push('A'); }
    }
    class B implements ITagged {
      tag = 'B';
      dispose(): void { events.push('B'); }
    }
    class C implements ITagged {
      tag = 'C';
      dispose(): void { events.push('C'); }
    }
    registerScopedService(LifecycleScope.App, IA, A);
    registerScopedService(LifecycleScope.Session, IB, B);
    registerScopedService(LifecycleScope.Agent, IC, C);

    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 's1');
    const agent = session.createChild(LifecycleScope.Agent, 'main');
    app.accessor.get(IA);
    session.accessor.get(IB);
    agent.accessor.get(IC);
    await app.dispose();
    expect(events).toEqual(['C', 'B', 'A']);
  });

  it('disposing a child removes it from the parent children map', async () => {
    const { app, session, agent } = buildTree();
    await agent.dispose();
    expect(session.children.has('main')).toBe(false);
    await session.dispose();
    expect(app.children.has('s1')).toBe(false);
    await app.dispose();
  });

  it('toHandle exposes id/kind/accessor for parent-domain reach-in', async () => {
    const { app, session } = buildTree();
    const handle = session.toHandle();
    expect(handle.id).toBe('s1');
    expect(handle.kind).toBe(LifecycleScope.Session);
    expect(handle.accessor.get(ISessionSvc).tag).toBe('session');
    await app.dispose();
  });

  it('seeds inject a context token resolvable from that scope', async () => {
    interface ISessionContext {
      sessionId: string;
    }
    const ISessionContext = createDecorator<ISessionContext>('tree-session-ctx');
    _clearScopedRegistryForTests();

    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 's1', {
      seeds: [[ISessionContext as ServiceIdentifier<unknown>, { sessionId: 's1' }]],
    });
    expect(session.accessor.get(ISessionContext).sessionId).toBe('s1');
    expect(() => app.accessor.get(ISessionContext)).toThrow();
    await app.dispose();
  });

  it('use-after-dispose throws on createChild', async () => {
    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 's1');
    await session.dispose();
    expect(() => session.createChild(LifecycleScope.Agent, 'a1')).toThrow(/disposed/);
    await app.dispose();
  });

  it('does not construct OnDemand services until they are resolved', async () => {
    let constructions = 0;
    interface ITagged {
      tag: string;
    }
    const ITagged = createDecorator<ITagged>('tree-on-demand');
    _clearScopedRegistryForTests();
    class Tagged implements ITagged {
      tag = 'tagged';
      constructor() {
        constructions += 1;
      }
    }
    registerScopedService(
      LifecycleScope.Session,
      ITagged,
      Tagged,
      ScopeActivation.OnDemand,
    );

    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 's1');
    expect(constructions).toBe(0);
    expect(session.accessor.get(ITagged)).toBeInstanceOf(Tagged);
    expect(constructions).toBe(1);
    await app.dispose();
  });

  it('constructs OnScopeCreated services and their dependencies in dependency order', async () => {
    const events: string[] = [];
    interface ITagged {
      tag: string;
    }
    const IDep = createDecorator<ITagged>('tree-scope-create-dep');
    const ITop = createDecorator<ITagged>('tree-scope-create-top');
    _clearScopedRegistryForTests();
    class Dep implements ITagged {
      tag = 'dep';
      constructor() {
        events.push('dep');
      }
    }
    class Top implements ITagged {
      tag = 'top';
      constructor(@IDep public readonly dep: ITagged) {
        events.push('top');
      }
    }
    registerScopedService(LifecycleScope.Session, ITop, Top);
    registerScopedService(
      LifecycleScope.Session,
      IDep,
      Dep,
      ScopeActivation.OnDemand,
    );

    const app = createAppScope();
    app.createChild(LifecycleScope.Session, 's1');
    expect(events).toEqual(['dep', 'top']);
    await app.dispose();
  });

  it('an OnScopeCreated construction failure is sticky Failed (D5), not a scope-creation error', async () => {
    interface IBoom {
      tag: 'boom';
    }
    const IBoom = createDecorator<IBoom>('tree-scope-create-boom');
    _clearScopedRegistryForTests();
    class Boom implements IBoom {
      tag = 'boom' as const;
      constructor() {
        throw new Error('boom');
      }
    }
    registerScopedService(LifecycleScope.Session, IBoom, Boom);

    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 's1');
    expect(session.instantiation.cascade.stateOf(IBoom)).toBe('Failed');
    expect(() => session.accessor.get(IBoom)).toThrow(/boom/);
    await app.dispose();
  });

  it('exposes the scope ledger for debug introspection', async () => {
    const { app } = buildTree();
    expect(app.ledger.state).toBe('active');
    const labels = app.ledger.entries().map((entry) => entry.label);
    expect(labels).toContain('instantiation');
    expect(labels).toContain('scope:s1');
    await app.dispose();
    expect(app.ledger.state).toBe('disposed');
  });
});
