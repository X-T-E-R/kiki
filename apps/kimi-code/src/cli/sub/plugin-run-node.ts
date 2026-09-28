import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { getPluginHostRunnerFile } from '#/native/native-assets';

export async function runPluginNodeEntry(entry: string, args: readonly string[]): Promise<void> {
  const pluginRoot = process.env['KIKI_PLUGIN_ROOT'];
  if (pluginRoot === undefined || pluginRoot.trim().length === 0) {
    throw new Error('KIKI_PLUGIN_ROOT is required to run a plugin node entry.');
  }

  const { entryReal, argsReal } = await validatePluginNodeEntry(entry, args, pluginRoot);
  process.argv = [process.argv[0] ?? process.execPath, entryReal, ...argsReal];
  await import(pathToFileURL(entryReal).href);
}

export async function validatePluginNodeEntry(
  entry: string,
  args: readonly string[],
  pluginRoot: string,
  trustedRunner: string | null = getPluginHostRunnerFile(),
): Promise<{ entryReal: string; argsReal: readonly string[] }> {
  const [rootReal, entryReal] = await Promise.all([realpath(pluginRoot), realpath(entry)]);
  if (isWithin(entryReal, rootReal)) return { entryReal, argsReal: args };
  if (trustedRunner !== null && args.length === 1 &&
    entryReal === await realpath(trustedRunner) &&
    isWithin(await realpath(args[0]!), rootReal)) {
    return { entryReal, argsReal: [await realpath(args[0]!)] };
  }
  throw new Error(`Plugin node entry must be inside KIKI_PLUGIN_ROOT: ${entry}`);
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
