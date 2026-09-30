import { setClampedTimeout } from '@kiki/node-sdk';
import { resolvePrintTimeoutMs, resolvePromptInput, type CLIOptions } from './options';

export async function waitForPrintOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    signal.throwIfAborted();
  }
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function withPrintTimeout<T>(opts: CLIOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = resolvePrintTimeoutMs(opts.timeout);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    const deadline = Date.now() + timeoutMs;
    const arm = (): void => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        controller.abort(new Error(`Print run timed out after ${opts.timeout}s (--timeout).`));
      } else {
        timer = setClampedTimeout(arm, remaining);
      }
    };
    arm();
  }
  try {
    return await run(controller.signal);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Await `promise`, but stop waiting after `timeoutMs`.
 *
 * The timeout only bounds how long we WAIT — it does not change the outcome:
 *  - if `promise` settles first, its result is propagated (a rejection throws),
 *    so a cleanup step that actually fails in time still surfaces;
 *  - if the timeout wins, we resolve (give up waiting) and swallow the abandoned
 *    promise's eventual late rejection so it can't surface as an unhandled
 *    rejection.
 *
 * Used to bound shutdown so a wedged cleanup step can't keep a completed
 * headless run alive, without silently swallowing a cleanup that fails fast. The
 * timer stays ref'd so a cleanup step that suspends on an unref'd handle (e.g.
 * telemetry's retry backoff when the network is blocked) can't drain the event
 * loop and exit 0 before the rejection propagates — the timer keeps the loop
 * alive until it fires, then gives the rejection a chance to surface. A wedged
 * cleanup is still bounded by `timeoutMs`, so this can't hang the run forever.
 */
export async function raceWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Attach the catch eagerly (synchronously) so `promise` is always consumed and
  // a late rejection can never become an unhandled rejection. Before the timeout
  // wins, the handler rethrows so a real cleanup failure still propagates.
  const guarded = promise.catch((error: unknown) => {
    if (timedOut) return;
    throw error;
  });
  const timedOutSignal = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([guarded, timedOutSignal]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface PromptOutput {
  readonly columns?: number | undefined;
  write(chunk: string): boolean;
}

export interface PromptRunIO {
  readonly stdout?: PromptOutput;
  readonly stderr?: PromptOutput;
  readonly process?: PromptProcess;
}

export interface PromptProcess {
  once(signal: NodeJS.Signals, listener: () => Promise<void>): unknown;
  off(signal: NodeJS.Signals, listener: () => Promise<void>): unknown;
  exit(code?: number): never | void;
}

/**
 * `kiki -p`. Loads the shared-client print runner lazily to keep the
 * in-process host's module graph off the interactive startup path.
 */
export async function runPrompt(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
): Promise<void> {
  await withPrintTimeout(opts, async (signal) => {
    const resolved = await waitForPrintOperation(resolvePromptInput(opts), signal);
    const { runV2Print } = await waitForPrintOperation(import('./v2/run-v2-print'), signal);
    await runV2Print(resolved, version, io, signal);
  });
}

export function requireConfiguredModel(...models: readonly (string | undefined)[]): string {
  const model = configuredModel(...models);
  if (model === undefined) {
    throw new Error(
      'No model configured. Run `kiki` and use /login to sign in, then retry; or set default_model in config.toml.',
    );
  }
  return model;
}

export function configuredModel(...models: readonly (string | undefined)[]): string | undefined {
  return models.find((model) => model !== undefined && model.trim().length > 0);
}

export function installPromptTerminationCleanup(
  promptProcess: PromptProcess,
  cleanup: () => Promise<void>,
): () => void {
  let terminating = false;
  const exitAfterCleanup = async (signal: NodeJS.Signals): Promise<void> => {
    if (terminating) return;
    terminating = true;
    try {
      await cleanup();
    } finally {
      promptProcess.exit(signalExitCode(signal));
    }
  };
  const onSigint = () => exitAfterCleanup('SIGINT');
  const onSigterm = () => exitAfterCleanup('SIGTERM');
  const onSighup = () => exitAfterCleanup('SIGHUP');
  promptProcess.once('SIGINT', onSigint);
  promptProcess.once('SIGTERM', onSigterm);
  promptProcess.once('SIGHUP', onSighup);
  return () => {
    promptProcess.off('SIGINT', onSigint);
    promptProcess.off('SIGTERM', onSigterm);
    promptProcess.off('SIGHUP', onSighup);
  };
}

export function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGHUP') return 129;
  return 143;
}

