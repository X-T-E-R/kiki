import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import * as donor from '@nb-corp/nb-search';
import { installGlobalProxyDispatcher } from '@kiki/agent-core-v2/_base/utils/proxy';
import { configureNbSearchWorkerLauncher } from '@kiki/agent-core-v2/app/nbSearch/runtimeLauncher';

export const NB_SEARCH_WORKER_COMMAND = '--internal-nb-search-worker';
const READY = 'nb-search-worker-ready-v1';
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NbSearchWorkerHost {
  readonly executable: string;
  readonly entryArgs: readonly string[];
  readonly startupTimeoutMs?: number;
}

/** Configure only from a trusted application entry point, never a user-supplied script path. */
export function installNbSearchWorkerHost(host: NbSearchWorkerHost): void {
  configureNbSearchWorkerLauncher((env) => ({ launch: (jobId, jobsRoot) => launchNbSearchWorker(host, env, jobId, jobsRoot) }));
}

export function launchNbSearchWorker(host: NbSearchWorkerHost, env: NodeJS.ProcessEnv, jobId: string, jobsRoot: string): Promise<void> {
  if (!JOB_ID.test(jobId) || !isAbsolute(jobsRoot)) return Promise.reject(new Error('Invalid nb-search worker identity or jobs root.'));
  return new Promise((resolve, reject) => {
    const child = spawn(host.executable, [...host.entryArgs, NB_SEARCH_WORKER_COMMAND, jobId, jobsRoot], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) { child.kill(); reject(error); }
      else { child.unref(); child.channel?.unref(); resolve(); }
    };
    const timer = setTimeout(() => finish(new Error('nb-search worker startup timed out.')), host.startupTimeoutMs ?? 15_000);
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`nb-search worker exited before readiness (${code}).`)));
    child.on('message', (message) => { if (message === READY) finish(); });
  });
}

/** Recognize a fixed internal command. Does not execute script paths from argv or search configuration. */
export async function runNbSearchWorkerCommand(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (args[0] !== NB_SEARCH_WORKER_COMMAND) return false;
  const [, jobId, jobsRoot] = args;
  if (args.length !== 3 || jobId === undefined || !JOB_ID.test(jobId) || jobsRoot === undefined || !isAbsolute(jobsRoot)) throw new Error('Invalid nb-search worker command.');
  const run = Reflect.get(donor, 'runWorker') as ((jobId: string, env: NodeJS.ProcessEnv, jobsRoot: string, onReady: () => void) => Promise<void>) | undefined;
  if (typeof run !== 'function') throw new Error('The bundled nb-search worker entry is unavailable.');
  installGlobalProxyDispatcher(env);
  try {
    await run(jobId, env, jobsRoot, () => {
      process.send?.(READY, () => { if (process.connected) process.disconnect(); });
    });
  } finally { if (process.connected) process.disconnect(); }
  return true;
}
