/**
 * Header-anchored lineage & departure popover.
 *
 * Replaces the centered modal `seedDialog` and surfaces Fork / Branch / `/btw`
 * plus live parent-child lineage jumps in one compact, click-anchored paper-ink
 * popover without touching the right preview split.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { SessionSeedMode } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { useCoarsePointer } from '../../lib/layoutHooks';
import { isImeKeyEvent } from '../../lib/shortcuts';
import {
  FLOATING_OWNER_ATTRIBUTE,
  FLOATING_PORTAL_OWNERS_ATTRIBUTE,
  floatingSurfaceZIndex,
  hasOpenOwnedFloatingPortal,
  owningModalId,
  registerOverlay,
  resolveFloatingOwners,
} from '../../lib/uiBusy';
import { MODAL_ESCAPE_ATTRIBUTE } from '../Dialog';
import { Icon } from '../icons';
import { ActionSheet } from '../overlays/ActionSheet';
import { POPOVER_SURFACE_CLASS } from '../SearchableSelect';
import type { ForkOriginSummary, TimelineOffshootItem } from './forkLineageModel';

const SEED_MODES: readonly SessionSeedMode[] = ['verbatim', 'compact', 'fresh'];

export const ForkLaunchPopover = memo(function ForkLaunchPopover({
  origin,
  offshoots,
  canFork,
  canBranch,
  canSideQuestion,
  busy,
  openRequest,
  onOpenSession,
  onOpenBranch,
  onForkSession,
  onStartBranch,
  onStartSideQuestion,
}: {
  origin: ForkOriginSummary | undefined;
  offshoots: readonly TimelineOffshootItem[];
  canFork: boolean;
  canBranch: boolean;
  canSideQuestion: boolean;
  busy?: boolean;
  openRequest?: { readonly seq: number; readonly focusBranch?: boolean };
  onOpenSession: (sessionId: string) => void;
  onOpenBranch: (agentId: string) => void;
  onForkSession: (seed: SessionSeedMode) => void;
  onStartBranch: (task: string, seed: SessionSeedMode, openMode?: 'route' | 'split') => void;
  onStartSideQuestion: () => void;
}) {
  const { t } = useI18n();
  const coarse = useCoarsePointer();
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<SessionSeedMode>('verbatim');
  const [branchTask, setBranchTask] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const handledSeqRef = useRef(0);

  useEffect(() => {
    if (openRequest === undefined || openRequest.seq === handledSeqRef.current) return;
    handledSeqRef.current = openRequest.seq;
    setOpen(true);
    if (openRequest.focusBranch && !coarse) {
      requestAnimationFrame(() => {
        branchInputRef.current?.focus();
      });
    }
  }, [openRequest, coarse]);

  const hasLineage = origin !== undefined || offshoots.length > 0;
  const hasActions = canFork || canBranch || canSideQuestion;

  useEffect(() => {
    if (!open || coarse) return;
    const unregister = registerOverlay('header-fork-popover');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node)
        || (!containerRef.current?.contains(event.target) && !panelRef.current?.contains(event.target))
      ) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, coarse]);

  if (!hasLineage && !hasActions) return null;

  const badgeCount = offshoots.length;
  const hasRunningBranch = offshoots.some(
    (entry) => entry.kind === 'branch' && (entry.branchState === 'running' || entry.branchState === 'waiting'),
  );

  const submitBranch = (openMode: 'route' | 'split' = 'route') => {
    if (!canBranch || busy) return;
    const clean = branchTask.trim();
    setBranchTask('');
    setOpen(false);
    onStartBranch(clean, seed, openMode);
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        data-header-fork-trigger
        aria-label={t('fork.headerButtonAria')}
        title={t('fork.headerButtonAria')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className={`relative inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-md px-1.5 text-ink-soft transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink lg:h-8 lg:min-w-8 ${
          open ? 'bg-ink/[0.07] text-ink' : ''
        }`}
      >
        <Icon name="branch" size={14} />
        {badgeCount > 0 ? (
          <span
            data-header-fork-count
            className="text-[11px] leading-none font-normal text-ink-soft tabular-nums"
          >
            {badgeCount}
          </span>
        ) : null}
        {hasRunningBranch ? (
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse"
          />
        ) : null}
      </button>

      {open && !coarse ? (
        <Popover.Root
          open
          modal={false}
          onOpenChange={(nextOpen, eventDetails) => {
            if (nextOpen) return;
            if (eventDetails.reason === 'escape-key') {
              if (hasOpenOwnedFloatingPortal('header-fork-popover')) {
                eventDetails.cancel();
                return;
              }
              setOpen(false);
              triggerRef.current?.focus();
              return;
            }
            eventDetails.cancel();
          }}
        >
          <Popover.Portal>
            <Popover.Positioner
              anchor={triggerRef}
              side="bottom"
              align="end"
              sideOffset={6}
              collisionPadding={8}
              positionMethod="fixed"
              style={{ zIndex: floatingSurfaceZIndex(triggerRef.current) }}
            >
              <Popover.Popup
                ref={panelRef}
                role="dialog"
                aria-label={t('fork.headerButtonAria')}
                data-header-fork-popover
                initialFocus={false}
                finalFocus={false}
                {...{
                  [FLOATING_OWNER_ATTRIBUTE]: 'header-fork-popover',
                  [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: resolveFloatingOwners(triggerRef.current, 'header-fork-popover'),
                  [MODAL_ESCAPE_ATTRIBUTE]: owningModalId(triggerRef.current),
                }}
                className={`anim-enter w-72 max-h-[min(var(--available-height,calc(100dvh-24px)),calc(100dvh-24px))] overflow-y-auto overscroll-contain p-2 outline-none ${POPOVER_SURFACE_CLASS}`}
              >
          {hasLineage ? (
            <div className="mb-2 border-b border-hairline pb-2">
              <div className="px-2 pb-1 text-[11px] font-normal text-ink-faint">
                {t('fork.popover.lineageHeading')}
              </div>
              <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                {origin !== undefined ? (
                  <button
                    type="button"
                    data-fork-popover-origin={origin.sessionId}
                    onClick={() => {
                      setOpen(false);
                      onOpenSession(origin.sessionId);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
                  >
                    <Icon name="arrowLeft" size={12} className="shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1 truncate">
                      {origin.turnIndex !== undefined
                        ? t('fork.provenanceFromTurn', { title: origin.title, turn: origin.turnIndex + 1 })
                        : t('fork.provenanceFrom', { title: origin.title })}
                    </span>
                  </button>
                ) : null}
                {offshoots.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    data-fork-popover-offshoot={item.id}
                    onClick={() => {
                      setOpen(false);
                      if (item.kind === 'fork') {
                        onOpenSession(item.id);
                      } else {
                        onOpenBranch(item.id);
                      }
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
                  >
                    <Icon name="branch" size={12} className="shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    {item.turnIndex !== undefined ? (
                      <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">
                        #{item.turnIndex + 1}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {canFork || canBranch ? (
            <div className="mb-2 px-1">
              <div className="mb-1 px-1 text-[11px] font-normal text-ink-faint">
                {t('transcript.branch.seedLabel')}
              </div>
              <div className="grid grid-cols-3 gap-0.5 rounded-lg bg-canvas/70 p-0.5">
                {SEED_MODES.map((mode) => {
                  const selected = seed === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      data-fork-popover-seed={mode}
                      aria-pressed={selected}
                      onClick={() => {
                        setSeed(mode);
                      }}
                      className={`rounded-md px-1.5 py-1 text-[11px] leading-4 font-normal transition-colors ${
                        selected
                          ? 'bg-paper text-ink shadow-xs'
                          : 'text-ink-faint hover:text-ink-soft'
                      }`}
                    >
                      {t(`transcript.branch.seed.${mode}`)}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            {canFork ? (
              <button
                type="button"
                data-fork-popover-action="fork"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  onForkSession(seed);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-ink/[0.06] disabled:opacity-45"
              >
                <Icon name="branch" size={14} className="shrink-0 text-ink-soft" />
                <span className="flex-1">{t('fork.popover.forkSession')}</span>
              </button>
            ) : null}

            {canBranch ? (
              <div className="rounded-lg border border-hairline bg-canvas/45 p-1.5">
                <input
                  ref={branchInputRef}
                  type="text"
                  data-fork-popover-branch-input
                  value={branchTask}
                  placeholder={t('fork.popover.branchPlaceholder')}
                  onChange={(event) => {
                    setBranchTask(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !isImeKeyEvent(event)) {
                      event.preventDefault();
                      submitBranch('route');
                    }
                  }}
                  className="mb-1 w-full rounded-md bg-transparent px-1.5 py-1 text-[12px] text-ink placeholder:text-ink-faint focus:bg-paper focus:outline-1 focus:outline-selected-ink"
                />
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    data-fork-popover-action="branch"
                    disabled={busy}
                    onClick={() => {
                      submitBranch('route');
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] font-normal text-ink transition-colors hover:bg-ink/[0.06] disabled:opacity-45"
                  >
                    <Icon name="arrowUpRight" size={12} className="shrink-0 text-ink-soft" />
                    <span className="truncate">{t('fork.popover.startBranch')}</span>
                  </button>
                  <button
                    type="button"
                    data-fork-popover-action="branch-split"
                    disabled={busy}
                    title={t('fork.popover.openInSplit')}
                    aria-label={t('fork.popover.openInSplit')}
                    onClick={() => {
                      submitBranch('split');
                    }}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink-soft disabled:opacity-45"
                  >
                    <Icon name="panel" size={12} />
                  </button>
                </div>
              </div>
            ) : null}

            {canSideQuestion ? (
              <button
                type="button"
                data-fork-popover-action="btw"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  onStartSideQuestion();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-soft transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-45"
              >
                <Icon name="ask" size={14} className="shrink-0 text-ink-faint" />
                <span className="flex-1">{t('fork.popover.sideQuestion')}</span>
                <span className="text-[11px] text-ink-faint">/btw</span>
              </button>
            ) : null}
          </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : null}

      {coarse && open ? (
        <ActionSheet
          ariaLabel={t('fork.headerButtonAria')}
          overlayId="fork-launch-sheet"
          onClose={() => {
            setOpen(false);
          }}
        >
          {hasLineage ? (
            <div className="border-b border-hairline pb-1.5 mb-1.5">
              <div className="px-3 py-1 text-[11px] font-normal text-ink-faint">
                {t('fork.popover.lineageHeading')}
              </div>
              {origin !== undefined ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onOpenSession(origin.sessionId);
                  }}
                  className="touch-sheet-row flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[14px] text-ink"
                >
                  <Icon name="arrowLeft" size={16} />
                  <span className="min-w-0 flex-1 truncate">
                    {origin.turnIndex !== undefined
                      ? t('fork.provenanceFromTurn', { title: origin.title, turn: origin.turnIndex + 1 })
                      : t('fork.provenanceFrom', { title: origin.title })}
                  </span>
                </button>
              ) : null}
              {offshoots.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    if (item.kind === 'fork') {
                      onOpenSession(item.id);
                    } else {
                      onOpenBranch(item.id);
                    }
                  }}
                  className="touch-sheet-row flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[14px] text-ink"
                >
                  <Icon name="branch" size={16} />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                </button>
              ))}
            </div>
          ) : null}
          {canFork || canBranch ? (
            <div className="border-b border-hairline pb-1.5 mb-1.5">
              <div className="px-3 py-1 text-[11px] font-normal text-ink-faint">
                {t('transcript.branch.seedLabel')}
              </div>
              {SEED_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={seed === mode}
                  onClick={() => {
                    setSeed(mode);
                  }}
                  className="touch-sheet-row flex w-full items-center justify-between gap-2.5 rounded-lg px-3 py-2 text-left text-[14px] text-ink"
                >
                  <span>{t(`transcript.branch.seed.${mode}`)}</span>
                  {seed === mode ? <Icon name="check" size={14} /> : null}
                </button>
              ))}
            </div>
          ) : null}
          {canFork ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onForkSession(seed);
              }}
              className="touch-sheet-row flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[14px] text-ink disabled:opacity-45"
            >
              <Icon name="branch" size={16} />
              <span>{t('fork.popover.forkSession')}</span>
            </button>
          ) : null}
          {canBranch ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                submitBranch('route');
              }}
              className="touch-sheet-row flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[14px] text-ink disabled:opacity-45"
            >
              <Icon name="arrowUpRight" size={16} />
              <span>{t('fork.popover.startBranch')}</span>
            </button>
          ) : null}
          {canSideQuestion ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onStartSideQuestion();
              }}
              className="touch-sheet-row flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[14px] text-ink disabled:opacity-45"
            >
              <Icon name="ask" size={16} />
              <span>{t('fork.popover.sideQuestion')}</span>
            </button>
          ) : null}
        </ActionSheet>
      ) : null}
    </div>
  );
});
