import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { ExecutorCatalogItem, NamedAgentProfile } from '@kiki/protocol';
import {
  isNativeExecutor,
  profileExecutor,
  profileFileLabel,
  type ExecutionChoice,
} from '@kiki/session-core/composer';
import { errorText } from '@kiki/session-core/i18n';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import type { AgentProfileCatalogMode } from '../../lib/agentProfileCatalog';
import { useConnection } from '../../state/connection';
import {
  MENU_ROW_CLASS,
  MENU_ROW_SELECTED_CLASS,
  STATUS_SEGMENT_CLASS,
  STATUS_SEGMENT_ICON_CLASS,
  STATUS_SEGMENT_SET,
  useComposerPanelAnchor,
  usePopover,
} from '../ComposerControls';
import { Icon } from '../icons';
import { PersonaAvatar, personaAvatarOf } from '../persona/PersonaAvatar';
import { matchesPersona, sortPersonas, usePersonaList } from '../persona/usePersonas';
import {
  configuredEngineDescriptors,
  engineDisplayOf,
  engineOverridesOf,
  visibleEngines,
} from '../settings/profileEditor/engines';

function Check({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`flex h-[19px] w-3 shrink-0 items-center ${on ? 'text-ink' : 'text-transparent'}`}>
      <Icon name="check" size={12} />
    </span>
  );
}

function formatProfileSource(profile: NamedAgentProfile, locale: string): string | undefined {
  const file = profile.source_file;
  const fileName = file ? profileFileLabel(file) : undefined;
  if (profile.source === 'workspace') {
    return fileName ? `${locale === 'zh' ? '项目' : 'Workspace'} · ${fileName}` : (locale === 'zh' ? '项目' : 'Workspace');
  }
  if (profile.source === 'user') {
    return fileName ? `${locale === 'zh' ? '用户' : 'User'} · ${fileName}` : (locale === 'zh' ? '用户' : 'User');
  }
  if (profile.source === 'builtin') {
    return locale === 'zh' ? '内置' : 'Builtin';
  }
  return fileName;
}

export interface ProfileSelectProps {
  readonly choice: ExecutionChoice;
  readonly pending?: boolean;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (next: ExecutionChoice) => void;
  readonly catalog: readonly ExecutorCatalogItem[];
  readonly profiles: readonly NamedAgentProfile[];
  readonly catalogMode?: AgentProfileCatalogMode;
  readonly pickableProfile?: (profile: NamedAgentProfile) => boolean;
  readonly nativeLabel: string;
  readonly persona?: { readonly id: string; readonly name: string; readonly avatar: ReactNode };
  readonly onClearPersona?: () => void;
  readonly onSelectPersona?: (personaId: string) => void;
  readonly onCancelPending?: () => void;
  readonly boundExecution?: ExecutionChoice;
}

