/** First-run completion and the server-backed reply-preference identity, scoped to the active space. */
import { spaceStorage } from '../storage/spaceStorage';

export interface OnboardingState {
  readonly completedAt: string | undefined;
  readonly replyPreference?: { readonly connectionUrl: string; readonly memoryId: string };
}

const STORAGE_KEY = 'kiki.onboarding';

export function readOnboardingState(): OnboardingState {
  try {
    const raw = spaceStorage.getItem(STORAGE_KEY);
    if (raw === null) return { completedAt: undefined };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { completedAt: undefined };
    const record = parsed as Record<string, unknown>;
    const completedAt = record['completedAt'];
    const pointer = record['replyPreference'];
    const fields = typeof pointer === 'object' && pointer !== null && !Array.isArray(pointer) ? pointer as Record<string, unknown> : undefined;
    return {
      completedAt: typeof completedAt === 'string' && completedAt !== '' ? completedAt : undefined,
      replyPreference: typeof fields?.['connectionUrl'] === 'string' && fields['connectionUrl'] !== '' && typeof fields['memoryId'] === 'string' && fields['memoryId'] !== ''
        ? { connectionUrl: fields['connectionUrl'], memoryId: fields['memoryId'] } : undefined,
    };
  } catch {
    return { completedAt: undefined };
  }
}

function writeOnboardingState(next: OnboardingState): OnboardingState {
  try { spaceStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {
    // The memory itself remains authoritative if browser storage is unavailable.
  }
  return next;
}

export function rememberOnboardingReplyPreference(connectionUrl: string, memoryId: string): void {
  writeOnboardingState({ ...readOnboardingState(), replyPreference: { connectionUrl, memoryId } });
}

export function isOnboardingCompleted(): boolean {
  return readOnboardingState().completedAt !== undefined;
}

export function markOnboardingCompleted(): OnboardingState {
  return writeOnboardingState({ ...readOnboardingState(), completedAt: new Date().toISOString() });
}
