import { useContext, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';

import { isDesktopRuntime, selectDirectoriesNative } from '../../lib/desktop';
import { useI18n } from '../../i18n';
import { errorText, issueText } from '../../i18n/locale';
import {
  groupSkills,
  normalizeCapQuery,
  pickWorkspace,
  SKILL_GROUP_ORDER,
  type SkillGroupId,
} from '../../lib/capabilities';
import {
  appendExtraSkillDirs,
  markRestartRequired,
  validateExtraSkillDirs,
} from '../../lib/settings';
import { sortWorkspacesByRecency } from '../../lib/sorting';
import { useConnection } from '../../state/connection';
import { CapabilityGroup } from '../capabilities/CapabilityGroup';
import { SkillCard } from '../capabilities/rows';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { SearchableSelect, type SearchableSelectOption } from '../SearchableSelect';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingsWorkspaceScopeContext } from './workspaceScope';

/** Groups collapsed on first paint: builtin is long and rarely the answer. */
const COLLAPSED_BY_DEFAULT: ReadonlySet<string> = new Set(['builtin', 'other']);

const SOURCE_LABEL_KEYS = {
  plugin: 'cap.source.plugin',
  project: 'cap.source.project',
  user: 'cap.source.user',
  extra: 'cap.source.extra',
  builtin: 'cap.source.builtin',
} as const;

const GROUP_TITLE_KEYS = {
  plugin: 'cap.group.plugin',
  project: 'cap.group.project',
  user: 'cap.group.user',
  extra: 'cap.group.extra',
  builtin: 'cap.group.builtin',
  other: 'cap.group.other',
} as const;

/**
 * Skills defaults (redesign §10.3): the old capabilities skills card minus
 * telemetry (now under Data), plus the builtin product-skills switch from the
 * dissolved sidecar card. All three fields patch the server config file; the
 * builtin switch needs a restart to take effect.
 */
function SkillsDefaultsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [mergeSkills, setMergeSkills] = useState(true);
  const [builtinProductSkills, setBuiltinProductSkills] = useState(true);
  const [extraDirs, setExtraDirs] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectingDirs, setSelectingDirs] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const isDesktop = isDesktopRuntime();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    const config = configQuery.data;
    if (config === undefined) return;
    setMergeSkills(config.merge_all_available_skills !== false);
    setBuiltinProductSkills(config.builtin_product_skills !== false);
    setExtraDirs((config.extra_skill_dirs ?? []).join('\n'));
  }, [configQuery.data]);

  const selectExtraDirs = async () => {
    setSelectingDirs(true);
    setFeedback(null);
    try {
      const selected = await selectDirectoriesNative();
      if (selected !== null) setExtraDirs((current) => appendExtraSkillDirs(current, selected));
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSelectingDirs(false);
    }
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
        extra_skill_dirs: extraDirs.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean),
        builtin_product_skills: builtinProductSkills,
      });
      queryClient.setQueryData(['config'], echoed);
      setMergeSkills(echoed.merge_all_available_skills !== false);
      setBuiltinProductSkills(echoed.builtin_product_skills !== false);
      setExtraDirs((echoed.extra_skill_dirs ?? []).join('\n'));
      if (builtinProductSkills !== (configQuery.data?.builtin_product_skills !== false)) {
        markRestartRequired(['builtin_product_skills']);
        setFeedback({ tone: 'success', text: t('st.caps.savedRestart') });
      } else {
        setFeedback({ tone: 'success', text: t('st.caps.saved') });
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-caps" title={t('st.caps.title')}>
      <div className="space-y-4">
        <Toggle label={t('st.caps.mergeSkills')} checked={mergeSkills} onChange={setMergeSkills} />
        <Toggle label={t('st.sidecar.builtinSkills')} checked={builtinProductSkills} onChange={setBuiltinProductSkills} />
        <div>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="settings-extra-skill-dirs" className="text-[11px] font-medium text-ink-soft">{t('st.caps.extraDirs')}</label>
            {isDesktop ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={selectingDirs}
                onClick={() => void selectExtraDirs()}
              >
                {t('st.caps.selectDirs')}
              </button>
            ) : null}
          </div>
          <textarea id="settings-extra-skill-dirs" className={`${INPUT} mt-1 min-h-24 font-mono`} value={extraDirs} onChange={(event) => { setExtraDirs(event.target.value); }} placeholder={t('st.caps.extraDirsPlaceholder')} />
        </div>
        <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('common.saving') : t('st.caps.save')}</button>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/**
 * The /capabilities skill browser, re-homed as a settings card (redesign
 * §8.2): same grouping/filtering pipeline (lib/capabilities), same row
 * chrome, but the workspace is chosen by the section-level selector and the
 * page header echoes its scope.
 */
