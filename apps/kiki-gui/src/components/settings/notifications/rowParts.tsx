import type { ReactNode } from 'react';

import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import type { BrandId } from './catalog';

/** Short marks: the tile says which platform without a logo we do not ship. */
const MARK: Readonly<Record<BrandId, string>> = {
  wechat: 'WX', telegram: 'TG', feishu: 'FS', qq: 'QQ', discord: 'DC', slack: 'SL', matrix: 'MX',
  wecom: 'WC', dingtalk: 'DT', http: '{ }', email: '@', windows: '', other: '…', plugin: 'P',
};

/**
 * The platform tile. A channel Kiki can talk on is tinted with the selected
 * role; one that only receives alerts stays on the neutral ground, so the
 * list reads its capabilities before any word does.
 */
export function PlatformMark({ brand, twoWay, size = 'md' }: { brand: BrandId; twoWay: boolean; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-10 w-10 rounded-[10px] text-[12.5px]' : 'h-8 w-8 rounded-[8px] text-[11px]';
  return (
    <span aria-hidden data-channel-mark={brand}
      className={`flex shrink-0 items-center justify-center font-semibold tracking-[0.02em] ${box} ${
        twoWay ? 'bg-selected text-selected-ink' : 'bg-ink/[0.05] text-ink-soft ring-1 ring-inset ring-hairline'
      }`}>
      {brand === 'windows' ? <Icon name="bell" size={14} /> : MARK[brand]}
    </span>
  );
}

/** 可对话 / 仅提醒: what the channel can do, a fact of its kind. */
export function CapabilityTag({ twoWay }: { twoWay: boolean }) {
  const { t } = useI18n();
  return (
    <span data-channel-capability={twoWay ? 'two-way' : 'alerts'}
      className={`shrink-0 rounded-[4px] px-1.5 py-px text-[11px] leading-4 ${
        twoWay ? 'bg-selected/70 text-selected-ink' : 'border border-hairline text-ink-faint'
      }`}>
      {t(twoWay ? 'st.channels.cap.twoWay' : 'st.channels.cap.alerts')}
    </span>
  );
}

export type StatusTone = 'ok' | 'busy' | 'idle' | 'warn' | 'error';

const DOT: Record<StatusTone, string> = {
  ok: 'bg-success',
  busy: 'bg-amber-ink status-dot-busy',
  idle: 'bg-ink/[0.25]',
  warn: 'bg-amber-rule',
  error: 'bg-danger',
};

const TEXT: Record<StatusTone, string> = {
  ok: 'text-ink-soft',
  busy: 'text-amber-ink',
  idle: 'text-ink-faint',
  warn: 'text-amber-ink',
  error: 'text-danger',
};

export function StatusText({ tone, children, data }: { tone: StatusTone; children: ReactNode; data?: Record<`data-${string}`, string | undefined> }) {
  return (
    <span {...data} className={`inline-flex shrink-0 items-center gap-1.5 ${TEXT[tone]}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}

/**
 * One row of "My channels": the tile, the name with its capability, and a
 * second line that leads with status; the row's own switch sits on the
 * right. The whole left side opens the row's detail underneath — no chevron:
 * the open state is a quiet tint on the summary strip and the body sits
 * under the row as its continuation (batch rules 11-14).
 */
export function ChannelListRow({ brand, twoWay, name, status, meta, control, open, onToggle, bodyId, expandLabel, children, data }: {
  brand: BrandId;
  twoWay: boolean;
  name: string;
  status: ReactNode;
  meta?: ReactNode;
  control?: ReactNode;
  open: boolean;
  onToggle: () => void;
  bodyId: string;
  expandLabel: string;
  children: ReactNode;
  data: Record<`data-${string}`, string | undefined>;
}) {
  return (
    <div {...data} data-open={open ? 'true' : undefined}>
      <div className={`flex min-h-[60px] items-center gap-2 px-3 py-2 transition-colors ${open ? 'bg-ink/[0.03]' : ''}`}>
        <button type="button" aria-expanded={open} aria-controls={bodyId} aria-label={expandLabel} onClick={onToggle}
          className="group/row -my-1 -ml-1 flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40">
          <PlatformMark brand={brand} twoWay={twoWay} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-[13.5px] font-medium text-ink" data-channel-name>{name}</span>
              <CapabilityTag twoWay={twoWay} />
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px]">
              {status}
              {meta !== undefined && meta !== null ? <>
                <span aria-hidden className="text-ink-faint">·</span>
                <span className="min-w-0 truncate text-ink-faint">{meta}</span>
              </> : null}
            </span>
          </span>
        </button>
        {control !== undefined ? <div className="flex shrink-0 items-center gap-2 pl-1">{control}</div> : null}
      </div>
      <div id={bodyId} hidden={!open} data-channel-body className="space-y-5 px-4 pb-5 pt-4 sm:pl-[60px] sm:pr-5">
        {children}
      </div>
    </div>
  );
}
