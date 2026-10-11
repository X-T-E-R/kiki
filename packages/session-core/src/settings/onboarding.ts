/** First-run completion flag, scoped to the active space. */
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
