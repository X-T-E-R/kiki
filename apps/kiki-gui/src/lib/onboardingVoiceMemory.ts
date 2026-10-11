import { LocalizedError, translate, type Locale } from '@kiki/session-core/i18n';
import { readOnboardingState, rememberOnboardingReplyPreference } from '@kiki/session-core/settings';

import type { KikiClient, MemoryEntry, MemoryListQuery } from './client';

export type OnboardingVoice = 'concise' | 'detailed';
type MemoryClient = Pick<KikiClient, 'listMemory' | 'getMemory' | 'putMemory'>;
const TARGET = { scope: 'global' } as const;
const LOCALES = ['en', 'zh'] as const;
const VOICES = ['concise', 'detailed'] as const;
// One title across locales also lets the store's existing duplicate-title guard
// prevent simultaneous first choices from creating conflicting active entries.
const TITLE = 'Reply style · 说话方式';

function isSetupMemory(entry: MemoryEntry): boolean {
  return entry.type === 'user' && entry.status === 'active' && entry.source.writer === 'user' && LOCALES.some((locale) =>
    entry.reason === translate(locale, 'onboarding.agreement.voice.reason') && (
      entry.title === TITLE || VOICES.some((voice) => entry.title === translate(locale, `onboarding.agreement.voice.${voice}.title`)
        && entry.body === translate(locale, `onboarding.agreement.voice.${voice}.body`))
    ));
}

export function onboardingVoiceFromMemory(entry: MemoryEntry | null): OnboardingVoice | null {
  return VOICES.find((voice) => LOCALES.some((locale) => entry?.body === translate(locale, `onboarding.agreement.voice.${voice}.body`))) ?? null;
}

export async function readOnboardingVoiceMemory(client: MemoryClient, connectionUrl: string): Promise<MemoryEntry | null> {
  const pointer = readOnboardingState().replyPreference;
  if (pointer?.connectionUrl === connectionUrl) {
    const entry = await client.getMemory(TARGET, pointer.memoryId);
    // A saved pointer identifies this user's topic even after its text was edited
    // in Settings. Never reactivate an archived entry or replace another type.
    if (entry.type !== 'user' || entry.status !== 'active') throw new LocalizedError({ key: 'onboarding.agreement.voice.inactive' });
    return entry;
  }
  const found = new Map<string, MemoryEntry>();
  const cursors = new Set<string>();
  let query: MemoryListQuery = { mode: 'list', type: 'user', statuses: ['active'], page_size: 20 };
  const signal = AbortSignal.timeout(10_000);
  // Active memory capacity is 300. A finite extra allowance permits empty
  // preparation pages; incomplete, cycling or oversized scans never create.
  for (let pageIndex = 0; pageIndex < 32; pageIndex += 1) {
    const page = await client.listMemory(TARGET, query, signal);
    if (page.coverage?.complete !== true) throw new LocalizedError({ key: 'onboarding.agreement.voice.readFailed' });
    for (const entry of page.items) if (isSetupMemory(entry)) found.set(entry.id, entry);
    if (page.next_cursor == null && page.coverage.exhausted) {
      if (found.size > 1) throw new LocalizedError({ key: 'onboarding.agreement.voice.ambiguous' });
      const candidate = found.values().next().value as MemoryEntry | undefined;
      if (candidate === undefined) return null;
      const entry = await client.getMemory(TARGET, candidate.id);
      if (!isSetupMemory(entry)) throw new LocalizedError({ key: 'memory.conflict' });
      rememberOnboardingReplyPreference(connectionUrl, entry.id);
      return entry;
    }
    if (page.next_cursor == null || cursors.has(page.next_cursor)) break;
    cursors.add(page.next_cursor);
    query = { cursor: page.next_cursor };
  }
  throw new LocalizedError({ key: 'onboarding.agreement.voice.readFailed' });
}

export async function saveOnboardingVoiceMemory(client: MemoryClient, connectionUrl: string, locale: Locale, voice: OnboardingVoice): Promise<MemoryEntry> {
  const current = await readOnboardingVoiceMemory(client, connectionUrl);
  const result = await client.putMemory(TARGET, current?.id ?? 'new', {
    type: 'user', title: current?.title ?? TITLE,
    body: translate(locale, `onboarding.agreement.voice.${voice}.body`),
    reason: translate(locale, 'onboarding.agreement.voice.reason'),
    action: current === null ? undefined : 'update', expected_revision: current?.revision,
  });
  rememberOnboardingReplyPreference(connectionUrl, result.entry.id);
  return result.entry;
}
