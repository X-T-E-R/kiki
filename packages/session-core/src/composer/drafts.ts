/** Per-session composer drafts: in-memory for this app run, optionally mirrored to `kiki.drafts`. */

import type { PermissionMode, PromptPlanGate } from '@kiki/protocol';

import type { ComposerAttachment } from './attachments';
import type { SelectionAnnotation } from './selectionQuote';
import { readSettings } from '../settings/settings';

const KEY = 'kiki.drafts';
const PERSISTED_COMPOSER_STATE_KEY = 'kiki.composerStates';
const PERSISTED_NEW_SESSION_DRAFT_KEY = 'kiki.newSessionDraft';

const memory = new Map<string, string>();
const pending = new Map<string, string>();
const DRAFT_WRITE_DELAY_MS = 400;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let hydratedFromDisk = false;
let unloadListenersInstalled = false;

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

function cancelDraftWrite(): void {
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = undefined;
  pending.clear();
}

/** Persist all pending edits together (also called when leaving a page or composer). */
export function flushDrafts(): void {
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = undefined;
  if (pending.size === 0) return;
  if (!draftsEnabled()) {
    pending.clear();
    return;
  }
  // Merge at flush time so edits from another tab to other sessions survive.
  const all = readAllStored();
  for (const [sessionId, text] of pending) {
    if (text === '') delete all[sessionId];
    else all[sessionId] = text;
  }
  pending.clear();
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage full / unavailable — drafts are a convenience, not a guarantee
  }
}

function scheduleDraftWrite(): void {
  if (!unloadListenersInstalled && typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushDrafts);
    window.addEventListener('beforeunload', flushDrafts);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushDrafts();
    });
    unloadListenersInstalled = true;
  }
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushDrafts, DRAFT_WRITE_DELAY_MS);
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
  if (!draftsEnabled()) {
    cancelDraftWrite();
    return;
  }
  pending.set(sessionId, text);
  scheduleDraftWrite();
}

/** Drop the on-disk store. In-memory drafts for this app run stay put. */
export function clearStoredDrafts(): void {
  cancelDraftWrite();
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(PERSISTED_COMPOSER_STATE_KEY);
    localStorage.removeItem(PERSISTED_NEW_SESSION_DRAFT_KEY);
  } catch {
    // ignore
  }
}

/** Test-only: forget this-process memory as if the module were freshly imported. */
export function resetDraftMemoryForTests(): void {
  cancelDraftWrite();
  memory.clear();
  hydratedFromDisk = false;
}

// ---- per-session composer chrome ----

/**
 * In-memory chrome survives session switches. Only model/effort overrides
 * are optionally mirrored to disk; attachments, unsent annotations and
 * execution controls never cross that persistence boundary.
 */
