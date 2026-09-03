import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveKikiHome(
  explicitHome?: string,
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  return resolve(
    explicitHome
      ?? env['KIKI_HOME']
      ?? env['KIMI_CODE_HOME']
      ?? join(userHome, '.kiki'),
  );
}
