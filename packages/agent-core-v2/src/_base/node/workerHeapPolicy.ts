import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { isMainThread } from 'node:worker_threads';

let enabled = false;

/** Opt in before creating workers. Keeps the existing main isolate's heap and lets future isolates use their own resourceLimits. Changes the process-wide V8 default for future isolates. */
export function enableIndependentWorkerHeaps(): void {
  if (enabled) return;
  if (!isMainThread) throw new Error('Worker heap policy must be enabled by the main thread before workers start');
  setFlagsFromString('--max-old-space-size=0');
  enabled = true;
}

export function removeInjectedHeapOption(env: NodeJS.ProcessEnv): void {
  const injected = env['KIKI_INJECTED_HEAP_OPTION'];
  const options = env['NODE_OPTIONS'];
  if (injected && options?.endsWith(` ${injected}`)) {
    const original = options.slice(0, -injected.length - 1);
    if (original === '') delete env['NODE_OPTIONS'];
    else env['NODE_OPTIONS'] = original;
  }
  delete env['KIKI_INJECTED_HEAP_OPTION'];
}

export function warnIfWorkerHeapLimit(expectedMb: number): void {
  const observedMb = getHeapStatistics().heap_size_limit / 1024 / 1024;
  if (observedMb < expectedMb * 0.9 || observedMb > expectedMb + 256) {
    process.emitWarning(`Worker heap limit is ${Math.round(observedMb)} MiB; expected ${expectedMb} MiB old-space plus at most 256 MiB young/code space. Check inherited Node heap flags.`, { code: 'KIKI_WORKER_HEAP_LIMIT' });
  }
}
