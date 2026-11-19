import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function validatePluginNodeEntry(
  entry: string,
  args: readonly string[],
  pluginRoot: string,
  trustedRunner: string | null = null,
): Promise<{ entryReal: string; argsReal: readonly string[] }> {
  const [rootReal, entryReal] = await Promise.all([realpath(pluginRoot), realpath(entry)]);
  if (isWithin(entryReal, rootReal)) return { entryReal, argsReal: args };
  if (trustedRunner !== null && args.length === 1) {
    const runnerReal = await realpath(trustedRunner).catch(() => null);
    if (runnerReal !== null && entryReal === runnerReal) {
      const targetReal = await realpath(args[0]!);
      if (isWithin(targetReal, rootReal)) {
        return { entryReal, argsReal: [targetReal] };
      }
    }
  }
  throw new Error(`Plugin node entry must be inside KIKI_PLUGIN_ROOT: ${entry}`);
}

export async function executePluginNodeEntry(
  entry: string,
  args: readonly string[],
  trustedRunner: string | null = null,
): Promise<void> {
  const pluginRoot = process.env['KIKI_PLUGIN_ROOT'];
  if (pluginRoot === undefined || pluginRoot.trim().length === 0) {
    throw new Error('KIKI_PLUGIN_ROOT is required to run a plugin node entry.');
  }

  const { entryReal, argsReal } = await validatePluginNodeEntry(
    entry,
    args,
    pluginRoot,
    trustedRunner,
  );
  process.argv = [process.argv[0] ?? process.execPath, entryReal, ...argsReal];
  process.stdin.once('end', () => {
    const timer = setTimeout(() => process.exit(0), 1_000);
    timer.unref();
  });
  // Keep disk ESM/TLA loading outside the native bundle's dynamic-import-to-require transform.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const importModule = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<unknown>;
  await importModule(pathToFileURL(entryReal).href);
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
