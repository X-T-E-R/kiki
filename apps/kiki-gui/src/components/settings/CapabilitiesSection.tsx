import { useContext, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { isDesktopRuntime, selectDirectoriesNative } from '../../lib/desktop';
import { useI18n } from '../../i18n';
import { errorText, issueText } from '../../i18n/locale';
import { experimentalFlagRows } from '../../lib/agentSettings';
import {
  appendExtraSkillDirs,
  CAPABILITY_GROUPS,
  capabilityGroupForCard,
  parseAdvancedServerConfig,
  validateExtraSkillDirs,
} from '../../lib/settings';
import { sortWorkspacesByRecency } from '../../lib/sorting';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { RuntimeConfigEditor } from '../RuntimeConfigEditor';
import { SearchableSelect, type SearchableSelectOption } from '../SearchableSelect';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { McpConfigManager } from './McpConfigManager';
import { SectionCard, SettingsFlashContext, SettingsGroup } from './SectionCard';
import { SettingsWorkspaceScopeContext } from './workspaceScope';

function ExperimentalFlagsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const metaQuery = useQuery({ queryKey: ['meta'], queryFn: () => client.meta(), staleTime: 15_000 });

  useEffect(() => {
    if (configQuery.data !== undefined) setOverrides({ ...(configQuery.data.experimental ?? {}) });
  }, [configQuery.data]);

  const rows = experimentalFlagRows(metaQuery.data ?? {}, { experimental: overrides });
  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({
        experimental: overrides,
        replace_domains: ['experimental'],
      });
      queryClient.setQueryData(['config'], echoed);
      setOverrides({ ...(echoed.experimental ?? {}) });
      await queryClient.invalidateQueries({ queryKey: ['meta'] });
      setFeedback({ tone: 'success', text: t('st.experimental.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-experimental" title={t('st.experimental.title')}>
      <div className="space-y-3">
        <Hint>{t('st.experimental.hint')}</Hint>
        <fieldset disabled={saving} className="space-y-2 disabled:opacity-60">
          {rows.map((row) => (
            <div key={row.id} className="rounded-lg border border-hairline bg-paper px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-all font-mono text-[12px] font-medium text-ink">{row.id}</p>
                  <p className="text-[10.5px] text-ink-faint">
                    {t(row.effective ? 'st.experimental.effectiveOn' : 'st.experimental.effectiveOff')}
                    {' · '}
                    {t(row.override === undefined ? 'st.experimental.inherited' : 'st.experimental.overridden')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Toggle
                    label={t('st.experimental.overrideLabel', { id: row.id })}
                    checked={row.override ?? row.effective}
                    onChange={(checked) => { setOverrides((current) => ({ ...current, [row.id]: checked })); }}
                  />
                  {row.override !== undefined ? (
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      onClick={() => {
                        setOverrides((current) => {
                          const next = { ...current };
                          delete next[row.id];
                          return next;
                        });
                      }}
                    >
                      {t('st.experimental.useInherited')}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
          {rows.length === 0 && !metaQuery.isLoading && !configQuery.isLoading ? <Hint>{t('st.experimental.empty')}</Hint> : null}
        </fieldset>
        <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('common.saving') : t('common.save')}</button>
        {metaQuery.isError ? <InlineError error={metaQuery.error} /> : null}
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

export function CapabilitiesSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [workspaceId, setWorkspaceId] = useState('');
  const [mergeSkills, setMergeSkills] = useState(true);
  const [extraDirs, setExtraDirs] = useState('');
  const [advanced, setAdvanced] = useState('{}');
  const [saving, setSaving] = useState(false);
  const [selectingDirs, setSelectingDirs] = useState(false);
  const [advancedSaving, setAdvancedSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [advancedFeedback, setAdvancedFeedback] = useState<Feedback>(null);
  const isDesktop = isDesktopRuntime();
  // Group fold state: user toggles override CAPABILITY_GROUPS defaults; a
  // settings-search flash forces the target card's group open so the
  // scroll + flash lands on a visible card.
  const [openOverrides, setOpenOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const flashId = useContext(SettingsFlashContext);
  const flashGroupId = flashId !== null ? capabilityGroupForCard(flashId)?.id : undefined;

  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  // The v2 management plane addresses project layers by working directory;
  // the user-level entries resolve with or without one.
  const mcpCwd =
    workspacesQuery.data?.items.find((workspace) => workspace.id === workspaceId)?.root ?? '';
  const mcpConfigQuery = useQuery({
    queryKey: ['mcp-managed-servers', mcpCwd],
    queryFn: () => client.listManagedMcpServers(mcpCwd === '' ? undefined : mcpCwd),
    staleTime: 60_000,
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
  useEffect(() => {
    if (workspaceId === '' && sortedWorkspaces[0] !== undefined) setWorkspaceId(sortedWorkspaces[0].id);
  }, [workspaceId, sortedWorkspaces]);

  // The scope header names the workspace this section's MCP edits target;
  // switching the card-level selector updates the page header in lockstep.
  const reportWorkspaceScope = useContext(SettingsWorkspaceScopeContext);
  const workspaceScopeName = sortedWorkspaces.find((workspace) => workspace.id === workspaceId)?.name ?? null;
  useEffect(() => {
    reportWorkspaceScope(workspaceScopeName);
    return () => { reportWorkspaceScope(null); };
  }, [reportWorkspaceScope, workspaceScopeName]);
  useEffect(() => {
    const config = configQuery.data;
    if (config === undefined) return;
    setMergeSkills(config.merge_all_available_skills !== false);
    setExtraDirs((config.extra_skill_dirs ?? []).join('\n'));
    setAdvanced(JSON.stringify({
      permission: config.permission ?? {},
      hooks: config.hooks ?? [],
      services: config.services ?? {},
      loop_control: config.loop_control ?? {},
      background: config.background ?? {},
    }, null, 2));
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
      });
      queryClient.setQueryData(['config'], echoed);
      setMergeSkills(echoed.merge_all_available_skills !== false);
      setExtraDirs((echoed.extra_skill_dirs ?? []).join('\n'));
      setFeedback({ tone: 'success', text: t('st.caps.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const saveAdvanced = async () => {
    let patch;
    try {
      patch = parseAdvancedServerConfig(advanced);
    } catch (error) {
      setAdvancedFeedback({ tone: 'error', text: errorText(locale, error) });
      return;
    }
    setAdvancedSaving(true);
    setAdvancedFeedback(null);
    try {
      const echoed = await client.patchConfig(patch);
      queryClient.setQueryData(['config'], echoed);
      setAdvanced(JSON.stringify({
        permission: echoed.permission ?? {},
        hooks: echoed.hooks ?? [],
        services: echoed.services ?? {},
        loop_control: echoed.loop_control ?? {},
        background: echoed.background ?? {},
      }, null, 2));
      setAdvancedFeedback({ tone: 'success', text: t('st.advanced.saved') });
    } catch (error) {
      setAdvancedFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setAdvancedSaving(false);
    }
  };

  const groupContent: Record<string, React.ReactNode> = {
    // Browsing surfaces (the skill catalog, MCP runtime status + restart) live
    // on /capabilities — settings keeps only the values it owns.
    skills: (
      <SectionCard id="st-card-caps" title={t('st.caps.title')}>
        <div className="space-y-4">
          <Toggle label={t('st.caps.mergeSkills')} checked={mergeSkills} onChange={setMergeSkills} />
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
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>
    ),
    mcp: (
      <SectionCard id="st-card-mcp" title={t('st.mcp.title')}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-ink-soft">{t('st.mcp.workspace')}</span>
            <SearchableSelect
              id="workspace-mcp-select"
              options={workspaceOptions}
              value={workspaceId}
              onChange={setWorkspaceId}
              ariaLabel={t('st.mcp.workspace')}
            />
          </div>
          <McpConfigManager
            cwd={mcpCwd}
            entries={mcpConfigQuery.data ?? []}
            loading={mcpConfigQuery.isLoading}
            error={mcpConfigQuery.error}
            onEcho={(servers) => {
              queryClient.setQueryData(['mcp-managed-servers', mcpCwd], servers);
            }}
          />
        </div>
      </SectionCard>
    ),
    runtime: <RuntimeConfigEditor />,
    experimental: <ExperimentalFlagsCard />,
    advanced: (
      <SectionCard id="st-card-advanced" title={t('st.advanced.title')}>
        <div className="space-y-3">
          <Hint>{t('st.advanced.hint')}</Hint>
          <textarea className={`${INPUT} min-h-64 font-mono`} value={advanced} onChange={(event) => { setAdvanced(event.target.value); }} aria-label={t('st.advanced.aria')} />
          <button type="button" className={PRIMARY_BUTTON} disabled={advancedSaving} onClick={() => void saveAdvanced()}>{advancedSaving ? t('common.saving') : t('st.advanced.save')}</button>
          <FeedbackLine feedback={advancedFeedback} />
        </div>
      </SectionCard>
    ),
  };

  return (
    <div className="space-y-4">
      <p className="px-1 text-[11.5px] text-ink-faint">
        {t('st.caps.browseHint')}{' '}
        <Link to="/capabilities" className="font-medium text-accent hover:underline">{t('st.caps.browseLink')}</Link>
      </p>
      {CAPABILITY_GROUPS.map((group) => {
        const open = group.id === flashGroupId ? true : (openOverrides[group.id] ?? group.defaultOpen);
        return (
          <SettingsGroup
            key={group.id}
            id={group.id}
            title={t(group.titleKey)}
            count={group.cardIds.length}
            open={open}
            onToggle={() => { setOpenOverrides((current) => ({ ...current, [group.id]: !open })); }}
          >
            {groupContent[group.id]}
          </SettingsGroup>
        );
      })}
    </div>
  );
}
