import { useI18n } from '../i18n';

export type UsagePanel = 'history' | 'realtime' | 'export';

/**
 * `panel=` is the page's own axis, so a view stays deep-linkable: history is the
 * default, `limits` is the older alias for the live governance view, and
 * `export` is the external-sync reading added alongside it.
 */
export function usagePanelFromSearch(search: string): UsagePanel {
  const panel = new URLSearchParams(search).get('panel');
  if (panel === 'export') return 'export';
  return panel === 'realtime' || panel === 'limits' ? 'realtime' : 'history';
}

export function UsageNavigation({ panel, onChange }: { panel: UsagePanel; onChange: (panel: UsagePanel) => void }) {
  const { t } = useI18n();
  return <nav aria-label={t('usage.title')} className="flex gap-5 border-b border-hairline">
    {(['history', 'realtime', 'export'] as const).map((value) => <button key={value} type="button" data-usage-panel={value} aria-current={panel === value ? 'page' : undefined} onClick={() => { onChange(value); }} className={`border-b-2 py-2 text-sm ${panel === value ? 'border-accent text-ink' : 'border-transparent text-ink-faint hover:text-ink'}`}>{t(value === 'export' ? 'usage.export.nav' : `usage.governance.${value}`)}</button>)}
  </nav>;
}
