const VAULT_DB_NAME = 'kiki.shell.vault';
const VAULT_STORE_NAME = 'tokens';
const VAULT_KEY_ID = '__aes_gcm_key__';

interface EncryptedVaultRecord {
  iv: Uint8Array;
  cipher: ArrayBuffer;
}

const ephemeralTokens = new Map<string, string>();

function openVaultDb(): Promise<IDBDatabase | null> {
  return new Promise((resolveDb, rejectDb) => {
    if (typeof indexedDB === 'undefined') {
      resolveDb(null);
      return;
    }
    const req = indexedDB.open(VAULT_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VAULT_STORE_NAME)) {
        db.createObjectStore(VAULT_STORE_NAME);
      }
    };
    req.onsuccess = () => resolveDb(req.result);
    req.onerror = () => rejectDb(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolveGet, rejectGet) => {
    const tx = db.transaction(VAULT_STORE_NAME, 'readonly');
    const req = tx.objectStore(VAULT_STORE_NAME).get(key);
    req.onsuccess = () => resolveGet(req.result as T | undefined);
    req.onerror = () => rejectGet(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolvePut, rejectPut) => {
    const tx = db.transaction(VAULT_STORE_NAME, 'readwrite');
    tx.objectStore(VAULT_STORE_NAME).put(value, key);
    tx.oncomplete = () => resolvePut();
    tx.onerror = () => rejectPut(tx.error);
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolveDel, rejectDel) => {
    const tx = db.transaction(VAULT_STORE_NAME, 'readwrite');
    tx.objectStore(VAULT_STORE_NAME).delete(key);
    tx.oncomplete = () => resolveDel();
    tx.onerror = () => rejectDel(tx.error);
  });
}

async function getOrCreateVaultKey(db: IDBDatabase): Promise<CryptoKey | null> {
  if (!globalThis.crypto?.subtle) return null;
  const existing = await idbGet<CryptoKey>(db, VAULT_KEY_ID);
  if (existing) return existing;
  const key = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  await idbPut(db, VAULT_KEY_ID, key);
  return key;
}

function tokenVaultKey(serverId: string, origin?: string): string {
  return origin ? `${serverId}@${origin}` : serverId;
}

async function encryptAndStoreVaultEntry(
  db: IDBDatabase,
  key: CryptoKey,
  vaultKey: string,
  token: string,
): Promise<void> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(vaultKey);
  const cipher = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    new TextEncoder().encode(token),
  );
  await idbPut(db, vaultKey, { iv, cipher });
}

async function readAndDecryptVaultEntry(
  db: IDBDatabase,
  key: CryptoKey,
  vaultKey: string,
): Promise<string | undefined> {
  const record = await idbGet<Partial<EncryptedVaultRecord>>(db, vaultKey);
  if (!record) return undefined;
  if (!record.iv || !record.cipher) {
    await idbDelete(db, vaultKey).catch(() => {});
    return undefined;
  }
  const iv = new Uint8Array(record.iv.byteLength);
  iv.set(record.iv);
  const aad = new TextEncoder().encode(vaultKey);
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    record.cipher,
  );
  const decoded = new TextDecoder().decode(plain);
  return decoded || undefined;
}

export async function saveWebPeerToken(
  serverId: string,
  token: string,
  origin?: string,
): Promise<void> {
  if (!serverId || !token) return;
  ephemeralTokens.set(serverId, token);
  if (origin) {
    ephemeralTokens.set(tokenVaultKey(serverId, origin), token);
  }
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto?.getRandomValues !== 'function') {
    return;
  }
  try {
    const db = await openVaultDb();
    if (!db) return;
    try {
      const key = await getOrCreateVaultKey(db);
      if (!key) return;
      await encryptAndStoreVaultEntry(db, key, serverId, token);
      if (origin) {
        await encryptAndStoreVaultEntry(db, key, tokenVaultKey(serverId, origin), token);
      }
    } finally {
      db.close();
    }
  } catch {
  }
}

export async function readWebPeerToken(
  serverId: string,
  origin?: string,
): Promise<string | undefined> {
  if (!serverId) return undefined;
  const scopedKey = origin ? tokenVaultKey(serverId, origin) : null;
  if (scopedKey && ephemeralTokens.has(scopedKey)) {
    return ephemeralTokens.get(scopedKey);
  }
  if (ephemeralTokens.has(serverId)) {
    return ephemeralTokens.get(serverId);
  }
  if (!globalThis.crypto?.subtle) {
    return undefined;
  }
  try {
    const db = await openVaultDb();
    if (!db) return undefined;
    try {
      const key = await getOrCreateVaultKey(db);
      if (!key) return undefined;
      if (scopedKey) {
        const scopedDecoded = await readAndDecryptVaultEntry(db, key, scopedKey);
        if (scopedDecoded) {
          ephemeralTokens.set(scopedKey, scopedDecoded);
          return scopedDecoded;
        }
      }
      const decoded = await readAndDecryptVaultEntry(db, key, serverId);
      if (decoded) {
        ephemeralTokens.set(serverId, decoded);
        return decoded;
      }
    } finally {
      db.close();
    }
  } catch {
  }
  return undefined;
}

export async function deleteWebPeerToken(
  serverId: string,
  origins: readonly string[] = [],
): Promise<void> {
  if (!serverId) return;
  ephemeralTokens.delete(serverId);
  for (const origin of origins) {
    ephemeralTokens.delete(tokenVaultKey(serverId, origin));
  }
  try {
    const db = await openVaultDb();
    if (!db) return;
    try {
      await idbDelete(db, serverId);
      for (const origin of origins) {
        await idbDelete(db, tokenVaultKey(serverId, origin));
      }
    } finally {
      db.close();
    }
  } catch {
  }
}
