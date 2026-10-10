import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../i18n';

export type UsagePanel = 'history' | 'realtime' | 'quota' | 'export';

/**
 * `panel=` is the page's own axis, so a view stays deep-linkable: history is the
 * default, `realtime`/`limits` is the live governance view, `quota` displays
 * remaining provider allowances, and `export` is external sync.
 */
export function usagePanelFromSearch(search: string): UsagePanel {
  const panel = new URLSearchParams(search).get('panel');
  if (panel === 'export') return 'export';
  if (panel === 'quota') return 'quota';
  return panel === 'realtime' || panel === 'limits' ? 'realtime' : 'history';
}

const NAV_ITEMS: readonly { id: UsagePanel; labelKey: string }[] = [
  { id: 'history', labelKey: 'usage.governance.history' },
  { id: 'realtime', labelKey: 'usage.governance.realtime' },
  { id: 'quota', labelKey: 'usage.quota.nav' },
  { id: 'export', labelKey: 'usage.export.nav' },
];

export function UsageNavigation({ panel, onChange }: { panel: UsagePanel; onChange: (panel: UsagePanel) => void }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t('usage.title')} className="flex gap-5 border-b border-hairline">
      {NAV_ITEMS.map(({ id, labelKey }) => (
        <button
          key={id}
          type="button"
          data-usage-panel={id}
          data-usage-nav-item={id}
          aria-current={panel === id ? 'page' : undefined}
          onClick={() => { onChange(id); }}
          className={`border-b-2 py-2 text-sm ${panel === id ? 'border-accent text-ink font-medium' : 'border-transparent text-ink-faint hover:text-ink'}`}
        >
          {t(labelKey as I18nKey)}
        </button>
      ))}
    </nav>
  );
}
