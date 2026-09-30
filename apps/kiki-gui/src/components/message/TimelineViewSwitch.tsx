/**
 * Header controls for Bot mode: the "消息 | 过程" segmented switch and the
 * delivery-mode rows of the session menu.
 *
 * The switch is a radio group, not a pair of tabs: both views are the same
 * timeline projected two ways, and the choice sticks per session. On narrow
 * headers it moves into the ⋯ menu (design §4.7, 390px).
 */

import { useI18n } from '../../i18n';
import type { TimelineView } from './messageViewMode';

const SEGMENT =
  'min-h-7 rounded-[6px] px-3 text-[12.5px] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent';

export function TimelineViewSwitch({
  view,
  onChange,
  className = '',
}: {
  readonly view: TimelineView;
  readonly onChange: (view: TimelineView) => void;
  readonly className?: string;
}) {
  const { t } = useI18n();
  const option = (value: TimelineView, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={view === value}
      data-timeline-view-option={value}
      onClick={() => { onChange(value); }}
      className={`${SEGMENT} ${view === value ? 'bg-panel font-medium text-ink shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.08)]' : 'text-ink-soft hover:text-ink'}`}
    >
      {label}
    </button>
  );
  return (
    <div
      role="radiogroup"
      aria-label={t('message.viewSwitchAria')}
      title="Ctrl+Shift+."
      data-timeline-view-switch={view}
      className={`flex shrink-0 items-center gap-0.5 rounded-lg bg-ink/[0.05] p-0.5 ${className}`}
    >
      {option('message', t('message.view'))}
      {option('process', t('message.process'))}
    </div>
  );
}

const MENU_ITEM =
  'flex min-h-8 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-[13px] text-ink transition-colors hover:bg-paper';

/** Menu rows: the view (narrow headers only) and the session's delivery mode. */
export function TimelineMenuRows({
  view,
  onView,
  delivery,
  onDelivery,
  deliveryPending,
  showView,
}: {
  readonly view: TimelineView;
  readonly onView: (view: TimelineView) => void;
  readonly delivery: 'reply' | 'message';
  readonly onDelivery: (delivery: 'reply' | 'message') => void;
  /** A change made while a turn runs lands on the next turn only. */
  readonly deliveryPending: boolean;
  readonly showView: boolean;
}) {
  const { t } = useI18n();
  const mark = (on: boolean) => (
    <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${on ? 'bg-ink' : 'bg-transparent'}`} />
  );
  return (
    <>
      {showView ? (
        <>
          <p className="px-3 pt-1.5 pb-0.5 text-[12px] font-medium text-ink-faint">{t('message.viewSwitchAria')}</p>
          {(['message', 'process'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={view === value}
              data-timeline-view-menu={value}
              className={MENU_ITEM}
              onClick={() => { onView(value); }}
            >
              <span className={view === value ? 'font-medium' : undefined}>{t(value === 'message' ? 'message.view' : 'message.process')}</span>
              {mark(view === value)}
            </button>
          ))}
          <div className="my-1 h-px bg-hairline" />
        </>
      ) : null}
      <p className="px-3 pt-1.5 pb-0.5 text-[12px] font-medium text-ink-faint">{t('message.deliveryLabel')}</p>
      {(['message', 'reply'] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="menuitemradio"
          aria-checked={delivery === value}
          data-delivery-option={value}
          title={t(value === 'message' ? 'message.deliveryMessageHint' : 'message.deliveryReplyHint')}
          className={MENU_ITEM}
          onClick={() => { onDelivery(value); }}
        >
          <span className={delivery === value ? 'font-medium' : undefined}>
            {t(value === 'message' ? 'message.messageDelivery' : 'message.replyDelivery')}
          </span>
          {delivery === value && deliveryPending ? (
            <span data-delivery-pending className="text-[11.5px] text-ink-faint">{t('message.deliveryNextTurn')}</span>
          ) : mark(delivery === value)}
        </button>
      ))}
    </>
  );
}
