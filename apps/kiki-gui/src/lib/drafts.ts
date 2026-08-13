/** Per-session composer drafts: in-memory for this app run, optionally mirrored to `kiki.drafts`. */

import { readSettings } from './settings';

const KEY = 'kiki.drafts';

const memory = new Map<string, string>();
let hydratedFromDisk = false;

function draftsEnabled(): boolean {
  return readSettings().draftPersistence;
}

function readAllStored(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function persistOne(sessionId: string, text: string): void {
  const all = readAllStored();
  if (text === '') {
    delete all[sessionId];
  } else {
    all[sessionId] = text;
  }
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage full / unavailable — drafts are a convenience, not a guarantee
  }
}

function hydrateFromDiskIfNeeded(): void {
  if (hydratedFromDisk) return;
  hydratedFromDisk = true;
  if (!draftsEnabled()) return;
  for (const [sessionId, text] of Object.entries(readAllStored())) {
    if (typeof text === 'string' && text !== '') memory.set(sessionId, text);
  }
}

export function readDraft(sessionId: string): string {
  hydrateFromDiskIfNeeded();
  return memory.get(sessionId) ?? '';
}

export function writeDraft(sessionId: string, text: string): void {
  hydrateFromDiskIfNeeded();
  if (text === '') memory.delete(sessionId);
  else memory.set(sessionId, text);
  if (!draftsEnabled()) return;
  persistOne(sessionId, text);
}

/** Drop the on-disk store. In-memory drafts for this app run stay put. */
export function clearStoredDrafts(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** @deprecated Use clearStoredDrafts — name kept for the settings toggle call site. */
export function clearAllDrafts(): void {
  clearStoredDrafts();
}

/** Test-only: forget this-process memory as if the module were freshly imported. */
export function resetDraftMemoryForTests(): void {
  memory.clear();
  hydratedFromDisk = false;
}
