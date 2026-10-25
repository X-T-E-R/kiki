import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import type { IDisposable } from '#/_base/di/lifecycle';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import type { AvailabilityChange } from '#/_base/di/serviceCollection';

interface IFoo {
  tag: string;
}
const IFoo = createDecorator<IFoo>('provide-foo');

interface IBar {
  tag: string;
}
const IBar = createDecorator<IBar>('provide-bar');

class Foo implements IFoo, IDisposable {
  tag = 'foo';
  disposed = false;
  dispose(): void {
    this.disposed = true;
  }
}

class Bar implements IBar {
  tag = 'bar';
  constructor(@IFoo public readonly foo: IFoo) {}
}

describe('InstantiationService.provide/unprovide (L1)', () => {
  it('waits for an ordinary token retirement already in progress before closing its scope', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    class Slow {
      async dispose(): Promise<void> { events.push('start'); await gate; events.push('end'); }
    }
    const id = createDecorator<Slow>('pending-retirement-token');
    const ix = new InstantiationService(new ServiceCollection());
    ix.provide(id, new SyncDescriptor(Slow));
    ix.invokeFunction((accessor) => accessor.get(id));
    ix.unprovide(id);
    let settled = false;
    const idle = ix.cascade.whenIdle();
    const close = Promise.resolve(ix.dispose()).then(() => { settled = true; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const observed = { settled, events: [...events] };
    release();
    await Promise.all([close, idle]);
    expect(observed).toEqual({ settled: false, events: ['start'] });
    expect(events).toEqual(['start', 'end']);
  });
  it('provides a service at runtime and resolves it', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    const foo = ix.invokeFunction((a) => a.get(IFoo));
    expect(foo).toBeInstanceOf(Foo);
    await ix.dispose();
  });

  it('unprovide removes the token; strict resolution then throws', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.invokeFunction((a) => a.get(IFoo));
    ix.unprovide(IFoo);
    expect(() => ix.invokeFunction((a) => a.get(IFoo))).toThrow(/unknown service/);
    await ix.dispose();
  });

  it('unprovide retires the materialized instance', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    const foo = ix.invokeFunction((a) => a.get(IFoo)) as Foo;
    expect(foo.disposed).toBe(false);
    ix.unprovide(IFoo);
    expect(foo.disposed).toBe(true);
    await ix.dispose();
  });

  it('reprovide retires the old generation and resolves a fresh instance', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    const first = ix.invokeFunction((a) => a.get(IFoo)) as Foo;

    ix.provide(IFoo, new SyncDescriptor(Foo));
    expect(first.disposed).toBe(true);

    const second = ix.invokeFunction((a) => a.get(IFoo)) as Foo;
    expect(second).not.toBe(first);
    expect(second.disposed).toBe(false);
    await ix.dispose();
    expect(second.disposed).toBe(true);
  });

  it('stamps every generation with a container-monotonic uid', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    const h1 = ix.provide(IFoo, new SyncDescriptor(Foo));
    const h2 = ix.provide(IBar, new SyncDescriptor(Bar));
    ix.provide(IFoo, new SyncDescriptor(Foo));
    const uidAfter = (ix as unknown as { _services: ServiceCollection })._services.uidOf(IFoo)!;
    expect(h2.uid).toBeGreaterThan(h1.uid);
    expect(uidAfter).toBeGreaterThan(h2.uid);
    await ix.dispose();
  });

  it('fires availability events with { oldUid, newUid } on provide/unprovide', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    const changes: AvailabilityChange[] = [];
    const services = (ix as unknown as { _services: ServiceCollection })._services;
    services.onDidChange(IFoo, (change) => changes.push(change));

    const h1 = ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IFoo, new SyncDescriptor(Foo));
    const uid2 = services.uidOf(IFoo)!;
    ix.unprovide(IFoo);

    expect(changes).toEqual([
      { oldUid: undefined, newUid: h1.uid },
      { oldUid: h1.uid, newUid: uid2 },
      { oldUid: uid2, newUid: undefined },
    ]);
    await ix.dispose();
  });

  it('the provide handle is a ledger entry: disposing it unprovides', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    const handle = ix.provide(IFoo, new SyncDescriptor(Foo));
    await handle.dispose();
    expect(() => ix.invokeFunction((a) => a.get(IFoo))).toThrow(/unknown service/);
    await ix.dispose();
  });

  it('container teardown retires provided services exactly once', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    const foo = ix.invokeFunction((a) => a.get(IFoo)) as Foo;
    let calls = 0;
    const origDispose = foo.dispose.bind(foo);
    foo.dispose = () => {
      calls += 1;
      origDispose();
    };
    await ix.dispose();
    expect(calls).toBe(1);
  });
});

