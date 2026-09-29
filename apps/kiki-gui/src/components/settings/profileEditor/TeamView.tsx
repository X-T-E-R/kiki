import { useMemo, useState } from 'react';

import type { ModelCatalogItem } from '@kiki/protocol';
import { useI18n } from '../../../i18n';
import type { NamedAgentProfile } from '../../../lib/client';
import { Icon } from '../../icons';
import { sourceBadgeLabel } from '../../agent-panel/SourceBadge';
import { SearchableSelect } from '../../SearchableSelect';
import { SETTINGS_SELECT_TRIGGER, SettingsSegmented } from '../SettingsPrimitives';
import { diagnosticTone, type ProfileDiagnostic } from './diagnostics';
import { EFFORTS, effortLabel, isExternalExecutor } from './profileDraft';
import { TeamRoster } from './TeamRoster';

export type TeamFilter = 'all' | 'main' | 'subagent';
type TeamLayout = 'list' | 'teams';
/** Names the "May call" cell shows before collapsing the rest into +N. */
const DISPATCH_SHOWN = 2;

type SourceGroup = 'workspace' | 'global' | 'builtin';
const GROUP_ORDER: readonly SourceGroup[] = ['workspace', 'global', 'builtin'];
const GROUP_LABEL = {
  workspace: 'st.profiles.groupWorkspace',
  global: 'st.profiles.groupGlobal',
  builtin: 'st.profiles.groupBuiltin',
} as const;

/**
 * Workspace = the selected workspace's own agent folders; global = the user
 * home and configured extra folders; built-in = shipped with Kiki.
 */
export function sourceGroup(source: string): SourceGroup {
  if (source === 'workspace') return 'workspace';
  if (source === 'builtin') return 'builtin';
  return 'global';
}

export interface TeamRow {
  readonly key: string;
  readonly profile: NamedAgentProfile;
  readonly writable: boolean;
  readonly diagnostics: readonly ProfileDiagnostic[];
  readonly shipped: boolean;
  readonly engineLabel?: string;
}

const displayName = (profile: NamedAgentProfile, locale: string) => profile.name === 'agent' && profile.main
  ? locale === 'zh' ? 'Kiki（默认）' : 'Kiki'
  : profile.name;

/** Who this profile may dispatch, as a short cell. */
function dispatchCell(profile: NamedAgentProfile, t: ReturnType<typeof useI18n>['t']): { text: string; names: string[] } {
  if (profile.subagents === undefined) return { text: t('st.profiles.subagentsAny'), names: [] };
  if (profile.subagents.length === 0) return { text: t('st.profiles.subagentsNone'), names: [] };
  const names = profile.subagents.map((entry) => typeof entry === 'string' ? entry : entry.name);
  return { text: names.join(', '), names };
}

/**
 * One table across every profile: role, engine, model, effort, and who it
 * may dispatch. Model and effort edit in place (each change saves on its own,
 * like the other single-choice settings); a warning mark flags a pin that does
 * not resolve or a file that does not run. This is the view the operator used
 * to keep by hand in AGENTS.md, now read from the files themselves.
 */
