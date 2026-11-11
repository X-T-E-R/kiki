import { afterEach, describe, expect, it } from 'vitest';

import { createAdmissionGate, createCordisRuntime, Schema, scopeTarget } from '../src/index.ts';
import type { CordisFiberHandle, CordisPluginContext } from '../src/index.ts';

const runtimes: ReturnType<typeof createCordisRuntime>[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

function makeRuntime() {
  const runtime = createCordisRuntime();
  runtimes.push(runtime);
  return runtime;
}

type IsolatableContext = CordisPluginContext & { isolate(name: string): CordisPluginContext };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function errorFrom(callback: () => unknown): unknown {
  try {
    callback();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('Cordis runtime lifecycle and scope boundaries', () => {
  it('permanently closes an empty runtime on disposal', async () => {
    const runtime = makeRuntime();

    await runtime.dispose();
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(runtime.appGate.revoked).toBe(true);
    expect(errorFrom(() => runtime.mount(runtime.ctx, 'after-close', () => {}))).toMatchObject({ code: 'revoked' });
  });

  it('finishes async effect setup in order and drains cleanups in reverse order', async () => {
    const runtime = makeRuntime();
    const events: string[] = [];
    const plugin = async (raw: CordisPluginContext) => {
      const ctx = raw as CordisPluginContext & { effect(execute: () => Promise<() => void>): PromiseLike<unknown> };
      const effectB = ctx.effect(async () => {
        events.push('B-start');
        await Promise.resolve();
        events.push('B-end');
        return () => events.push('B-cleanup');
      });
      await effectB;
      const effectA = ctx.effect(async () => {
        events.push('A-start');
        await Promise.resolve();
        events.push('A-end');
        return () => events.push('A-cleanup');
      });
      await effectA;
    };
    const mounted = runtime.mount(runtime.ctx, 'async-effects', plugin);

    await mounted.ready;
    expect(events).toEqual(['B-start', 'B-end', 'A-start', 'A-end']);

    await mounted.dispose();
    expect(events).toEqual(['B-start', 'B-end', 'A-start', 'A-end', 'A-cleanup', 'B-cleanup']);
  });

  it('waits for each async cleanup before starting the previous effect cleanup', async () => {
    const runtime = makeRuntime();
    const cleanupEvents: string[] = [];
    const cleanupBStarted = deferred();
    const releaseCleanupB = deferred();
    const mounted = runtime.mount(runtime.ctx, 'serial-async-cleanup', (ctx: CordisPluginContext) => {
      ctx.effect(() => async () => {
        cleanupEvents.push('A-start');
        cleanupEvents.push('A-end');
      });
      ctx.effect(() => async () => {
        cleanupEvents.push('B-start');
        cleanupBStarted.resolve();
        await releaseCleanupB.promise;
        cleanupEvents.push('B-end');
      });
    });

    await mounted.ready;
    const disposing = mounted.dispose();
    await cleanupBStarted.promise;
    try {
      expect(cleanupEvents).toEqual(['B-start']);
    } finally {
      releaseCleanupB.resolve();
    }
    await disposing;

    expect(cleanupEvents).toEqual(['B-start', 'B-end', 'A-start', 'A-end']);
  });

  it('rejects effect creation from cleanup after the owning plugin is inactive', async () => {
    const runtime = makeRuntime();
    let lateEffectError: unknown;
    const mounted = runtime.mount(runtime.ctx, 'late-cleanup-effect', (ctx: CordisPluginContext) => {
      ctx.effect(() => () => {
        try {
          ctx.effect(() => {});
        } catch (error) {
          lateEffectError = error;
        }
      });
    });

    await mounted.ready;
    await mounted.dispose();

    expect(lateEffectError).toMatchObject({ code: 'INACTIVE_EFFECT' });
  });

  it('joins reentrant disposal while an async apply callback is still running', async () => {
    const runtime = makeRuntime();
    const applying = deferred();
    const finishApply = deferred();
    const events: string[] = [];
    let mounted!: CordisFiberHandle;
    const plugin = async (ctx: CordisPluginContext) => {
      ctx.effect(() => () => { events.push('cleanup'); });
      events.push('apply-start');
      applying.resolve();
      void mounted.dispose();
      await finishApply.promise;
      events.push('apply-end');
    };
    mounted = runtime.mount(runtime.ctx, 'reentrant-apply-disposal', plugin);

    await applying.promise;
    const disposing = mounted.dispose();
    finishApply.resolve();
    await disposing;
    await mounted.ready;

    expect(events).toEqual(['apply-start', 'apply-end', 'cleanup']);
    expect(mounted.phase).toBe('disposed');
  });

  it('stops admitting a revoked scope immediately, before async cleanup finishes', async () => {
    const runtime = makeRuntime();
    const key = {};
    const gate = createAdmissionGate({ scopeKind: 'session' });
    const scope = runtime.createScope(runtime.ctx, key, gate);
    const deliveries: unknown[] = [];
    const mounted = runtime.mount(scope.ctx, 'revoked-scope-listener', (ctx: CordisPluginContext) => {
      ctx.on('runtime.event', (value) => { deliveries.push(value); });
    });
    await mounted.ready;
    const target = scopeTarget({}, key);

    runtime.ctx.emit('runtime.event', 'before', target);
    expect(deliveries).toEqual(['before']);

    gate.revoke();
    runtime.ctx.emit('runtime.event', 'after', target);
    expect(gate.revoked).toBe(true);
    expect(gate.epoch).toBe(1);
    expect(deliveries).toEqual(['before']);

    await scope.dispose();
  });

  it('blocks descendant and internal-dispatch callbacks after owner revocation', async () => {
    const runtime = makeRuntime();
    const childDeliveries: string[] = [];
    const parentCleanupStarted = deferred();
    const releaseParentCleanup = deferred();
    const childPlugin = (ctx: CordisPluginContext) => {
      ctx.on('runtime.parent-child', (value) => { childDeliveries.push(String(value)); });
    };
    const parentPlugin = async (ctx: CordisPluginContext) => {
      const child = ctx.plugin(childPlugin);
      await child.ready;
      ctx.effect(() => async () => {
        parentCleanupStarted.resolve();
        await releaseParentCleanup.promise;
      });
    };
    const parent = runtime.mount(runtime.ctx, 'parent-with-child', parentPlugin);
    await parent.ready;
    const target = scopeTarget({}, runtime.appKey);
    const disposing = parent.dispose();

    runtime.ctx.emit('runtime.parent-child', 'same-stack', target);
    expect(childDeliveries).toEqual([]);
    await parentCleanupStarted.promise;
    try {
      runtime.ctx.emit('runtime.parent-child', 'cleanup-wait', target);
      expect(childDeliveries).toEqual([]);
    } finally {
      releaseParentCleanup.resolve();
    }
    await disposing;

    const sessionKey = {};
    const sessionGate = createAdmissionGate({ scopeKind: 'session' });
    const session = runtime.createScope(runtime.ctx, sessionKey, sessionGate);
    const internalDispatches: unknown[] = [];
    const observer = runtime.mount(session.ctx, 'internal-dispatch-observer', (ctx: CordisPluginContext) => {
      ctx.on('internal/dispatch', (...args: unknown[]) => {
        if (args[1] === 'runtime.unscoped') internalDispatches.push(args[1]);
      });
    });
    await observer.ready;

    const appTarget = scopeTarget({}, runtime.appKey);
    runtime.ctx.emit('runtime.unscoped', 'before-revoke', appTarget);
    expect(internalDispatches).toEqual(['runtime.unscoped']);
    sessionGate.revoke();
    runtime.ctx.emit('runtime.unscoped', 'after-revoke', appTarget);
    expect(internalDispatches).toEqual(['runtime.unscoped']);

    await session.dispose();
  });

  it('does not apply a plugin mounted immediately before scope disposal', async () => {
    const runtime = makeRuntime();
    const key = {};
    const scope = runtime.createScope(runtime.ctx, key, createAdmissionGate({ scopeKind: 'session' }));
    let applies = 0;
    const mounted = runtime.mount(scope.ctx, 'disposed-before-apply', () => { applies += 1; });

    await scope.dispose();
    await mounted.ready;

    expect(applies).toBe(0);
    expect(mounted.phase).toBe('disposed');
  });

  it('keeps injected child cleanup behind the parent last async cleanup', async () => {
    const runtime = makeRuntime();
    const events: string[] = [];
    const childActivated = deferred();
    const parentCleanupStarted = deferred();
    const releaseParentCleanup = deferred();
    const childPlugin = {
      inject: ['dependency'],
      apply(ctx: CordisPluginContext) {
        ctx.effect(() => () => { events.push('child-clean'); });
        childActivated.resolve();
      },
    };
    const parentPlugin = (raw: CordisPluginContext, config: { dependency: string }) => {
      const ctx = raw as CordisPluginContext;
      ctx.provide('dependency', config.dependency);
      ctx.plugin(childPlugin);
      ctx.effect(() => async () => {
        events.push('parent-last-start');
        parentCleanupStarted.resolve();
        await releaseParentCleanup.promise;
        events.push('parent-last-end');
      });
    };
    const parent = runtime.mount(runtime.ctx, 'dependency-owner', parentPlugin, { dependency: 'ready' });
    await parent.ready;
    await childActivated.promise;

    const disposing = parent.dispose();
    await parentCleanupStarted.promise;
    try {
      expect(events).toEqual(['parent-last-start']);
    } finally {
      releaseParentCleanup.resolve();
    }
    await disposing;

    expect(events).toEqual(['parent-last-start', 'parent-last-end', 'child-clean']);
  });

  it('closes a captured positional waterfall continuation after runtime disposal', async () => {
    const runtime = makeRuntime();
    let continuation: (() => unknown) | undefined;
    let terminalCalls = 0;
    const mounted = runtime.mount(runtime.ctx, 'positional-waterfall-listener', (ctx: CordisPluginContext) => {
      ctx.on('public-event', (_value, next) => { continuation = next; });
    });
    await mounted.ready;
    const waterfall = runtime.rawContext.events.waterfall.bind(runtime.rawContext.events) as (...args: unknown[]) => unknown;

    waterfall(scopeTarget({}, runtime.appKey), 'public-event', {}, () => { terminalCalls += 1; });
    expect(continuation).toBeTypeOf('function');

    await runtime.dispose();

    expect(errorFrom(() => continuation?.())).toMatchObject({ code: 'continuation_closed' });
    expect(terminalCalls).toBe(0);
  });

  it('keeps same-named services from sibling scopes isolated with ctx.isolate', async () => {
    const runtime = makeRuntime();
    const leftKey = {};
    const rightKey = {};
    const leftScope = runtime.createScope(runtime.ctx, leftKey, createAdmissionGate({ scopeKind: 'session' }));
    const rightScope = runtime.createScope(runtime.ctx, rightKey, createAdmissionGate({ scopeKind: 'session' }));
    const left = (leftScope.ctx as IsolatableContext).isolate('shared.name');
    const right = (rightScope.ctx as IsolatableContext).isolate('shared.name');
    const leftProvider = runtime.mount(left, 'left-provider', (ctx: CordisPluginContext) => {
      ctx.provide('shared.name', 'left');
    });
    const rightProvider = runtime.mount(right, 'right-provider', (ctx: CordisPluginContext) => {
      ctx.provide('shared.name', 'right');
    });

    await Promise.all([leftProvider.ready, rightProvider.ready]);

    expect(left.get('shared.name')).toBe('left');
    expect(right.get('shared.name')).toBe('right');
    expect(leftScope.ctx.get('shared.name')).toBeUndefined();
    expect(rightScope.ctx.get('shared.name')).toBeUndefined();

    await Promise.all([leftScope.dispose(), rightScope.dispose()]);
  });

  it('routes keyed carriers through the scope chain and rejects missing or forged carriers', async () => {
    const runtime = makeRuntime();
    const deliveries: string[] = [];
    const appPlugin = runtime.mount(runtime.ctx, 'app-waterfall-listener', (ctx: CordisPluginContext) => {
      ctx.on('runtime.waterfall', (_value, next) => {
        deliveries.push('app');
        return next?.();
      });
    });
    const childKey = {};
    const childScope = runtime.createScope(runtime.ctx, childKey, createAdmissionGate({ scopeKind: 'session' }));
    const childPlugin = runtime.mount(childScope.ctx, 'child-waterfall-listener', (ctx: CordisPluginContext) => {
      ctx.on('runtime.waterfall', (_value, next) => {
        deliveries.push('child');
        return next?.();
      });
    });
    await Promise.all([appPlugin.ready, childPlugin.ready]);

    const result = await runtime.ctx.waterfall({
      eventName: 'runtime.waterfall',
      initialValue: 1,
      target: scopeTarget({}, childKey),
      asyncTimeoutMs: 1000,
      syncWarnBudgetMs: 100,
    });

    expect(result.value).toBe(1);
    expect(deliveries).toEqual(['app', 'child']);
    expect(errorFrom(() => runtime.ctx.waterfall({
      eventName: 'runtime.waterfall',
      initialValue: 1,
      asyncTimeoutMs: 1000,
      syncWarnBudgetMs: 100,
    }))).toMatchObject({ code: 'scope_missing' });
    expect(errorFrom(() => runtime.ctx.waterfall({
      eventName: 'runtime.waterfall',
      initialValue: 1,
      target: { scopeKey: runtime.appKey } as ReturnType<typeof scopeTarget>,
      asyncTimeoutMs: 1000,
      syncWarnBudgetMs: 100,
    }))).toMatchObject({ code: 'scope_missing' });

    await childScope.dispose();
  });
});

describe('guarded waterfall counterexamples', () => {
  it('reports a double continuation while preserving the first downstream run', async () => {
    const runtime = makeRuntime();
    let duplicateFailure: unknown;
    const mounted = runtime.mount(runtime.ctx, 'double-next', (ctx: CordisPluginContext) => {
      ctx.on('runtime.double-next', (_value, next) => {
        const first = next!();
        void next!().catch((error) => { duplicateFailure = error; });
        return first;
      });
    });
    await mounted.ready;

    const result = await runtime.ctx.waterfall({
      eventName: 'runtime.double-next',
      initialValue: 1,
      target: scopeTarget({}, runtime.appKey),
      asyncTimeoutMs: 1000,
      syncWarnBudgetMs: 100,
    });

    expect(result.value).toBe(1);
    expect(result.violations.map(({ kind }) => kind)).toContain('double_next');
    expect(duplicateFailure).toMatchObject({ code: 'double_next' });
  });

  it('rejects next called after the async deadline using a controlled latch', async () => {
    const runtime = makeRuntime();
    const release = deferred();
    const lateCallSettled = deferred();
    let lateFailure: unknown;
    const mounted = runtime.mount(runtime.ctx, 'late-next', (ctx: CordisPluginContext) => {
      ctx.on('runtime.late-next', async (_value, next) => {
        await release.promise;
        try {
          await next!();
        } catch (error) {
          lateFailure = error;
        } finally {
          lateCallSettled.resolve();
        }
      });
    });
    await mounted.ready;

    const result = await runtime.ctx.waterfall({
      eventName: 'runtime.late-next',
      initialValue: 1,
      target: scopeTarget({}, runtime.appKey),
      asyncTimeoutMs: 25,
      syncWarnBudgetMs: 100,
    });
    release.resolve();
    await lateCallSettled.promise;

    expect(result.violations.map(({ kind }) => kind)).toContain('async_timeout');
    expect(lateFailure).toMatchObject({ code: 'continuation_closed' });
  });

  it('reports a synchronous listener that exceeds its warning budget', async () => {
    const runtime = makeRuntime();
    const mounted = runtime.mount(runtime.ctx, 'sync-overbudget', (ctx: CordisPluginContext) => {
      ctx.on('runtime.sync-budget', (_value, next) => {
        const until = performance.now() + 15;
        while (performance.now() < until) {}
        return next?.();
      });
    });
    await mounted.ready;

    const result = await runtime.ctx.waterfall({
      eventName: 'runtime.sync-budget',
      initialValue: 1,
      target: scopeTarget({}, runtime.appKey),
      asyncTimeoutMs: 1000,
      syncWarnBudgetMs: 0,
    });

    expect(result.violations.map(({ kind }) => kind)).toContain('sync_budget_exceeded');
  });

  it('updates volatile schema data in place without remounting the plugin', async () => {
    const runtime = makeRuntime();
    let applies = 0;
    let liveReference: { get(): Readonly<{ endpoint: string }> } | undefined;
    const plugin = {
      Config: Schema.object({
        stable: Schema.string(),
        live: Schema.object({ endpoint: Schema.string() }).volatile(),
      }),
      apply(_ctx: CordisPluginContext, config: { stable: string; live: { get(): Readonly<{ endpoint: string }> } }) {
        applies += 1;
        liveReference = config.live;
      },
    };
    const mounted = runtime.mount(runtime.ctx, 'volatile-config', plugin, {
      stable: 'kept',
      live: { endpoint: 'https://before.example.test' },
    });
    await mounted.ready;
    const initialReference = liveReference;

    await mounted.updateConfig({
      stable: 'kept',
      live: { endpoint: 'https://after.example.test' },
    });

    expect(applies).toBe(1);
    expect(liveReference).toBe(initialReference);
    expect(liveReference?.get()).toEqual({ endpoint: 'https://after.example.test' });
  });
});
