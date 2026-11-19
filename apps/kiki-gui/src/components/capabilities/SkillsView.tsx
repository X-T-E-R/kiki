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

import { useEffect, useMemo, useRef, useState } from 'react';
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
import { SettingsDraftFooter } from '../settings/SettingsPrimitives';
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

const SOURCE_BADGE_KEYS: Record<SkillGroupId, 'cap.skills.source.plugin' | 'cap.skills.sourceBadge.project' | 'cap.skills.source.user' | 'cap.skills.sourceBadge.extra' | 'cap.skills.source.builtin' | 'cap.skills.source.other'> = {
  plugin: 'cap.skills.source.plugin',
  project: 'cap.skills.sourceBadge.project',
  user: 'cap.skills.source.user',
  extra: 'cap.skills.sourceBadge.extra',
  builtin: 'cap.skills.source.builtin',
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

export function SkillsView({
  workspaceId,
  onOpenPlugin,
  defaultSourcesOpen = false,
  inSettings = false,
}: {
  readonly workspaceId: string;
  /** Plugin-sourced skills link to their plugin when the host can show it. */
  readonly onOpenPlugin?: (pluginId: string) => void;
  readonly defaultSourcesOpen?: boolean;
  readonly inSettings?: boolean;
}) {
  const existingPreview = useMediaPreview();
  const content = (
    <SkillsViewInner
      workspaceId={workspaceId}
      onOpenPlugin={onOpenPlugin}
      defaultSourcesOpen={defaultSourcesOpen}
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
  inSettings,
}: {
  readonly workspaceId: string;
  readonly onOpenPlugin?: (pluginId: string) => void;
  readonly defaultSourcesOpen: boolean;
  readonly inSettings: boolean;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const preview = useMediaPreview();
  const canManageConfig = typeof client.getConfig === 'function' && typeof client.patchConfig === 'function';

  const [sourcesOpen, setSourcesOpen] = useState(defaultSourcesOpen);
  const [togglingSkills, setTogglingSkills] = useState<Readonly<Record<string, boolean>>>({});

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

  const isSkillEnabled = (skill: SkillDescriptor): boolean => {
    const normalized = normalizeSkillKey(skill.name);
    if (configQuery.data?.disabled_skills !== undefined) {
      return !disabledSkillSet.has(normalized);
    }
    return skill.enabled !== false;
  };

  const toggleSkillEnabled = async (skill: SkillDescriptor, nextEnabled: boolean) => {
    if (!canManageConfig) return;
    const key = normalizeSkillKey(skill.name);
    if (key === '' || togglingSkills[key]) return;
    setTogglingSkills((prev) => ({ ...prev, [key]: true }));

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
      label: t(SOURCE_BADGE_KEYS[id]),
      test: (skill: SkillDescriptor) => skillGroupId(skill.source, skill.plugin_id) === id,
    }));
  }, [allSkills, t]);

  const view = useListView({ listId: 'cap-skills', items: allSkills, keyOf, textOf, filters });
  const toolbarView = useMemo(() => ({
    ...view,
    tools: {
      ...view.tools,
      search: allSkills.length > 0,
      filters: filters.length > 1,
      filterIds: filters.map((item) => item.id),
    },
  }), [allSkills.length, filters, view]);

  const groups = useMemo(
    () => groupItems(allSkills, view.visible, (skill) => {
      const id = skillGroupId(skill.source, skill.plugin_id);
      return [{ key: id, label: t(GROUP_TITLE_KEYS[id]) }];
    }, SKILL_GROUP_ORDER),
    [allSkills, view.visible, t],
  );

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
      onClick={() => { setSourcesOpen((open) => !open); }}
      className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5 ${
        sourcesOpen ? 'bg-ink/[0.08] text-ink' : ''
      }`}
    >
      <Icon name="folder" size={14} className="text-ink-soft" />
      <span>{t('st.caps.sourcesButton')}</span>
      {extraDirCount > 0 ? (
        <span className="rounded bg-ink/[0.06] px-1 text-[11px] text-ink-soft tabular-nums">{extraDirCount}</span>
      ) : null}
    </button>
  ) : null;

  return (
    <div
      className={`min-w-0 space-y-3 ${
        inSettings ? '' : '[&_[data-list-toolbar]]:-top-4 min-[720px]:[&_[data-list-toolbar]]:-top-8'
      }`}
      data-skills-view
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
        <InlineError error={skillsQuery.error} />
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
        groups.map((group) => (
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
      className="space-y-3 rounded-lg border border-hairline bg-panel px-4 py-3.5"
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
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink';

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
  const groupId = skillGroupId(skill.source, skill.plugin_id);
  const sourceBadge = t(SOURCE_BADGE_KEYS[groupId]);
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
        <span className="hidden rounded bg-ink/[0.045] px-1.5 py-0.5 text-[11px] leading-4 text-ink-faint sm:inline-flex">
          {sourceBadge}
        </span>

        <span className="hidden items-center gap-0.5 opacity-0 transition-opacity duration-[var(--kiki-motion-quick)] min-[640px]:flex group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
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
          <Toggle
            layout="bare"
            label={enabled ? t('cap.skills.disable', { name: skill.name }) : t('cap.skills.enable', { name: skill.name })}
            checked={enabled}
            disabled={toggling}
            dataAttr="data-skill-toggle"
            dataAttrValue={skill.name}
            onChange={onToggleEnabled}
          />
        ) : null}
      </div>
    </div>
  );
}
