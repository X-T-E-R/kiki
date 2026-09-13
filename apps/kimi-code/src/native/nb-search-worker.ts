import { isSea } from 'node:sea';
import { installNbSearchWorkerHost, NB_SEARCH_WORKER_COMMAND, runNbSearchWorkerCommand } from '@kiki/node-sdk';

export function initializeNbSearchWorkerEntry(): boolean {
  const args = process.argv.slice(2);
  if (args[0] === NB_SEARCH_WORKER_COMMAND) {
    void runNbSearchWorkerCommand(args).then(
      () => process.exit(0),
      (error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); },
    );
    return true;
  }
  const entry = process.argv[1];
  if (entry === undefined) throw new Error('nb-search host entry is unavailable.');
  installNbSearchWorkerHost({ executable: process.execPath, entryArgs: isSea() ? [] : [...process.execArgv, entry] });
  return false;
}
