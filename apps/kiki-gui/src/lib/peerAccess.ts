export function isPeerConnectionSource(source: string | null | undefined): boolean {
  return source === 'app-shell' || source === 'remote';
}

export function isLocalOwnerRequiredError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as {
    readonly code?: unknown;
    readonly status?: unknown;
    readonly message?: unknown;
    readonly msg?: unknown;
  };
  if (record.code === 40101 || record.code === '40101') return true;
  const text = typeof record.message === 'string'
    ? record.message
    : typeof record.msg === 'string'
      ? record.msg
      : '';
  if (/local_owner_required/i.test(text)) return true;
  return record.status === 403 && /\b40101\b/.test(text);
}
