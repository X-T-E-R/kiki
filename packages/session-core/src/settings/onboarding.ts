/**
 * First-run onboarding completion flag, persisted to `localStorage` under one
 * `kiki.onboarding` key — the same convention as `kiki.layout`
 * (`layoutPrefs.ts`) and `kiki.settings` (`settings.ts`). Skipping the wizard
 * counts as completing it: either way the flag lands and the auto-popup never
 * fires again. Manual re-entry (settings → about) does not clear the flag.
 *
 * Nothing subscribes to this value mid-run — the App-level trigger reads it
 * once the auth/models probes answer, and the wizard writes it on exit — so
 * unlike layoutPrefs this module carries no pub/sub.
 */

export interface OnboardingState {
  /** ISO-8601 completion time; `undefined` while onboarding has never finished. */
  readonly completedAt: string | undefined;
}

const STORAGE_KEY = 'kiki.onboarding';

export function readOnboardingState(): OnboardingState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { completedAt: undefined };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { completedAt: undefined };
    }
    const completedAt = (parsed as Record<string, unknown>)['completedAt'];
    return {
      completedAt: typeof completedAt === 'string' && completedAt !== '' ? completedAt : undefined,
    };
  } catch {
    return { completedAt: undefined };
  }
}

export function isOnboardingCompleted(): boolean {
  return readOnboardingState().completedAt !== undefined;
}

export function markOnboardingCompleted(): OnboardingState {
  const next: OnboardingState = { completedAt: new Date().toISOString() };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage is a convenience; the in-memory close path still stands.
  }
  return next;
}
