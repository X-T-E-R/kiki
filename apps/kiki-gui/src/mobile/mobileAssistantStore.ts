import { useSyncExternalStore } from 'react';

/**
 * The phone view's assistant binding: which persona home chat the Assistant
 * tab opens, per space, plus the most recent one. Device-level and keyed by
 * space inside the value, so it never needs `spaceStorage` prefixing.
 */
export const MOBILE_ASSISTANT_STORAGE_KEY = 'kiki.mobile.assistant.v1';

export interface MobileAssistantBinding {
  readonly spaceKey: string;
  readonly personaId: string;
  readonly sessionId: string;
}

interface MobileAssistantState {
  readonly version: 1;
  readonly current?: MobileAssistantBinding;
  readonly bySpace: Readonly<Record<string, { readonly personaId: string; readonly sessionId: string }>>;
}

const EMPTY_STATE: MobileAssistantState = { version: 1, bySpace: {} };
const listeners = new Set<() => void>();
let cached: { readonly raw: string | null; readonly state: MobileAssistantState } | null = null;
let memoryFallback: MobileAssistantState | null = null;

function isBinding(value: unknown): value is { readonly personaId: string; readonly sessionId: string } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['personaId'] === 'string' && record['personaId'] !== ''
    && typeof record['sessionId'] === 'string' && record['sessionId'] !== '';
}

function parseState(raw: string | null): MobileAssistantState {
  if (raw === null) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed['version'] !== 1) return EMPTY_STATE;
    const bySpace: Record<string, { personaId: string; sessionId: string }> = {};
    const rawBySpace = parsed['bySpace'];
    if (typeof rawBySpace === 'object' && rawBySpace !== null) {
      for (const [spaceKey, entry] of Object.entries(rawBySpace as Record<string, unknown>)) {
        if (isBinding(entry)) bySpace[spaceKey] = { personaId: entry.personaId, sessionId: entry.sessionId };
      }
    }
    const current = parsed['current'];
    const currentSpace = typeof current === 'object' && current !== null ? (current as Record<string, unknown>)['spaceKey'] : undefined;
    const currentBinding =
      isBinding(current) && typeof currentSpace === 'string' && currentSpace !== ''
        ? { spaceKey: currentSpace, personaId: current.personaId, sessionId: current.sessionId }
        : undefined;
    return currentBinding === undefined ? { version: 1, bySpace } : { version: 1, current: currentBinding, bySpace };
  } catch {
    return EMPTY_STATE;
  }
}

function readRaw(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(MOBILE_ASSISTANT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readState(): MobileAssistantState {
  if (memoryFallback !== null) return memoryFallback;
  const raw = readRaw();
  if (cached !== null && cached.raw === raw) return cached.state;
  const state = parseState(raw);
  cached = { raw, state };
  return state;
}

function writeState(state: MobileAssistantState): void {
  const raw = JSON.stringify(state);
  if (typeof localStorage === 'undefined') {
    memoryFallback = state;
  } else {
    try {
      localStorage.setItem(MOBILE_ASSISTANT_STORAGE_KEY, raw);
      memoryFallback = null;
      cached = { raw, state };
    } catch {
      memoryFallback = state;
    }
  }
  for (const listener of listeners) listener();
}

/** The binding for one space, or the most recent binding when no space is given. */
export function readMobileAssistant(spaceKey?: string): MobileAssistantBinding | undefined {
  const state = readState();
  if (spaceKey === undefined) return state.current;
  const entry = state.bySpace[spaceKey];
  return entry === undefined ? undefined : { spaceKey, ...entry };
}

export function writeMobileAssistant(binding: MobileAssistantBinding): void {
  const state = readState();
  writeState({
    version: 1,
    current: binding,
    bySpace: { ...state.bySpace, [binding.spaceKey]: { personaId: binding.personaId, sessionId: binding.sessionId } },
  });
}

/**
 * The space the global scope must move to after the assistant starts in
 * `nextSpaceKey`, or undefined when the current scope already shows it. A
 * concrete scope is what the Assistant tab reads its binding from, so leaving
 * it on another computer would reopen the old chat.
 */
export function assistantScopeTarget(scopeSpaceKey: string | undefined, nextSpaceKey: string): string | undefined {
  return scopeSpaceKey === undefined || scopeSpaceKey === nextSpaceKey ? undefined : nextSpaceKey;
}

export function clearMobileAssistant(spaceKey: string): void {
  const state = readState();
  const { [spaceKey]: _removed, ...rest } = state.bySpace;
  const current = state.current?.spaceKey === spaceKey ? undefined : state.current;
  writeState(current === undefined ? { version: 1, bySpace: rest } : { version: 1, current, bySpace: rest });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === MOBILE_ASSISTANT_STORAGE_KEY) {
      memoryFallback = null;
      listener();
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** Live binding for a space (re-renders on writes from this or another tab). */
export function useMobileAssistant(spaceKey: string | undefined): MobileAssistantBinding | undefined {
  const state = useSyncExternalStore(subscribe, readState, readState);
  if (spaceKey === undefined) return state.current;
  const entry = state.bySpace[spaceKey];
  return entry === undefined ? undefined : { spaceKey, ...entry };
}
