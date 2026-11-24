/** Per-session composer drafts: in-memory for this app run, optionally mirrored to `kiki.drafts`. */

import type { DeferredAppendTiming, ModelSwitchMode, PermissionMode, PromptPlanGate, PromptSkillActivation } from '@kiki/protocol';

import { parseExecutionChoice, type ExecutionChoice } from './executionSelection';
import {
  MAX_ATTACHMENTS,
  MAX_TOTAL_IMAGE_BYTES,
  revokeAttachmentPreviewUrls,
  type ComposerAttachment,
  type ImageAttachment,
} from './attachments';
import type { SelectionAnnotation, SelectionQuote } from './selectionQuote';
import { readSettings, settingsSnapshot } from '../settings/settings';
import { spaceStorage, spaceStorageKey, type SpaceStorage } from '../storage/spaceStorage';

const KEY = 'kiki.drafts';
const PERSISTED_COMPOSER_STATE_KEY = 'kiki.composerStates';
const PERSISTED_NEW_SESSION_DRAFT_KEY = 'kiki.newSessionDraft';

const memoryByScope = new Map<string, Map<string, string>>();
const hydratedScopes = new Set<string>();
interface PendingDraftBatch {
  readonly storage: SpaceStorage;
  readonly drafts: Map<string, string>;
}
const pending = new Map<string, PendingDraftBatch>();
const DRAFT_WRITE_DELAY_MS = 400;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let unloadListenersInstalled = false;

function activeDraftScope(): string {
  return spaceStorageKey(KEY);
}

function draftMemoryForScope(scope: string = activeDraftScope()): Map<string, string> {
  let scoped = memoryByScope.get(scope);
  if (scoped === undefined) {
    scoped = new Map<string, string>();
    memoryByScope.set(scope, scoped);
  }
  return scoped;
}

function draftsEnabledForTyping(): boolean {
  return typeof localStorage !== 'undefined' && settingsSnapshot().draftPersistence;
}

function draftsEnabled(): boolean {
  return typeof localStorage !== 'undefined' && readSettings().draftPersistence;
}

