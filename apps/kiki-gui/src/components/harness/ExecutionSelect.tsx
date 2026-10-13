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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { configuredEngineDescriptors, engineDisplayOf, engineOverridesOf, visibleEngines } from '../settings/profileEditor/engines';

import type { ExecutorCatalogItem, NamedAgentProfile } from '@kiki/protocol';
import {
  isNativeExecutor,
  NATIVE_EXECUTOR,
  profileExecutor,
  profileFileLabel,
  type ExecutionChoice,
  type ExecutionContextGroup,
} from '@kiki/session-core/composer';
import type { I18nKey } from '@kiki/session-core/i18n';

import { errorText } from '@kiki/session-core/i18n';
import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import type { AgentProfileCatalogMode } from '../../lib/agentProfileCatalog';
import { externalClientsFacade } from '../../lib/externalClients';
import { useConnection, useOptionalConnection } from '../../state/connection';
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
  catalogMode,
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
  catalogMode: AgentProfileCatalogMode;
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
  const { t, locale } = useI18n();
  const host = useHost();
  const connection = useOptionalConnection();
  const { client, scopeId, meta } = useConnection();
  const serverId = meta?.server_id ?? '';
  const connectionKey = `${scopeId}\0${serverId}`;
  const nativePathPicker = host.pickFilePath !== undefined && connection?.connectionSource !== 'ssh' && connection?.connectionSource !== 'remote';
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
    retry: false,
    enabled: typeof client.getConfig === 'function',
  });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const openRef = useRef(open);
  openRef.current = open;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = (refocus = false) => {
    openRef.current = false;
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  };
  const onKeyDown = usePopover(open, close, rootRef, 'composer-execution');
  useComposerPanelAnchor(rootRef, open);

  const clientRef = useRef(client);
  clientRef.current = client;
  const connectionKeyRef = useRef(connectionKey);
  connectionKeyRef.current = connectionKey;
  const catalogModeRef = useRef(catalogMode);
  catalogModeRef.current = catalogMode;
  const fileScope = catalogMode.mode === 'cwd'
    ? `cwd:${catalogMode.cwd}`
    : catalogMode.mode === 'workspace' ? `workspace:${catalogMode.workspaceId}` : catalogMode.mode;
  const previewProfileFile = useCallback(async (
    request: { readonly path: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<NamedAgentProfile> => {
    const mode = catalogModeRef.current;
    const body = mode.mode === 'cwd'
      ? { path: request.path, cwd: mode.cwd }
      : mode.mode === 'workspace'
        ? { path: request.path, workspace_id: mode.workspaceId }
        : { path: request.path };
    const response = await clientRef.current.previewAgentProfileFile(body, options);
    return response.profile;
  }, [fileScope, connectionKey]);
  const previewIdentityRef = useRef(previewProfileFile);
  previewIdentityRef.current = previewProfileFile;
  const committedPreviewIdentityRef = useRef(previewProfileFile);

  const [resolvedFile, setResolvedFile] = useState<{
    readonly path: string;
    readonly name?: string;
    readonly description?: string;
  }>({ path: '' });
  const [fileForm, setFileForm] = useState<{ readonly open: boolean; readonly path: string }>({ open: false, path: '' });
  const formOpenRef = useRef(fileForm.open);
  formOpenRef.current = fileForm.open;
  const formPathRef = useRef(fileForm.path);
  formPathRef.current = fileForm.path;
  const [check, setCheck] = useState<{
    readonly path: string;
    readonly profile?: NamedAgentProfile;
    readonly error?: string;
  } | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [picking, setPicking] = useState(false);
  const checkFlight = useRef<AbortController | null>(null);
  const checkGeneration = useRef(0);
  const abortCheck = useCallback(() => {
    checkGeneration.current += 1;
    checkFlight.current?.abort();
    checkFlight.current = null;
    setChecking(false);
  }, []);
  useEffect(() => () => { abortCheck(); }, [abortCheck]);
  const attemptedFileReads = useRef(new Set<string>());
  useEffect(() => {
    if (committedPreviewIdentityRef.current === previewProfileFile) return;
    committedPreviewIdentityRef.current = previewProfileFile;
    abortCheck();
    attemptedFileReads.current.clear();
    setCheck(undefined);
    setResolvedFile({ path: '' });
    setPicking(false);
  }, [abortCheck, previewProfileFile]);

  const runCheck = useCallback(async (path: string) => {
    const requestIdentity = previewProfileFile;
    const flightKey = connectionKey;
    if (path === '' || requestIdentity !== previewIdentityRef.current || flightKey !== connectionKeyRef.current || !openRef.current || !formOpenRef.current) return;
    checkFlight.current?.abort();
    const generation = ++checkGeneration.current;
    const controller = new AbortController();
    checkFlight.current = controller;
    setChecking(true);
    setCheck(undefined);
    const current = () => !controller.signal.aborted
      && generation === checkGeneration.current
      && requestIdentity === previewIdentityRef.current
      && flightKey === connectionKeyRef.current
      && openRef.current
      && formOpenRef.current
      && formPathRef.current.trim() === path;
    try {
      const profile = await requestIdentity({ path }, { signal: controller.signal });
      if (current()) setCheck({ path, profile });
    } catch (error) {
      if (current()) setCheck({ path, error: errorText(locale, error) });
    } finally {
      if (checkFlight.current === controller) {
        checkFlight.current = null;
        if (generation === checkGeneration.current && flightKey === connectionKeyRef.current) setChecking(false);
      }
    }
  }, [connectionKey, locale, previewProfileFile]);

  const openFileChooser = useCallback(async () => {
    const requestIdentity = previewProfileFile;
    const flightKey = connectionKey;
    const sameConnection = () => requestIdentity === previewIdentityRef.current && flightKey === connectionKeyRef.current;
    if (!nativePathPicker) {
      formOpenRef.current = true;
      formPathRef.current = choice.profile_file ?? '';
      setFileForm({ open: true, path: formPathRef.current });
      setCheck(undefined);
      return;
    }
    setPicking(true);
    try {
      const path = await host.pickFilePath!();
      if (path === null || path.trim() === '' || !sameConnection() || !openRef.current) return;
      formOpenRef.current = true;
      formPathRef.current = path;
      setFileForm({ open: true, path });
      setCheck(undefined);
      await runCheck(path);
    } catch (error) {
      if (!sameConnection() || !openRef.current) return;
      const path = choice.profile_file ?? '';
      formOpenRef.current = true;
      formPathRef.current = path;
      setFileForm({ open: true, path });
      setCheck({ path, error: errorText(locale, error) });
    } finally {
      if (flightKey === connectionKeyRef.current) setPicking(false);
    }
  }, [choice.profile_file, connectionKey, host, locale, nativePathPicker, previewProfileFile, runCheck]);

  useEffect(() => {
    if (!open) {
      attemptedFileReads.current.clear();
      abortCheck();
      setCheck(undefined);
    }
  }, [abortCheck, open]);
  useEffect(() => {
    const path = choice.profile_file;
    if (!open || path === undefined) return;
    if (attemptedFileReads.current.has(path)) return;
    attemptedFileReads.current.add(path);
    const flightKey = connectionKey;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && flightKey === connectionKeyRef.current;
    void previewProfileFile({ path }, { signal: controller.signal })
      .then((profile) => {
        if (current()) setResolvedFile({ path, name: profile.name, description: profile.description });
      })
      .catch(() => {
        if (current()) setResolvedFile({ path });
      });
    return () => { controller.abort(); };
  }, [open, choice.profile_file, connectionKey, previewProfileFile]);

  const extFacade = useMemo(() => externalClientsFacade(client?.klient), [client]);
  const extClientsQuery = useQuery({
    queryKey: ['external-clients'],
    queryFn: () => extFacade!.list(),
    staleTime: 15_000,
    retry: false,
    enabled: extFacade !== undefined,
  });
  const externalConnections = extClientsQuery.data?.connections ?? [];

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
  const externalEngines = visibleEngines(catalog, profiles,
    engineOverridesOf(configQuery.data), engineDisplayOf(configQuery.data), configuredEngineDescriptors(configQuery.data))
    .filter((item) => item.id !== NATIVE_EXECUTOR);
  const nativeProfiles = profilesByEngine.get(NATIVE_EXECUTOR) ?? [];
  const visibleExternal = externalEngines.filter((item) => matches(item, profilesByEngine.get(item.id) ?? []));
  const externalLabelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of visibleExternal) {
      counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
    }
    return counts;
  }, [visibleExternal]);
  const retainedExternal = !isNativeExecutor(choice.executor) && choice.external_connection_id === undefined
    && !externalEngines.some((item) => item.id === choice.executor)
    && matches({ id: choice.executor, label: engineLabel }, profilesByEngine.get(choice.executor) ?? []);
  const nativeVisible = matches({ id: NATIVE_EXECUTOR, label: nativeLabel }, nativeProfiles);
  const visibleExtConnections = externalConnections.filter((conn) => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return true;
    return conn.name.toLowerCase().includes(needle);
  });
  const nothingMatches = !nativeVisible && visibleExternal.length === 0 && visibleExtConnections.length === 0 && !retainedExternal && choice.profile_file === undefined;
  // Opening the panel can push the trigger out of view, so bring it back.
  useEffect(() => {
    if (open) triggerRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);

  const facts = executionContextFacts(contextGroups, allowKikiSubagents, t);
  const setChoice = (next: ExecutionChoice) => {
    onChange(next);
    close(true);
  };
  // A bound persona names who answers, so the face and the name replace the
  // engine's; the engine stays stated in the panel and the tooltip. A pending
  // switch is never hidden behind a persona: the user is waiting on it.
  // The default native profile reads as the product name, as it always has.
  const resolvedName = resolvedFile.path === choice.profile_file ? resolvedFile.name : undefined;
  const profileText = choice.profile === undefined
    ? (choice.profile_file === undefined ? undefined : (resolvedName ?? profileFileLabel(choice.profile_file)))
    : choice.profile === 'agent' && isNativeExecutor(choice.executor) ? nativeLabel : choice.profile;
  const isExternalClient = choice.external_connection_id !== undefined;
  const checkedProfile = check?.profile;
  const checkedPath = check?.path;
  const useFile = (profile: NamedAgentProfile, path: string) => {
    const source = profile.source_file ?? path;
    setResolvedFile({ path: source, name: profile.name, description: profile.description });
    onChange({ executor: profileExecutor(profile), profile: undefined, profile_file: source, overrides: undefined });
    formOpenRef.current = false;
    formPathRef.current = '';
    setFileForm({ open: false, path: '' });
    setCheck(undefined);
    close(true);
  };
  const triggerText = isExternalClient ? (choice.external_connection_name ?? t('st.section.connectionServices')) : (profileText ?? engineLabel);
  const showPersona = persona !== undefined && !pending;
  const ariaEngine = t('composer.execution.aria', {
    engine: engineLabel,
    profile: choice.profile_file ?? choice.profile ?? t('composer.execution.bare'),
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
        data-execution-profile-file={choice.profile_file}
        data-execution-pending={pending ? 'true' : undefined}
        data-composer-persona-chip={showPersona === true ? persona.id : undefined}
        disabled={disabled}
        title={pending
          ? t('composer.execution.pendingTitle')
          : busy
            ? t('composer.execution.busyTitle')
            : t('composer.execution.title', { engine: engineLabel })}
        aria-label={showPersona === true ? t('persona.chipAria') : ariaEngine}
        onClick={() => {
          if (open) { close(); return; }
          openRef.current = true;
          setOpen(true);
        }}
        className={showPersona === true
          ? 'flex h-7 min-w-0 max-w-44 items-center gap-1.5 rounded-full pr-1.5 pl-1.5 text-[13px] font-medium text-ink outline-none transition-colors hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:opacity-60 pointer-coarse:h-10'
          : `${STATUS_SEGMENT_CLASS} max-w-52 ${pending ? 'pr-5 font-medium text-accent-ink hover:text-accent-ink' : choice.executor !== NATIVE_EXECUTOR || choice.profile !== undefined || choice.profile_file !== undefined || isExternalClient ? STATUS_SEGMENT_SET : ''} disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {showPersona === true
          ? <>
            {persona.avatar}
            <span className="min-w-0 truncate">{persona.name}</span>
          </>
          : <>
            <Icon name={isExternalClient ? 'external' : isNativeExecutor(choice.executor) ? 'agent' : 'terminal'} size={14} className={STATUS_SEGMENT_ICON_CLASS} />
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
          {fileForm.open ? (
            <div data-execution-file-form className="flex flex-col">
              <div className="flex items-center gap-1.5 border-b border-hairline px-2 py-1.5">
                <button
                  type="button"
                  data-execution-file-back
                  aria-label={t('composer.execution.fileBack')}
                  title={t('composer.execution.fileBack')}
                  onClick={() => { abortCheck(); formOpenRef.current = false; formPathRef.current = ''; setFileForm({ open: false, path: '' }); setCheck(undefined); }}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-9 pointer-coarse:w-9"
                >
                  <Icon name="arrowLeft" size={12} />
                </button>
                <span className="min-w-0 truncate text-[12px] font-medium text-ink">{t('composer.execution.fileGroupAria')}</span>
              </div>
              <form
                className="flex flex-col gap-2 p-2.5"
                onSubmit={(event) => { event.preventDefault(); void runCheck(fileForm.path.trim()); }}
              >
                <input
                  type="text"
                  data-execution-file-path
                  value={fileForm.path}
                  onChange={(event) => {
                    abortCheck();
                    formOpenRef.current = true;
                    formPathRef.current = event.target.value;
                    setFileForm({ open: true, path: event.target.value });
                    setCheck(undefined);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    event.stopPropagation();
                    void runCheck(fileForm.path.trim());
                  }}
                  placeholder={t('composer.execution.filePathPlaceholder')}
                  aria-label={t('composer.execution.filePathAria')}
                  className="w-full rounded-md border border-hairline bg-paper px-2 py-1 font-mono text-[12px] text-ink outline-none focus-visible:border-selected-ink placeholder:font-sans placeholder:text-ink-faint"
                />
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-[11px] leading-snug text-ink-faint">{t('composer.execution.fileNote')}</p>
                  <button
                    type="button"
                    data-execution-file-check
                    disabled={checking || fileForm.path.trim() === ''}
                    onClick={() => { void runCheck(fileForm.path.trim()); }}
                    className="shrink-0 rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] text-ink transition-colors hover:border-hairline-strong hover:text-ink focus-visible:border-selected-ink disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('composer.execution.fileCheck')}
                  </button>
                </div>
                {check?.error !== undefined ? (
                  <p role="alert" data-execution-file-error className="break-words text-[12px] leading-snug text-danger">{check.error}</p>
                ) : null}
                {checkedProfile !== undefined && checkedPath !== undefined ? (
                  <div data-execution-file-preview={checkedProfile.name} className="min-w-0 rounded-md border border-hairline bg-paper p-2">
                    <p className="flex min-w-0 items-center gap-1.5">
                      <Icon
                        name={isNativeExecutor(checkedProfile.executor) ? 'agent' : 'terminal'}
                        size={14}
                        className={STATUS_SEGMENT_ICON_CLASS}
                      />
                      <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">{checkedProfile.name}</span>
                      <span className="shrink-0 text-[11px] text-ink-faint">
                        {isNativeExecutor(checkedProfile.executor)
                          ? nativeLabel
                          : (catalog.find((item) => item.id === checkedProfile.executor)?.label ?? checkedProfile.executor)}
                      </span>
                    </p>
                    {checkedProfile.description !== undefined && checkedProfile.description !== '' ? (
                      <p className="mt-0.5 text-[11.5px] leading-snug text-ink-faint">{checkedProfile.description}</p>
                    ) : null}
                    <p className="mt-1 min-w-0 truncate font-mono text-[11px] text-ink-faint">{checkedProfile.source_file ?? checkedPath}</p>
                    <button
                      type="button"
                      data-execution-file-use
                      data-execution-file-apply
                      onClick={() => { useFile(checkedProfile, checkedPath); }}
                      className="mt-2 rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] font-medium text-ink transition-colors hover:border-hairline-strong hover:text-ink focus-visible:border-selected-ink"
                    >
                      {t('composer.execution.fileUse')}
                    </button>
                  </div>
                ) : null}
              </form>
            </div>
          ) : (
            <>
          <div className="flex items-center gap-1 border-b border-hairline px-3 py-2">
            <input
              type="text"
              data-autofocus
              data-execution-filter
              autoFocus
              value={query}
              onChange={(event) => { setQuery(event.target.value); }}
              placeholder={t('composer.execution.searchPlaceholder')}
              aria-label={t('composer.execution.filterAria')}
              className="w-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
            />
            <button
              type="button"
              data-execution-file-open
              data-execution-file-picker={nativePathPicker ? 'native' : 'path'}
              aria-label={t('composer.execution.fileOpen')}
              title={t('composer.execution.fileOpen')}
              disabled={picking || checking}
              onClick={() => { void openFileChooser(); }}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-9 pointer-coarse:w-9 disabled:cursor-wait disabled:opacity-50"
            >
              <Icon name="file" size={12} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {choice.profile_file !== undefined ? (
              <ul role="group" aria-label={t('composer.execution.fileGroupAria')} className="space-y-0.5">
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected
                    data-menu-row
                    data-execution-file-row={choice.profile_file}
                    onClick={() => {
                      formOpenRef.current = true;
                      formPathRef.current = choice.profile_file ?? '';
                      setFileForm({ open: true, path: choice.profile_file ?? '' });
                      setCheck(undefined);
                    }}
                    className={`${MENU_ROW_CLASS} items-start ${MENU_ROW_SELECTED_CLASS}`}
                  >
                    <Check on />
                    <span className="min-w-0 flex-1">
                      <span className="block min-w-0 truncate font-medium text-ink">
                        {resolvedFile.path === choice.profile_file && resolvedFile.name !== undefined
                          ? resolvedFile.name
                          : profileFileLabel(choice.profile_file)}
                      </span>
                      <span className="mt-0.5 block min-w-0 truncate font-mono text-[11px] text-ink-faint">{choice.profile_file}</span>
                      {resolvedFile.path === choice.profile_file && resolvedFile.description !== undefined && resolvedFile.description !== '' ? (
                        <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">{resolvedFile.description}</span>
                      ) : null}
                      {resolvedFile.path === choice.profile_file && resolvedFile.name === undefined ? (
                        <span data-execution-file-unread className="mt-0.5 block text-[11.5px] leading-snug text-danger">
                          {t('composer.execution.fileUnread')}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              </ul>
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
                current={isNativeExecutor(choice.executor) && !isExternalClient}
                bare={choice.profile === undefined && choice.profile_file === undefined}
                profiles={nativeProfiles}
                profile={choice.profile}
                onBare={() => { setChoice({ ...choice, executor: NATIVE_EXECUTOR, profile: undefined, profile_file: undefined, external_connection_id: undefined, external_connection_name: undefined }); }}
                onProfile={(name) => { setChoice({ ...choice, executor: NATIVE_EXECUTOR, profile: name, profile_file: undefined, external_connection_id: undefined, external_connection_name: undefined }); }}
              />
            ) : null}
            {visibleExternal.map((item) => {
              const duplicateLabel = (externalLabelCounts.get(item.label) ?? 0) > 1;
              const hint = duplicateLabel
                ? [item.id, item.version].filter((part) => part !== undefined && part !== '').join(' · ')
                : undefined;
              return (
                <EngineRow
                  key={item.id}
                  id={item.id}
                  label={item.label}
                  hint={hint}
                  current={choice.executor === item.id && !isExternalClient}
                  bare={choice.profile === undefined && choice.profile_file === undefined}
                  profiles={profilesByEngine.get(item.id) ?? []}
                  profile={choice.profile}
                  unavailable={item.status === 'unavailable'}
                  onBare={() => { setChoice({ ...choice, executor: item.id, profile: undefined, profile_file: undefined, external_connection_id: undefined, external_connection_name: undefined }); }}
                  onProfile={(name) => { setChoice({ ...choice, executor: item.id, profile: name, profile_file: undefined, external_connection_id: undefined, external_connection_name: undefined }); }}
                />
              );
            })}
            {retainedExternal ? (
              <div data-execution-restore={choice.executor} className="mx-1 my-2 space-y-1 px-2 py-1.5">
                <p className="text-[12px] leading-snug text-ink-faint">{t(engineItem?.status === 'unavailable' ? 'composer.execution.needsSetup' : 'composer.execution.keptEngine', { engine: engineLabel })}</p>
                <Link to="/settings/ai?tab=providers#st-card-engines" data-execution-configure
                  onClick={() => { close(); }}
                  className="text-[12px] font-medium text-ink underline decoration-dotted underline-offset-2 focus-visible:outline-selected-ink">
                  {t('composer.execution.configure')}
                </Link>
              </div>
            ) : null}
            {/* Independent group for inbound external client connections */}
            {visibleExtConnections.length > 0 ? (
              <div data-execution-external-clients className="mt-1 border-t border-hairline pt-2 pb-1">
                <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                  {t('st.section.connectionServices')}
                </div>
                {visibleExtConnections.map((conn) => {
                  const selected = choice.external_connection_id === conn.id;
                  return (
                    <button
                      key={conn.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      data-menu-row
                      data-execution-external-connection={conn.id}
                      onClick={() => {
                        setChoice({
                          executor: 'external-client',
                          profile: undefined,
                          profile_file: undefined,
                          external_connection_id: conn.id,
                          external_connection_name: conn.name,
                          overrides: undefined,
                        });
                      }}
                      className={`${MENU_ROW_CLASS} items-start ${selected ? MENU_ROW_SELECTED_CLASS : ''}`}
                    >
                      <Check on={selected} />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <Icon name="external" size={12} className="shrink-0 text-ink-soft" />
                          <span className="min-w-0 truncate font-medium text-ink">{conn.name}</span>
                        </span>
                        <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint">
                          {conn.status === 'active' ? t('st.xc.statusActive') : t('st.xc.statusPaused')} · {conn.tools.length} {t('st.xc.tools')}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          {facts.length > 0 ? (
            <div className="flex flex-wrap items-baseline justify-end gap-x-3 gap-y-1 border-t border-hairline px-3 py-2">
              <p data-execution-facts className="flex shrink-0 items-center gap-1 text-[11.5px] text-ink-faint">{facts.join(' · ')}</p>
            </div>
          ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
