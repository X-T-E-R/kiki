import * as cordis from './vendor/cordis/index.ts';
import * as cosmokit from './vendor/cosmokit/index.ts';
import * as schemastery from './vendor/schemastery/index.ts';
import * as scope from './vendor/scope/index.ts';
import type {
  AnyCordisPlugin, CordisCanonicalAbi, CordisFiberHandle, CordisPluginContext,
  CordisScopeKey, CordisScopedTarget, ScopeAdmissionGate, WaterfallViolationReport,
} from './index.ts';

const abiKey = Symbol.for('kiki.cordis.canonical-abi.v1');
type Canonical = CordisCanonicalAbi & {
  readonly cordisNamespace: typeof cordis;
  readonly cosmokitNamespace: typeof cosmokit;
  readonly schemasteryNamespace: typeof schemastery;
  readonly rawScopeNamespace: typeof scope;
};

/** One canonical set of Cordis and scope identities for this JavaScript realm. */
export function getCordisCanonicalAbi(): Canonical {
  const registry = globalThis as typeof globalThis & { [abiKey]?: Canonical };
  if (registry[abiKey]) return registry[abiKey];
  const scopeNamespace: CordisCanonicalAbi['scopeNamespace'] = {
    createScope: (ctx, key) => {
      const parent = scope.scopeOf(ctx as any) ?? ctx.scopeKey;
      if (parent && !scope.scopeParentOf(key)) scope.bindScopeParent(key, parent);
      const created = scope.createScope(ctx as any, key);
      return { ctx: created.ctx as any, dispose: created.dispose };
    },
    bindScopeParent: scope.bindScopeParent,
    scopeParentOf: scope.scopeParentOf,
    scopeChainOf: scope.scopeChainOf,
    scopeOf: ctx => scope.scopeOf(ctx as any),
    scopeTarget: scope.scopeTarget,
  };
  const abi: Canonical = Object.freeze({
    version: '1', cordisNamespace: cordis, cosmokitNamespace: cosmokit,
    schemasteryNamespace: schemastery, scopeNamespace: Object.freeze(scopeNamespace), rawScopeNamespace: scope,
  });
  Object.defineProperty(registry, abiKey, { value: abi });
  return abi;
}

/** Synchronous monotonic admission state; revocation never waits for cleanup. */
export function createAdmissionGate(input: Pick<ScopeAdmissionGate, 'scopeKind' | 'sessionId' | 'agentId'>): ScopeAdmissionGate {
  let epoch = 0;
  let revoked = false;
  return Object.freeze({ ...input, get epoch() { return epoch; }, get revoked() { return revoked; }, revoke() {
    if (revoked) return;
    revoked = true;
    epoch += 1;
  } });
}

export class CordisScopeError extends Error {
  constructor(readonly code: 'scope_missing' | 'scope_forbidden' | 'revoked', message: string) { super(message); }
}

export interface CordisRuntime {
  readonly abi: CordisCanonicalAbi;
  readonly ctx: CordisPluginContext;
  readonly rawContext: cordis.Context;
  readonly appKey: CordisScopeKey;
  readonly appGate: ScopeAdmissionGate;
  createScope(parent: CordisPluginContext, key: CordisScopeKey, gate: ScopeAdmissionGate): { readonly ctx: CordisPluginContext; dispose(): Promise<void> };
  mount<T>(ctx: CordisPluginContext, pluginId: string, plugin: AnyCordisPlugin<T>, config?: T): CordisFiberHandle;
  dispose(): Promise<void>;
}

/** Create the plugin plane over the canonical, hardened Cordis implementation. */
export function createCordisRuntime(onViolation?: (report: WaterfallViolationReport) => void): CordisRuntime {
  const abi = getCordisCanonicalAbi();
  const { Context, FiberState } = abi.cordisNamespace;
  const scopes = abi.rawScopeNamespace;
  const rawContext = new Context();
  const appKey = {};
  const appGate = createAdmissionGate({ scopeKind: 'app' });
  const gates = new WeakMap<CordisScopeKey, ScopeAdmissionGate>([[appKey, appGate]]);
  Object.defineProperty(rawContext, 'scopeKey', { value: appKey });
  const scopeKeyOf = (ctx: cordis.Context) => scopes.scopeOf(ctx) ?? appKey;
  const alive = (key: CordisScopeKey) => scopes.scopeChainOf(key).every(key => gates.get(key)?.revoked !== true);
  const admitted = (ctx: cordis.Context) => ctx.fiber.canEnter() && alive(scopeKeyOf(ctx));
  rawContext.events._admit = admitted;
  rawContext.events._onViolation = onViolation;
  rawContext.events._route = (source, target) => {
    if (!scopes.isScopeCarrier(target) || !scopes.carrierKeyOf(target)) throw new CordisScopeError('scope_missing', 'Business events require a keyed scope carrier');
    const key = scopes.carrierKeyOf(target)!;
    const sourceKey = scopeKeyOf(source);
    const chain = scopes.scopeChainOf(key);
    if (!chain.includes(appKey) || !chain.includes(sourceKey)) throw new CordisScopeError('scope_forbidden', 'Event target is outside the emitting scope');
    const filter = target[Context.filter];
    const targetAdmitted = () => alive(key) && admitted(source);
    return { targetAdmitted, listenerAdmitted: listener => targetAdmitted() && admitted(listener) &&
      listener.fiber.state === FiberState.ACTIVE && filter.call(target, listener) };
  };
  let disposing: Promise<void> | undefined;
  const runtime: CordisRuntime = {
    abi, ctx: rawContext as any, rawContext, appKey, appGate,
    createScope(parent, key, gate) {
      const parentKey = scopeKeyOf(parent as any);
      if (!alive(parentKey)) throw new CordisScopeError('revoked', 'Parent scope is revoked');
      scopes.bindScopeParent(key, parentKey);
      gates.set(key, gate);
      const created = scopes.createScope(parent as any, key);
      return { ctx: created.ctx as any, dispose: () => { gate.revoke(); return created.dispose(); } };
    },
    mount(ctx, pluginId, plugin, config) {
      if (!alive(scopeKeyOf(ctx as any))) throw new CordisScopeError('revoked', 'Plugin scope is revoked');
      const mounted = (ctx as any as cordis.Context).plugin(plugin as any, config);
      const fiber = mounted.ctx.fiber;
      Object.defineProperty(fiber, 'pluginId', { value: pluginId });
      const uid = fiber.uid!;
      let draining: Promise<void> | undefined;
      return { uid, pluginId, get phase() { return fiber.phase; }, ready: fiber.ready,
        updateConfig: raw => fiber.updateConfig(raw),
        dispose: () => draining ??= (async () => { await fiber.dispose(); while (fiber.inertia) await fiber.inertia; })(),
      };
    },
    dispose() {
      appGate.revoke();
      return disposing ??= rawContext.fiber.dispose();
    },
  };
  return runtime;
}

/** Mint a canonical carrier; payloads, not the carrier, contain the subject. */
export function scopeTarget<T extends object>(subject: T, key: CordisScopeKey | undefined): CordisScopedTarget<T> {
  return getCordisCanonicalAbi().rawScopeNamespace.scopeTarget(subject, key);
}