function SkillCatalogCard({ workspaceId }: { workspaceId: string }) {
  const { client } = useConnection();
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const skillsQuery = useQuery({
    queryKey: ['workspace-skills', workspaceId],
    queryFn: () => client.listWorkspaceSkills(workspaceId),
    enabled: workspaceId !== '',
    staleTime: 60_000,
  });

  const query = normalizeCapQuery(filter);
  const filtering = query !== '';
  const groups = useMemo(
    () => groupSkills(skillsQuery.data?.skills ?? [], filter),
    [skillsQuery.data, filter],
  );
  // Without a filter every known group renders (empty ones with their own
  // quiet empty state); with a filter only groups holding matches survive.
  const visibleGroups = useMemo(() => {
    if (filtering) return groups;
    return SKILL_GROUP_ORDER.filter((id) => id !== 'other' || groups.some((g) => g.id === 'other'))
      .map((id) => ({
        id,
        skills: groups.find((g) => g.id === id)?.skills ?? [],
      }));
  }, [filtering, groups]);

  const nothingMatched = filtering && visibleGroups.every((group) => group.skills.length === 0);

  const isOpen = (id: string) =>
    filtering ? true : !(collapsed[id] ?? COLLAPSED_BY_DEFAULT.has(id));
  const toggle = (id: string) => {
    setCollapsed((current) => ({ ...current, [id]: !(current[id] ?? COLLAPSED_BY_DEFAULT.has(id)) }));
  };

  return (
    <SectionCard id="st-card-skill-catalog" title={t('st.skills.catalogTitle')}>
      <div className="space-y-3">
        <input
          type="text"
          value={filter}
          onChange={(event) => { setFilter(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setFilter('');
          }}
          placeholder={t('cap.filterPlaceholder')}
          aria-label={t('cap.filterAria')}
          className={INPUT}
        />
        {workspaceId === '' ? (
          <Hint>{t('cap.noWorkspace')}</Hint>
        ) : skillsQuery.isPending ? (
          <Hint>{t('cap.loadingSkills')}</Hint>
        ) : skillsQuery.isError ? (
          <InlineError error={skillsQuery.error} />
        ) : (
          <>
            {visibleGroups.map((group) => (
              <CapabilityGroup
                key={group.id}
                id={group.id}
                title={t(GROUP_TITLE_KEYS[group.id])}
                count={group.skills.length}
                open={isOpen(group.id)}
                onToggle={() => { toggle(group.id); }}
              >
                {group.skills.length === 0 ? (
                  <Hint>{t('cap.emptyGroup')}</Hint>
                ) : (
                  group.skills.map((skill) => (
                    <SkillCard
                      key={`${skill.source}:${skill.name}`}
                      skill={skill}
                      sourceLabel={
                        group.id === 'other'
                          ? skill.source
                          : t(SOURCE_LABEL_KEYS[group.id as Exclude<SkillGroupId, 'other'>])
                      }
                    />
                  ))
                )}
              </CapabilityGroup>
            ))}
            {nothingMatched ? (
              <p className="rounded-2xl border border-hairline bg-panel px-4 py-10 text-center text-[12.5px] text-ink-faint">
                {t('cap.emptyFilter', { query: filter.trim() })}
              </p>
            ) : null}
          </>
        )}
      </div>
    </SectionCard>
  );
}

/**
 * Skills leaf (redesign §8.2 / §10.3): skill defaults + the skill catalog.
 * The `/capabilities` shim lands here (`?from=capabilities`) with a signpost
 * naming the three destinations the old page split into.
 */
export function SkillsSection() {
  const { client } = useConnection();
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const requestedWorkspace = searchParams.get('workspace') ?? undefined;
  const fromCapabilities = searchParams.get('from') === 'capabilities';
  const [workspaceId, setWorkspaceId] = useState('');

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const workspaces = workspacesQuery.data?.items ?? [];
  const sortedWorkspaces = useMemo(() => sortWorkspacesByRecency(workspaces), [workspaces]);
  const workspaceOptions: readonly SearchableSelectOption[] = useMemo(
    () =>
      sortedWorkspaces.map((workspace) => ({
        value: workspace.id,
        label: workspace.name,
        hint: workspace.root,
        title: workspace.name,
      })),
    [sortedWorkspaces],
  );
  // An explicit `?workspace=` deep link wins; otherwise the first registered
  // workspace — the same default the old /capabilities page used.
  useEffect(() => {
    if (workspaceId !== '') return;
    const picked = pickWorkspace(sortedWorkspaces, requestedWorkspace);
    if (picked !== undefined) setWorkspaceId(picked.id);
  }, [workspaceId, sortedWorkspaces, requestedWorkspace]);

  // The scope header names the workspace the catalog browses; switching the
  // selector updates the page header in lockstep.
  const reportWorkspaceScope = useContext(SettingsWorkspaceScopeContext);
  const workspaceScopeName = sortedWorkspaces.find((workspace) => workspace.id === workspaceId)?.name ?? null;
  useEffect(() => {
    reportWorkspaceScope(workspaceScopeName);
    return () => { reportWorkspaceScope(null); };
  }, [reportWorkspaceScope, workspaceScopeName]);

  // The split signpost keeps the deep-link context (server/token/workspace)
  // when pointing at the sibling leaves; only the `from` marker is dropped.
  const shimLinkTarget = (section: string) => {
    const params = new URLSearchParams(searchParams);
    params.delete('from');
    const query = params.toString();
    return `/settings/${section}${query === '' ? '' : `?${query}`}`;
  };

  return (
    <div className="space-y-4">
      {fromCapabilities ? (
        <p data-capabilities-shim-note className="rounded-lg border border-hairline bg-panel px-3 py-2 text-[11.5px] text-ink-soft">
          {t('st.shim.capabilities')}{' '}
          <Link to={shimLinkTarget('skills')} className="font-medium text-accent hover:underline">{t('st.section.skills')}</Link>
          {' · '}
          <Link to={shimLinkTarget('mcp')} className="font-medium text-accent hover:underline">{t('st.section.mcp')}</Link>
          {' · '}
          <Link to={shimLinkTarget('plugins')} className="font-medium text-accent hover:underline">{t('st.shim.plugins')}</Link>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 px-1">
        <span className="text-[11px] font-medium text-ink-soft">{t('st.mcp.workspace')}</span>
        <SearchableSelect
          id="workspace-skills-select"
          options={workspaceOptions}
          value={workspaceId}
          onChange={setWorkspaceId}
          ariaLabel={t('st.mcp.workspace')}
        />
      </div>
      {workspacesQuery.isError ? <InlineError error={workspacesQuery.error} /> : null}
      <SkillsDefaultsCard />
      <SkillCatalogCard workspaceId={workspaceId} />
    </div>
  );
}
