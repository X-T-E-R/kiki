/**
 * Unified Skills management surface — shared across `/capabilities?tab=skills`
 * and `Settings -> Extensions -> Skills`.
 *
 * One sticky toolbar holds instant search, source filter pills with counts,
 * density toggle, and the collapsible Sources & folders panel (`merge_all_available_skills`,
 * `builtin_product_skills`, and `extra_skill_dirs`). Every skill row supports
 * viewing `SKILL.md`, copying `/command`, opening its local folder on desktop,
 * jumping to its owning plugin, and toggling per-skill `disabled_skills` state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { SkillDescriptor } from '@kiki/protocol';
import { errorText, issueText } from '@kiki/session-core/i18n';
import {
  appendExtraSkillDirs,
  markRestartRequired,
  readLastSessionId,
  validateExtraSkillDirs,
} from '@kiki/session-core/settings';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { SKILL_GROUP_ORDER, skillGroupId, type SkillGroupId } from '../../lib/capabilities';
import { copyTextToClipboard } from '../../lib/clipboard';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { FeedbackLine, InlineError, Toggle, type Feedback } from '../controls';
import { Icon } from '../icons';
import { MediaPreviewProvider } from '../mediaPreview';
import { useMediaPreview } from '../mediaPreviewContext';
import { SettingsDraftFooter, SettingsLoadFailure } from '../settings/SettingsPrimitives';
import { useSavedTick } from '../settings/useSavedTick';
import {
  groupItems,
  LIST_ROW_HEIGHT,
  ListBody,
  ListEmpty,
  ListGroup,
  ListToolbar,
  useListView,
  type ListDensity,
  type ListFilterSpec,
} from '../settings/list';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { EmptyNote, Tag } from './primitives';

const GROUP_TITLE_KEYS: Record<SkillGroupId, 'cap.group.plugin' | 'cap.group.project' | 'cap.group.user' | 'cap.group.extra' | 'cap.group.builtin' | 'cap.group.other'> = {
  plugin: 'cap.group.plugin',
  project: 'cap.group.project',
  user: 'cap.group.user',
  extra: 'cap.group.extra',
  builtin: 'cap.group.builtin',
  other: 'cap.group.other',
};

const JUMP_LABEL_KEYS: Record<SkillGroupId, 'cap.source.plugin' | 'cap.source.project' | 'cap.source.user' | 'cap.source.extra' | 'cap.source.builtin' | 'cap.skills.source.other'> = {
  plugin: 'cap.source.plugin',
  project: 'cap.source.project',
  user: 'cap.source.user',
  extra: 'cap.source.extra',
  builtin: 'cap.source.builtin',
  other: 'cap.skills.source.other',
};

function normalizeSkillKey(name: string): string {
  return name.trim().toLowerCase();
}

function pluginIdFromSkill(skill: SkillDescriptor): string | undefined {
  if (skill.plugin_id !== undefined && skill.plugin_id !== '') return skill.plugin_id;
  const match = /[\\/]plugins[\\/](?:managed[\\/])?([^\\/]+)[\\/]/.exec(skill.path);
  return match?.[1];
}

function findScrollContainer(anchor: HTMLElement | null): HTMLElement | null {
  if (anchor === null) return null;
  const marked = anchor.closest<HTMLElement>('[data-settings-scroll]');
  if (marked !== null) return marked;
  for (let node = anchor.parentElement; node !== null; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      return node;
    }
  }
  return null;
}

export function SkillsView({
  workspaceId,
  onOpenPlugin,
  defaultSourcesOpen = false,
  openSourcesRequest,
  inSettings = false,
}: {
  readonly workspaceId: string;
  /** Plugin-sourced skills link to their plugin when the host can show it. */
  readonly onOpenPlugin?: (pluginId: string) => void;
  readonly defaultSourcesOpen?: boolean;
  /** Monotonic request counter from Capabilities header Add menu to open Sources & folders. */
  readonly openSourcesRequest?: number;
  readonly inSettings?: boolean;
}) {
  const existingPreview = useMediaPreview();
  const content = (
    <SkillsViewInner
      workspaceId={workspaceId}
      onOpenPlugin={onOpenPlugin}
      defaultSourcesOpen={defaultSourcesOpen}
      openSourcesRequest={openSourcesRequest}
      inSettings={inSettings}
    />
  );
  if (existingPreview !== null) return content;
  return (
    <MediaPreviewProvider sessionId={readLastSessionId() ?? undefined} registerSessionOpener={false}>
      {content}
    </MediaPreviewProvider>
  );
}

