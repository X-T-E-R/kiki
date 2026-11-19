import { getPluginHostRunnerFile } from '#/native/native-assets';
import {
  executePluginNodeEntry,
  validatePluginNodeEntry as validatePluginNodeEntryWithRunner,
} from '#/plugin-node-validate';

export async function runPluginNodeEntry(entry: string, args: readonly string[]): Promise<void> {
  await executePluginNodeEntry(entry, args, getPluginHostRunnerFile());
}

export async function validatePluginNodeEntry(
  entry: string,
  args: readonly string[],
  pluginRoot: string,
  trustedRunner: string | null = getPluginHostRunnerFile(),
): Promise<{ entryReal: string; argsReal: readonly string[] }> {
  return validatePluginNodeEntryWithRunner(entry, args, pluginRoot, trustedRunner);
}