export function ProfileSelect({
  choice,
  pending = false,
  busy = false,
  disabled = false,
  onChange,
  catalog,
  profiles,
  catalogMode = { mode: 'disabled' },
  pickableProfile = () => true,
  nativeLabel,
  persona,
  onClearPersona,
  onSelectPersona,
  onCancelPending,
  boundExecution,
}: ProfileSelectProps) {
  const { t, locale } = useI18n();
  const host = useHost();
  const { client, meta, connectionSource } = useConnection();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const close = useCallback((refocus?: boolean) => {
    openRef.current = false;
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);
  const popoverKeyDown = usePopover(open, close, rootRef, 'composer-profile-select');

  useComposerPanelAnchor(rootRef, open);

  const [openDirection, setOpenDirection] = useState<'up' | 'down'>('up');
  useEffect(() => {
    if (!open) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect && rect.top > 0 && rect.top < 380 && window.innerHeight - rect.bottom > rect.top) {
      setOpenDirection('down');
    } else {
      setOpenDirection('up');
    }
  }, [open]);

  const clientRef = useRef(client);
  clientRef.current = client;

  const serverId = meta?.server_id ?? '';
  const serverIdRef = useRef(serverId);
  serverIdRef.current = serverId;

  const catalogKey = `${catalogMode.mode}:${catalogMode.mode === 'cwd' ? (catalogMode.cwd ?? '') : catalogMode.mode === 'workspace' ? (catalogMode.workspaceId ?? '') : ''}`;
  const catalogKeyRef = useRef(catalogKey);
  catalogKeyRef.current = catalogKey;

  const catalogModeRef = useRef(catalogMode);
  catalogModeRef.current = catalogMode;

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
  }, []);

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

  useEffect(() => {
    abortCheck();
    setCheck(undefined);
    setPicking(false);
    setResolvedFile({ path: '' });
  }, [abortCheck, serverId, catalogKey]);

  const runCheck = useCallback(async (path: string) => {
    if (path === '' || !openRef.current || !formOpenRef.current) return;
    checkFlight.current?.abort();
    const generation = ++checkGeneration.current;
    const controller = new AbortController();
    checkFlight.current = controller;
    setChecking(true);
    setCheck(undefined);
    try {
      const profile = await previewProfileFile({ path }, { signal: controller.signal });
      if (!controller.signal.aborted && generation === checkGeneration.current) {
        setCheck({ path, profile });
      }
    } catch (error) {
      if (!controller.signal.aborted && generation === checkGeneration.current) {
        setCheck({ path, error: errorText(locale, error) });
      }
    } finally {
      if (checkFlight.current === controller) {
        checkFlight.current = null;
        if (generation === checkGeneration.current) setChecking(false);
      }
    }
  }, [locale, previewProfileFile]);

  const isRemote = connectionSource === 'ssh' || connectionSource === 'remote';
  const nativePathPicker = !isRemote && typeof host.pickFilePath === 'function';
  const openFileChooser = useCallback(async () => {
    if (!nativePathPicker) {
      formOpenRef.current = true;
      formPathRef.current = choice.profile_file ?? '';
      setFileForm({ open: true, path: formPathRef.current });
      setCheck(undefined);
      return;
    }
    setPicking(true);
    const startServerId = serverIdRef.current;
    const startCatalogKey = catalogKeyRef.current;
    try {
      const path = await host.pickFilePath!();
      if (serverIdRef.current !== startServerId || catalogKeyRef.current !== startCatalogKey) return;
      if (path === null || path.trim() === '' || !openRef.current) return;
      formOpenRef.current = true;
      formPathRef.current = path;
      setFileForm({ open: true, path });
      setCheck(undefined);
      await runCheck(path);
    } catch (error) {
      if (serverIdRef.current !== startServerId || catalogKeyRef.current !== startCatalogKey) return;
      if (!openRef.current) return;
      const path = choice.profile_file ?? '';
      formOpenRef.current = true;
      formPathRef.current = path;
      setFileForm({ open: true, path });
      setCheck({ path, error: errorText(locale, error) });
    } finally {
      if (serverIdRef.current === startServerId && catalogKeyRef.current === startCatalogKey) {
        setPicking(false);
      }
    }
  }, [choice.profile_file, host, locale, nativePathPicker, runCheck]);

  useEffect(() => {
    if (!open) {
      abortCheck();
      setCheck(undefined);
      setFileForm({ open: false, path: '' });
      setQuery('');
    } else {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
    }
  }, [abortCheck, open]);

  useEffect(() => {
    const path = choice.profile_file;
    if (!open || path === undefined) return;
    const controller = new AbortController();
    void previewProfileFile({ path }, { signal: controller.signal })
      .then((profile) => {
        if (!controller.signal.aborted) setResolvedFile({ path, name: profile.name, description: profile.description });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResolvedFile({ path });
      });
    return () => { controller.abort(); };
  }, [open, choice.profile_file, serverId, catalogKey, previewProfileFile]);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    enabled: typeof client.getConfig === 'function',
    staleTime: 60_000,
  });

  const externalExecutors = useMemo(() => {
    return visibleEngines(
      catalog,
      profiles,
      engineOverridesOf(configQuery.data),
      engineDisplayOf(configQuery.data),
      configuredEngineDescriptors(configQuery.data),
    ).filter((item) => !isNativeExecutor(item.id));
  }, [catalog, profiles, configQuery.data]);

  const candidateProfiles = useMemo(() => {
    return profiles.filter((p) => {
      if (!pickableProfile(p)) return false;
      if (p.disabled === true) return false;
      if (p.source === 'builtin' && (!p.source_file || p.source_file.trim() === '')) return false;
      const pExecutor = profileExecutor(p);
      if (!isNativeExecutor(pExecutor) && !externalExecutors.some((item) => item.id === pExecutor)) return false;
      return true;
    });
  }, [profiles, pickableProfile, externalExecutors]);

  const mainProfiles = useMemo(() => {
    return candidateProfiles.filter((p) => p.main === true);
  }, [candidateProfiles]);

  const otherProfiles = useMemo(() => {
    return candidateProfiles.filter((p) => p.main !== true);
  }, [candidateProfiles]);

  const personasQuery = usePersonaList({ enabled: onSelectPersona !== undefined });
  const allPersonas = useMemo(() => sortPersonas((personasQuery.data ?? []).filter((item) => !item.archived)), [personasQuery.data]);
  const filteredPersonas = useMemo(() => {
    if (allPersonas.length === 0) return [];
    return allPersonas.filter((item) => matchesPersona(item, query));
  }, [allPersonas, query]);

  const filterProfileList = useCallback((list: readonly NamedAgentProfile[]) => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return list;
    return list.filter((p) =>
      `${p.name} ${p.description ?? ''} ${p.when_to_use ?? ''} ${p.source_file ?? ''}`.toLowerCase().includes(needle)
    );
  }, [query]);

  const filteredMainProfiles = useMemo(() => filterProfileList(mainProfiles), [filterProfileList, mainProfiles]);
  const filteredOtherProfiles = useMemo(() => filterProfileList(otherProfiles), [filterProfileList, otherProfiles]);

  const currentExecutorItem = catalog.find((item) => item.id === choice.executor);
  const currentExecutorLabel = isNativeExecutor(choice.executor)
    ? nativeLabel
    : (currentExecutorItem?.label ?? choice.executor);

  const hasFile = choice.profile_file !== undefined && choice.profile_file !== '';
  const isCustomProfile = choice.profile !== undefined && choice.profile !== '' && !(choice.profile === 'agent' && isNativeExecutor(choice.executor));

  const resolvedFileName = resolvedFile.path === choice.profile_file ? resolvedFile.name : undefined;
  const buttonLabel = hasFile
    ? (resolvedFileName ?? profileFileLabel(choice.profile_file!))
    : isCustomProfile
      ? choice.profile
      : currentExecutorLabel;

  const baseTriggerText = buttonLabel;
  const triggerText = pending ? t('composer.execution.pendingSuffix', { name: baseTriggerText }) : baseTriggerText;
  const showPersona = persona !== undefined && !pending;

  const isNativeSelected = isNativeExecutor(choice.executor) && (choice.profile === undefined || choice.profile === '' || choice.profile === 'agent') && !hasFile;

  const isPassthroughMatching = useCallback((id: string, label: string) => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return true;
    return `${id} ${label}`.toLowerCase().includes(needle);
  }, [query]);

  const pickDefault = useCallback(() => {
    onChange({
      ...choice,
      executor: 'native',
      profile: undefined,
      profile_file: undefined,
      overrides: undefined,
      external_connection_id: undefined,
      external_connection_name: undefined,
    });
    close(true);
  }, [choice, onChange, close]);

  const retainedUnavailableExternal = !isNativeExecutor(choice.executor)
    && choice.external_connection_id === undefined
    && !externalExecutors.some((item) => item.id === choice.executor);

  const checkedProfile = check?.profile;
  const checkedPath = check?.path;
  const useFile = (profile: NamedAgentProfile, path: string) => {
    const source = profile.source_file ?? path;
    setResolvedFile({ path: source, name: profile.name, description: profile.description });
    onChange({
      executor: profileExecutor(profile),
      profile: undefined,
      profile_file: source,
      overrides: undefined,
      external_connection_id: undefined,
      external_connection_name: undefined,
    });
    formOpenRef.current = false;
    formPathRef.current = '';
    setFileForm({ open: false, path: '' });
    setCheck(undefined);
    close(true);
  };

  const renderProfileRow = (p: NamedAgentProfile) => {
    const isSelected = choice.profile === p.name && choice.profile_file === undefined;
    const pExecutor = profileExecutor(p);
    const pEngine = catalog.find((item) => item.id === pExecutor);
    const pEngineLabel = isNativeExecutor(pExecutor) ? nativeLabel : (pEngine?.label ?? pExecutor);
    const pModel = p.pinned_model_alias;
    const pEffort = p.thinking_effort;
    const comboPreview = pModel
      ? [pEngineLabel, pModel, pEffort].filter(Boolean).join(' · ')
      : `${pEngineLabel} · ${t('composer.engineModelDefault')}`;
    const sourceLabel = formatProfileSource(p, locale);

    return (
      <li key={p.name} data-execution-engine={pExecutor}>
        <button
          type="button"
          role="option"
          aria-selected={isSelected}
          data-menu-row
          data-execution-profile={p.name}
          data-option-value={p.name}
          onClick={() => {
            onChange({
              executor: pExecutor,
              profile: p.name,
              profile_file: undefined,
              overrides: undefined,
              external_connection_id: undefined,
              external_connection_name: undefined,
            });
            close(true);
          }}
          className={`${MENU_ROW_CLASS} items-start ${isSelected ? MENU_ROW_SELECTED_CLASS : ''}`}
        >
          <Check on={isSelected} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center justify-between gap-1.5">
              <span className="min-w-0 truncate font-medium text-ink">{p.name}</span>
              {sourceLabel ? (
                <span className="shrink-0 text-[11px] text-ink-faint">{sourceLabel}</span>
              ) : null}
            </span>
            {p.description !== undefined && p.description !== '' ? (
              <span className="mt-0.5 block truncate text-[11.5px] leading-snug text-ink-faint">
                {p.description}
              </span>
            ) : null}
            <span className="mt-0.5 block truncate text-[11.5px] leading-snug text-ink-faint">
              {comboPreview}
            </span>
          </span>
        </button>
      </li>
    );
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape/arrow handling
    <div ref={rootRef} className="relative min-w-0" data-profile-select onKeyDown={(e) => {
      if (e.key === 'Escape' && open) {
        e.stopPropagation();
        close(true);
      } else {
        popoverKeyDown(e);
      }
    }}>
      <button
        ref={triggerRef}
        type="button"
        role="button"
        aria-haspopup="true"
        aria-expanded={open}
        id="composer-profile-select"
        data-profile-trigger
        data-execution-profile-file={choice.profile_file}
        data-execution-pending={pending ? 'true' : undefined}
        data-profile-badge={isCustomProfile ? 'true' : undefined}
        data-profile-file-badge={hasFile ? 'true' : undefined}
        data-composer-persona-chip={showPersona === true ? persona.id : undefined}
        disabled={disabled}
        title={pending
          ? t('composer.execution.pendingTitle')
          : busy
            ? t('composer.execution.busyTitle')
            : triggerText}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
        className={showPersona === true
          ? 'flex h-7 min-w-0 max-w-44 items-center gap-1.5 rounded-full pr-1.5 pl-1.5 text-[13px] font-medium text-ink outline-none transition-colors hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:opacity-60 pointer-coarse:h-10'
          : `${STATUS_SEGMENT_CLASS} max-w-52 ${pending ? 'pr-5 font-medium text-accent-ink hover:text-accent-ink' : choice.profile !== undefined || choice.profile_file !== undefined ? STATUS_SEGMENT_SET : ''} disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {showPersona === true ? (
          <>
            {persona.avatar}
            <span className="min-w-0 truncate">{persona.name}</span>
          </>
        ) : (
          <>
            <Icon name="agent" size={14} className={STATUS_SEGMENT_ICON_CLASS} />
            <span className="min-w-0 truncate @max-[24rem]/toolbar:sr-only">
              {triggerText}
            </span>
          </>
        )}
      </button>

      {pending && onCancelPending !== undefined ? (
        <button
          type="button"
          data-execution-cancel-pending
          aria-label={t('composer.execution.cancelPending')}
          title={t('composer.execution.cancelPending')}
          onClick={() => { onCancelPending(); }}
          className="absolute top-1/2 right-1.5 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-accent-ink transition-colors hover:bg-accent-ink/[0.08] focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-8 pointer-coarse:w-8"
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
          ref={panelRef}
          data-execution-panel
          role="radiogroup"
          aria-label="Profile"
          className={`anim-enter absolute left-0 z-50 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-[var(--radius-card)] border border-hairline bg-paper text-ink shadow-lg ${openDirection === 'up' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}
          style={{ backgroundColor: 'var(--color-paper)' }}
        >
          {fileForm.open ? (
            <div data-execution-file-form className="flex flex-col">
              <div className="flex items-center gap-1.5 border-b border-hairline px-2.5 py-1.5">
                <button
                  type="button"
                  data-execution-file-back
                  aria-label={t('composer.execution.fileBack')}
                  onClick={() => {
                    abortCheck();
                    formOpenRef.current = false;
                    formPathRef.current = '';
                    setFileForm({ open: false, path: '' });
                    setCheck(undefined);
                  }}
                  className="rounded p-1 text-ink-soft transition-colors hover:bg-paper hover:text-ink focus-visible:border-selected-ink"
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
              <div className="border-b border-hairline p-2">
                <input
                  ref={searchInputRef}
                  type="text"
                  data-execution-filter
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); }}
                  placeholder={t('composer.profile.searchPlaceholder')}
                  aria-label={t('composer.execution.filterAria')}
                  className="w-full rounded-md border border-hairline bg-paper px-2.5 py-1 text-[12.5px] text-ink outline-none focus-visible:border-selected-ink placeholder:text-ink-faint"
                />
              </div>

              <div className="flex-1 overflow-y-auto p-1 max-h-[min(var(--cp-max-h,24rem),24rem)] space-y-2">
                {retainedUnavailableExternal ? (
                  <div data-execution-restore={choice.executor} className="mx-1 my-1 space-y-1 px-2.5 py-1.5 rounded border border-hairline bg-surface/40">
                    <p className="text-[11.5px] leading-snug text-ink-faint">
                      {t(
                        currentExecutorItem?.status === 'unavailable'
                          ? 'composer.execution.needsSetup'
                          : 'composer.execution.keptEngine',
                        { engine: currentExecutorLabel },
                      )}
                    </p>
                    <Link
                      to="/settings/ai?tab=providers#st-card-engines"
                      data-execution-configure
                      onClick={() => { close(); }}
                      className="text-[11.5px] font-medium text-ink underline decoration-dotted underline-offset-2"
                    >
                      {t('composer.execution.configure')}
                    </Link>
                  </div>
                ) : null}

                {/* Group 1: 内置直通（默认） */}
                <div>
                  <div className="px-3 pt-1 pb-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                    {t('composer.profileGroupPassthrough')}
                  </div>
                  <ul className="space-y-0.5">
                    {/* Native passthrough */}
                    {isPassthroughMatching('native', nativeLabel) ? (
                      <li>
                        <button
                          type="button"
                          role="option"
                          aria-selected={isNativeSelected ? 'true' : 'false'}
                          data-menu-row
                          data-profile-unspecified
                          data-execution-bare="native"
                          data-option-value=""
                          data-execution-passthrough="native"
                          onClick={pickDefault}
                          className={`${MENU_ROW_CLASS} items-start ${isNativeSelected ? MENU_ROW_SELECTED_CLASS : ''}`}
                        >
                          <Check on={isNativeSelected} />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center justify-between gap-1.5">
                              <span className="block min-w-0 truncate font-medium text-ink">{nativeLabel}</span>
                              <span className="shrink-0 text-[11px] text-ink-faint">{t('composer.profilePassthroughBadge')}</span>
                            </span>
                            <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">
                              {t('composer.execution.nativeBareHint') || (locale === 'zh' ? '使用默认系统提示与引擎设置' : 'Use default system prompt and engine settings')}
                            </span>
                          </span>
                        </button>
                      </li>
                    ) : null}

                    {/* External engines passthrough */}
                    {externalExecutors.map((item) => {
                      if (!isPassthroughMatching(item.id, item.label)) return null;
                      if (item.status === 'unavailable' && choice.executor === item.id) {
                        return null;
                      }
                      const isSelected = choice.executor === item.id && (choice.profile === undefined || choice.profile === '') && !hasFile;
                      const usable = item.status !== 'unavailable';
                      return (
                        <li key={item.id} data-execution-engine={item.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={isSelected ? 'true' : 'false'}
                            data-menu-row
                            data-execution-engine={item.id}
                            data-execution-bare={item.id}
                            data-execution-passthrough={item.id}
                            data-option-value={item.id}
                            disabled={!usable && choice.executor !== item.id}
                            onClick={() => {
                              onChange({
                                ...choice,
                                executor: item.id,
                                profile: undefined,
                                profile_file: undefined,
                                overrides: undefined,
                                external_connection_id: undefined,
                                external_connection_name: undefined,
                              });
                              close(true);
                            }}
                            className={`${MENU_ROW_CLASS} items-start ${isSelected ? MENU_ROW_SELECTED_CLASS : ''} ${!usable && choice.executor !== item.id ? 'opacity-60 cursor-not-allowed' : ''}`}
                          >
                            <Check on={isSelected} />
                            <span className="min-w-0 flex-1">
                              <span className="flex min-w-0 items-center justify-between gap-1.5">
                                <span className="block min-w-0 truncate font-medium text-ink">{item.label}</span>
                                <span className="shrink-0 text-[11px] text-ink-faint">{t('composer.profilePassthroughBadge')}</span>
                              </span>
                              {item.status === 'unavailable' ? (
                                <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">
                                  {t('composer.execution.needsSetup', { engine: item.label })}
                                </span>
                              ) : (
                                <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">
                                  {item.version ? `${item.id} · ${item.version}` : item.id}
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {/* Group 2: 自定义 Profile */}
                <div className="border-t border-hairline pt-1">
                  <div className="px-3 pt-1 pb-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                    {t('composer.profileGroupCustom')}
                  </div>
                  <ul className="space-y-0.5">
                    {/* Active Profile File Row if chosen */}
                    {choice.profile_file !== undefined ? (
                      <li>
                        <button
                          type="button"
                          role="option"
                          aria-selected
                          data-menu-row
                          data-execution-file-row={choice.profile_file}
                          onClick={() => { close(true); }}
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
                    ) : null}

                    {/* Retained built-in profile from previous session / read-only */}
                    {(() => {
                      const retainedProfile = (boundExecution?.profile !== undefined && boundExecution.profile_file === undefined && !candidateProfiles.some((p) => p.name === boundExecution.profile))
                        ? boundExecution.profile
                        : undefined;
                      if (!retainedProfile) return null;
                      const isSelected = choice.profile === retainedProfile && choice.profile_file === undefined;
                      return (
                        <li key={retainedProfile} data-profile-retained={retainedProfile}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={isSelected ? 'true' : 'false'}
                            data-execution-profile={retainedProfile}
                            onClick={() => {
                              onChange({
                                ...choice,
                                executor: boundExecution?.executor ?? choice.executor,
                                profile: retainedProfile,
                                profile_file: undefined,
                                external_connection_id: undefined,
                                external_connection_name: undefined,
                              });
                              close(true);
                            }}
                            className={`${MENU_ROW_CLASS} items-start ${isSelected ? MENU_ROW_SELECTED_CLASS : ''}`}
                          >
                            <Check on={isSelected} />
                            <span className="min-w-0 flex-1">
                              <span className="block min-w-0 truncate font-medium text-ink">
                                {retainedProfile === 'agent' && isNativeExecutor(boundExecution?.executor ?? choice.executor) ? nativeLabel : retainedProfile}
                              </span>
                              <span className="mt-0.5 block text-[11px] text-ink-faint">
                                {t('composer.profile.retained')}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })()}

                    {/* Filtered Main Profiles */}
                    {filteredMainProfiles.map(renderProfileRow)}

                    {/* Filtered Other Profiles */}
                    {filteredOtherProfiles.map(renderProfileRow)}

                    {filteredMainProfiles.length === 0 && filteredOtherProfiles.length === 0 && (onSelectPersona === undefined || filteredPersonas.length === 0) && query.trim() !== '' ? (
                      <li className="px-3 py-4 text-center text-[12px] text-ink-faint">
                        {t('composer.execution.noMatch', { query: query.trim() })}
                      </li>
                    ) : null}

                    {/* Pick from file button */}
                    <li className="mt-1 border-t border-hairline pt-1">
                      <button
                        type="button"
                        data-execution-file-open
                        data-execution-file-picker={nativePathPicker ? 'native' : 'path'}
                        disabled={picking}
                        onClick={() => { void openFileChooser(); }}
                        className={`${MENU_ROW_CLASS} text-ink-soft hover:text-ink disabled:opacity-50`}
                      >
                        <span aria-hidden className="flex h-[19px] w-3 shrink-0 items-center text-ink-soft">
                          <Icon name="file" size={12} />
                        </span>
                        <span className="min-w-0 truncate font-medium">{t('composer.execution.fileOpen')}</span>
                      </button>
                    </li>
                  </ul>
                </div>

                {/* Group 3: 角色 (Personas) */}
                {onSelectPersona !== undefined ? (
                  <div className="border-t border-hairline pt-1">
                    <div className="px-3 pt-1 pb-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                      {t('persona.title')}
                    </div>
                    {personasQuery.isPending && personasQuery.data === undefined ? (
                      <p className="px-3 py-2 text-[12px] text-ink-faint">
                        {t('persona.loading')}
                      </p>
                    ) : personasQuery.isError && (personasQuery.data === undefined || personasQuery.data.length === 0) ? (
                      <div className="px-3 py-2 space-y-1">
                        <p className="text-[12px] text-danger">{t('persona.loadFailed')}</p>
                        <button
                          type="button"
                          onClick={() => { void personasQuery.refetch(); }}
                          className="text-[11.5px] font-medium text-ink underline decoration-dotted underline-offset-2"
                        >
                          {t('common.retry')}
                        </button>
                      </div>
                    ) : allPersonas.length === 0 ? (
                      <p className="px-3 py-2 text-[12px] text-ink-faint">
                        {t('persona.empty')}
                      </p>
                    ) : (
                      <ul className="space-y-0.5">
                        {filteredPersonas.map((item) => {
                          const isSelected = persona?.id === item.id;
                          const subline = [item.title, item.job].filter(Boolean).join(' · ');
                          return (
                            <li key={item.id} data-composer-persona-option={item.id}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={isSelected ? 'true' : 'false'}
                                data-menu-row
                                data-persona-id={item.id}
                                data-option-value={item.id}
                                onClick={() => {
                                  onSelectPersona(item.id);
                                  close(true);
                                }}
                                className={`${MENU_ROW_CLASS} items-start ${isSelected ? MENU_ROW_SELECTED_CLASS : ''}`}
                              >
                                <Check on={isSelected} />
                                <PersonaAvatar
                                  persona={personaAvatarOf(item)}
                                  size={20}
                                  decorative
                                  className="!rounded-full shrink-0 mt-0.5"
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block min-w-0 truncate font-medium text-ink">
                                    {item.name}
                                  </span>
                                  {subline ? (
                                    <span className="mt-0.5 block truncate text-[11.5px] leading-snug text-ink-faint">
                                      {subline}
                                    </span>
                                  ) : null}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                        {filteredPersonas.length === 0 && query.trim() !== '' ? (
                          <li className="px-3 py-1.5 text-[12px] text-ink-faint">
                            {t('composer.execution.noMatch', { query: query.trim() })}
                          </li>
                        ) : null}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
