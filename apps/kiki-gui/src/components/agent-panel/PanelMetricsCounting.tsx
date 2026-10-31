import { useI18n } from '../../i18n';

export function PanelMetricsCounting() {
  const { locale } = useI18n();
  return (
    <span role="status" data-metrics-counting className="text-[11.5px] font-normal text-ink-faint">
      {locale === 'zh' ? '统计中…' : 'Counting…'}
    </span>
  );
}
