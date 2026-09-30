import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import { atomicWrite } from '#/_base/utils/fs';

export const ANTIGRAVITY_AUTH_METHODS = ['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform'] as const;
export type AntigravityAuthMethod = typeof ANTIGRAVITY_AUTH_METHODS[number];

export async function antigravityAuthSettings(home: string, method?: AntigravityAuthMethod): Promise<AntigravityAuthMethod> {
  const requested = join(home, 'antigravity-acp', 'settings.json');
  const path = await realpath(requested).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return requested;
  });
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  const value: unknown = text === undefined ? {} : JSON.parse(text);
  if (!isRecord(value)) throw new Error('Antigravity settings.json must be an object');
  const auth = value['auth'];
  if (auth !== undefined && !isRecord(auth)) throw new Error('Antigravity auth settings must be an object');
  const existing = isRecord(auth) ? auth['type'] : undefined;
  const selected = method ?? (ANTIGRAVITY_AUTH_METHODS.includes(existing as AntigravityAuthMethod) ? existing as AntigravityAuthMethod : 'oauth-personal');
  if (existing !== selected) {
    value['auth'] = { ...isRecord(auth) ? auth : {}, type: selected };
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
  }
  return selected;
}

export function antigravityCredentialEnvToRemove(method: AntigravityAuthMethod): readonly string[] {
  const google = ['GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_VERTEXAI'];
  return method === 'gemini-api-key' ? google : method === 'agent-platform' ? ['GEMINI_API_KEY'] : ['GEMINI_API_KEY', ...google];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
