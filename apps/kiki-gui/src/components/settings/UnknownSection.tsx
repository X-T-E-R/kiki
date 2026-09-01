import { useI18n } from '../../i18n';
import type { SettingsSearchEntry } from '../../lib/settings';
import { SettingsSearch } from './SettingsNav';

/**
 * `/settings/:section` named nothing the resolver knows (and no recognizable
 * `#st-card-*` to follow). Instead of silently falling back to General —
 * which made stale bookmarks look like they still worked — say so and put the
 * search, the shortest path to wherever the content lives now, right there.
 */
export function UnknownSettingsSection({
  section,
  onSearchHit,
}: {
  section: string;
  onSearchHit: (entry: SettingsSearchEntry) => void;
}) {
  const { t } = useI18n();
  return (
    <div data-settings-unknown className="mx-auto max-w-[760px] px-4 py-10 lg:px-8">
      <h2 className="font-display text-[15px] font-semibold tracking-tight text-ink">
        {t('st.unknown.title')}
      </h2>
      <p className="mt-1 max-w-[480px] text-[12.5px] leading-relaxed text-ink-soft">
        {t('st.unknown.body', { section })}
      </p>
      <SettingsSearch focusToken={null} onSearchHit={onSearchHit} className="mt-4 max-w-[360px]" />
    </div>
  );
}
