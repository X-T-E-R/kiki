import { useI18n } from '../i18n';

export type UsagePanel = 'realtime' | 'limits' | 'history';

export function usagePanelFromSearch(search: string): UsagePanel {
  const params = new URLSearchParams(search);
  const panel = params.get('panel');
  if (panel === 'realtime' || panel === 'limits' || panel === 'history') return panel;
  return ['view', 'session', 'range', 'dimension', 'workspace', 'granularity', 'include_archived', 'start_at', 'end_at'].some((key) => params.has(key)) ? 'history' : 'realtime';
}

export function UsageNavigation({ panel, onChange }: { panel: UsagePanel; onChange: (panel: UsagePanel) => void }) {
  const { t } = useI18n();
  return <nav aria-label={t('usage.title')} className="flex gap-5 border-b border-hairline">
    {(['realtime', 'limits', 'history'] as const).map((value) => <button key={value} type="button" data-usage-panel={value} aria-current={panel === value ? 'page' : undefined} onClick={() => { onChange(value); }} className={`border-b-2 py-2 text-sm ${panel === value ? 'border-accent text-ink' : 'border-transparent text-ink-faint hover:text-ink'}`}>{t(`usage.governance.${value}`)}</button>)}
  </nav>;
}
