import { useRef } from 'react';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../i18n';
import { searchHasUsageHistoryParams } from '../lib/usageV2';

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

/**
 * The page's views as an underline tab strip under the page title — the same
 * navigation shape every tabbed settings page uses, with arrow/Home/End keys.
 * `data-usage-panel` + `aria-current="page"` stay: deep links and the existing
 * tests read the state from them.
 */
export function UsageNavigation({ panel, onChange }: { panel: UsagePanel; onChange: (panel: UsagePanel) => void }) {
  const { t } = useI18n();
  const tabsRef = useRef<HTMLDivElement>(null);

  const select = (next: UsagePanel, focus = false) => {
    if (focus) tabsRef.current?.querySelector<HTMLButtonElement>(`[data-usage-panel="${next}"]`)?.focus();
    if (next !== panel) onChange(next);
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = NAV_ITEMS.length - 1;
    const target = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    select(NAV_ITEMS[target]!.id, true);
  };

  return (
    <div data-usage-nav role="tablist" aria-label={t('usage.title')} className="flex gap-1 overflow-x-auto border-b border-hairline">
      {NAV_ITEMS.map(({ id, labelKey }, index) => {
        const active = panel === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-current={active ? 'page' : undefined}
            tabIndex={active ? 0 : -1}
            data-usage-panel={id}
            data-usage-nav-item={id}
            onClick={() => { select(id); }}
            onKeyDown={(event) => { onKeyDown(event, index); }}
            className={`-mb-px min-h-9 shrink-0 border-b-2 px-3 py-1.5 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:min-h-11 ${
              active
                ? 'border-ink font-medium text-ink'
                : 'border-transparent text-ink-soft hover:text-ink'
            }`}
          >
            {t(labelKey as I18nKey)}
          </button>
        );
      })}
    </div>
  );
}
