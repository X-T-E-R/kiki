/**
 * The event hub — klient-level event forwarding. It exposes typed, namespaced
 * events and hides the engine's `onDid*`/`onWill*` surface: each public event
 * name resolves to one registration (a global-bus type filter, a scope
 * stream, or a service emitter). Underlying channel subscriptions are shared
 * per source and ref-counted by listener count. Payloads are validated
 * against the event schema before delivery; bad payloads are dropped and
 * reported through `onError`, never thrown.
 *
 * One hub serves one scope: the global klient hub binds `{}`, session/agent
 * handles bind their scope coordinates, so `stream` sources resolve to the
 * right scope's event stream on every transport.
 */

import type { IDisposable, KlientChannel, ScopeRef } from '../channel.js';
import type { EventRegistration } from '#/contract/types';
import type { KlientEventPayloads } from '#/contract/global/events';
import { parseEvent } from '../validation.js';

/** Initial source attachment only; subsequent disconnects still report through onError. */
export interface EventSubscription extends IDisposable {
  readonly ready: Promise<void>;
}

export interface KlientEvents<TPayloadMap extends object = KlientEventPayloads> {
  on<E extends keyof TPayloadMap & string>(
    event: E,
    listener: (payload: TPayloadMap[E]) => void,
  ): EventSubscription;
  /**
   * Observe authoritative state, not an event replay. All selected event sources
   * attach before the first read and before every reconnect read. Events invalidate
   * the snapshot; superseded reads are aborted and their results are discarded.
   * Supply a facade GET as `read`, and select every source that can change it.
   * Read failures surface through `onError` and stop this observation; subscription
   * errors invalidate it until the transport acknowledges a restored subscription.
   */
  observe<T>(
    options: {
      events: readonly (keyof TPayloadMap & string)[];
      read: (signal: AbortSignal) => Promise<T>;
    },
    listener: (snapshot: T) => void,
  ): IDisposable;
  /** Validation failures, observation failures and listener exceptions surface here. */
  onError(listener: (error: Error) => void): IDisposable;
}

type AnyListener = (payload: never) => void;

interface AttachmentWaiter {
  resolve(): void;
  reject(error: Error): void;
}

interface SharedSub {
  readonly reg: EventRegistration;
  disposable: IDisposable;
  refs: number;
  attached: boolean;
  readonly waiters: Set<AttachmentWaiter>;
}

/** Stable identity of a registration's underlying channel subscription. */
function keyOf(reg: EventRegistration): string {
  switch (reg.kind) {
    case 'bus':
      return 'bus';
    case 'stream':
      return `stream:${reg.name}`;
    case 'emitter':
      return `emitter:${reg.service}:${reg.event}`;
  }
}

function rawTypeOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const type = (raw as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

export class EventHub<TPayloadMap extends object = KlientEventPayloads>
  implements KlientEvents<TPayloadMap>
{
  private readonly listeners = new Map<string, Set<AnyListener>>();
  private readonly subs = new Map<string, SharedSub>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private closed = false;

  constructor(
    private readonly channel: KlientChannel,
    private readonly validate: boolean,
    private readonly scope: ScopeRef,
    private readonly registrations: Record<string, EventRegistration>,
  ) {}

  on<E extends keyof TPayloadMap & string>(
    event: E,
    listener: (payload: TPayloadMap[E]) => void,
  ): EventSubscription {
    if (this.closed) throw new Error('event hub is closed');
    if (this.registrations[event] === undefined) {
      throw new Error(`unknown event: ${event}`);
    }
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const entry = listener as AnyListener;
    set.add(entry);
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const ready = { promise, resolve, reject };
    void ready.promise.catch(() => {});
    let sub: SharedSub;
    try {
      sub = this.acquire(event, ready);
    } catch (error) {
      set.delete(entry);
      if (set.size === 0) this.listeners.delete(event);
      throw error;
    }

    let disposed = false;
    return {
      ready: ready.promise,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        sub.waiters.delete(ready);
        ready.reject(new Error('event subscription disposed before attachment'));
        set.delete(entry);
        if (set.size === 0) {
          this.listeners.delete(event);
        }
        this.release(event);
      },
    };
  }

  private readonly observations = new Set<IDisposable>();

  observe<T>(
    options: {
      events: readonly (keyof TPayloadMap & string)[];
      read: (signal: AbortSignal) => Promise<T>;
    },
    listener: (snapshot: T) => void,
  ): IDisposable {
    if (this.closed) throw new Error('event hub is closed');
    if (options.events.length === 0) throw new Error('observe requires at least one event');
    if (typeof options.read !== 'function') throw new Error('observe requires a snapshot reader');
    const sources = new Map<string, EventRegistration>();
    for (const event of options.events) {
      const reg = this.registrations[event];
      if (reg === undefined) throw new Error(`unknown event: ${event}`);
      sources.set(keyOf(reg), reg);
    }
    const ready = new Set<string>();
    const subscriptions: IDisposable[] = [];
    let disposed = false;
    let generation = 0;
    let queued = false;
    let controller: AbortController | undefined;
    const observation: IDisposable = {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        generation += 1;
        controller?.abort();
        for (const subscription of subscriptions) subscription.dispose();
        this.observations.delete(observation);
      },
    };
    const invalidate = (): void => {
      generation += 1;
      controller?.abort();
      if (disposed || queued || ready.size !== sources.size) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (disposed || ready.size !== sources.size) return;
        const current = generation;
        controller = new AbortController();
        const signal = controller.signal;
        void Promise.resolve().then(() => {
          if (disposed || current !== generation) return;
          return options.read(signal);
        }).then((snapshot) => {
          if (disposed || current !== generation) return;
          try {
            listener(snapshot as T);
          } catch (error) {
            this.reportError(error instanceof Error ? error : new Error(String(error)));
          }
        }, (error: unknown) => {
          if (disposed || current !== generation) return;
          observation.dispose();
          this.reportError(error instanceof Error ? error : new Error(String(error)));
        });
      });
    };
    this.observations.add(observation);
    try {
      for (const [key, reg] of sources) {
        const source = reg.kind === 'emitter'
          ? { kind: 'emitter' as const, service: reg.service, event: reg.event }
          : { kind: 'stream' as const, name: reg.kind === 'bus' ? 'events' : reg.name };
        subscriptions.push(this.channel.listen(this.scope, source, () => {
          invalidate();
        }, (error) => {
          if (disposed) return;
          ready.delete(key);
          invalidate();
          this.reportError(error);
        }, () => {
          if (disposed) return;
          ready.add(key);
          invalidate();
        }));
      }
    } catch (error) {
      observation.dispose();
      throw error;
    }
    return observation;
  }

  onError(listener: (error: Error) => void): IDisposable {
    this.errorListeners.add(listener);
    return {
      dispose: () => {
        this.errorListeners.delete(listener);
      },
    };
  }

  /** Detach every subscription; the hub may not be reused after. */
  close(): void {
    this.closed = true;
    for (const observation of this.observations) observation.dispose();
    for (const sub of this.subs.values()) {
      for (const waiter of sub.waiters) waiter.reject(new Error('event hub closed before attachment'));
      sub.waiters.clear();
      sub.disposable.dispose();
    }
    this.subs.clear();
    this.listeners.clear();
  }

  private acquire(event: string, waiter: AttachmentWaiter): SharedSub {
    const reg = this.registrations[event]!;
    const key = keyOf(reg);
    let sub = this.subs.get(key);
    if (sub === undefined) {
      sub = {
        reg,
        disposable: { dispose() {} },
        refs: 0,
        attached: false,
        waiters: new Set([waiter]),
      };
      this.subs.set(key, sub);
      try {
        sub.disposable = this.subscribe(key, sub);
      } catch (error) {
        this.subs.delete(key);
        throw error;
      }
    } else if (sub.attached) {
      waiter.resolve();
    } else {
      sub.waiters.add(waiter);
    }
    sub.refs += 1;
    return sub;
  }

  private release(event: string): void {
    const reg = this.registrations[event];
    if (reg === undefined) return;
    const key = keyOf(reg);
    const sub = this.subs.get(key);
    if (sub === undefined) return;
    sub.refs -= 1;
    if (sub.refs <= 0) {
      sub.disposable.dispose();
      this.subs.delete(key);
    }
  }

  private subscribe(key: string, sub: SharedSub): IDisposable {
    const reg = sub.reg;
    const source = reg.kind === 'emitter'
      ? { kind: 'emitter' as const, service: reg.service, event: reg.event }
      : { kind: 'stream' as const, name: reg.kind === 'bus' ? 'events' : reg.name };
    return this.channel.listen(this.scope, source, (data) => {
      this.deliver(key, data);
    }, (error) => {
      sub.attached = false;
      for (const waiter of sub.waiters) waiter.reject(error);
      sub.waiters.clear();
      this.reportError(error);
    }, () => {
      sub.attached = true;
      for (const waiter of sub.waiters) waiter.resolve();
      sub.waiters.clear();
    });
  }

  /** Fan one raw payload out to the registrations attached to this source. */
  private deliver(key: string, raw: unknown): void {
    for (const [event, reg] of Object.entries(this.registrations)) {
      if (keyOf(reg) !== key || !this.listeners.has(event)) continue;
      if (reg.kind === 'bus') {
        // Global bus events are `{ type, payload }` facts; only registered
        // types are forwarded, with the payload unwrapped.
        if (rawTypeOf(raw) !== reg.type) continue;
        this.deliverValidated(event, reg, (raw as { payload?: unknown }).payload);
        continue;
      }
      if (reg.kind === 'stream' && reg.type !== undefined) {
        // Scoped streams (e.g. the agent `events` bus) carry flat
        // `{ type, ...fields }` events; forward the whole event.
        if (rawTypeOf(raw) !== reg.type) continue;
        this.deliverValidated(event, reg, raw);
        continue;
      }
      this.deliverValidated(event, reg, raw);
    }
  }

  private deliverValidated(event: string, reg: EventRegistration, data: unknown): void {
    let payload: unknown = data;
    if (this.validate) {
      const parsed = parseEvent(event, reg.schema, data);
      if (!parsed.ok) {
        this.reportError(parsed.error);
        return;
      }
      payload = parsed.data;
    }
    const set = this.listeners.get(event);
    if (set === undefined) return;
    for (const listener of set) {
      try {
        (listener as (payload: unknown) => void)(payload);
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private reportError(error: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch {
        // error listeners must not take the hub down
      }
    }
  }
}
