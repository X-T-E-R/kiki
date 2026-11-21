import type { PersonaSummary } from '@kiki/protocol';
import type { UnifiedInboxItem } from '@kiki/session-core/sessions';

import { Icon } from '../../components/icons';
import { LifeMark } from '../../components/LifeMark';
import { PersonaAvatar, personaAvatarOf } from '../../components/persona/PersonaAvatar';
import { RelativeTime } from '../../components/RelativeTime';
import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import { NeedsYouCard } from '../components/NeedsYouCard';
import { SpacePill } from '../SpacePill';

interface TodayTabProps {
  readonly spaceLabel: string;
  readonly spaceStatusTone: 'online' | 'attention' | 'offline';
  readonly onlineSpacesCount: number;
  readonly needsYouItems: readonly UnifiedInboxItem[];
  readonly runningItems: readonly UnifiedInboxItem[];
  readonly recentItems: readonly UnifiedInboxItem[];
  readonly personas: readonly PersonaSummary[];
  readonly resolveClient: (spaceKey: string) => KikiClient;
  readonly onOpenSpaceSheet: () => void;
  readonly onPairNew: () => void;
  readonly onOpenItem: (item: UnifiedInboxItem) => void;
  readonly onQuickPrompt: () => void;
  readonly onOpenPersona: (persona: PersonaSummary) => void;
  readonly onRefresh: () => void;
}

function greetingKeyForHour(hour: number): 'mobile.greeting.morning' | 'mobile.greeting.afternoon' | 'mobile.greeting.evening' {
  if (hour < 12) return 'mobile.greeting.morning';
  if (hour < 18) return 'mobile.greeting.afternoon';
  return 'mobile.greeting.evening';
}

