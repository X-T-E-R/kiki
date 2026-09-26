import { describe, expect, it, vi } from 'vitest';

import { Ledger } from '#/_base/lifecycle/ledger';
import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '#/_base/errors/unexpectedError';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { ScopeUnits } from '#/_base/di/fiber';
import { createDecorator } from '#/_base/di/instantiation';
import type { InstantiationService } from '#/_base/di/instantiationService';
import { Scope } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';

interface IFoo {
  tag: string;
}
const IFoo = createDecorator<IFoo>('scope-units-foo');

interface IPack {
  marker: string;
}
const IPack = createDecorator<IPack>('scope-units-pack');

class Foo implements IFoo {
  tag = 'foo';
}

describe('ScopeUnits — kernel materialization fold (D11/G2)', () => {
  const log: string[] = [];

  class AgentFeature extends Service {
    constructor() {
      super();
      this.provide(IFoo, Foo);
      this.effect(() => {
        log.push('feature up');
        return () => {
          log.push('feature down');
        };
      });
    }
  }

  class FeaturePack extends Service {
    constructor() {
      super();
      this.provide(ScopeUnits('agent'), AgentFeature);
    }
  }

  function appWithPack(): Scope {
    log.length = 0;
    const app = Scope.createApp({ id: 'app' });
    app.instantiation.provide(IPack, new SyncDescriptor(FeaturePack));
    app.accessor.get(IPack);
    return app;
  }

  it('materializes a contributed recipe inside every new scope of the kind', () => {
    const app = appWithPack();
    const a1 = app.createChild('agent', 'a1');
    expect(a1.accessor.get(IFoo).tag).toBe('foo');
    expect(log).toEqual(['feature up']);
    const a2 = app.createChild('agent', 'a2');
    expect(a2.accessor.get(IFoo).tag).toBe('foo');
    expect(log).toEqual(['feature up', 'feature up']);
    app.dispose();
  });

  it('tears the materialized unit down when the provider dies (连坐)', () => {
    const app = appWithPack();
    const a1 = app.createChild('agent', 'a1');
    expect(a1.accessor.get(IFoo).tag).toBe('foo');
    app.instantiation.unprovide(IPack);
    expect(log).toEqual(['feature up', 'feature down']);
    expect(() => a1.accessor.get(IFoo)).toThrow();
    app.dispose();
  });

  it('tears the materialized unit down with the target scope (idempotent with 连坐)', () => {
    const app = appWithPack();
    const a1 = app.createChild('agent', 'a1');
    expect(a1.accessor.get(IFoo).tag).toBe('foo');
    a1.dispose();
    expect(log).toEqual(['feature up', 'feature down']);
    app.dispose();
    expect(log).toEqual(['feature up', 'feature down']);
  });

  it('materializes records that arrive after the scope exists, and retracts them on withdrawal', () => {
    log.length = 0;
    const app = Scope.createApp({ id: 'app' });
    const a1 = app.createChild('agent', 'a1');
    app.instantiation.provide(IPack, new SyncDescriptor(FeaturePack));
    app.accessor.get(IPack);
    expect(log).toEqual(['feature up']);
    expect(a1.accessor.get(IFoo).tag).toBe('foo');
    app.instantiation.unprovide(IPack);
    expect(log).toEqual(['feature up', 'feature down']);
    app.dispose();
  });

  it('finishes provider teardown after withdrawing a late contribution from two live scopes', () => {
    const cleanup: string[] = [];
    const unexpected: unknown[] = [];
    let nextUnit = 0;
    class LateFeature extends Service {
      constructor() {
        super();
        const id = ++nextUnit;
        this.effect(() => () => { cleanup.push(`unit-${id}:first`); });
        this.effect(() => () => { cleanup.push(`unit-${id}:second`); });
      }
    }
    class LatePack extends Service {
      constructor() {
        super();
        this.effect(() => () => { cleanup.push('provider:first'); });
        this.effect(() => () => { cleanup.push('provider:second'); });
        this.provide(ScopeUnits('agent'), LateFeature);
      }
    }
    const app = Scope.createApp({ id: 'late-provider-app' });
    const first = app.createChild('agent', 'first');
    const second = app.createChild('agent', 'second');
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      app.instantiation.provide(IPack, new SyncDescriptor(LatePack));
      app.accessor.get(IPack);
      const [record] = (app.instantiation as InstantiationService).collectionStore.storedRecordsFor(
        ScopeUnits('agent'), app.instantiation,
      );
      const book = record!.providerBook;
      expect(nextUnit).toBe(2);
      expect(() => app.instantiation.unprovide(IPack)).not.toThrow();
      expect(unexpected).toEqual([]);
      expect(book.state).toBe('disposed');
      expect(book.size).toBe(0);
      expect(book.entries()).toEqual([]);
      expect(cleanup).toEqual([
        'unit-1:second', 'unit-1:first',
        'unit-2:second', 'unit-2:first',
        'provider:second', 'provider:first',
      ]);
      void book.teardown();
      first.dispose();
      second.dispose();
      app.dispose();
      expect(cleanup).toHaveLength(6);
      expect(unexpected).toEqual([]);
    } finally {
      app.dispose();
      resetUnexpectedErrorHandler();
    }
  });

  it('releases provider entries across repeated target scope lifetimes', () => {
    const app = appWithPack();
    try {
      const [record] = (app.instantiation as InstantiationService).collectionStore.storedRecordsFor(
        ScopeUnits('agent'), app.instantiation,
      );
      const book = record!.providerBook;
      const baseline = book.size;
      for (let index = 0; index < 100; index++) {
        const agent = app.createChild('agent', `agent-${index}`);
        expect(book.size).toBe(baseline + 1);
        agent.dispose();
        expect(book.size).toBe(baseline);
      }
      expect(log.filter((entry) => entry === 'feature down')).toHaveLength(100);
      app.instantiation.unprovide(IPack);
      expect(book.size).toBe(0);
    } finally {
      app.dispose();
    }
  });

  it('releases both registrations when a live contribution is withdrawn repeatedly', () => {
    const registrations = vi.spyOn(Ledger.prototype, 'register');
    const app = appWithPack();
    const agent = app.createChild('agent', 'agent');
    try {
      const fold = registrations.mock.contexts.find(
        (ledger): ledger is Ledger => ledger instanceof Ledger && ledger.label === 'scope-units:agent',
      )!;
      const [record] = (app.instantiation as InstantiationService).collectionStore.storedRecordsFor(
        ScopeUnits('agent'), app.instantiation,
      );
      const book = record!.providerBook;
      const baseline = book.size;
      const foldBaseline = fold.size;
      expect(foldBaseline).toBe(2);
      for (let index = 0; index < 100; index++) {
        const withdraw = (app.instantiation as InstantiationService).collectionStore.addRecord(
          ScopeUnits('agent'), app.instantiation, 'dynamic', 'app', book, () => {},
        );
        expect(book.size).toBe(baseline + 1);
        expect(fold.size).toBe(foldBaseline + 1);
        withdraw();
        withdraw();
        expect(book.size).toBe(baseline);
        expect(fold.size).toBe(foldBaseline);
      }
      app.instantiation.unprovide(IPack);
      expect(book.size).toBe(0);
      expect(fold.size).toBe(1);
      expect(log).toEqual(['feature up', 'feature down']);
      agent.dispose();
      expect(fold.size).toBe(0);
      expect(log).toEqual(['feature up', 'feature down']);
    } finally {
      app.dispose();
      registrations.mockRestore();
    }
  });

  it('does not materialize records of a different kind', () => {
    log.length = 0;
    const app = Scope.createApp({ id: 'app' });
    app.instantiation.provide(IPack, new SyncDescriptor(FeaturePack));
    app.accessor.get(IPack);
    app.createChild('session', 's1');
    expect(log).toEqual([]);
    app.dispose();
  });
});
