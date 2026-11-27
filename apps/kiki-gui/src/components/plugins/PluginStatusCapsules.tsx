/**
 * PluginStatusCapsules — E12 Slot 2 (`status-capsule`).
 *
 * Compact status-bar capsules aligned with Kiki's Paper & Ink status line: a
 * 6px semantic indicator dot (`idle | active | ok | warn | error`), localized
 * label, and optional single-line tabular telemetry value. Interactive only
 * when the contribution declares an `action`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';

import type { PluginGuiSlotContribution } from '@kiki/protocol';
import {
  resolvePluginLocalizedText,
  selectStatusCapsuleSlots,
  type PluginStatusCapsuleSlotContribution,
} from '@kiki/session-core';

import { useI18n } from '../../i18n';
import { floatingSurfaceZIndex, registerOverlay } from '../../lib/uiBusy';
import { STATUS_SEGMENT_CLASS } from '../ComposerControls';
import { Icon, Spinner } from '../icons';
import { FOCUS_RING } from '../rail-variants/shell';
import { POPOVER_SURFACE_CLASS } from '../popoverSurfaceClass';
import { useExecutePluginSlotAction, usePluginGuiSlots } from './PluginComposerSlots';

const MAX_INLINE_CAPSULES = 3;
const CAPSULE_POPOVER_SEARCH_MIN = 6;

const DOT_TONE_CLASSES: Readonly<Record<PluginStatusCapsuleSlotContribution['dotTone'], string>> = {
  idle: 'bg-ink-faint/60',
  active: 'bg-accent',
  ok: 'bg-success',
  warn: 'bg-amber-rule',
  error: 'bg-danger',
};

export function PluginStatusCapsules({
  slots,
  sessionId,
  workspaceId,
  disabled = false,
  onOpenPanel,
}: {
  readonly slots?: readonly PluginGuiSlotContribution[];
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly disabled?: boolean;
  readonly onOpenPanel?: (pluginId: string, panelId: string) => void;
}) {
  const { t, locale } = useI18n();
  const queried = usePluginGuiSlots({ sessionId, workspaceId });
  const effectiveSlots = slots ?? queried.slots;
  const capsules = useMemo(() => selectStatusCapsuleSlots(effectiveSlots), [effectiveSlots]);
  const { execute, busyKey } = useExecutePluginSlotAction();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchorRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!overflowOpen) {
      setQuery('');
      return;
    }
    return registerOverlay('plugin-status-capsules');
  }, [overflowOpen]);

  if (capsules.length === 0) return null;

  const hasOverflow = capsules.length > MAX_INLINE_CAPSULES;
  const inlineCapsules = hasOverflow ? capsules.slice(0, MAX_INLINE_CAPSULES) : capsules;
  const overflowCapsules = hasOverflow ? capsules.slice(MAX_INLINE_CAPSULES) : [];
  const overflowTone: 'error' | 'warn' | null = overflowCapsules.some((c) => c.dotTone === 'error')
    ? 'error'
    : overflowCapsules.some((c) => c.dotTone === 'warn')
      ? 'warn'
      : null;

  const needles = query.trim().toLowerCase().split(/\s+/).filter((part) => part !== '');
  const filtering = needles.length > 0;
  const popoverCapsules = filtering
    ? capsules.filter((capsule) => {
        const label = resolvePluginLocalizedText(capsule.label, locale);
        const haystack = [
          label,
          capsule.label.default,
          capsule.label.zh ?? '',
          capsule.valueText ?? '',
          capsule.pluginId,
          capsule.id,
        ].join('\n').toLowerCase();
        return needles.every((needle) => haystack.includes(needle));
      })
    : overflowCapsules;

  const renderInlineCapsule = (capsule: PluginStatusCapsuleSlotContribution) => {
    const key = `${capsule.pluginId}:${capsule.id}`;
    const label = resolvePluginLocalizedText(capsule.label, locale);
    const fullText =
      capsule.valueText !== undefined && capsule.valueText !== ''
        ? `${label} · ${capsule.valueText}`
        : label;
    const isBusy = busyKey === key;

    const content = (
      <>
        {isBusy ? (
          <Spinner label={label} />
        ) : (
          <span
            aria-hidden
            data-plugin-capsule-dot={capsule.dotTone}
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE_CLASSES[capsule.dotTone]}`}
          />
        )}
        <span className="min-w-0 truncate text-[12px] leading-4 text-ink-soft">{label}</span>
        {capsule.valueText !== undefined && capsule.valueText !== '' ? (
          <span
            data-plugin-capsule-value
            className="max-w-28 shrink-0 truncate font-mono text-[11.5px] leading-4 text-ink-faint tabular-nums @max-[38rem]/toolbar:hidden"
          >
            {capsule.valueText}
          </span>
        ) : null}
      </>
    );

    if (capsule.action === undefined) {
      return (
        <span
          key={key}
          title={fullText}
          data-plugin-status-capsule={key}
          className="inline-flex h-7 max-w-44 min-w-0 items-center gap-1.5 rounded-md px-2 select-none"
        >
          {content}
        </span>
      );
    }

    const action = capsule.action;
    return (
      <button
        key={key}
        type="button"
        disabled={disabled || isBusy}
        title={fullText}
        aria-label={fullText}
        data-plugin-status-capsule={key}
        onClick={() => {
          void execute(
            {
              pluginId: capsule.pluginId,
              label,
              action,
              sessionId,
              workspaceId,
              onOpenPanel,
            },
            key,
          );
        }}
        className={`${STATUS_SEGMENT_CLASS} max-w-48`}
      >
        {content}
      </button>
    );
  };

  const renderPopoverCapsule = (capsule: PluginStatusCapsuleSlotContribution) => {
    const key = `${capsule.pluginId}:${capsule.id}`;
    const label = resolvePluginLocalizedText(capsule.label, locale);
    const fullText =
      capsule.valueText !== undefined && capsule.valueText !== ''
        ? `${label} · ${capsule.valueText}`
        : label;
    const isBusy = busyKey === key;

    const inner = (
      <>
        {isBusy ? (
          <Spinner label={label} />
        ) : (
          <span
            aria-hidden
            data-plugin-capsule-dot={capsule.dotTone}
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE_CLASSES[capsule.dotTone]}`}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{label}</span>
        {capsule.valueText !== undefined && capsule.valueText !== '' ? (
          <span
            data-plugin-capsule-value
            className="max-w-28 shrink-0 truncate font-mono text-[11.5px] text-ink-faint tabular-nums"
          >
            {capsule.valueText}
          </span>
        ) : null}
      </>
    );

    if (capsule.action === undefined) {
      return (
        <div
          key={key}
          title={fullText}
          data-plugin-status-capsule={key}
          className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 select-none"
        >
          {inner}
        </div>
      );
    }

    const action = capsule.action;
    return (
      <button
        key={key}
        type="button"
        disabled={disabled || isBusy}
        title={fullText}
        aria-label={fullText}
        data-plugin-status-capsule={key}
        onClick={() => {
          setOverflowOpen(false);
          void execute(
            {
              pluginId: capsule.pluginId,
              label,
              action,
              sessionId,
              workspaceId,
              onOpenPanel,
            },
            key,
          );
        }}
        className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-left transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-10"
      >
        {inner}
      </button>
    );
  };

  return (
    <div
      ref={anchorRef}
      role="group"
      aria-label={t('pluginSlot.statusAria')}
      data-plugin-status-capsules
      className="flex min-w-0 shrink flex-nowrap items-center gap-0.5 overflow-hidden @max-[32rem]/toolbar:hidden"
    >
      {inlineCapsules.map(renderInlineCapsule)}
      {hasOverflow ? (
        <Popover.Root
          open={overflowOpen}
          onOpenChange={(nextOpen, details) => {
            if (!nextOpen && details.reason === 'escape-key' && query !== '') {
              details.cancel();
              setQuery('');
              searchInputRef.current?.focus();
              return;
            }
            setOverflowOpen(nextOpen);
          }}
        >
          <Popover.Trigger
            type="button"
            data-plugin-capsules-overflow={overflowCapsules.length}
            aria-label={t('pluginSlot.capsulesMoreAria', { count: overflowCapsules.length })}
            title={t('pluginSlot.capsulesMoreAria', { count: overflowCapsules.length })}
            className={`${STATUS_SEGMENT_CLASS} shrink-0 font-mono text-[11.5px] tabular-nums`}
          >
            {overflowTone !== null ? (
              <span
                aria-hidden
                data-plugin-capsules-overflow-tone={overflowTone}
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE_CLASSES[overflowTone]}`}
              />
            ) : null}
            <span>+{overflowCapsules.length}</span>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner
              side="top"
              align="start"
              sideOffset={6}
              collisionPadding={8}
              positionMethod="fixed"
              style={{ zIndex: floatingSurfaceZIndex(anchorRef.current) }}
              className="outline-none"
            >
              <Popover.Popup
                data-plugin-capsules-popover=""
                aria-label={t('pluginSlot.statusAria')}
                className={`anim-enter flex w-64 max-h-[min(20rem,var(--available-height,60vh))] flex-col p-1 outline-none ${POPOVER_SURFACE_CLASS}`}
              >
                <p className="px-2.5 py-1 text-[11px] font-normal text-ink-faint">
                  {t('pluginSlot.statusAria')}
                </p>
                {capsules.length >= CAPSULE_POPOVER_SEARCH_MIN ? (
                  <label className="relative mx-1.5 mb-1 block">
                    <span className="sr-only">{t('pluginSlot.capsulesSearch')}</span>
                    <Icon name="search" size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-faint" />
                    <input
                      ref={searchInputRef}
                      type="search"
                      data-plugin-capsules-search=""
                      value={query}
                      onChange={(event) => { setQuery(event.target.value); }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape' && query !== '') {
                          event.preventDefault();
                          event.stopPropagation();
                          setQuery('');
                        }
                      }}
                      placeholder={t('pluginSlot.capsulesSearch')}
                      className="h-7 w-full rounded-md border border-hairline bg-transparent pr-6 pl-6 text-[12px] text-ink placeholder:text-ink-faint transition-colors hover:border-hairline-strong focus:border-hairline-strong focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-selected-ink [&::-webkit-search-cancel-button]:hidden"
                    />
                    {query !== '' ? (
                      <button
                        type="button"
                        aria-label={t('inspector.cap.clearSearch')}
                        onClick={() => { setQuery(''); searchInputRef.current?.focus(); }}
                        className={`absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-ink-faint transition-colors hover:text-ink ${FOCUS_RING}`}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    ) : null}
                  </label>
                ) : null}
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {popoverCapsules.length === 0 ? (
                    <p data-plugin-capsules-empty="" className="px-2.5 py-2 text-[12px] text-ink-faint">
                      {t('pluginSlot.capsulesNoMatch')}
                    </p>
                  ) : (
                    popoverCapsules.map(renderPopoverCapsule)
                  )}
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </div>
  );
}