export function TodayTab({
  spaceLabel,
  spaceStatusTone,
  onlineSpacesCount,
  needsYouItems,
  runningItems,
  recentItems,
  personas,
  resolveClient,
  onOpenSpaceSheet,
  onPairNew,
  onOpenItem,
  onQuickPrompt,
  onOpenPersona,
  onRefresh,
}: TodayTabProps) {
  const { t } = useI18n();
  const greeting = t(greetingKeyForHour(new Date().getHours()));
  const summaryLine =
    needsYouItems.length > 0
      ? t('mobile.today.summary', { waiting: needsYouItems.length, online: onlineSpacesCount })
      : onlineSpacesCount === 1
        ? t('mobile.today.summarySingleOnline')
        : t('mobile.today.summaryOnline', { online: onlineSpacesCount });

  const featuredPersona = personas[0];
  const isClear = needsYouItems.length === 0 && runningItems.length === 0;

  return (
    <div data-mobile-screen="today" className="flex min-h-0 flex-1 flex-col">
      <header className="mx-auto flex h-12 w-full max-w-[572px] shrink-0 items-center justify-between px-4">
        <SpacePill label={spaceLabel} statusTone={spaceStatusTone} onClick={onOpenSpaceSheet} />
        <button
          type="button"
          data-mobile-pair-trigger
          aria-label={t('mobile.spaces.pairAction')}
          onClick={onPairNew}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-panel text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
        >
          <Icon name="plus" size={16} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(108px+var(--kiki-safe-bottom-inset))] pt-5">
        <div className="mx-auto flex w-full max-w-[540px] flex-col gap-6">
          <section className="space-y-1">
            <h1 className="font-display text-[30px] font-medium leading-[1.15] tracking-[-0.02em] text-ink">
              {greeting}
            </h1>
            <p className="text-[13.5px] text-ink-faint tabular-nums">{summaryLine}</p>
          </section>

          {needsYouItems.length > 0 ? (
            <section className="space-y-2.5" aria-label={t('mobile.today.needsYouSection')}>
              <div className="flex items-center justify-between px-0.5">
                <h2 className="text-[12px] font-medium uppercase tracking-[0.05em] text-ink-faint">
                  {t('mobile.today.needsYouSection')}
                </h2>
                <span className="text-[12px] font-semibold tabular-nums text-accent-ink">
                  {needsYouItems.length}
                </span>
              </div>
              <div className="flex flex-col gap-3">
                {needsYouItems.slice(0, 5).map((item) => (
                  <NeedsYouCard
                    key={item.encodedKey}
                    item={item}
                    client={resolveClient(item.spaceKey)}
                    onOpenThread={() => { onOpenItem(item); }}
                    onResolved={onRefresh}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {runningItems.length > 0 ? (
            <section className="space-y-2" aria-label={t('mobile.today.runningSection')}>
              <h2 className="px-0.5 text-[12px] font-medium uppercase tracking-[0.05em] text-ink-faint">
                {t('mobile.today.runningSection')}
              </h2>
              <div className="divide-y divide-hairline/70">
                {runningItems.slice(0, 5).map((item) => (
                  <button
                    key={item.encodedKey}
                    type="button"
                    data-mobile-running-row={item.sessionId}
                    onClick={() => { onOpenItem(item); }}
                    className="flex min-h-[54px] w-full items-center gap-3 py-2.5 text-left transition-colors active:opacity-75"
                  >
                    <LifeMark markId={`m-run:${item.encodedKey}`} life="working" className="h-[8px] w-[8px] shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-ink">{item.title}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink-faint">
                        <span className="min-w-0 truncate">{item.spaceName}</span>
                        <span aria-hidden="true">·</span>
                        <RelativeTime at={item.at} className="shrink-0 tabular-nums" />
                      </span>
                    </span>
                    <Icon name="chevron" size={14} className="shrink-0 text-ink-faint" />
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <section className="space-y-2.5" aria-label={t('mobile.today.assistantSection')}>
            <h2 className="px-0.5 text-[12px] font-medium uppercase tracking-[0.05em] text-ink-faint">
              {t('mobile.today.assistantSection')}
            </h2>

            {featuredPersona !== undefined ? (
              <button
                type="button"
                data-mobile-assistant-card
                onClick={() => { onOpenPersona(featuredPersona); }}
                className="flex w-full items-center gap-3.5 rounded-2xl border border-hairline/90 bg-panel p-3.5 text-left shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.04)] transition-colors hover:border-hairline-strong"
              >
                <PersonaAvatar persona={personaAvatarOf(featuredPersona)} size={42} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15.5px] font-semibold text-ink">{featuredPersona.name}</span>
                  <span className="mt-0.5 block truncate text-[13px] text-ink-soft">
                    {featuredPersona.title?.trim() || featuredPersona.job?.trim() || t('mobile.today.openChat')}
                  </span>
                </span>
                <Icon name="chevron" size={14} className="shrink-0 text-ink-faint" />
              </button>
            ) : (
              <button
                type="button"
                data-mobile-assistant-card
                onClick={onQuickPrompt}
                className="flex w-full items-center gap-3.5 rounded-2xl border border-hairline/90 bg-panel p-3.5 text-left shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.04)] transition-colors hover:border-hairline-strong"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
                  <Icon name="profileMain" size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium text-ink">{t('mobile.today.quickPrompt')}</span>
                  <span className="mt-0.5 block truncate text-[13px] text-ink-faint">{spaceLabel}</span>
                </span>
                <Icon name="arrowRight" size={14} className="shrink-0 text-ink-faint" />
              </button>
            )}
          </section>

          {isClear && recentItems.length > 0 ? (
            <section className="space-y-2" aria-label={t('mobile.today.recentSection')}>
              <h2 className="px-0.5 text-[12px] font-medium uppercase tracking-[0.05em] text-ink-faint">
                {t('mobile.today.recentSection')}
              </h2>
              <div className="divide-y divide-hairline/65">
                {recentItems.slice(0, 4).map((item) => (
                  <button
                    key={item.encodedKey}
                    type="button"
                    onClick={() => { onOpenItem(item); }}
                    className="flex min-h-[54px] w-full items-center gap-3 py-2.5 text-left transition-colors active:opacity-75"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-ink">{item.title}</span>
                      <span className="mt-0.5 block truncate text-[12.5px] text-ink-faint">
                        {item.preview ?? item.spaceName}
                      </span>
                    </span>
                    <RelativeTime at={item.at} className="shrink-0 text-[12px] tabular-nums text-ink-faint" />
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
