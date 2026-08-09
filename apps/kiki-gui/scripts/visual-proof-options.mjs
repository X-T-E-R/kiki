import { join } from 'node:path';

export const UPDATE_GOLDENS_FLAG = '--update-goldens';
const ONLY_FLAG = '--only';
const ONLY_PREFIX = `${ONLY_FLAG}=`;

/**
 * Keep routine proof output out of the tracked golden directory. Updating the
 * goldens is intentionally an explicit command-line choice.
 */
export function selectProofOutput(root, argv, scenarioNames) {
  const updateGoldens = argv.includes(UPDATE_GOLDENS_FLAG);
  const onlyArgs = argv.filter((arg) => arg === ONLY_FLAG || arg.startsWith(ONLY_PREFIX));

  if (onlyArgs.length > 1) {
    throw new Error(`${ONLY_FLAG} may only be specified once`);
  }

  const [onlyArg] = onlyArgs;
  if (onlyArg === ONLY_FLAG) {
    throw new Error(`${ONLY_FLAG} requires a comma-separated value, for example ${ONLY_PREFIX}reconnect`);
  }

  const only = onlyArg === undefined ? null : onlyArg.slice(ONLY_PREFIX.length).split(',');
  const unknownScenarios = only?.filter((name) => name.length === 0 || !scenarioNames.includes(name)) ?? [];
  if (unknownScenarios.length > 0) {
    throw new Error(`unknown scenario(s): ${unknownScenarios.join(', ')}`);
  }
  if (updateGoldens && onlyArgs.length > 0) {
    throw new Error(`${UPDATE_GOLDENS_FLAG} cannot be combined with ${ONLY_FLAG}`);
  }

  return {
    mode: updateGoldens ? 'update-goldens' : 'disposable',
    outputDir: updateGoldens
      ? join(root, 'screenshots', 'batch3')
      : join(root, '.tmp', 'visual-proof', 'batch3'),
    only,
  };
}
