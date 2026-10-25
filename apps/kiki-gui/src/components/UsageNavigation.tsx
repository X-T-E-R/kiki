import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../i18n';
import { searchHasUsageHistoryParams } from '../lib/usageV2';
import { segmentClass } from './WorkspaceScopeControl';

export type UsagePanel = 'history' | 'realtime' | 'quota' | 'export';

/**
 * `panel=` is the page's own axis, so a view stays deep-linkable: a bare
 * `/usage` visit opens the live governance view, historical filter/session/view
 * links remain history, and explicit `panel=` values keep their old meaning.
 */
export function usagePanelFromSearch(search: string): UsagePanel {
  const panel = new URLSearchParams(search).get('panel');
  if (panel === 'export') return 'export';
  if (panel === 'quota') return 'quota';
  if (panel === 'history') return 'history';
  if (panel === 'realtime' || panel === 'limits') return 'realtime';
  return searchHasUsageHistoryParams(search) ? 'history' : 'realtime';
}

const NAV_ITEMS: readonly { id: UsagePanel; labelKey: string }[] = [
  { id: 'realtime', labelKey: 'usage.governance.realtime' },
  { id: 'history', labelKey: 'usage.governance.history' },
  { id: 'quota', labelKey: 'usage.quota.nav' },
  { id: 'export', labelKey: 'usage.export.nav' },
];

export function UsageNavigation({ panel, onChange }: { panel: UsagePanel; onChange: (panel: UsagePanel) => void }) {
  const { t } = useI18n();
  return (
    <nav
      aria-label={t('usage.title')}
      className="order-last inline-flex w-full overflow-x-auto rounded-[9px] border border-hairline bg-paper p-0.5 sm:order-none sm:w-auto"
    >
      {NAV_ITEMS.map(({ id, labelKey }) => (
        <button
          key={id}
          type="button"
          data-usage-panel={id}
          data-usage-nav-item={id}
          aria-current={panel === id ? 'page' : undefined}
          onClick={() => { onChange(id); }}
          className={segmentClass(panel === id, 'h-7 flex-1 px-2.5 text-[12px] sm:flex-none pointer-coarse:min-h-11')}
        >
          {t(labelKey as I18nKey)}
        </button>
      ))}
    </nav>
  );
}
