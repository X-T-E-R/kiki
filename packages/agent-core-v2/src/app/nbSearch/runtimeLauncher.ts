import * as donor from '@nb-corp/nb-search';

export interface NbSearchWorkerLauncher { launch(jobId: string, jobsRoot: string): Promise<void> }
export type NbSearchWorkerLauncherFactory = (env: NodeJS.ProcessEnv) => NbSearchWorkerLauncher;
let factory: NbSearchWorkerLauncherFactory | undefined;

/** Host startup injection only; not sourced from user search configuration. */
export function configureNbSearchWorkerLauncher(value: NbSearchWorkerLauncherFactory): void { factory = value; }

export function createHostedNbSearchRuntime(options: Parameters<typeof donor.createNbSearchRuntime>[0]) {
  if (factory === undefined) return donor.createNbSearchRuntime(options);
  if (typeof Reflect.get(donor, 'runWorker') !== 'function') throw new Error('The bundled nb-search runtime does not support hosted workers.');
  return donor.createNbSearchRuntime({ ...options, launcher: factory(options?.env ?? process.env) } as Parameters<typeof donor.createNbSearchRuntime>[0]);
}
