/**
 * ExecutionSelect — the composer's engine control, at the position the profile
 * picker used to hold.
 *
 * The choice a user makes here has two parts that only make sense together:
 * which engine runs, and (optionally) which of that engine's profiles shapes
 * it. So this is ONE panel with two sections rather than two pickers: picking
 * an engine filters the profile list under it, and picking a profile implies
 * its engine. The model control stays where it is — a model is a choice
 * *within* the engine, not a third axis of the same question.
 *
 * The leading row of every engine is the bare harness: no profile, no Kiki
 * prompt, no injected tools, no forced model or effort. That is the default
 * for a newly picked external engine, because a harness that already has its
 * own configuration, credentials and working directory should be driven as
 * it is until the user asks for Kiki's layer.
 *
 * Provenance is stated where it is decided: the engine row and the profile row
 * each say where their value came from (this session, the engine's settings,
 * its own default), so an inherited value never reads as one the user set.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ExecutorCatalogItem, NamedAgentProfile } from '@kiki/protocol';
import {
  isNativeExecutor,
  NATIVE_EXECUTOR,
  profileExecutor,
  type ExecutionChoice,
  type ExecutionContextGroup,
} from '@kiki/session-core/composer';
import type { I18nKey } from '@kiki/session-core/i18n';

import { useNavigate } from 'react-router-dom';

import { useI18n } from '../../i18n';
import { isRunnableEngine, visibleEngines } from '../settings/profileEditor/engines';
import { COMPOSER_PANEL_START, STATUS_SEGMENT_CLASS, STATUS_SEGMENT_ICON_CLASS, STATUS_SEGMENT_SET, useComposerPanelAnchor, usePopover, MENU_ROW_CLASS, MENU_ROW_SELECTED_CLASS } from '../ComposerControls';
import { POPOVER_SURFACE_CLASS } from '../SearchableSelect';
import { Icon } from '../icons';

function Check({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`flex h-[19px] w-3 shrink-0 items-center ${on ? 'text-ink' : 'text-transparent'}`}>
      <Icon name="check" size={12} />
    </span>
  );
}

/** One engine row, with its own profiles nested under it. */
function EngineRow({
  id,
  label,
  hint,
  badges,
  current,
  bare,
  profiles,
  profile,
  onBare,
  onProfile,
  unavailable,
}: {
  id: string;
  label: string;
  hint?: string;
  badges?: readonly string[];
  current: boolean;
  bare: boolean;
  profiles: readonly NamedAgentProfile[];
  profile: string | undefined;
  onBare: () => void;
  onProfile: (name: string) => void;
  unavailable?: boolean;
}) {
  const { t } = useI18n();
  const native = isNativeExecutor(id);
  return (
    <div data-execution-engine={id} data-current={current ? 'true' : undefined}>
      <button
        type="button"
        role="option"
        aria-selected={current && bare}
        data-menu-row
        data-execution-bare={id}
        onClick={onBare}
        className={`${MENU_ROW_CLASS} items-start ${current && bare ? MENU_ROW_SELECTED_CLASS : ''} ${unavailable === true ? 'opacity-70' : ''}`}
      >
        <Check on={current && bare} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate font-medium text-ink">{label}</span>
            {unavailable === true ? (
              <span className="shrink-0 text-[11px] text-amber-ink">{t('composer.execution.notInstalled')}</span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint">
            {native ? t('composer.execution.nativeBareHint') : t('composer.execution.bareHint')}
          </span>
          {hint !== undefined && hint !== '' ? <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-faint">{hint}</span> : null}
          {badges !== undefined && badges.length > 0 ? (
            <span className="mt-1 flex flex-wrap items-center gap-1">
              {badges.map((badge) => <span key={badge} className="rounded-[4px] bg-ink/[0.05] px-1.5 text-[11px] leading-4 text-ink-faint">{badge}</span>)}
            </span>
          ) : null}
        </span>
      </button>
      {profiles.length > 0 ? (
        <ul role="group" aria-label={t('composer.execution.profileGroupAria', { engine: label })} className="mt-0.5 space-y-0.5 pl-7">
          {profiles.map((item) => {
            const selected = current && profile === item.name;
            return (
              <li key={item.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-menu-row
                  data-execution-profile={item.name}
                  onClick={() => { onProfile(item.name); }}
                  className={`${MENU_ROW_CLASS} items-start ${selected ? MENU_ROW_SELECTED_CLASS : ''}`}
                >
                  <Check on={selected} />
                  <span className="min-w-0 flex-1">
                    <span className="block min-w-0 truncate text-[12.5px] text-ink">{item.name}</span>
                    {item.description !== undefined && item.description !== '' ? (
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">{item.description}</span>
                    ) : item.when_to_use !== undefined && item.when_to_use !== '' ? (
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">{item.when_to_use}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The Kiki-tools and context groups this engine currently grants, as short
 * facts under the trigger. Empty is not worth a badge; the panel is where a
 * user looks for the full list.
 */
export function executionContextFacts(
  groups: readonly ExecutionContextGroup[] | undefined,
  allowSubagents: boolean | undefined,
  t: (key: I18nKey) => string,
): string[] {
  const facts: string[] = [];
  if (allowSubagents === true) facts.push(t('composer.execution.fact.subagents'));
  for (const group of groups ?? []) facts.push(t(`composer.execution.fact.${group}` as I18nKey));
  return facts;
}

export function ExecutionSelect({
  choice,
  pending,
  busy,
  onChange,
  catalog,
  profiles,
  engineOverrides,
  engineDisplay,
  engineDescriptors,
  pickableProfile,
  nativeLabel,
  contextGroups,
  allowKikiSubagents,
  persona,
  onClearPersona,
  onCancelPending,
  disabled = false,
}: {
  /** The pick the chip shows: the pending one when there is one, else the bound one. */
  choice: ExecutionChoice;
  /** True when this pick is waiting for the next user message. */
  pending: boolean;
  busy: boolean;
  onChange: (next: ExecutionChoice) => void;
  catalog: readonly ExecutorCatalogItem[];
  /** Main profiles the workspace offers, already filtered for availability. */
  profiles: readonly NamedAgentProfile[];
  /**
   * The raw `agent_executor_overrides` record, which carries the display
   * choice (see `visibleEngines`). Pass it so the panel lists engines that can
   * actually run here rather than every engine Kiki knows about; an engine the
   * user hid from the list stays installed and still runs whatever is bound to
   * it.
   */
  engineOverrides?: Readonly<Record<string, unknown>> | undefined;
  /**
   * The raw `agent_executor_display` record: the one switch that hides every
   * external engine at once (see `visibleEngines`).
   */
  engineDisplay?: Readonly<Record<string, unknown>> | undefined;
  /**
   * The raw `agent_executors` descriptors the user authored, which are an engine
   * they configured even without a profile or an override entry.
   */
  engineDescriptors?: Readonly<Record<string, unknown>> | undefined;
  /** Whether one profile is a conversation candidate (main, enabled, public). */
  pickableProfile: (profile: NamedAgentProfile) => boolean;
  nativeLabel: string;
  /** Kiki context groups the current binding resolved to, for the trigger's facts. */
  contextGroups: readonly ExecutionContextGroup[] | undefined;
  allowKikiSubagents: boolean | undefined;
  /**
   * A persona bound to this draft. It rides the same control: the trigger shows
   * the face and name, and the panel behind it still chooses the engine — an
   * identity and an engine are different facts, and a user changes one without
   * losing the other.
   */
  persona?: { readonly id: string; readonly name: string; readonly avatar?: ReactNode };
  /** Present only while a persona is bound; removes it without touching the engine. */
  onClearPersona?: () => void;
  /**
   * Present only while a switch is waiting for the next message. "Next message"
   * is a decision window, not a done deal: the user who changes their mind
   * should not have to reopen the panel and re-pick the engine they are already
   * on to get back to where they started. The chip carries the undo instead.
   * It stays live while a turn runs — dropping a queued switch touches neither
   * the running turn nor the session binding.
   */
  onCancelPending?: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = (refocus = false) => {
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  };
  const onKeyDown = usePopover(open, close, rootRef, 'composer-execution');
  useComposerPanelAnchor(rootRef, open);

  const engineItem = catalog.find((item) => item.id === choice.executor);
  const engineLabel = isNativeExecutor(choice.executor) ? nativeLabel : (engineItem?.label ?? choice.executor);
  // The bare-harness row is the first row of every engine, so the profile
  // list is exactly the engine's own main profiles — never another engine's.
  const profilesByEngine = useMemo(() => {
    const map = new Map<string, NamedAgentProfile[]>();
    for (const profile of profiles) {
      if (!pickableProfile(profile)) continue;
      const bucket = map.get(profileExecutor(profile));
      if (bucket === undefined) map.set(profileExecutor(profile), [profile]);
      else bucket.push(profile);
    }
    return map;
  }, [profiles, pickableProfile]);

  const navigate = useNavigate();
  const engineNeedsSetup = !isNativeExecutor(choice.executor) &&
    (engineItem === undefined || !isRunnableEngine(engineItem, engineOverrides, engineDescriptors));
  const listedEngines = useMemo(() => {
    const listed = visibleEngines(catalog, profiles, engineOverrides, engineDisplay, engineDescriptors);
    if (listed.some((item) => item.id === choice.executor)) return listed;
    const bound = catalog.find((item) => item.id === choice.executor);
    return bound === undefined || !isRunnableEngine(bound, engineOverrides, engineDescriptors) ? listed : [...listed, bound];
  }, [catalog, profiles, engineOverrides, engineDisplay, engineDescriptors, choice.executor]);

  /**
   * One filter over the whole panel, matched against everything a reader can
   * see: the engine name, its id, and every profile name and description.
   * A bare engine with no profile row of its own survives on its own name
   * alone — the row is the "run this harness as it is" choice.
   */
  const matches = (engine: { readonly id: string; readonly label: string }, own: readonly NamedAgentProfile[]): boolean => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return true;
    if (`${engine.label} ${engine.id}`.toLowerCase().includes(needle)) return true;
    return own.some((profile) =>
      `${profile.name} ${profile.description ?? ''} ${profile.when_to_use ?? ''}`.toLowerCase().includes(needle));
  };
  const externalEngines = listedEngines.filter((item) => item.id !== NATIVE_EXECUTOR);
  const nativeProfiles = profilesByEngine.get(NATIVE_EXECUTOR) ?? [];
  const visibleExternal = externalEngines.filter((item) => matches(item, profilesByEngine.get(item.id) ?? []));
  const nativeVisible = matches({ id: NATIVE_EXECUTOR, label: nativeLabel }, nativeProfiles);
  const nothingMatches = !nativeVisible && visibleExternal.length === 0;
  // Opening the panel can push the trigger out of view, so bring it back.
  useEffect(() => {
    if (open) triggerRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);

  const facts = executionContextFacts(contextGroups, allowKikiSubagents, t);
  const setChoice = (executor: string, profile: string | undefined) => {
    const resetsCurrentBare = executor === choice.executor && profile === undefined && choice.profile === undefined && choice.overrides !== undefined;
    onChange({ executor, profile, overrides: resetsCurrentBare ? {
      model: null, thinking: null, permission_mode: null, kiki_context: null, allow_kiki_subagents: null,
    } : undefined });
    close(true);
  };
  // A bound persona names who answers, so the face and the name replace the
  // engine's; the engine stays stated in the panel and the tooltip. A pending
  // switch is never hidden behind a persona: the user is waiting on it.
  // The default native profile reads as the product name, as it always has.
  const profileText = choice.profile === undefined
    ? undefined
    : choice.profile === 'agent' && isNativeExecutor(choice.executor) ? nativeLabel : choice.profile;
  const triggerText = profileText ?? engineLabel;
  const showPersona = persona !== undefined && !pending;
  const ariaEngine = t('composer.execution.aria', {
    engine: engineLabel,
    profile: choice.profile ?? t('composer.execution.bare'),
  });

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape/arrow handling for the open panel
    <div ref={rootRef} className="relative min-w-0" data-execution-select onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        role="button"
        aria-haspopup="true"
        aria-expanded={open}
        id="composer-execution-select"
        data-execution-trigger
        data-execution-engine-value={choice.executor}
        data-execution-pending={pending ? 'true' : undefined}
        data-composer-persona-chip={showPersona === true ? persona.id : undefined}
        disabled={disabled}
        title={pending
          ? t('composer.execution.pendingTitle')
          : busy
            ? t('composer.execution.busyTitle')
            : t('composer.execution.title', { engine: engineLabel })}
        aria-label={showPersona === true ? t('persona.chipAria') : ariaEngine}
        onClick={() => { setOpen((value) => !value); }}
        className={showPersona === true
          ? 'flex h-7 min-w-0 max-w-44 items-center gap-1.5 rounded-full pr-1.5 pl-1.5 text-[13px] font-medium text-ink outline-none transition-colors hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:opacity-60 pointer-coarse:h-10'
          : `${STATUS_SEGMENT_CLASS} max-w-52 ${pending ? 'pr-5 font-medium text-accent-ink hover:text-accent-ink' : choice.executor !== NATIVE_EXECUTOR || choice.profile !== undefined ? STATUS_SEGMENT_SET : ''} disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {showPersona === true
          ? <>
            {persona.avatar}
            <span className="min-w-0 truncate">{persona.name}</span>
          </>
          : <>
            <Icon name={isNativeExecutor(choice.executor) ? 'agent' : 'terminal'} size={14} className={STATUS_SEGMENT_ICON_CLASS} />
            <span className="min-w-0 truncate @max-[24rem]/toolbar:sr-only">
              {pending ? t('composer.execution.pendingSuffix', { name: triggerText }) : triggerText}
            </span>
          </>}
      </button>
      {pending && onCancelPending !== undefined ? (
        <button
          type="button"
          data-execution-cancel-pending
          aria-label={t('composer.execution.cancelPending')}
          title={t('composer.execution.cancelPending')}
          onClick={() => { onCancelPending(); }}
          className="absolute top-1/2 -right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-9 pointer-coarse:w-9"
        >
          <Icon name="close" size={12} />
        </button>
      ) : null}
      {showPersona === true && onClearPersona !== undefined ? (
        <button
          type="button"
          data-composer-persona-clear
          data-composer-persona-clear-id={persona.id}
          disabled={busy}
          aria-label={t('persona.chipRemove', { name: persona.name })}
          title={t('persona.chipRemove', { name: persona.name })}
          onClick={() => { onClearPersona(); }}
          className="absolute top-1/2 left-[4.25rem] flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-9 pointer-coarse:w-9"
        >
          <Icon name="close" size={12} />
        </button>
      ) : null}
      {open ? (
        <div
          data-execution-panel
          role="radiogroup"
          aria-label={t('composer.execution.panelLabel')}
          className={`anim-enter ${COMPOSER_PANEL_START} flex max-h-[min(var(--cp-max-h,none),26rem)] w-96 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden ${POPOVER_SURFACE_CLASS}`}
        >
          <div className="border-b border-hairline px-3 py-2">
            <input
              type="text"
              data-autofocus
              data-execution-filter
              ref={(input) => { input?.focus(); }}
              value={query}
              onChange={(event) => { setQuery(event.target.value); }}
              placeholder={t('composer.execution.searchPlaceholder')}
              aria-label={t('composer.execution.filterAria')}
              className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {engineNeedsSetup ? (
              <div data-execution-restore={choice.executor} className="mb-1 rounded-md bg-paper px-3 py-2">
                <p className="text-[12px] leading-snug text-ink-soft">{t('composer.execution.needsSetup', { engine: engineLabel })}</p>
                <button
                  type="button"
                  data-execution-configure
                  onClick={() => { close(); void navigate('/settings/ai?tab=engines#st-card-engines'); }}
                  className="mt-1 text-[12px] font-medium text-selected-ink underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
                >
                  {t('composer.execution.configure')}
                </button>
              </div>
            ) : null}
            {nothingMatches ? (
              <p data-execution-empty className="px-2 py-4 text-center text-[12px] text-ink-faint">
                {t('composer.execution.noMatch', { query: query.trim() })}
              </p>
            ) : null}
            {nativeVisible ? (
              <EngineRow
                id={NATIVE_EXECUTOR}
                label={nativeLabel}
                current={isNativeExecutor(choice.executor)}
                bare={choice.profile === undefined}
                profiles={nativeProfiles}
                profile={choice.profile}
                onBare={() => { setChoice(NATIVE_EXECUTOR, undefined); }}
                onProfile={(name) => { setChoice(NATIVE_EXECUTOR, name); }}
              />
            ) : null}
            {visibleExternal.map((item) => (
              <EngineRow
                key={item.id}
                id={item.id}
                label={item.label}
                hint={[item.id, item.version].filter((part) => part !== undefined && part !== '').join(' · ')}
                current={choice.executor === item.id}
                bare={choice.profile === undefined}
                profiles={profilesByEngine.get(item.id) ?? []}
                profile={choice.profile}
                unavailable={item.status === 'unavailable'}
                onBare={() => { setChoice(item.id, undefined); }}
                onProfile={(name) => { setChoice(item.id, name); }}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-hairline px-3 py-2">
            <p className="min-w-0 text-[11.5px] leading-snug text-ink-faint">{t('composer.execution.bareNote')}</p>
            {facts.length > 0 ? (
              <p data-execution-facts className="flex shrink-0 items-center gap-1 text-[11.5px] text-ink-faint">{facts.join(' · ')}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
