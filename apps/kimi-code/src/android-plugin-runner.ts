import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installGlobalProxyDispatcher } from '@kiki/node-sdk/proxy';

import { executePluginNodeEntry } from './plugin-node-validate';

installGlobalProxyDispatcher(process.env);

void (async () => {
  try {
    const commandIndex = process.argv.indexOf('__plugin_run_node');
    const entry = process.argv[commandIndex + 1] ?? '';
    const args = process.argv.slice(commandIndex + 2);
    const bundleRunner =
      process.env['KIKI_PLUGIN_HOST_RUNNER'] ??
      join(dirname(fileURLToPath(import.meta.url)), 'hostRunner.mjs');
    await executePluginNodeEntry(entry, args, bundleRunner);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
})();