export function TeamView({ rows, models, filter, onFilter, onOpen, onQuickSave, savingKey, onNew, toolbar }: {
  rows: readonly TeamRow[];
  models: readonly ModelCatalogItem[];
  filter: TeamFilter;
  onFilter: (filter: TeamFilter) => void;
  onOpen: (row: TeamRow) => void;
  onQuickSave: (row: TeamRow, patch: { pinned_model_alias?: string | null; thinking_effort?: string | null }) => void;
  savingKey?: string;
  onNew: () => void;
  toolbar?: React.ReactNode;
}) {
  const { t, tp, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<TeamLayout>('list');
  const modelIds = useMemo(() => new Set(models.map((model) => model.id)), [models]);
  const visible = rows.filter((row) => (filter === 'all' || (filter === 'main') === row.profile.main)
    && (query.trim() === '' || `${row.profile.name} ${row.profile.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())));
  const modelChoices = (current: string) => [
    { value: '', label: t('st.profiles.modelUnset') },
    ...models.map((model) => ({ value: model.id, label: model.id, group: model.provider_id })),
    ...(current !== '' && current !== 'inherit' && !modelIds.has(current) ? [{ value: current, label: current, hint: t('st.profiles.aliasMissingShort') }] : []),
  ];
  const warnings = rows.reduce((count, row) => count + row.diagnostics.filter((item) => diagnosticTone(item) === 'warning').length, 0);
  // Source groups in precedence order; each group keeps main agents above subagents.
  const groups = GROUP_ORDER.map((id) => ({
    id,
    rows: visible.filter((row) => sourceGroup(row.profile.source) === id)
      .toSorted((a, b) => Number(b.profile.main) - Number(a.profile.main)),
  })).filter((group) => group.rows.length > 0);
  const viewSwitch = <SettingsSegmented<TeamLayout> ariaLabel={t('st.profiles.layout')} value={layout} onChange={setLayout} dataAttr="data-team-layout"
    choices={[{ value: 'list', label: t('st.profiles.layoutList') }, { value: 'teams', label: t('st.profiles.layoutTeams') }]} />;
  if (layout === 'teams') return <div className="space-y-3" data-team-view>
    <div className="flex flex-wrap items-center gap-2">
      {viewSwitch}
      <div className="ml-auto flex items-center gap-2">{toolbar}</div>
    </div>
    <TeamRoster rows={rows} onOpen={onOpen} displayName={(profile) => displayName(profile, locale)} />
  </div>;
  return <div className="space-y-3" data-team-view>
    <div className="flex flex-wrap items-center gap-2">
      {viewSwitch}
      <SettingsSegmented<TeamFilter> ariaLabel={t('st.profiles.filter')} value={filter} onChange={onFilter} dataAttr="data-team-filter"
        choices={(['all', 'main', 'subagent'] as const).map((item) => ({ value: item, label: t(`st.agentManager.${item}`) }))} />
      <label className="relative min-w-[10rem] flex-1 sm:max-w-[16rem]">
        <span className="sr-only">{t('st.profiles.search')}</span>
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"><Icon name="search" size={12} /></span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('st.profiles.search')}
          className="h-8 w-full rounded-md bg-ink/[0.04] pl-7 pr-2 text-[13px] text-ink outline-none placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-accent/40" />
      </label>
      <div className="ml-auto flex items-center gap-2">
        {toolbar}
        <button type="button" data-profile-new onClick={onNew}
          className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-[12.5px] font-semibold text-on-accent transition-colors hover:bg-accent-deep">
          <Icon name="plus" size={12} />{t('st.agentManager.new')}
        </button>
      </div>
    </div>
    {warnings > 0 ? <p data-team-warnings className="inline-flex items-center gap-1.5 text-[12px] text-amber-ink">
      <Icon name="warning" size={12} />{tp('st.profiles.teamWarnings', warnings)}
    </p> : null}
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-0 text-left text-[13px] max-sm:min-w-0 max-sm:table-auto" data-team-table>
        <thead className="max-sm:hidden">
          <tr className="text-[11.5px] font-medium text-ink-faint">
            <th scope="col" className="border-b border-hairline py-2 pr-3 font-medium">{t('st.profiles.colRole')}</th>
            <th scope="col" className="w-[12rem] border-b border-hairline py-2 pr-3 font-medium">{t('st.profiles.model')}</th>
            <th scope="col" className="w-[7rem] border-b border-hairline py-2 pr-3 font-medium">{t('st.profiles.effort')}</th>
            <th scope="col" className="w-[10rem] border-b border-hairline py-2 font-medium">{t('st.profiles.colDispatches')}</th>
          </tr>
        </thead>
        {groups.map((group) => <tbody key={group.id} data-team-group={group.id}>
          <tr className="max-sm:block">
            <th scope="colgroup" colSpan={4} className="border-b border-hairline pb-1.5 pt-4 text-left font-medium max-sm:block">
              <span className="text-[12.5px] text-ink">{t(GROUP_LABEL[group.id])}</span>
              <span className="ml-1.5 text-[11.5px] tabular-nums text-ink-faint">{group.rows.length}</span>
            </th>
          </tr>
          {group.rows.map((row, index) => {
            const { profile } = row;
            // A light label where the main agents end and the subagents begin.
            const kindLabel = index === 0 || group.rows[index - 1]!.profile.main !== profile.main
              ? <tr key={`${row.key}:kind`} data-team-kind={profile.main ? 'main' : 'subagent'} className="max-sm:block">
                <td colSpan={4} className="pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-[0.04em] text-ink-faint max-sm:block">
                  {t(profile.main ? 'st.profiles.groupMain' : 'st.profiles.groupSubagents')}
                </td>
              </tr> : null;
            return [kindLabel, renderRow(row)];
          })}
        </tbody>)}
      </table>
      {visible.length === 0 ? <p className="py-6 text-center text-[12.5px] text-ink-faint">{t(query.trim() === '' ? 'st.profiles.teamEmpty' : 'st.profiles.teamNoMatch')}</p> : null}
    </div>
  </div>;

  function renderRow(row: TeamRow) {
            const { profile } = row;
            const dispatch = dispatchCell(profile, t);
            const external = isExternalExecutor(profile.executor);
            const warn = row.diagnostics.filter((item) => diagnosticTone(item) === 'warning');
            const aliasMissing = row.diagnostics.some((item) => item.kind === 'aliasMissing' && item.field === 'model_alias');
            const shadowed = row.diagnostics.some((item) => item.kind === 'shadowedBy');
            const alias = profile.pinned_model_alias ?? '';
            const effort = profile.thinking_effort ?? '';
            const saving = savingKey === row.key;
            const quickEditable = row.writable && !saving && !shadowed;
            return <tr key={row.key} data-team-row={profile.name} data-team-source={profile.source}
              className={`align-top max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:border-b max-sm:border-hairline max-sm:py-2.5 ${shadowed || profile.disabled ? 'text-ink-faint' : ''}`}>
              <td className="border-b border-hairline py-2.5 pr-3 max-sm:w-full max-sm:border-0 max-sm:p-0">
                <button type="button" onClick={() => onOpen(row)} data-team-open={profile.name}
                  className="group -mx-1 flex min-h-9 w-full min-w-0 flex-col items-start rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
                  <span className="flex w-full min-w-0 items-center gap-1.5">
                    <span className={`min-w-0 truncate font-medium group-hover:underline ${shadowed ? 'line-through decoration-ink-faint/60' : 'text-ink'}`}>{displayName(profile, locale)}</span>
                    {profile.main ? <span className="shrink-0 rounded-[4px] bg-ink/[0.05] px-1.5 text-[11px] text-ink-soft">{t('st.agentManager.main')}</span> : null}
                    {external ? <span data-team-engine className="shrink-0 rounded-[4px] border border-hairline px-1.5 text-[11px] text-ink-soft">{row.engineLabel ?? profile.executor}</span> : null}
                    {profile.disabled ? <span className="shrink-0 text-[11.5px] text-ink-faint">{t('st.namedAgents.disabledBadge')}</span> : null}
                    {warn.length > 0 ? <span data-team-warning className="shrink-0 text-amber-ink" title={tp('st.profiles.rowWarnings', warn.length)}>
                      <Icon name="warning" size={12} /><span className="sr-only">{tp('st.profiles.rowWarnings', warn.length)}</span>
                    </span> : null}
                  </span>
                  <span className="w-full truncate text-[12px] text-ink-faint">
                    {sourceBadgeLabel(t, profile.source)}{row.shipped && profile.source !== 'builtin' ? ` · ${t('st.profiles.shippedCopy')}` : ''}
                    {profile.description !== undefined ? ` · ${profile.description}` : ''}
                  </span>
                </button>
              </td>
              <td className="border-b border-hairline py-2 pr-3 max-sm:border-0 max-sm:p-0" data-team-model>
                <span className="sr-only sm:hidden">{t('st.profiles.model')}</span>
                {quickEditable && !external ? <SearchableSelect id={`team-model-${row.key}`} value={alias} allowCustomValue
                  options={modelChoices(alias)} ariaLabel={t('st.profiles.modelFor', { name: profile.name })} searchPlaceholder="provider/model"
                  triggerSuffix={aliasMissing ? <Icon name="warning" size={12} className="shrink-0 text-amber-ink" /> : undefined}
                  triggerLabel={alias === '' ? <span className="font-sans text-ink-soft">{t('st.profiles.modelUnset')}</span>
                    : <span className="min-w-0 truncate font-mono">{alias}</span>}
                  buttonClassName={`${SETTINGS_SELECT_TRIGGER} w-full max-w-[12rem] text-[12px] ${aliasMissing ? 'text-amber-ink' : ''}`}
                  onChange={(next) => { if (next !== alias) onQuickSave(row, { pinned_model_alias: next === '' ? null : next }); }} />
                  : <span className={`inline-flex h-8 items-center gap-1 font-mono text-[12px] ${aliasMissing ? 'text-amber-ink' : ''}`}>
                    {aliasMissing ? <Icon name="warning" size={12} /> : null}{alias === '' ? <span className="font-sans text-ink-soft">{t('st.profiles.modelUnset')}</span> : alias}
                  </span>}
              </td>
              <td className="border-b border-hairline py-2 pr-3 max-sm:border-0 max-sm:p-0" data-team-effort>
                {quickEditable ? <SearchableSelect id={`team-effort-${row.key}`} value={effort} hideFilter
                  options={[{ value: '', label: '—' }, ...EFFORTS.map((level) => ({ value: level, label: effortLabel(level) })),
                    ...(effort !== '' && !(EFFORTS as readonly string[]).includes(effort) ? [{ value: effort, label: effortLabel(effort) }] : [])]}
                  triggerLabel={effort === '' ? <span className="text-ink-soft">—</span> : effortLabel(effort)}
                  ariaLabel={t('st.profiles.effortFor', { name: profile.name })} buttonClassName={`${SETTINGS_SELECT_TRIGGER} text-[12px]`}
                  onChange={(next) => { if (next !== effort) onQuickSave(row, { thinking_effort: next === '' ? null : next }); }} />
                  : <span className="inline-flex h-8 items-center text-[12px]">{effort === '' ? <span className="text-ink-soft">—</span> : effort}</span>}
              </td>
              <td className="min-w-0 border-b border-hairline py-2 text-[12px] max-sm:w-full max-sm:border-0 max-sm:p-0" data-team-dispatch
                title={dispatch.names.length > DISPATCH_SHOWN ? dispatch.text : undefined}>
                {/* One line: the first names, then +N; the full list is in the title. */}
                <span className="flex h-8 min-w-0 items-center gap-1 whitespace-nowrap">
                  <span className="shrink-0 text-ink-faint sm:hidden">{t('st.profiles.colDispatches')}:</span>
                  <span className={`min-w-0 truncate ${dispatch.names.length > 0 ? 'text-ink-soft' : 'text-ink-faint'}`}>
                    {dispatch.names.length > 0 ? dispatch.names.slice(0, DISPATCH_SHOWN).join(', ') : dispatch.text}
                  </span>
                  {dispatch.names.length > DISPATCH_SHOWN ? <span data-team-dispatch-more className="shrink-0 rounded-[4px] bg-ink/[0.05] px-1 text-[11px] text-ink-soft">
                    {t('st.profiles.dispatchMore', { count: dispatch.names.length - DISPATCH_SHOWN })}
                    <span className="sr-only">: {dispatch.names.slice(DISPATCH_SHOWN).join(', ')}</span>
                  </span> : null}
                </span>
              </td>
            </tr>;
  }
}
