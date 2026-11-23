export const RECEIPT_FILE_NAME = 'desktop-build-receipt.json';
export const RECEIPT_SCHEMA_VERSION = 1;
export const DESKTOP_EXE = 'kiki-desktop.exe';
export const SERVER_EXE = 'kiki-server.exe';

export const FULL_COMMIT_RE = /^[0-9a-f]{40}$/;
export const FULL_HASH_RE = /^[0-9a-f]{64}$/;

export function assertFullCommit(value) {
  const commit = typeof value === 'string' ? value.trim() : '';
  if (!FULL_COMMIT_RE.test(commit)) {
    throw new Error('sourceCommit must be the full 40-character commit selected for this build.');
  }
  return commit;
}

export function assertEvidenceRef(value, label) {
  const reference = typeof value === 'string' ? value.trim() : '';
  if (reference === '' || /[\r\n]/.test(reference)) {
    throw new Error(`${label} reference is required.`);
  }
  return reference;
}
