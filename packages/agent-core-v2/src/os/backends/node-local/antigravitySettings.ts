import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import { atomicWrite } from '#/_base/utils/fs';

export const ANTIGRAVITY_AUTH_METHODS = ['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform'] as const;
export type AntigravityAuthMethod = typeof ANTIGRAVITY_AUTH_METHODS[number];

export async function antigravityAuthSettings(home: string, method?: AntigravityAuthMethod): Promise<AntigravityAuthMethod> {
  const requested = join(home, 'antigravity-acp', 'settings.json');
  const fallback = method ?? 'oauth-personal';
  let path: string;
  try {
    path = await realpath(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fallback;
    path = requested;
  }

  let text: string | undefined;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fallback;
  }

  let value: Record<string, unknown> | undefined;
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) return fallback;
      value = parsed;
    } catch {
      return fallback;
    }
  }

  const auth = value?.['auth'];
  if (auth !== undefined && !isRecord(auth)) return fallback;
  const existing = isRecord(auth) ? auth['type'] : undefined;
  const selected = method ?? (ANTIGRAVITY_AUTH_METHODS.includes(existing as AntigravityAuthMethod) ? existing as AntigravityAuthMethod : 'oauth-personal');
  if (value === undefined || existing !== selected) {
    const next = value ?? {};
    next['auth'] = { ...isRecord(auth) ? auth : {}, type: selected };
    try {
      await mkdir(dirname(path), { recursive: true });
      await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
    } catch {
      return selected;
    }
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
