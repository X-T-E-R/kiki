import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installGlobalProxyDispatcher } from '@kiki/node-sdk/proxy';

installGlobalProxyDispatcher(process.env);

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

void (async () => {
  try {
    const commandIndex = process.argv.indexOf('__plugin_run_node');
    const entry = process.argv[commandIndex + 1] ?? '';
    const args = process.argv.slice(commandIndex + 2);
    const pluginRoot = process.env['KIKI_PLUGIN_ROOT'];
    if (pluginRoot === undefined || pluginRoot.trim().length === 0) {
      throw new Error('KIKI_PLUGIN_ROOT is required to run a plugin node entry.');
    }
    const bundleRunner =
      process.env['KIKI_PLUGIN_HOST_RUNNER'] ??
      join(dirname(fileURLToPath(import.meta.url)), 'hostRunner.mjs');
    const [rootReal, entryReal] = await Promise.all([realpath(pluginRoot), realpath(entry)]);
    let finalArgs = args;
    if (!isWithin(entryReal, rootReal)) {
      const runnerReal = await realpath(bundleRunner).catch(() => null);
      if (runnerReal !== null && args.length === 1 && entryReal === runnerReal) {
        const targetReal = await realpath(args[0]!);
        if (!isWithin(targetReal, rootReal)) {
          throw new Error(`Plugin node entry must be inside KIKI_PLUGIN_ROOT: ${entry}`);
        }
        finalArgs = [targetReal];
      } else {
        throw new Error(`Plugin node entry must be inside KIKI_PLUGIN_ROOT: ${entry}`);
      }
    }
    process.argv = [process.argv[0] ?? process.execPath, entryReal, ...finalArgs];
    process.stdin.once('end', () => {
      const timer = setTimeout(() => process.exit(0), 1_000);
      timer.unref();
    });
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const importModule = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<unknown>;
    await importModule(pathToFileURL(entryReal).href);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
})();
