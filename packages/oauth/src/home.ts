import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveKikiHome(explicit?: string, env: NodeJS.ProcessEnv = process.env, userHome = homedir()): string {
  return resolve(explicit ?? env['KIKI_HOME'] ?? join(userHome, '.kiki'));
}