function readAllStored(storage: SpaceStorage = spaceStorage): Record<string, string> {
  try {
    const raw = storage.getItem(KEY);
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

function cancelDraftWriteForScope(scope: string): void {
  pending.delete(scope);
  if (pending.size === 0 && writeTimer !== undefined) {
    clearTimeout(writeTimer);
    writeTimer = undefined;
  }
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
  // Each batch retains the space handle captured when its first edit arrived;
  // switching spaces before this flush must not redirect that write.
  const batches = [...pending.values()];
  pending.clear();
  for (const batch of batches) {
    const all = readAllStored(batch.storage);
    for (const [sessionId, text] of batch.drafts) {
      if (text === '') delete all[sessionId];
      else all[sessionId] = text;
    }
    try {
      if (Object.keys(all).length === 0) batch.storage.removeItem(KEY);
      else batch.storage.setItem(KEY, JSON.stringify(all));
    } catch {
      // storage full / unavailable — drafts are a convenience, not a guarantee
    }
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

function hydrateFromDiskIfNeeded(scope: string = activeDraftScope()): Map<string, string> {
  const scoped = draftMemoryForScope(scope);
  if (hydratedScopes.has(scope)) return scoped;
  hydratedScopes.add(scope);
  if (!draftsEnabled()) return scoped;
  for (const [sessionId, text] of Object.entries(readAllStored())) {
    if (typeof text === 'string' && text !== '') scoped.set(sessionId, text);
  }
  return scoped;
}

export function readDraft(sessionId: string): string {
  return hydrateFromDiskIfNeeded().get(sessionId) ?? '';
}

export function writeDraft(sessionId: string, text: string): void {
  const scope = activeDraftScope();
  const scoped = hydrateFromDiskIfNeeded(scope);
  if (text === '') scoped.delete(sessionId);
  else scoped.set(sessionId, text);
  if (!draftsEnabledForTyping()) {
    cancelDraftWrite();
    return;
  }
  const batch = pending.get(scope) ?? {
    storage: spaceStorage.capture(),
    drafts: new Map<string, string>(),
  };
  batch.drafts.set(sessionId, text);
  pending.set(scope, batch);
  scheduleDraftWrite();
}

/** Drop the on-disk store for the active space. In-memory drafts for this app run stay put. */
export function clearStoredDrafts(): void {
  cancelDraftWriteForScope(activeDraftScope());
  try {
    spaceStorage.removeItem(KEY);
    spaceStorage.removeItem(PERSISTED_COMPOSER_STATE_KEY);
    spaceStorage.removeItem(PERSISTED_NEW_SESSION_DRAFT_KEY);
  } catch {
    // ignore
  }
}

/** Test-only: forget this-process memory as if the module were freshly imported. */
export function resetDraftMemoryForTests(): void {
  cancelDraftWrite();
  memoryByScope.clear();
  hydratedScopes.clear();
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
  quotes?: readonly SelectionQuote[];
  quote?: string | null;
  quoteSource?: SelectionAnnotation['source'];
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
  goalObjective: string | undefined;
  modelOverride: string | undefined;
  effortOverride: string | undefined;
  modelChoice?: ComposerModelChoice;
  effortChoice?: ComposerModelChoice;
  modelSwitchMode?: ModelSwitchMode;
  /**
   * Engine (and optional profile of it) the user picked for this session.
   * `undefined` = never picked: the session's own committed binding stands.
   * It rides every prompt of the session until the pick is dropped, and is
   * never mirrored to disk with the model scalars.
   */
  execution?: ExecutionChoice;
}

/** The committed binding visible when the user last chose this control, not the chosen override value. */
export interface ComposerModelChoice {
  readonly model?: string;
  readonly thinking?: string;
}

export interface PersistedComposerScalars {
  readonly modelOverride?: string;
  readonly effortOverride?: string;
  readonly modelChoice?: ComposerModelChoice;
  readonly effortChoice?: ComposerModelChoice;
  readonly modelSwitchMode?: ModelSwitchMode;
}

/** A locally accepted binding change; this refresh allowance is never persisted with draft choices. */
export interface ComposerModelBindingChange {
  readonly previous: ComposerModelChoice;
  readonly next: ComposerModelChoice;
}

function sameComposerModelBinding(left: ComposerModelChoice | undefined, right: ComposerModelChoice): boolean {
  return left !== undefined && left.model === right.model && left.thinking === right.thinking;
}

/** Restore choices for their original binding, or carry newer picks across an explicitly accepted local change. */
export function resolveComposerModelOverrides(input: PersistedComposerScalars & {
  readonly conversationStarted: boolean;
  readonly pendingBinding: boolean;
  readonly binding: ComposerModelChoice;
  readonly acceptedBindingChange?: ComposerModelBindingChange;
}): PersistedComposerScalars {
  const resolveChoice = (choice: ComposerModelChoice | undefined) => {
    const change = input.acceptedBindingChange;
    if (!input.pendingBinding && change !== undefined && sameComposerModelBinding(choice, change.previous)
      && sameComposerModelBinding(input.binding, change.next)) return input.binding;
    return choice;
  };
  const modelChoice = resolveChoice(input.modelChoice);
  const effortChoice = resolveChoice(input.effortChoice);
  const keep = (choice: ComposerModelChoice | undefined) => !input.conversationStarted || input.pendingBinding
    || (input.modelSwitchMode !== undefined && input.modelOverride !== undefined && input.modelChoice !== undefined)
    || sameComposerModelBinding(choice, input.binding);
  return {
    modelOverride: keep(modelChoice) ? input.modelOverride : undefined,
    effortOverride: keep(effortChoice) ? input.effortOverride : undefined,
    modelChoice: keep(modelChoice) ? modelChoice : undefined,
    effortChoice: keep(effortChoice) ? effortChoice : undefined,
    modelSwitchMode: keep(modelChoice) && input.modelOverride !== undefined ? input.modelSwitchMode : undefined,
  };
}

function readModelChoice(value: unknown): ComposerModelChoice | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const model = record['model'];
  const thinking = record['thinking'];
  if (model !== undefined && typeof model !== 'string' || thinking !== undefined && typeof thinking !== 'string') return undefined;
  return { model, thinking };
}

export interface PersistedNewSessionDraft {
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly profile?: string;
  readonly execution?: ExecutionChoice;
  readonly modelOverride?: string;
  readonly effortOverride?: string;
  readonly modelFromProfile?: boolean;
  readonly effortFromProfile?: boolean;
  readonly prefillSource?: string;
  readonly dismissedPersonaSource?: string;
}

const composerMemoryByScope = new Map<string, Map<string, ComposerSessionState>>();

function composerMemoryForScope(scope: string = activeDraftScope()): Map<string, ComposerSessionState> {
  let scoped = composerMemoryByScope.get(scope);
  if (scoped === undefined) {
    scoped = new Map<string, ComposerSessionState>();
    composerMemoryByScope.set(scope, scoped);
  }
  return scoped;
}

function readAllStoredComposerScalars(): Record<string, PersistedComposerScalars> {
  try {
    const raw = spaceStorage.getItem(PERSISTED_COMPOSER_STATE_KEY);
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
        const modelChoice = readModelChoice(record['modelChoice']);
        const effortChoice = readModelChoice(record['effortChoice']);
        const mode = record['modelSwitchMode'];
        const modelSwitchMode = modelOverride !== undefined && (mode === 'direct' || mode === 'compact' || mode === 'fresh') ? mode : undefined;
        Object.defineProperty(result, sessionId, { value: { modelOverride, effortOverride, modelChoice, effortChoice, modelSwitchMode }, enumerable: true, configurable: true, writable: true });
      }
    }
    return result;
  } catch {
    return {};
  }
}

function samePersistedModelChoice(
  left: ComposerModelChoice | undefined,
  right: ComposerModelChoice | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return left.model === right.model && left.thinking === right.thinking;
}

function samePersistedComposerScalars(
  left: PersistedComposerScalars,
  right: PersistedComposerScalars,
): boolean {
  return (
    left.modelOverride === right.modelOverride &&
    left.effortOverride === right.effortOverride &&
    left.modelSwitchMode === right.modelSwitchMode &&
    samePersistedModelChoice(left.modelChoice, right.modelChoice) &&
    samePersistedModelChoice(left.effortChoice, right.effortChoice)
  );
}

function persistComposerScalars(
  sessionId: string,
  scalars: PersistedComposerScalars,
): void {
  if (!draftsEnabled()) return;
  const empty = scalars.modelOverride === undefined && scalars.effortOverride === undefined;
  if (empty) {
    try {
      if (spaceStorage.getItem(PERSISTED_COMPOSER_STATE_KEY) === null) return;
    } catch {
      return;
    }
  }
  const all = readAllStoredComposerScalars();
  if (empty) {
    if (!(sessionId in all)) return;
    delete all[sessionId];
  } else {
    all[sessionId] = scalars;
  }
  try {
    if (Object.keys(all).length === 0) {
      spaceStorage.removeItem(PERSISTED_COMPOSER_STATE_KEY);
    } else {
      spaceStorage.setItem(PERSISTED_COMPOSER_STATE_KEY, JSON.stringify(all));
    }
  } catch {
    // storage full / unavailable
  }
}

export function readNewSessionDraft(): PersistedNewSessionDraft {
  if (!draftsEnabled()) return {};
  try {
    const raw = spaceStorage.getItem(PERSISTED_NEW_SESSION_DRAFT_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    return {
      workspaceId: typeof record['workspaceId'] === 'string' ? record['workspaceId'] : undefined,
      cwd: typeof record['cwd'] === 'string' ? record['cwd'] : undefined,
      profile: typeof record['profile'] === 'string' ? record['profile'] : undefined,
      execution: parseExecutionChoice(record['execution']),
      modelOverride: typeof record['modelOverride'] === 'string' ? record['modelOverride'] : undefined,
      effortOverride: typeof record['effortOverride'] === 'string' ? record['effortOverride'] : undefined,
      modelFromProfile: typeof record['modelFromProfile'] === 'boolean' ? record['modelFromProfile'] : undefined,
      effortFromProfile: typeof record['effortFromProfile'] === 'boolean' ? record['effortFromProfile'] : undefined,
      prefillSource: typeof record['prefillSource'] === 'string' ? record['prefillSource'] : undefined,
      dismissedPersonaSource: typeof record['dismissedPersonaSource'] === 'string' ? record['dismissedPersonaSource'] : undefined,
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
      draft.execution !== undefined ||
      (draft.profile !== undefined && draft.profile !== '') ||
      (draft.modelOverride !== undefined && draft.modelOverride !== '') ||
      (draft.effortOverride !== undefined && draft.effortOverride !== '');
    if (!hasValues) {
      spaceStorage.removeItem(PERSISTED_NEW_SESSION_DRAFT_KEY);
    } else {
      spaceStorage.setItem(PERSISTED_NEW_SESSION_DRAFT_KEY, JSON.stringify({
        workspaceId: draft.workspaceId,
        cwd: draft.cwd,
        profile: draft.profile,
        execution: draft.execution,
        modelOverride: draft.modelOverride,
        effortOverride: draft.effortOverride,
        modelFromProfile: draft.modelFromProfile,
        effortFromProfile: draft.effortFromProfile,
        prefillSource: draft.prefillSource,
        dismissedPersonaSource: draft.dismissedPersonaSource,
      }));
    }
  } catch {
    // storage unavailable
  }
}

export function clearNewSessionDraft(): void {
  try {
    spaceStorage.removeItem(PERSISTED_NEW_SESSION_DRAFT_KEY);
  } catch {
    // ignore
  }
}

/** Restored composer chrome for a session; `{}` when none was captured yet. */
export function readComposerState(
  sessionId: string,
): Partial<ComposerSessionState> {
  const inMemory = composerMemoryForScope().get(sessionId);
  if (inMemory !== undefined) return inMemory;
  if (!draftsEnabled()) return {};
  const stored = readAllStoredComposerScalars()[sessionId];
  if (typeof stored !== 'object' || stored === null) return {};
  return {
    modelOverride: typeof stored.modelOverride === 'string' ? stored.modelOverride : undefined,
    effortOverride: typeof stored.effortOverride === 'string' ? stored.effortOverride : undefined,
    modelChoice: stored.modelChoice,
    effortChoice: stored.effortChoice,
    modelSwitchMode: stored.modelSwitchMode,
  };
}

export function writeComposerState(sessionId: string, state: ComposerSessionState): void {
  const scoped = composerMemoryForScope();
  const previous = scoped.get(sessionId);
  scoped.set(sessionId, state);
  const nextScalars: PersistedComposerScalars = {
    modelOverride: state.modelOverride,
    effortOverride: state.effortOverride,
    modelChoice: state.modelChoice,
    effortChoice: state.effortChoice,
    modelSwitchMode: state.modelSwitchMode,
  };
  if (previous !== undefined && samePersistedComposerScalars(previous, nextScalars)) {
    return;
  }
  persistComposerScalars(sessionId, nextScalars);
}

export function clearComposerState(sessionId: string): void {
  const scopedComposer = composerMemoryForScope();
  revokeAttachmentPreviewUrls(scopedComposer.get(sessionId)?.attachments);
  scopedComposer.delete(sessionId);
  pendingSubmissionMemoryForScope().delete(sessionId);
  if (draftsEnabled()) {
    persistComposerScalars(sessionId, {});
  }
}

/** Test-only: forget every session's captured composer chrome. */
export function resetComposerMemoryForTests(): void {
  for (const scoped of composerMemoryByScope.values()) {
    for (const state of scoped.values()) revokeAttachmentPreviewUrls(state.attachments);
  }
  composerMemoryByScope.clear();
  pendingSubmissionMemoryByScope.clear();
}

export interface PendingComposerSubmission {
  readonly scope: string;
  readonly connectionScopeId: string;
  readonly payload: string;
  readonly key: string;
  readonly draftText: string;
  readonly afterModelSwitch?: string;
  readonly appendTiming?: DeferredAppendTiming;
  readonly skills?: readonly PromptSkillActivation[];
  readonly inFlightGeneration?: number;
  readonly inFlightPromise?: Promise<unknown>;
  readonly retryInvalidated?: boolean;
}

const pendingSubmissionMemoryByScope = new Map<string, Map<string, PendingComposerSubmission>>();
let nextPendingSubmissionGeneration = 0;

function pendingSubmissionMemoryForScope(
  scope: string = activeDraftScope(),
): Map<string, PendingComposerSubmission> {
  let scoped = pendingSubmissionMemoryByScope.get(scope);
  if (scoped === undefined) {
    scoped = new Map<string, PendingComposerSubmission>();
    pendingSubmissionMemoryByScope.set(scope, scoped);
  }
  return scoped;
}

type PendingSubmissionListener = (sessionId: string) => void;
const pendingSubmissionListeners = new Set<PendingSubmissionListener>();

function notifyPendingSubmission(sessionId: string): void {
  for (const listener of pendingSubmissionListeners) listener(sessionId);
}

export function subscribePendingSubmissions(listener: PendingSubmissionListener): () => void {
  pendingSubmissionListeners.add(listener);
  return () => {
    pendingSubmissionListeners.delete(listener);
  };
}

export function readPendingSubmission(sessionId: string): PendingComposerSubmission | undefined {
  return pendingSubmissionMemoryForScope().get(sessionId);
}

export function isPendingSubmissionInFlight(sessionId: string, scope?: string): boolean {
  const current = pendingSubmissionMemoryForScope().get(sessionId);
  if (current?.inFlightGeneration === undefined) return false;
  return scope === undefined || current.scope === scope;
}

export function beginPendingSubmissionFlight(
  sessionId: string,
  submission: Omit<PendingComposerSubmission, 'inFlightGeneration' | 'inFlightPromise' | 'retryInvalidated'>,
  inFlightPromise?: Promise<unknown>,
): { readonly submission: PendingComposerSubmission; readonly generation: number } {
  nextPendingSubmissionGeneration += 1;
  const generation = nextPendingSubmissionGeneration;
  const next: PendingComposerSubmission = {
    ...submission,
    inFlightGeneration: generation,
    inFlightPromise,
  };
  pendingSubmissionMemoryForScope().set(sessionId, next);
  notifyPendingSubmission(sessionId);
  return { submission: next, generation };
}

export function finishPendingSubmissionFlight(sessionId: string, generation: number): void {
  const activeScope = activeDraftScope();
  let ownerScope: string | undefined;
  let ownerMap: Map<string, PendingComposerSubmission> | undefined;
  let current: PendingComposerSubmission | undefined;
  const activeMap = pendingSubmissionMemoryByScope.get(activeScope);
  const activeCandidate = activeMap?.get(sessionId);
  if (activeCandidate?.inFlightGeneration === generation) {
    ownerScope = activeScope;
    ownerMap = activeMap;
    current = activeCandidate;
  } else {
    for (const [scope, scoped] of pendingSubmissionMemoryByScope) {
      const candidate = scoped.get(sessionId);
      if (candidate?.inFlightGeneration === generation) {
        ownerScope = scope;
        ownerMap = scoped;
        current = candidate;
        break;
      }
    }
  }
  if (current === undefined || ownerMap === undefined || ownerScope === undefined) return;
  const currentDraft = ownerScope === activeScope
    ? readDraft(sessionId)
    : (memoryByScope.get(ownerScope)?.get(sessionId) ?? '');
  if (current.retryInvalidated === true || currentDraft !== current.draftText) {
    ownerMap.delete(sessionId);
  } else {
    ownerMap.set(sessionId, {
      scope: current.scope,
      connectionScopeId: current.connectionScopeId,
      payload: current.payload,
      key: current.key,
      draftText: current.draftText,
      afterModelSwitch: current.afterModelSwitch,
      appendTiming: current.appendTiming,
      skills: current.skills,
    });
  }
  notifyPendingSubmission(sessionId);
}

export function invalidatePendingSubmissionRetry(sessionId: string): void {
  const scoped = pendingSubmissionMemoryForScope();
  const current = scoped.get(sessionId);
  if (current === undefined) return;
  if (current.inFlightGeneration === undefined) {
    scoped.delete(sessionId);
    notifyPendingSubmission(sessionId);
    return;
  }
  if (current.retryInvalidated === true) return;
  scoped.set(sessionId, { ...current, retryInvalidated: true });
}

export function writePendingSubmission(sessionId: string, submission: PendingComposerSubmission | undefined): void {
  const scoped = pendingSubmissionMemoryForScope();
  if (submission === undefined) {
    if (scoped.delete(sessionId)) notifyPendingSubmission(sessionId);
    return;
  }
  scoped.set(sessionId, submission);
  notifyPendingSubmission(sessionId);
}

export function clearPendingSubmissionsForConnection(connectionScopeId: string): void {
  const cleared: string[] = [];
  for (const scoped of pendingSubmissionMemoryByScope.values()) {
    for (const [key, entry] of scoped) {
      if (entry.connectionScopeId === connectionScopeId) {
        scoped.delete(key);
        cleared.push(key);
      }
    }
  }
  for (const key of cleared) notifyPendingSubmission(key);
}

export function settlePendingSubmission(
  sessionId: string,
  submissionKey: string,
  sentAnnotationIds?: ReadonlySet<string>,
): boolean {
  const scoped = pendingSubmissionMemoryForScope();
  const current = scoped.get(sessionId);
  if (current === undefined || current.key !== submissionKey) return false;
  if (current.retryInvalidated === true || readDraft(sessionId) !== current.draftText) {
    scoped.delete(sessionId);
    notifyPendingSubmission(sessionId);
    return false;
  }
  scoped.delete(sessionId);
  notifyPendingSubmission(sessionId);
  writeDraft(sessionId, '');
  const chrome = readComposerState(sessionId);
  revokeAttachmentPreviewUrls(chrome.attachments);
  const nextAnnotations = sentAnnotationIds !== undefined && sentAnnotationIds.size > 0
    ? (chrome.annotations ?? []).filter((item) => !sentAnnotationIds.has(item.id))
    : (chrome.annotations ?? []);
  writeComposerState(sessionId, {
    ...chrome,
    attachments: [],
    quotes: [],
    annotations: nextAnnotations,
    permissionMode: chrome.permissionMode,
    planMode: chrome.planMode,
    planGate: chrome.planGate,
    goalObjective: chrome.goalObjective,
    modelOverride: chrome.modelOverride,
    effortOverride: chrome.effortOverride,
  });
  for (const listener of appendListeners) listener(sessionId, []);
  return true;
}

// ---- per-session input history (memory-only) ----

/**
 * Sent prompts, newest last, for the composer's ArrowUp/ArrowDown recall.
 * Mirrors the chrome map's scope rules: memory-only (a restart starts every
 * composer fresh), per session (the /new draft keys on its workspace), and
 * capped like opencode's history store.
 */
export const INPUT_HISTORY_LIMIT = 50;

const historyMemoryByScope = new Map<string, Map<string, string[]>>();

function historyMemoryForScope(scope: string = activeDraftScope()): Map<string, string[]> {
  let scoped = historyMemoryByScope.get(scope);
  if (scoped === undefined) {
    scoped = new Map<string, string[]>();
    historyMemoryByScope.set(scope, scoped);
  }
  return scoped;
}

/**
 * Record a submitted prompt. Empty text is ignored; repeating the last entry
 * is a no-op (shell-style consecutive dedupe), and the oldest entries fall
 * off past INPUT_HISTORY_LIMIT.
 */
export function pushInputHistory(key: string, text: string): void {
  const trimmed = text.trim();
  if (trimmed === '') return;
  const scoped = historyMemoryForScope();
  const list = scoped.get(key) ?? [];
  if (list.at(-1) !== trimmed) list.push(trimmed);
  while (list.length > INPUT_HISTORY_LIMIT) list.shift();
  scoped.set(key, list);
}

/** Newest-last recall order; the composer walks it backwards from the end. */
export function readInputHistory(key: string): readonly string[] {
  return historyMemoryForScope().get(key) ?? [];
}

/** Test-only: forget every recorded prompt. */
export function resetInputHistoryForTests(): void {
  historyMemoryByScope.clear();
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
const AGENT_ROUTE_RE = /^\/(?:p\/[^/]+\/)?s\/([^/]+)\/agent\/([^/]+)/;

/**
 * Canonical draft/composer storage key for one conversation target:
 * main sessions key on `sessionId`; branches and subagents always key on
 * `JSON.stringify([scopeId ?? '', sessionId, agentId])`, even when `scopeId` is
 * empty/absent, so child drafts and annotations never collide with `main`.
 */
export function agentDraftKey(
  scopeId: string | undefined,
  sessionId: string,
  agentId?: string,
): string {
  if (agentId === undefined || agentId === '' || agentId === 'main') {
    return sessionId;
  }
  return JSON.stringify([scopeId ?? '', sessionId, agentId]);
}

/**
 * Resolve the draft/composer storage key for the currently viewed conversation:
 * main sessions key on `sessionId`; routed branches and subagents key via
 * `agentDraftKey` (matching `AgentWorkspace`).
 */
export function resolveActiveDraftKey(
  scopeId: string | undefined,
  sessionId: string | undefined,
  agentIdOrPathname?: string,
): string | undefined {
  if (sessionId === undefined || sessionId === '') return undefined;
  let agentId: string | undefined;
  if (agentIdOrPathname !== undefined && agentIdOrPathname !== '') {
    if (agentIdOrPathname.startsWith('/')) {
      const match = AGENT_ROUTE_RE.exec(agentIdOrPathname);
      if (match !== null) {
        try {
          const routeSession = decodeURIComponent(match[1]!);
          const routeAgent = decodeURIComponent(match[2]!);
          if (routeSession === sessionId && routeAgent !== '' && routeAgent !== 'main') {
            agentId = routeAgent;
          }
        } catch {
          // ignore malformed URI encoding
        }
      }
    } else if (agentIdOrPathname !== 'main') {
      agentId = agentIdOrPathname;
    }
  }
  return agentDraftKey(scopeId, sessionId, agentId);
}

/**
 * Append a programmatic attachment (e.g. an annotated image from MediaLightbox)
 * into a conversation's composer state and notify mounted subscribers (`SessionView`
 * and `AgentWorkspace`). Enforces the shared attachment count and image byte caps.
 */
export function appendAttachmentToDraft(
  draftKey: string,
  attachment: ComposerAttachment,
): { readonly added: boolean; readonly reason?: 'too_many' | 'total_too_large' } {
  invalidatePendingSubmissionRetry(draftKey);
  const previous = readComposerState(draftKey);
  const current = previous.attachments ?? [];
  if (current.length >= MAX_ATTACHMENTS) {
    return { added: false, reason: 'too_many' };
  }
  if (attachment.kind === 'image') {
    const used = current
      .filter((item): item is ImageAttachment => item.kind === 'image')
      .reduce((sum, item) => sum + item.size, 0);
    if (used + attachment.size > MAX_TOTAL_IMAGE_BYTES) {
      return { added: false, reason: 'total_too_large' };
    }
  }
  const nextAttachments = [...current, attachment];
  writeComposerState(draftKey, {
    attachments: nextAttachments,
    annotations: previous.annotations ?? [],
    quotes: previous.quotes,
    quote: previous.quote,
    quoteSource: previous.quoteSource,
    permissionMode: previous.permissionMode,
    planMode: previous.planMode,
    planGate: previous.planGate,
    goalObjective: previous.goalObjective,
    modelOverride: previous.modelOverride,
    effortOverride: previous.effortOverride,
    modelChoice: previous.modelChoice,
    effortChoice: previous.effortChoice,
    modelSwitchMode: previous.modelSwitchMode,
    execution: previous.execution,
  });
  for (const listener of appendListeners) listener(draftKey, [attachment]);
  return { added: true };
}

export function appendToDraft(sessionId: string, text: string): void {
  if (text === '') return;
  invalidatePendingSubmissionRetry(sessionId);
  const current = readDraft(sessionId);
  const separator = current !== '' && !/[\s]$/.test(current) ? ' ' : '';
  writeDraft(sessionId, `${current}${separator}${text}`);
  for (const listener of appendListeners) listener(sessionId);
}

export function recoverSubmittedDraft(key: string, text: string, attachments: readonly ComposerAttachment[]): boolean {
  const current = readComposerState(key);
  if (readDraft(key) !== '' || (current.attachments?.length ?? 0) !== 0) return false;
  writeDraft(key, text);
  writeComposerState(key, {
    ...current, attachments, annotations: current.annotations ?? [],
    permissionMode: current.permissionMode, planMode: current.planMode,
    planGate: current.planGate, goalObjective: current.goalObjective,
    modelOverride: current.modelOverride, effortOverride: current.effortOverride,
  });
  for (const listener of appendListeners) listener(key, attachments);
  return true;
}

export function restorePromptToDraft(sessionId: string, content: readonly import('@kiki/protocol').MessageContent[]): void {
  invalidatePendingSubmissionRetry(sessionId);
  const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n\n');
  const restored: ComposerAttachment[] = content.flatMap((part): ComposerAttachment[] => {
    if (part.type !== 'image' && part.type !== 'video' && part.type !== 'audio' && part.type !== 'file') return [];
    return [{ kind: 'retained', name: part.name ?? (part.type === 'file' ? part.file_id : part.type), content: part }];
  });
  const current = readDraft(sessionId);
  writeDraft(sessionId, current === '' ? text : text === '' ? current : `${current}\n\n${text}`);
  const previous = readComposerState(sessionId);
  writeComposerState(sessionId, {
    attachments: [...(previous.attachments ?? []), ...restored],
    annotations: previous.annotations ?? [],
    quotes: previous.quotes,
    quote: previous.quote,
    quoteSource: previous.quoteSource,
    permissionMode: previous.permissionMode,
    planMode: previous.planMode,
    planGate: previous.planGate,
    goalObjective: previous.goalObjective,
    modelOverride: previous.modelOverride,
    effortOverride: previous.effortOverride,
    modelChoice: previous.modelChoice,
    effortChoice: previous.effortChoice,
    modelSwitchMode: previous.modelSwitchMode,
    execution: previous.execution,
  });
  for (const listener of appendListeners) listener(sessionId, restored);
}

type DraftAppendListener = (sessionId: string, attachments?: readonly ComposerAttachment[]) => void;

const appendListeners = new Set<DraftAppendListener>();

/** Subscribe to `appendToDraft` writes; returns the unsubscribe. */
export function subscribeDraftAppends(listener: DraftAppendListener): () => void {
  appendListeners.add(listener);
  return () => {
    appendListeners.delete(listener);
  };
}
