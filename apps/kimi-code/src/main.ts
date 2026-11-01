import './native/worker-heap';
import { initializeMainHeap } from './native/main-heap';
import { PROCESS_NAME } from './constant/identity';
import type { CLIOptions } from './cli/options';

/** Result of a prompt or interactive shell launch; process disposition belongs to the entrypoint. */
export interface MainCommandOutcome {
  readonly headlessCompleted: boolean;
}

export async function handleMainCommand(opts: CLIOptions, version: string): Promise<MainCommandOutcome> {
  const runtime = await import('./main-runtime');
  return runtime.handleMainCommand(opts, version);
}

export async function main(): Promise<void> {
  if (initializeMainHeap()) return;
  process.title = PROCESS_NAME;
  const args = process.argv.slice(2);
  const assetSmoke = process.env['KIKI_NATIVE_ASSET_SMOKE'] === '1' || process.env['KIKI_AUTH_NATIVE_SMOKE'] === '1';
  try {
    if (!assetSmoke && args[0] === '__plugin_run_node') {
      await import('./plugin-node-entry');
    } else if (!assetSmoke && args[0] === 'tools') {
      const { runToolsCommand } = await import('./cli/tools-entry');
      await runToolsCommand(process.argv);
    } else if (!assetSmoke && args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
      const { getVersion } = await import('./cli/package-version');
      process.stdout.write(`${getVersion()}\n`);
    } else {
      const runtime = await import('./main-runtime');
      runtime.main();
    }
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}

void main();