export interface ComposerSessionState {
  attachments: readonly ComposerAttachment[];
  annotations: readonly SelectionAnnotation[];
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

export interface PersistedComposerScalars {
  readonly modelOverride?: string;
  readonly effortOverride?: string;
}

export interface PersistedNewSessionDraft {
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly profile?: string;
  readonly modelOverride?: string;
  readonly effortOverride?: string;
  readonly modelFromProfile?: boolean;
  readonly effortFromProfile?: boolean;
  readonly prefillSource?: string;
}

const composerMemory = new Map<string, ComposerSessionState>();

function readAllStoredComposerScalars(): Record<string, PersistedComposerScalars> {
  try {
    const raw = localStorage.getItem(PERSISTED_COMPOSER_STATE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, PersistedComposerScalars> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const modelOverride = typeof record['modelOverride'] === 'string' ? record['modelOverride'] : undefined;
      const effortOverride = typeof record['effortOverride'] === 'string' ? record['effortOverride'] : undefined;
      if (modelOverride !== undefined || effortOverride !== undefined) {
        Object.defineProperty(result, sessionId, { value: { modelOverride, effortOverride }, enumerable: true, configurable: true, writable: true });
      }
    }
    return result;
  } catch {
    return {};
  }
}

function persistComposerScalars(
  sessionId: string,
  scalars: PersistedComposerScalars,
): void {
  if (!draftsEnabled()) return;
  const all = readAllStoredComposerScalars();
  if (scalars.modelOverride === undefined && scalars.effortOverride === undefined) {
    delete all[sessionId];
  } else {
    all[sessionId] = scalars;
  }
  try {
    if (Object.keys(all).length === 0) {
      localStorage.removeItem(PERSISTED_COMPOSER_STATE_KEY);
    } else {
      localStorage.setItem(PERSISTED_COMPOSER_STATE_KEY, JSON.stringify(all));
    }
  } catch {
    // storage full / unavailable
  }
}

export function readNewSessionDraft(): PersistedNewSessionDraft {
  if (!draftsEnabled()) return {};
  try {
    const raw = localStorage.getItem(PERSISTED_NEW_SESSION_DRAFT_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    return {
      workspaceId: typeof record['workspaceId'] === 'string' ? record['workspaceId'] : undefined,
      cwd: typeof record['cwd'] === 'string' ? record['cwd'] : undefined,
      profile: typeof record['profile'] === 'string' ? record['profile'] : undefined,
      modelOverride: typeof record['modelOverride'] === 'string' ? record['modelOverride'] : undefined,
      effortOverride: typeof record['effortOverride'] === 'string' ? record['effortOverride'] : undefined,
      modelFromProfile: typeof record['modelFromProfile'] === 'boolean' ? record['modelFromProfile'] : undefined,
      effortFromProfile: typeof record['effortFromProfile'] === 'boolean' ? record['effortFromProfile'] : undefined,
      prefillSource: typeof record['prefillSource'] === 'string' ? record['prefillSource'] : undefined,
    };
  } catch {
    return {};
  }
}

export function writeNewSessionDraft(draft: PersistedNewSessionDraft): void {
  if (!draftsEnabled()) return;
  try {
    const hasValues =
      (draft.workspaceId !== undefined && draft.workspaceId !== '') ||
      (draft.cwd !== undefined && draft.cwd !== '') ||
      (draft.profile !== undefined && draft.profile !== '') ||
      (draft.modelOverride !== undefined && draft.modelOverride !== '') ||
      (draft.effortOverride !== undefined && draft.effortOverride !== '');
    if (!hasValues) {
      localStorage.removeItem(PERSISTED_NEW_SESSION_DRAFT_KEY);
    } else {
      localStorage.setItem(PERSISTED_NEW_SESSION_DRAFT_KEY, JSON.stringify({
        workspaceId: draft.workspaceId,
        cwd: draft.cwd,
        profile: draft.profile,
        modelOverride: draft.modelOverride,
        effortOverride: draft.effortOverride,
        modelFromProfile: draft.modelFromProfile,
        effortFromProfile: draft.effortFromProfile,
        prefillSource: draft.prefillSource,
      }));
    }
  } catch {
    // storage unavailable
  }
}

export function clearNewSessionDraft(): void {
  try {
    localStorage.removeItem(PERSISTED_NEW_SESSION_DRAFT_KEY);
  } catch {
    // ignore
  }
}

/** Restored composer chrome for a session; `{}` when none was captured yet. */
export function readComposerState(
  sessionId: string,
): Partial<ComposerSessionState> {
  const inMemory = composerMemory.get(sessionId);
  if (inMemory !== undefined) return inMemory;
  if (!draftsEnabled()) return {};
  const stored = readAllStoredComposerScalars()[sessionId];
  if (typeof stored !== 'object' || stored === null) return {};
  return {
    modelOverride: typeof stored.modelOverride === 'string' ? stored.modelOverride : undefined,
    effortOverride: typeof stored.effortOverride === 'string' ? stored.effortOverride : undefined,
  };
}

export function writeComposerState(sessionId: string, state: ComposerSessionState): void {
  composerMemory.set(sessionId, state);
  persistComposerScalars(sessionId, {
    modelOverride: state.modelOverride,
    effortOverride: state.effortOverride,
  });
}

export function clearComposerState(sessionId: string): void {
  composerMemory.delete(sessionId);
  if (draftsEnabled()) {
    persistComposerScalars(sessionId, {});
  }
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

// ---- external draft appends (「加入对话」 and friends) ----

/**
 * Append a snippet to a session's composer draft from outside the composer
 * (e.g. the preview workspace's `@` mention button). The composer owner
 * (SessionView) holds the draft in React state, so the append goes through
 * `writeDraft` for persistence and then notifies subscribers, who re-read the
 * stored text — one channel that works whether or not that session's composer
 * is currently mounted.
 */
export function appendToDraft(sessionId: string, text: string): void {
  if (text === '') return;
  const current = readDraft(sessionId);
  const separator = current !== '' && !/[\s]$/.test(current) ? ' ' : '';
  writeDraft(sessionId, `${current}${separator}${text}`);
  for (const listener of appendListeners) listener(sessionId);
}

type DraftAppendListener = (sessionId: string) => void;

const appendListeners = new Set<DraftAppendListener>();

/** Subscribe to `appendToDraft` writes; returns the unsubscribe. */
export function subscribeDraftAppends(listener: DraftAppendListener): () => void {
  appendListeners.add(listener);
  return () => {
    appendListeners.delete(listener);
  };
}