function SkillsViewInner({
  workspaceId,
  onOpenPlugin,
  defaultSourcesOpen,
  openSourcesRequest,
  inSettings,
}: {
  readonly workspaceId: string;
  readonly onOpenPlugin?: (pluginId: string) => void;
  readonly defaultSourcesOpen: boolean;
  readonly openSourcesRequest?: number;
  readonly inSettings: boolean;
}) {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const preview = useMediaPreview();
  const rootRef = useRef<HTMLDivElement>(null);
  const handledSourcesRequestRef = useRef(0);
  const pendingJumpGroupRef = useRef<string | null>(null);
  const canManageConfig = typeof client.getConfig === 'function' && typeof client.patchConfig === 'function';

  const [sourcesOpen, setSourcesOpen] = useState(defaultSourcesOpen);
  const [togglingSkills, setTogglingSkills] = useState<Readonly<Record<string, boolean>>>({});
  const [optimisticEnabled, setOptimisticEnabled] = useState<Readonly<Record<string, boolean>>>({});

  useEffect(() => {
    if (openSourcesRequest === undefined || openSourcesRequest === 0 || openSourcesRequest === handledSourcesRequestRef.current) return;
    handledSourcesRequestRef.current = openSourcesRequest;
    if (!canManageConfig) return;
    setSourcesOpen(true);
    requestAnimationFrame(() => {
      const panel = rootRef.current?.querySelector<HTMLElement>('[data-skills-sources-panel]');
      panel?.scrollIntoView?.({ block: 'nearest' });
    });
  }, [canManageConfig, openSourcesRequest]);

  const skillsQuery = useQuery({
    queryKey: ['workspace-skills', workspaceId],
    queryFn: () => client.listWorkspaceSkills(workspaceId),
    enabled: workspaceId !== '',
    staleTime: 60_000,
  });

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    enabled: canManageConfig,
    staleTime: 60_000,
  });

  const allSkills = useMemo(() => skillsQuery.data?.skills ?? [], [skillsQuery.data]);

  const disabledSkillSet = useMemo(() => {
    const set = new Set<string>();
    for (const entry of configQuery.data?.disabled_skills ?? []) {
      const normalized = normalizeSkillKey(entry);
      if (normalized !== '') set.add(normalized);
    }
    return set;
  }, [configQuery.data?.disabled_skills]);

  const isSkillEnabled = useCallback((skill: SkillDescriptor): boolean => {
    const normalized = normalizeSkillKey(skill.name);
    if (Object.hasOwn(optimisticEnabled, normalized)) {
      return optimisticEnabled[normalized]!;
    }
    if (configQuery.data?.disabled_skills !== undefined) {
      return !disabledSkillSet.has(normalized);
    }
    return skill.enabled !== false;
  }, [configQuery.data?.disabled_skills, disabledSkillSet, optimisticEnabled]);

  const toggleSkillEnabled = async (skill: SkillDescriptor, nextEnabled: boolean) => {
    if (!canManageConfig) return;
    const key = normalizeSkillKey(skill.name);
    if (key === '' || togglingSkills[key]) return;
    setTogglingSkills((prev) => ({ ...prev, [key]: true }));
    setOptimisticEnabled((prev) => ({ ...prev, [key]: nextEnabled }));

    const currentRaw = configQuery.data?.disabled_skills
      ?? allSkills.filter((item) => item.enabled === false).map((item) => item.name);
    const seen = new Set<string>();
    const nextDisabled: string[] = [];
    for (const entry of currentRaw) {
      const norm = normalizeSkillKey(entry);
      if (norm === '' || seen.has(norm)) continue;
      if (nextEnabled && norm === key) continue;
      seen.add(norm);
      nextDisabled.push(entry.trim());
    }
    if (!nextEnabled && !seen.has(key)) {
      nextDisabled.push(skill.name.trim());
    }

    try {
      const echoed = await client.patchConfig({
        disabled_skills: nextDisabled,
        replace_domains: ['disabled_skills'],
      });
      queryClient.setQueryData(['config'], echoed);
      await queryClient.invalidateQueries({ queryKey: ['workspace-skills'] });
    } catch (error) {
      pushToast({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setOptimisticEnabled((prev) => {
        if (!Object.hasOwn(prev, key)) return prev;
        const copy = { ...prev };
        delete copy[key];
        return copy;
      });
      setTogglingSkills((prev) => {
        const copy = { ...prev };
        delete copy[key];
        return copy;
      });
    }
  };

  const keyOf = (skill: SkillDescriptor) => `${skill.source}:${skill.path}`;
  const textOf = (skill: SkillDescriptor) => [skill.name, skill.description, skill.path];
  const filters = useMemo<readonly ListFilterSpec<SkillDescriptor>[]>(() => {
    const present = new Set(allSkills.map((skill) => skillGroupId(skill.source, skill.plugin_id)));
    return SKILL_GROUP_ORDER.filter((id) => present.has(id)).map((id) => ({
      id,
      label: t(JUMP_LABEL_KEYS[id]),
      test: (skill: SkillDescriptor) => skillGroupId(skill.source, skill.plugin_id) === id,
    }));
  }, [allSkills, t]);

  const baseView = useListView({ listId: 'cap-skills', items: allSkills, keyOf, textOf, filters });
  const [shortQuery, setShortQuery] = useState('');
  const view = useMemo(() => {
    if (baseView.tools.search) return baseView;
    const needles = shortQuery.trim().toLowerCase().split(/\s+/).filter((word) => word !== '');
    const visible = needles.length === 0
      ? baseView.visible
      : baseView.visible.filter((skill) => {
        const hay = textOf(skill).filter((part): part is string => part !== undefined && part !== '').join('\n').toLowerCase();
        return needles.every((needle) => hay.includes(needle));
      });
    return {
      ...baseView,
      query: shortQuery,
      setQuery: setShortQuery,
      visible,
      narrowed: baseView.narrowed || needles.length > 0,
      clear: () => {
        setShortQuery('');
        baseView.clear();
      },
    };
  }, [baseView, shortQuery]);
  useEffect(() => {
    if (baseView.tools.search && shortQuery !== '') setShortQuery('');
  }, [baseView.tools.search, shortQuery]);
  const toolbarView = useMemo(() => ({
    ...view,
    tools: {
      ...view.tools,
      search: allSkills.length > 0,
      filters: false,
      filterIds: [],
    },
  }), [allSkills.length, view]);

  const groups = useMemo(
    () => groupItems(allSkills, view.visible, (skill) => {
      const id = skillGroupId(skill.source, skill.plugin_id);
      return [{ key: id, label: t(GROUP_TITLE_KEYS[id]) }];
    }, SKILL_GROUP_ORDER),
    [allSkills, view.visible, t],
  );

  const visibleGroups = useMemo(
    () => (view.narrowed ? groups.filter((group) => group.items.length > 0) : groups),
    [groups, view.narrowed],
  );

  const enabledCount = useMemo(
    () => allSkills.reduce((sum, skill) => sum + (isSkillEnabled(skill) ? 1 : 0), 0),
    [allSkills, isSkillEnabled],
  );

  const scrollGroupIntoView = useCallback((groupKey: string) => {
    const root = rootRef.current;
    if (root === null) return;
    const section = root.querySelector<HTMLElement>(`[data-list-group="${groupKey}"]`);
    if (section === null) return;
    const toggle = section.querySelector<HTMLButtonElement>(`[data-list-group-toggle="${groupKey}"]`);
    const align = () => {
      const scroller = findScrollContainer(root);
      if (scroller !== null) {
        const toolbar = root.querySelector<HTMLElement>('[data-list-toolbar]');
        const toolbarHeight = toolbar !== null ? Math.round(toolbar.getBoundingClientRect().height) : 0;
        const scrollerRect = scroller.getBoundingClientRect();
        const sectionRect = section.getBoundingClientRect();
        const targetTop = Math.max(0, Math.round(scroller.scrollTop + sectionRect.top - scrollerRect.top - toolbarHeight - 8));
        scroller.scrollTo({ top: targetTop, behavior: 'auto' });
      } else {
        section.scrollIntoView?.({ block: 'start' });
      }
    };
    align();
    toggle?.focus({ preventScroll: true });
    // Preceding virtualized groups settle their measured row heights after a scroll jump;
    // one follow-up frame keeps the actual labelled heading pinned cleanly below the toolbar.
    requestAnimationFrame(() => {
      align();
    });
  }, []);

  const jumpToGroup = (groupKey: string) => {
    if (view.isFolded(groupKey)) {
      pendingJumpGroupRef.current = groupKey;
      view.toggleFold(groupKey);
      return;
    }
    scrollGroupIntoView(groupKey);
  };

  useEffect(() => {
    const target = pendingJumpGroupRef.current;
    if (target === null || view.isFolded(target)) return;
    pendingJumpGroupRef.current = null;
    scrollGroupIntoView(target);
  });

  const prevQueryRef = useRef(view.query);
  useEffect(() => {
    if (prevQueryRef.current === view.query) return;
    prevQueryRef.current = view.query;
    const scroller = findScrollContainer(rootRef.current);
    if (scroller !== null && scroller.scrollTop > 0) {
      scroller.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [view.query]);

  const openSkillDoc = (skill: SkillDescriptor) => {
    if (skill.source === 'builtin') preview?.openBuiltinSkill(skill.name);
    else preview?.openFile(skill.path);
  };

  const extraDirCount = configQuery.data?.extra_skill_dirs?.length ?? 0;
  const sourcesTrigger = canManageConfig ? (
    <button
      type="button"
      data-skills-sources-toggle
      aria-expanded={sourcesOpen}
      aria-label={t('st.caps.sourcesButton')}
      title={t('st.caps.sourcesButton')}
      onClick={() => { setSourcesOpen((open) => !open); }}
      className={`${SECONDARY_BUTTON} inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3 pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${
        sourcesOpen ? 'bg-ink/[0.08] text-ink' : ''
      }`}
    >
      <Icon name="folder" size={14} className="text-ink-soft" />
      <span className="hidden sm:inline">{t('st.caps.sourcesButton')}</span>
      {extraDirCount > 0 ? (
        <span className="rounded bg-ink/[0.06] px-1 text-[11px] text-ink-soft tabular-nums">{extraDirCount}</span>
      ) : null}
    </button>
  ) : null;

  return (
    <div
      ref={rootRef}
      className="min-w-0 space-y-3"
      data-skills-view
      data-in-settings={inSettings ? '' : undefined}
    >
      {allSkills.length > 0 ? (
        <ListToolbar
          view={toolbarView}
          total={allSkills.length}
          filters={filters}
          actions={sourcesTrigger}
          searchLabel={t('cap.skills.search')}
          searchPlaceholder={t('cap.skills.searchCount', { count: allSkills.length })}
        />
      ) : sourcesTrigger !== null ? (
        <div className="flex items-center justify-end">{sourcesTrigger}</div>
      ) : null}

      {allSkills.length > 0 && visibleGroups.length > 0 ? (
        <div
          data-skills-shelf-rail
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-hairline/70 pb-2.5 text-[12px]"
        >
          <span
            data-skills-shelf-scope={view.narrowed ? 'filtered' : 'workspace'}
            className="shrink-0 text-ink-faint tabular-nums"
          >
            {view.narrowed
              ? tp('cap.skills.matches', view.visible.length, { total: allSkills.length })
              : `${t('cap.workspace')} · ${t('cap.state.on')} ${enabledCount}/${allSkills.length}`}
          </span>
          <nav
            aria-label={t('cap.skills.sourceFilter')}
            data-skills-jump-rail
            className="-mx-2 flex min-w-0 flex-wrap items-center gap-0.5 sm:mx-0 sm:-mr-2"
          >
            {visibleGroups.map((group) => {
              const id = group.key as SkillGroupId;
              const label = t(JUMP_LABEL_KEYS[id]);
              return (
                <button
                  key={group.key}
                  type="button"
                  data-skills-jump={group.key}
                  onClick={() => { jumpToGroup(group.key); }}
                  className="inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
                >
                  <span>{label}</span>
                  <span className="text-[11.5px] text-ink-faint tabular-nums">
                    {view.narrowed ? `${group.items.length}/${group.total}` : group.items.length}
                  </span>
                </button>
              );
            })}
          </nav>
        </div>
      ) : null}

      {sourcesOpen && canManageConfig ? <SkillsSourcesPanel /> : null}

      {workspaceId === '' ? (
        <EmptyNote
          title={t('cap.noWorkspace')}
          body={t('cap.noWorkspaceBody')}
          action={(
            <Link
              to="/new"
              className="inline-flex min-h-8 items-center rounded-md bg-ink/[0.06] px-3 text-[13px] text-ink hover:bg-ink/[0.1] focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              {t('cap.openWorkspace')}
            </Link>
          )}
        />
      ) : skillsQuery.isPending ? (
        <p className="text-[13px] text-ink-faint" role="status">{t('cap.loadingSkills')}</p>
      ) : skillsQuery.isError ? (
        <SettingsLoadFailure
          message={errorText(locale, skillsQuery.error)}
          retrying={skillsQuery.isFetching}
          onRetry={() => { void skillsQuery.refetch(); }}
        />
      ) : allSkills.length === 0 ? (
        <ListEmpty kind="none" title={t('cap.skills.none')} body={t('cap.skills.noneBody')} />
      ) : view.visible.length === 0 ? (
        <ListEmpty
          kind="no-match"
          title={t('cap.skills.noMatchTitle')}
          body={view.query.trim() !== '' ? t('cap.emptyFilter', { query: view.query.trim() }) : undefined}
          onClear={view.clear}
        />
      ) : (
        visibleGroups.map((group) => (
          <ListGroup
            key={group.key}
            groupKey={group.key}
            label={group.label}
            count={group.items.length}
            total={group.total}
            folded={view.isFolded(group.key)}
            onToggle={() => { view.toggleFold(group.key); }}
          >
            <ListBody
              items={group.items}
              keyOf={keyOf}
              density={view.density}
              label={group.label}
              renderRow={(skill) => {
                const enabled = isSkillEnabled(skill);
                const toggling = Boolean(togglingSkills[normalizeSkillKey(skill.name)]);
                return (
                  <SkillRow
                    skill={skill}
                    density={view.density}
                    enabled={enabled}
                    toggling={toggling}
                    canToggle={canManageConfig}
                    canPreview={preview !== null}
                    onOpen={() => { openSkillDoc(skill); }}
                    onToggleEnabled={(next) => { void toggleSkillEnabled(skill, next); }}
                    onOpenPlugin={group.key === 'plugin' ? onOpenPlugin : undefined}
                  />
                );
              }}
            />
          </ListGroup>
        ))
      )}
    </div>
  );
}

function SkillsSourcesPanel() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const host = useHost();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canPickDirs = host.pickDirectories !== undefined;

  const [mergeSkills, setMergeSkills] = useState(true);
  const [builtinProductSkills, setBuiltinProductSkills] = useState(true);
  const [extraDirs, setExtraDirs] = useState('');
  const [baseline, setBaseline] = useState<{ merge: boolean; builtin: boolean; dirs: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectingDirs, setSelectingDirs] = useState(false);
  const [editingRawDirs, setEditingRawDirs] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  const dirty = baseline !== null
    && (mergeSkills !== baseline.merge || builtinProductSkills !== baseline.builtin || extraDirs !== baseline.dirs);

  useEffect(() => {
    const config = configQuery.data;
    if (config === undefined || dirty) return;
    const merge = config.merge_all_available_skills !== false;
    const builtin = config.builtin_product_skills !== false;
    const dirs = (config.extra_skill_dirs ?? []).join('\n');
    setMergeSkills(merge);
    setBuiltinProductSkills(builtin);
    setExtraDirs(dirs);
    setBaseline({ merge, builtin, dirs });
  }, [configQuery.data, dirty]);

  const parsedDirs = useMemo(
    () => extraDirs.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean),
    [extraDirs],
  );

  const selectExtraDirs = async () => {
    if (!canPickDirs) {
      setEditingRawDirs(true);
      requestAnimationFrame(() => { textareaRef.current?.focus(); });
      return;
    }
    setSelectingDirs(true);
    setFeedback(null);
    try {
      const selected = await host.pickDirectories?.();
      if (selected !== undefined && selected !== null) {
        setExtraDirs((current) => appendExtraSkillDirs(current, selected));
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSelectingDirs(false);
    }
  };

  const removeDirAt = (index: number) => {
    const next = parsedDirs.filter((_, idx) => idx !== index);
    setExtraDirs(next.join('\n'));
  };

  const save = async () => {
    const pathError = validateExtraSkillDirs(extraDirs);
    if (pathError !== null) {
      setFeedback({ tone: 'error', text: issueText(locale, pathError) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({
        merge_all_available_skills: mergeSkills,
        extra_skill_dirs: parsedDirs,
        builtin_product_skills: builtinProductSkills,
      });
      queryClient.setQueryData(['config'], echoed);
      const merge = echoed.merge_all_available_skills !== false;
      const builtin = echoed.builtin_product_skills !== false;
      const dirs = (echoed.extra_skill_dirs ?? []).join('\n');
      setMergeSkills(merge);
      setBuiltinProductSkills(builtin);
      setExtraDirs(dirs);
      setBaseline({ merge, builtin, dirs });
      await queryClient.invalidateQueries({ queryKey: ['workspace-skills'] });
      if (builtin !== (configQuery.data?.builtin_product_skills !== false)) {
        markRestartRequired(['builtin_product_skills']);
        setFeedback({ tone: 'success', text: t('st.caps.savedRestart') });
      } else {
        pingSaved();
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-skills-sources-panel
      className="space-y-3 rounded-lg bg-ink/[0.03] px-4 py-3.5"
    >
      <div className="grid gap-2 sm:grid-cols-2 sm:gap-4">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-ink">
            <span className="truncate">{t('st.caps.mergeSkills')}</span>
            <span
              title={t('st.caps.mergeSkillsHint')}
              aria-label={t('st.caps.mergeSkillsHint')}
              className="inline-flex shrink-0 text-ink-faint hover:text-ink-soft"
            >
              <Icon name="info" size={12} />
            </span>
          </span>
          <Toggle layout="bare" label={t('st.caps.mergeSkills')} checked={mergeSkills} onChange={setMergeSkills} />
        </div>

        <div className="flex min-h-8 items-center justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-ink">
            <span className="truncate">{t('st.sidecar.builtinSkills')}</span>
            <span
              title={t('st.caps.restartTooltip')}
              aria-label={t('st.caps.restartTooltip')}
              className="inline-flex shrink-0 text-ink-faint hover:text-ink-soft"
            >
              <Icon name="info" size={12} />
            </span>
          </span>
          <Toggle layout="bare" label={t('st.sidecar.builtinSkills')} checked={builtinProductSkills} onChange={setBuiltinProductSkills} />
        </div>
      </div>

      <div className="border-t border-hairline pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            htmlFor="settings-extra-skill-dirs"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-soft"
          >
            <span>{t('st.caps.extraDirs')}</span>
            <span
              title={t('st.caps.extraDirsHint')}
              aria-label={t('st.caps.extraDirsHint')}
              className="inline-flex text-ink-faint hover:text-ink-soft"
            >
              <Icon name="info" size={12} />
            </span>
          </label>
          <button
            type="button"
            data-skills-add-dir
            className={`${SECONDARY_BUTTON} inline-flex items-center gap-1`}
            disabled={selectingDirs}
            onClick={() => void selectExtraDirs()}
          >
            <Icon name="plus" size={12} />
            <span>{canPickDirs ? t('st.caps.selectDirs') : t('st.caps.addDir')}</span>
          </button>
        </div>

        {parsedDirs.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {parsedDirs.map((dir, index) => (
              <span
                key={`${dir}:${index}`}
                data-extra-skill-dir-chip={dir}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-hairline bg-paper px-2 py-0.5 font-mono text-[11.5px] text-ink-soft"
              >
                <span className="truncate">{dir}</span>
                <button
                  type="button"
                  aria-label={t('st.caps.removeDir', { dir })}
                  title={t('st.caps.removeDir', { dir })}
                  onClick={() => { removeDirAt(index); }}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-ink/[0.08] hover:text-ink"
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {(editingRawDirs || parsedDirs.length === 0) ? (
          <textarea
            ref={textareaRef}
            id="settings-extra-skill-dirs"
            rows={2}
            className={`${INPUT} mt-2 min-h-14 font-mono text-[12px]`}
            value={extraDirs}
            onChange={(event) => { setExtraDirs(event.target.value); }}
            placeholder={t('st.caps.extraDirsPlaceholder')}
          />
        ) : null}
      </div>

      <SettingsDraftFooter
        saved={justSaved}
        id="skill-defaults"
        dirty={dirty}
        saving={saving}
        saveLabel={t('st.caps.save')}
        onSave={() => void save()}
        onDiscard={() => {
          if (baseline !== null) {
            setMergeSkills(baseline.merge);
            setBuiltinProductSkills(baseline.builtin);
            setExtraDirs(baseline.dirs);
          }
          setFeedback(null);
        }}
      />
      {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

const ACTION_ICON_BTN =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11';

function SkillRow({
  skill,
  density,
  enabled,
  toggling,
  canToggle,
  canPreview,
  onOpen,
  onToggleEnabled,
  onOpenPlugin,
}: {
  readonly skill: SkillDescriptor;
  readonly density: ListDensity;
  readonly enabled: boolean;
  readonly toggling: boolean;
  readonly canToggle: boolean;
  readonly canPreview: boolean;
  readonly onOpen: () => void;
  readonly onToggleEnabled: (next: boolean) => void;
  readonly onOpenPlugin?: (pluginId: string) => void;
}) {
  const { t, locale } = useI18n();
  const host = useHost();
  const pluginId = pluginIdFromSkill(skill);
  const openLocalFolder = skill.source !== 'builtin' ? (host.revealPath ?? host.openPath) : undefined;
  const compact = density === 'compact';

  const isSlashCommand = skill.prompt_command === true;
  const metaTag = isSlashCommand && skill.argument_hint !== undefined ? (
    <Tag tone={enabled ? 'accent' : 'faint'}>{skill.argument_hint}</Tag>
  ) : !isSlashCommand && skill.disable_model_invocation === true ? (
    <Tag>{t('cap.skills.manualOnly')}</Tag>
  ) : null;

  const disabledTag = !enabled ? <Tag>{t('cap.skills.disabledBadge')}</Tag> : null;
  const description = skill.description;

  const copyCommand = async () => {
    try {
      await copyTextToClipboard(`/${skill.name}`);
      pushToast({ tone: 'info', text: t('cap.skills.copiedCommand', { name: skill.name }) });
    } catch (error) {
      pushToast({ tone: 'error', text: errorText(locale, error) });
    }
  };

  const revealDir = async () => {
    if (openLocalFolder === undefined) return;
    try {
      await openLocalFolder(skill.path);
    } catch (error) {
      pushToast({ tone: 'error', text: errorText(locale, error) });
    }
  };

  const nameNode = (
    <span className={`truncate font-mono text-[13px] font-medium ${
      compact ? 'shrink-0 max-w-[48%]' : 'min-w-0'
    } ${
      enabled ? 'text-ink' : 'text-ink-faint'
    }`}>
      {isSlashCommand ? <span className={enabled ? 'text-selected-ink' : 'text-ink-faint'}>/</span> : null}
      {skill.name}
    </span>
  );

  const body = compact ? (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {nameNode}
      {metaTag}
      {disabledTag}
      {description !== '' ? (
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint" title={description}>{description}</span>
      ) : null}
    </span>
  ) : (
    <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-1">
      <span className="flex min-w-0 items-center gap-2">
        {nameNode}
        {metaTag}
        {disabledTag}
      </span>
      {description !== '' ? (
        <span className="min-w-0 truncate text-[12px] text-ink-faint" title={description}>{description}</span>
      ) : null}
    </span>
  );

  return (
    <div
      className={`group flex min-w-0 items-center gap-2 px-3 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-within:bg-ink/[0.04] ${
        enabled ? '' : 'opacity-75'
      }`}
      style={{ minHeight: LIST_ROW_HEIGHT[density] }}
      data-skill-row={skill.name}
      data-skill-source={skill.source}
      data-skill-enabled={enabled ? 'true' : 'false'}
    >
      {canPreview ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('cap.skills.open', { name: skill.name })}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink"
        >
          {body}
        </button>
      ) : (
        body
      )}

      <div className="flex shrink-0 items-center gap-1">
        <span className="hidden items-center gap-0.5 opacity-100 transition-opacity duration-[var(--kiki-motion-quick)] min-[640px]:flex [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100">
          {canPreview ? (
            <button
              type="button"
              data-skill-view-doc={skill.name}
              aria-label={t('cap.skills.viewDoc')}
              title={t('cap.skills.viewDoc')}
              onClick={onOpen}
              className={ACTION_ICON_BTN}
            >
              <Icon name="file" size={14} />
            </button>
          ) : null}
          <button
            type="button"
            data-skill-copy-cmd={skill.name}
            aria-label={t('cap.skills.copyCommand', { name: skill.name })}
            title={t('cap.skills.copyCommand', { name: skill.name })}
            onClick={() => void copyCommand()}
            className={ACTION_ICON_BTN}
          >
            <Icon name="copy" size={14} />
          </button>
          {openLocalFolder !== undefined ? (
            <button
              type="button"
              data-skill-open-dir={skill.name}
              aria-label={t('cap.skills.openDir')}
              title={t('cap.skills.openDir')}
              onClick={() => void revealDir()}
              className={ACTION_ICON_BTN}
            >
              <Icon name="folder" size={14} />
            </button>
          ) : null}
          {pluginId !== undefined && onOpenPlugin !== undefined ? (
            <button
              type="button"
              aria-label={t('cap.skills.openPlugin', { name: pluginId })}
              title={t('cap.skills.openPlugin', { name: pluginId })}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-faint transition hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
              onClick={() => { onOpenPlugin(pluginId); }}
              data-skill-plugin={pluginId}
            >
              {pluginId}
            </button>
          ) : null}
        </span>

        {canToggle ? (
          <span className="flex w-9 shrink-0 items-center justify-end">
            <Toggle
              layout="bare"
              label={enabled ? t('cap.skills.disable', { name: skill.name }) : t('cap.skills.enable', { name: skill.name })}
              checked={enabled}
              disabled={toggling}
              dataAttr="data-skill-toggle"
              dataAttrValue={skill.name}
              onChange={onToggleEnabled}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}
