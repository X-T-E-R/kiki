import type { GuardedWaterfallOptions, GuardedWaterfallResult, WaterfallViolationReport } from './index.ts';

export interface WaterfallListener {
  readonly pluginId: string;
  admitted(): boolean;
  call(value: unknown, next: () => Promise<unknown>): unknown;
}

export class CordisContinuationError extends Error {
  constructor(readonly code: 'double_next' | 'continuation_closed') {
    super(code);
  }
}

export async function guardedWaterfall<T>(
  options: GuardedWaterfallOptions<T>,
  listeners: readonly WaterfallListener[],
  targetAdmitted: () => boolean,
  observe?: (report: WaterfallViolationReport) => void,
): Promise<GuardedWaterfallResult<T>> {
  const violations: WaterfallViolationReport[] = [];
  const touchedByPlugins = new Set<string>();
  let vetoedByPluginId: string | undefined;
  const { eventName, signal, validateStep, syncWarnBudgetMs = 50, asyncTimeoutMs = 5000 } = options;
  const cloneValue = options.cloneValue ?? ((value: T) => structuredClone(value));
  const dispatchAdmitted = () => !signal?.aborted && targetAdmitted();

  async function run(index: number, value: T): Promise<T> {
    if (!dispatchAdmitted()) return value;
    while (index < listeners.length && !listeners[index]!.admitted()) index += 1;
    const listener = listeners[index];
    if (!listener) return value;
    const { pluginId } = listener;
    const started = performance.now();
    const deadline = started + asyncTimeoutMs;
    let syncDurationMs = 0;
    let open = true;
    let called = false;
    let downstream: Promise<T> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const admitted = () => dispatchAdmitted() && listener.admitted();
    const report = (kind: WaterfallViolationReport['kind'], detail?: string) => {
      const diagnostic = { pluginId, eventName, kind, syncDurationMs, totalDurationMs: performance.now() - started, detail };
      violations.push(diagnostic);
      observe?.(diagnostic);
      options.onViolation?.(diagnostic);
    };
    const rejectNext = (code: CordisContinuationError['code']) => {
      const rejection = Promise.reject(new CordisContinuationError(code));
      void rejection.catch(() => {});
      return rejection;
    };
    const draft = cloneValue(value);
    const validate = (candidate: T) => validateStep ? validateStep(candidate, pluginId) : candidate;
    const next = () => {
      if (called) {
        report('double_next');
        return rejectNext('double_next');
      }
      if (!open || performance.now() >= deadline || !admitted()) return rejectNext('continuation_closed');
      called = true;
      const step = Promise.resolve().then(() => {
        if (!open || performance.now() >= deadline || !admitted()) return value;
        return downstream = run(index + 1, validate(draft));
      });
      void step.catch(() => {});
      return step;
    };
    const interrupted = Symbol('interrupted');
    try {
      touchedByPlugins.add(pluginId);
      let outcome: unknown;
      try { outcome = listener.call(draft, next); }
      finally {
        syncDurationMs = performance.now() - started;
        if (syncDurationMs > syncWarnBudgetMs) report('sync_budget_exceeded');
      }
      const interruption = new Promise<typeof interrupted>((resolve) => {
        timer = setTimeout(() => { open = false; resolve(interrupted); }, Math.max(0, deadline - performance.now()));
        abort = () => { open = false; resolve(interrupted); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      const returned = await Promise.race([outcome, interruption]);
      open = false;
      if (!admitted()) {
        report('revoked_late_return');
        return downstream ?? run(index + 1, value);
      }
      if (returned === interrupted || performance.now() >= deadline) {
        report('async_timeout');
        return downstream ?? run(index + 1, value);
      }
      if (!called) {
        const veto = returned === undefined ? value : validate(returned as T);
        report('missing_next');
        vetoedByPluginId = pluginId;
        return veto;
      }
      const after = await (downstream ?? run(index + 1, value));
      return admitted() && returned !== undefined && returned !== after ? validate(returned as T) : after;
    } catch (error) {
      open = false;
      if (!(error instanceof CordisContinuationError)) report('unhandled_exception', error instanceof Error ? error.message : String(error));
      return downstream ?? run(index + 1, value);
    } finally {
      open = false;
      if (timer !== undefined) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  const value = await run(0, options.initialValue);
  return { value, touchedByPlugins: [...touchedByPlugins], vetoedByPluginId, violations: [...violations] };
}
