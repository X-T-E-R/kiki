import path from 'node:path';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IConfigService } from '#/app/config/config';
import { isRecipeFileReference, resolveRecipeFileLocator } from './recipePrimitives';

export function resolveModelRecipeReference(value: string, modelId: string, config: IConfigService, bootstrap: IBootstrapService, local = false): string {
  if (!isRecipeFileReference(value) || path.isAbsolute(value.trim()) || value.trim().startsWith('~')) return value;
  const inherited = !local && config.origins('models')[`${modelId}.recipe`] === 'base';
  const directory = inherited ? bootstrap.baseHomeDir : path.dirname(bootstrap.configPath);
  return resolveRecipeFileLocator(value, directory);
}
