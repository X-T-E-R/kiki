/**
 * First-run flags.
 *
 * `kiki.onboarding` is the completion mark the old first-run wizard wrote,
 * scoped to the active space. The app no longer writes it; it is only read, so
 * someone who walked that wizard is not offered the tour line again.
 *
 * `kiki.firstRun` records the one-time hints the app now gives at the moment of
 * use (the tour line under the starters, the question about system
 * notifications). Each is offered at most once per device, whichever space is
 * open, so the key is application-level and stays outside the space namespace.
 */
import { spaceStorage } from '../storage/spaceStorage';

export interface OnboardingState {
  readonly completedAt: string | undefined;
}

const STORAGE_KEY = 'kiki.onboarding';

export function readOnboardingState(): OnboardingState {
  try {
    const raw = spaceStorage.getItem(STORAGE_KEY);
    if (raw === null) return { completedAt: undefined };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { completedAt: undefined };
    const completedAt = (parsed as Record<string, unknown>)['completedAt'];
    return { completedAt: typeof completedAt === 'string' && completedAt !== '' ? completedAt : undefined };
  } catch {
    return { completedAt: undefined };
  }
}

export function isOnboardingCompleted(): boolean {
  return readOnboardingState().completedAt !== undefined;
}

export function markOnboardingCompleted(): OnboardingState {
  const next = { completedAt: new Date().toISOString() };
  try { spaceStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {
    // Storage can be unavailable; first-run completion must not block setup.
  }
  return next;
}

/**
 * A hint the app gives once per device, at the moment it applies, and one
 * answer to it: `notifyDeclined` is the person saying no to system
 * notifications here, which Settings can take back.
 */
export type FirstRunHint = 'tourLine' | 'notifyAsk' | 'notifyDeclined';

const HINTS_KEY = 'kiki.firstRun';

function readHints(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(HINTS_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Whether this device has already had the hint: shown and answered, dismissed,
 * or made moot. Someone who finished the old wizard already chose how to start
 * and was offered the tour there, so the tour line counts as dismissed for them.
 */
export function isFirstRunHintDone(hint: FirstRunHint): boolean {
  if (readHints()[hint] === true) return true;
  return hint === 'tourLine' && isOnboardingCompleted();
}

export function markFirstRunHintDone(hint: FirstRunHint): void {
  try {
    localStorage.setItem(HINTS_KEY, JSON.stringify({ ...readHints(), [hint]: true }));
  } catch {
    // Storage can be unavailable; the hint may then come back once more.
  }
}

export function clearFirstRunHint(hint: FirstRunHint): void {
  try {
    const { [hint]: _cleared, ...rest } = readHints();
    localStorage.setItem(HINTS_KEY, JSON.stringify(rest));
  } catch {
    // Storage can be unavailable; nothing to take back then.
  }
}
