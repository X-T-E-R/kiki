/**
 * Process-wide registration for the SEA-extracted LiteLLM pricing snapshot.
 * Repository/dev runs resolve the vendored JSON directly; the single-file
 * executable extracts the native asset and configures its absolute path here.
 */

import fs from 'node:fs';
import path from 'node:path';

export type ModelPricingRuntimeState =
  | { readonly configured: false }
  | { readonly configured: true; readonly path: string };

let configuredPath: string | null = null;

export function configureModelPricingRuntime(snapshotPath: string): ModelPricingRuntimeState {
  if (!path.isAbsolute(snapshotPath)) {
    throw new TypeError('model pricing snapshot path must be absolute');
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(snapshotPath);
  } catch (error) {
    throw new TypeError(
      `model pricing snapshot is not readable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!stat.isFile()) {
    throw new TypeError('model pricing snapshot must be a regular file');
  }
  if (configuredPath !== null) {
    if (configuredPath !== snapshotPath) {
      throw new Error('model pricing runtime is already configured');
    }
    return { configured: true, path: configuredPath };
  }
  configuredPath = snapshotPath;
  return { configured: true, path: configuredPath };
}

/** Reset process-wide configuration. Intended for tests and controlled hosts. */
export function resetModelPricingRuntime(): void {
  configuredPath = null;
}

export function getModelPricingRuntimeState(): ModelPricingRuntimeState {
  return configuredPath === null
    ? { configured: false }
    : { configured: true, path: configuredPath };
}
