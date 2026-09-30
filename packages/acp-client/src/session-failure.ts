import { AcpClientError, AcpClientErrorCode } from '#/errors';

export function airSessionFailure(meta: unknown): AcpClientError | undefined {
  const air = object(object(object(meta)?.['jetbrains'])?.['air']);
  if (air === undefined || !Number.isSafeInteger(air['version']) || Number(air['version']) < 1) return undefined;
  const value = object(air['sessionFailure']);
  if (value === undefined || typeof value['id'] !== 'string' || value['id'].trim().length === 0 || !Number.isSafeInteger(value['revision']) || Number(value['revision']) < 1) return undefined;
  if (value['severity'] !== undefined && value['severity'] !== 'error') return undefined;
  const title = typeof value['title'] === 'string' ? value['title'].slice(0, 1024) : 'External session failed';
  const actions = Array.isArray(value['actions']) ? value['actions'].filter((action) => typeof action === 'string').slice(0, 8) : [];
  return new AcpClientError(AcpClientErrorCode.SessionFailed, title, { details: {
    sessionFailure: { id: value['id'], revision: value['revision'], category: value['category'], severity: 'error', title,
      details: typeof value['details'] === 'string' ? value['details'].slice(0, 16_384) : undefined, actions },
  } });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
