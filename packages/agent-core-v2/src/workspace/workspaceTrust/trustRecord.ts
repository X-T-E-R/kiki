import { encodeWorkDirKey, workDirKeyAliases, workspaceRootKey } from '#/_base/utils/workdir-slug';
import { canonicalWorkspaceRoot } from '#/_base/utils/paths';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

const TRUST_SCOPE = 'workspace-trust';

interface TrustRecord {
  readonly root: string;
  readonly trustedAt: number;
}

export async function readWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
): Promise<boolean> {
  try {
    for (const key of trustKeys(root)) {
      if ((await docs.get<TrustRecord>(TRUST_SCOPE, key)) !== undefined) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function migrateWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
): Promise<void> {
  const canonicalKey = trustKey(root);
  for (const key of trustKeys(root)) {
    const record = await docs.get<TrustRecord>(TRUST_SCOPE, key);
    if (record === undefined) continue;
    if (key !== canonicalKey) await docs.set(TRUST_SCOPE, canonicalKey, record);
    for (const alias of trustKeys(root, record)) {
      if (alias !== canonicalKey) await docs.delete(TRUST_SCOPE, alias);
    }
    return;
  }
}

export function writeWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
  trustedAt: number,
): Promise<void> {
  return docs.set(TRUST_SCOPE, trustKey(root), { root, trustedAt });
}

export async function deleteWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
): Promise<void> {
  const keys = new Set(trustKeys(root));
  for (const key of keys) {
    const record = await docs.get<TrustRecord>(TRUST_SCOPE, key);
    for (const alias of trustKeys(root, record)) keys.add(alias);
  }
  for (const key of keys) await docs.delete(TRUST_SCOPE, key);
}

function trustKeys(root: string, record?: TrustRecord): readonly string[] {
  const keys = new Set([trustKey(root), ...workDirKeyAliases(root)]);
  if (record !== undefined && workspaceRootKey(record.root) === workspaceRootKey(root)) {
    for (const key of workDirKeyAliases(record.root)) keys.add(key);
  }
  return [...keys];
}

function trustKey(root: string): string {
  return encodeWorkDirKey(canonicalWorkspaceRoot(root));
}
