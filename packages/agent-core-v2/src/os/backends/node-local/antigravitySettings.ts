import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import { atomicWrite } from '#/_base/utils/fs';

export const ANTIGRAVITY_AUTH_METHODS = ['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform'] as const;
export type AntigravityAuthMethod = typeof ANTIGRAVITY_AUTH_METHODS[number];

export interface AntigravityGcpSettings {
  readonly project?: string;
  readonly location?: string;
}

export interface AntigravityStoredSettings {
  readonly authMethod: AntigravityAuthMethod;
  readonly gcpProject?: string;
  readonly gcpLocation?: string;
  readonly present: boolean;
}

export async function readAntigravitySettings(home: string): Promise<AntigravityStoredSettings> {
  const requested = join(home, 'antigravity-acp', 'settings.json');
  let path: string;
  try {
    path = await realpath(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { authMethod: 'oauth-personal', present: false };
    }
    return { authMethod: 'oauth-personal', present: false };
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { authMethod: 'oauth-personal', present: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { authMethod: 'oauth-personal', present: true };
  }
  if (!isRecord(parsed)) return { authMethod: 'oauth-personal', present: true };
  const auth = parsed['auth'];
  const existing = isRecord(auth) ? auth['type'] : undefined;
  const authMethod = ANTIGRAVITY_AUTH_METHODS.includes(existing as AntigravityAuthMethod)
    ? existing as AntigravityAuthMethod
    : 'oauth-personal';
  const gcp = parsed['gcp'];
  const gcpProject = isRecord(gcp) && typeof gcp['project'] === 'string' && gcp['project'].trim() !== ''
    ? gcp['project'].trim()
    : undefined;
  const gcpLocation = isRecord(gcp) && typeof gcp['location'] === 'string' && gcp['location'].trim() !== ''
    ? gcp['location'].trim()
    : undefined;
  return { authMethod, gcpProject, gcpLocation, present: true };
}

export async function antigravityAuthSettings(
  home: string,
  method?: AntigravityAuthMethod,
  gcp?: AntigravityGcpSettings,
): Promise<AntigravityAuthMethod> {
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
  const existingGcp = value?.['gcp'];
  if (existingGcp !== undefined && !isRecord(existingGcp)) return fallback;
  let gcpChanged = false;
  let nextGcp: Record<string, unknown> | undefined = isRecord(existingGcp) ? { ...existingGcp } : undefined;
  if (gcp !== undefined) {
    nextGcp ??= {};
    if (gcp.project !== undefined) {
      const trimmed = gcp.project.trim();
      if (trimmed === '') {
        if (Object.hasOwn(nextGcp, 'project')) {
          delete nextGcp['project'];
          gcpChanged = true;
        }
      } else if (nextGcp['project'] !== trimmed) {
        nextGcp['project'] = trimmed;
        gcpChanged = true;
      }
    }
    if (gcp.location !== undefined) {
      const trimmed = gcp.location.trim();
      if (trimmed === '') {
        if (Object.hasOwn(nextGcp, 'location')) {
          delete nextGcp['location'];
          gcpChanged = true;
        }
      } else if (nextGcp['location'] !== trimmed) {
        nextGcp['location'] = trimmed;
        gcpChanged = true;
      }
    }
  }
  if (value === undefined || existing !== selected || gcpChanged) {
    const next = value ?? {};
    next['auth'] = { ...isRecord(auth) ? auth : {}, type: selected };
    if (nextGcp !== undefined) {
      if (Object.keys(nextGcp).length > 0) next['gcp'] = nextGcp;
      else delete next['gcp'];
    }
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
