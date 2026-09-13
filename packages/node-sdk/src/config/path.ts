import { mkdirSync } from 'node:fs';
import { resolveKikiHome } from '@kiki/oauth';
import { join } from 'pathe';

export { resolveKikiHome };

export function resolveConfigPath(input: {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}): string {
  return input.configPath ?? join(resolveKikiHome(input.homeDir), 'config.toml');
}

export function ensureKikiHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
}
