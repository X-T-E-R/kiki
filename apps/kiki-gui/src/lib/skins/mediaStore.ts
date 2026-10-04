/**
 * Local storage for background media bytes.
 *
 * A picked picture or video stays on this device: it is written to IndexedDB
 * and shown through a `blob:` URL, so it works the same in the desktop app, in
 * a browser tab pointed at a remote server, and offline. Nothing is uploaded.
 * (The desktop asset protocol would avoid the copy, but it would pin the
 * background to a path that can move and would not exist for a browser tab.)
 *
 * Where IndexedDB is unavailable (private windows in some browsers, jsdom)
 * the store falls back to memory for the session and says so through
 * `isPersistent()`, so the settings page can tell the user the choice will
 * not survive a reload.
 */

import { APPEARANCE_LIMITS, backgroundMediaTypeOf, sniffBackgroundMediaType } from '@kiki/protocol';

import type { BackgroundMediaRef } from './background';

const DB_NAME = 'kiki-appearance';
const STORE = 'media';

const memory = new Map<string, Blob>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
      request.onsuccess = () => { resolve(request.result); };
      request.onerror = () => { resolve(null); };
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    if (db === null) { resolve(undefined); return; }
    const request = body(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error('media store failed')); };
  }));
}

export async function isPersistent(): Promise<boolean> {
  return (await openDb()) !== null;
}

export async function putMedia(id: string, blob: Blob): Promise<void> {
  memory.set(id, blob);
  await run('readwrite', (store) => store.put(blob, id)).catch(() => undefined);
}

export async function getMedia(id: string): Promise<Blob | null> {
  const cached = memory.get(id);
  if (cached !== undefined) return cached;
  const blob = await run<Blob>('readonly', (store) => store.get(id) as IDBRequest<Blob>).catch(() => undefined);
  if (blob === undefined) return null;
  memory.set(id, blob);
  return blob;
}

export async function deleteMedia(id: string): Promise<void> {
  memory.delete(id);
  await run('readwrite', (store) => store.delete(id)).catch(() => undefined);
}

/** Why a picked file cannot become a background; shown as-is, in the UI's words. */
export type MediaRejection = 'type' | 'size' | 'content';

export interface MediaCheck {
  readonly ok: true;
  readonly kind: 'image' | 'video';
  readonly mime: string;
}

/**
 * Check a file against the same allow-list and size ceilings the server uses
 * for packs, and sniff its first bytes so a renamed file cannot pass as media.
 */
export async function checkBackgroundFile(file: Blob & { name?: string }, name: string | undefined = file.name): Promise<MediaCheck | { ok: false; reason: MediaRejection }> {
  const byName = name === undefined ? null : backgroundMediaTypeOf(name);
  const head = await readHead(file);
  const sniffed = sniffBackgroundMediaType(head);
  if (sniffed === null) return { ok: false, reason: byName === null ? 'type' : 'content' };
  if (byName !== null && byName.mime !== sniffed) return { ok: false, reason: 'content' };
  const kind = sniffed.startsWith('video/') ? 'video' : 'image';
  const limit = kind === 'video' ? APPEARANCE_LIMITS.videoBytes : APPEARANCE_LIMITS.imageBytes;
  if (file.size > limit) return { ok: false, reason: 'size' };
  return { ok: true, kind, mime: sniffed };
}

/** First bytes of a blob, through FileReader (the one reader every host has). */
function readHead(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => { resolve(new Uint8Array(reader.result as ArrayBuffer)); };
    reader.onerror = () => { resolve(new Uint8Array()); };
    reader.readAsArrayBuffer(file.slice(0, 32));
  });
}

let counter = 0;

/** Store a checked file and return the ref prefs can point at. */
export async function storeBackgroundFile(file: Blob, check: MediaCheck, name: string): Promise<BackgroundMediaRef> {
  counter += 1;
  const id = `local-${Date.now().toString(36)}-${counter.toString(36)}`;
  await putMedia(id, file.type === check.mime ? file : new Blob([file], { type: check.mime }));
  return { id, kind: check.kind, mime: check.mime, name: name.slice(0, 200), bytes: file.size };
}

/** Drop every stored file no ref still points at. */
export async function pruneMedia(keep: ReadonlySet<string>): Promise<void> {
  for (const id of Array.from(memory.keys())) if (!keep.has(id)) memory.delete(id);
  const keys = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys()).catch(() => undefined);
  for (const key of keys ?? []) {
    if (typeof key === 'string' && !keep.has(key)) await deleteMedia(key);
  }
}

/** Forget the in-memory cache (tests). */
export function resetMediaStore(): void {
  memory.clear();
  dbPromise = null;
}