describe('persistent dependency graph (L2 substrate)', () => {
  it('records constructor-injection edges for materialized services', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IBar, new SyncDescriptor(Bar));
    ix.invokeFunction((a) => a.get(IBar));

    const edges = ix.dependencyGraph.edges();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      consumer: { scope: ix, token: IBar },
      dependency: { scope: ix, token: IFoo },
      kind: 'instance',
    });
    await ix.dispose();
  });

  it('affectedSet computes the transitive dependents of a changed token', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IBar, new SyncDescriptor(Bar));
    ix.invokeFunction((a) => a.get(IBar));

    const tokens = (refs: readonly { token: unknown }[]): unknown[] =>
      refs.map((ref) => ref.token);
    expect(tokens(ix.dependencyGraph.affectedSet([{ scope: ix, token: IFoo }]))).toEqual([IFoo, IBar]);
    expect(tokens(ix.dependencyGraph.affectedSet([{ scope: ix, token: IBar }]))).toEqual([IBar]);
    await ix.dispose();
  });

  it('orders the affected set: dependents first for teardown, dependencies first for rebuild', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IBar, new SyncDescriptor(Bar));
    ix.invokeFunction((a) => a.get(IBar));

    const affected = ix.dependencyGraph.affectedSet([{ scope: ix, token: IFoo }]);
    const tokens = (refs: readonly { token: unknown }[]): unknown[] =>
      refs.map((ref) => ref.token);
    expect(tokens(ix.dependencyGraph.reverseTopoOrder(affected))).toEqual([IBar, IFoo]);
    expect(tokens(ix.dependencyGraph.topoOrder(affected))).toEqual([IFoo, IBar]);
    await ix.dispose();
  });

  it('retiring a consumer removes its edges', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IBar, new SyncDescriptor(Bar));
    ix.invokeFunction((a) => a.get(IBar));

    ix.unprovide(IBar);
    expect(ix.dependencyGraph.edges()).toHaveLength(0);
    const remaining = ix.dependencyGraph.affectedSet([{ scope: ix, token: IFoo }]);
    expect(remaining.map((ref) => ref.token)).toEqual([IFoo]);
    await ix.dispose();
  });

  it('container teardown leaves the graph empty (no dangling edges)', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IBar, new SyncDescriptor(Bar));
    ix.invokeFunction((a) => a.get(IBar));
    await ix.dispose();
    expect(ix.dependencyGraph.edges()).toHaveLength(0);
  });

  it('does not track createInstance products (leaves)', async () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    class Leaf {
      constructor(@IFoo public readonly foo: IFoo) {}
    }
    ix.createInstance(Leaf);
    expect(ix.dependencyGraph.edges()).toHaveLength(0);
    await ix.dispose();
  });
});

describe('TestInstantiationService.set rerouting', () => {
  it('set() on a materialized token retires the previous generation', async () => {
    const { TestInstantiationService } = await import('#/_base/di/testInstantiationService');
    const ix = new TestInstantiationService(new ServiceCollection(), true);
    ix.set(IFoo, new SyncDescriptor(Foo));
    const first = ix.get(IFoo) as Foo;
    ix.set(IFoo, new SyncDescriptor(Foo));
    expect(first.disposed).toBe(true);
    const second = ix.get(IFoo) as Foo;
    expect(second).not.toBe(first);
    await ix.dispose();
  });

  it('set() returns the previous value like before', async () => {
    const { TestInstantiationService } = await import('#/_base/di/testInstantiationService');
    const ix = new TestInstantiationService(new ServiceCollection(), true);
    const seeded = new Foo();
    expect(ix.set(IFoo, seeded)).toBeUndefined();
    expect(ix.set(IFoo, new Foo())).toBe(seeded);
    await ix.dispose();
  });
});
