/** Per-session composer drafts: in-memory for this app run, optionally mirrored to `kiki.drafts`. */

import type { PermissionMode, PromptPlanGate } from '@moonshot-ai/protocol';

import type { ComposerAttachment } from './attachments';
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

// ---- per-session composer chrome (memory-only) ----

/**
 * Composer state beyond text that should survive a session switch: attachment
 * chips and the pill overrides. Mirrors the draft map's in-memory layer, but
 * deliberately never touches localStorage — image attachments carry base64
 * payloads and pills are session-scoped chrome, not durable content. An
 * app restart starts every composer fresh; only the text draft persists.
 */
export interface ComposerSessionState {
  attachments: readonly ComposerAttachment[];
  /** Pill overrides; `undefined` means "no local override" (store/default). */
  permissionMode: PermissionMode | undefined;
  planMode: boolean | undefined;
  /**
   * Session-scoped plan-gate pick (`plan_gate` on the next prompt). The agent
   * never echoes its gate back over the wire, so unlike the mode pills this
   * override is never cleared by a server value — it rides every prompt of
   * this session until the user flips the switch again.
   */
  planGate: PromptPlanGate | undefined;
  swarmMode: boolean | undefined;
  goalObjective: string | undefined;
  modelOverride: string | undefined;
  effortOverride: string | undefined;
}

const composerMemory = new Map<string, ComposerSessionState>();

/** Restored composer chrome for a session; `{}` when none was captured yet. */
export function readComposerState(
  sessionId: string,
): Partial<ComposerSessionState> {
  return composerMemory.get(sessionId) ?? {};
}

export function writeComposerState(sessionId: string, state: ComposerSessionState): void {
  composerMemory.set(sessionId, state);
}

export function clearComposerState(sessionId: string): void {
  composerMemory.delete(sessionId);
}

/** Test-only: forget every session's captured composer chrome. */
export function resetComposerMemoryForTests(): void {
  composerMemory.clear();
}

// ---- per-session input history (memory-only) ----

/**
 * Sent prompts, newest last, for the composer's ArrowUp/ArrowDown recall.
 * Mirrors the chrome map's scope rules: memory-only (a restart starts every
 * composer fresh), per session (the /new draft keys on its workspace), and
 * capped like opencode's history store.
 */
export const INPUT_HISTORY_LIMIT = 50;

const historyMemory = new Map<string, string[]>();

/**
 * Record a submitted prompt. Empty text is ignored; repeating the last entry
 * is a no-op (shell-style consecutive dedupe), and the oldest entries fall
 * off past INPUT_HISTORY_LIMIT.
 */
export function pushInputHistory(key: string, text: string): void {
  const trimmed = text.trim();
  if (trimmed === '') return;
  const list = historyMemory.get(key) ?? [];
  if (list.at(-1) !== trimmed) list.push(trimmed);
  while (list.length > INPUT_HISTORY_LIMIT) list.shift();
  historyMemory.set(key, list);
}

/** Newest-last recall order; the composer walks it backwards from the end. */
export function readInputHistory(key: string): readonly string[] {
  return historyMemory.get(key) ?? [];
}

/** Test-only: forget every recorded prompt. */
export function resetInputHistoryForTests(): void {
  historyMemory.clear();
}

