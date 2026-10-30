import { Fragment, useMemo, useRef, useState } from 'react';

import type { ModelCatalogItem } from '@kiki/protocol';
import { useI18n } from '../../../i18n';
import type { NamedAgentProfile } from '../../../lib/client';
import { DisclosureChevron, Icon } from '../../icons';
import { sourceBadgeLabel } from '../../agent-panel/SourceBadge';
import { SearchableSelect } from '../../SearchableSelect';
import { SETTINGS_SELECT_TRIGGER } from '../SettingsPrimitives';
import { ListEmpty, ListToolbar, useListView, type ListSortSpec } from '../list';
import { diagnosticTone, type ProfileDiagnostic } from './diagnostics';
import { dispatchFieldsOf, EFFORTS, effortLabel, isExternalExecutor } from './profileDraft';
import { ModelMenuPreview } from './ModelMenuPreview';
import { useModelMenuPreview } from './useModelMenuPreview';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { AnchoredPopover } from '../../overlays';

/** Names the "Dispatches" cell shows before collapsing the rest into +N. */
const DISPATCH_SHOWN = 2;

/** The two populations a person thinks in: agents they talk to, and the helpers those agents send out. */
type KindGroup = 'main' | 'subagent';
const KIND_ORDER: readonly KindGroup[] = ['main', 'subagent'];
const KIND_LABEL = { main: 'st.profiles.groupMain', subagent: 'st.profiles.groupSubagents' } as const;

export interface TeamRow {
  readonly key: string;
  readonly profile: NamedAgentProfile;
  readonly writable: boolean;
  readonly diagnostics: readonly ProfileDiagnostic[];
  readonly shipped: boolean;
  readonly engineLabel?: string;
}

export const displayName = (profile: NamedAgentProfile, locale: string) => profile.name === 'agent' && profile.main
  ? locale === 'zh' ? 'Kiki（默认）' : 'Kiki'
  : profile.name;

/** Who this profile may dispatch, as a short cell. An undeclared list is the default, drawn quietly. */
function dispatchCell(profile: NamedAgentProfile, t: ReturnType<typeof useI18n>['t']): { text: string; names: string[]; quiet: boolean } {
  const dispatch = dispatchFieldsOf(profile);
  if (dispatch.can_spawn_subagents === false) return { text: t('st.profiles.dispatchNone'), names: [], quiet: true };
  if (dispatch.allowed_subagents === undefined) return { text: t('st.profiles.dispatchNotDeclared'), names: [], quiet: true };
  const names = dispatch.allowed_subagents.map((entry) => typeof entry === 'string' ? entry : entry.name)
    .filter((name) => name !== '*');
  if (names.length === 0) {
    return dispatch.allowed_subagents.length === 0
      ? { text: t('st.profiles.dispatchListEmpty'), names: [], quiet: true }
      : { text: t('st.profiles.dispatchNotDeclared'), names: [], quiet: true };
  }
  return { text: names.join(', '), names, quiet: false };
}

const TAG = 'shrink-0 rounded-[4px] bg-ink/[0.05] px-1.5 text-[11px] leading-[18px] text-ink-soft';
const TAG_OUTLINE = 'shrink-0 rounded-[4px] border border-hairline px-1.5 text-[11px] leading-[16px] text-ink-soft';

/**
 * The agents, in the two groups a person actually keeps apart: the agents
 * they talk to, and the helpers those agents dispatch. Where a file lives and
 * whether it can be edited are small tags on the row, not groupings. Model
 * and effort edit in place (each change saves on its own); a warning mark
 * flags a pin that does not resolve or a file that does not run.
 */
export function TeamView({ rows, models, onOpen, onQuickSave, savingKey, onNew, newActions, loading = false }: {
  rows: readonly TeamRow[];
  models: readonly ModelCatalogItem[];
  onOpen: (row: TeamRow) => void;
  onQuickSave: (row: TeamRow, patch: { pinned_model_alias?: string | null; thinking_effort?: string | null }) => void;
  savingKey?: string;
  onNew: () => void;
  /** Verbs that stand in for creating an agent by hand sit beside "New agent". */
  newActions?: React.ReactNode;
  /** While the catalog is still answering, an empty list is not the empty state. */
  loading?: boolean;
}) {
  const { t, tp, locale } = useI18n();
  const [pendingModel, setPendingModel] = useState<{ key: string; alias: string }>();
  // The menu review for a pinned model opens anchored to that row's model cell.
  const pendingAnchor = useRef<HTMLElement | null>(null);
  const pendingRow = pendingModel === undefined ? undefined : rows.find((row) => row.key === pendingModel.key);
  const modelIds = useMemo(() => new Set(models.map((model) => model.id)), [models]);
  const sorts = useMemo<readonly ListSortSpec<TeamRow>[]>(() => [
    { id: 'order', label: t('st.list.sort.order'), compare: () => 0 },
    { id: 'name', label: t('st.list.sort.name'), compare: (a, b) => a.profile.name.localeCompare(b.profile.name) },
  ], [t]);
  const view = useListView({
    listId: 'agent-profiles', items: rows, keyOf: (row) => row.key, sorts,
    textOf: (row) => [row.profile.name, row.profile.description],
  });
  const modelChoices = (current: string) => [
    { value: '', label: t('st.profiles.modelUnset') },
    ...models.map((model) => ({ value: model.id, label: model.id, group: model.provider_id })),
    ...(current !== '' && current !== 'inherit' && !modelIds.has(current) ? [{ value: current, label: current, hint: t('st.profiles.aliasMissingShort') }] : []),
  ];
  const warnings = rows.reduce((count, row) => count + row.diagnostics.filter((item) => diagnosticTone(item) === 'warning').length, 0);
  const kindOf = (row: TeamRow): KindGroup => row.profile.main ? 'main' : 'subagent';
  const groups = KIND_ORDER.map((id) => ({
    id,
    rows: view.visible.filter((row) => kindOf(row) === id),
    total: rows.filter((row) => kindOf(row) === id).length,
  })).filter((group) => group.rows.length > 0);
  const newButton = <button type="button" data-profile-new onClick={onNew}
    className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-accent px-3 text-[12.5px] font-medium text-on-accent transition-colors hover:bg-accent-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink">
    <Icon name="plus" size={12} />{t('st.agentManager.new')}
  </button>;
  return <div className="space-y-3" data-team-view>
    <ListToolbar view={view} total={rows.length} searchLabel={t('st.profiles.search')} searchPlaceholder={t('st.profiles.search')}
      sorts={sorts} showDensity={false} actions={<>{newButton}{newActions}</>} />
    {warnings > 0 ? <p data-team-warnings className="inline-flex items-center gap-1.5 text-[12px] text-amber-ink">
      <Icon name="warning" size={12} />{tp('st.profiles.teamWarnings', warnings)}
    </p> : null}
    <div className="overflow-x-auto px-1">
      <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-0 text-left text-[13px] max-sm:min-w-0 max-sm:table-auto" data-team-table>
        <thead className="max-sm:hidden">
          <tr className="text-[11.5px] text-ink-faint">
            <th scope="col" className="border-b border-hairline py-2 pr-3 font-normal"><span className="sr-only">{t('st.profiles.colRole')}</span></th>
            <th scope="col" className="w-[12rem] border-b border-hairline py-2 pr-3 font-normal">{t('st.profiles.model')}</th>
            <th scope="col" className="w-[7.5rem] border-b border-hairline py-2 pr-3 font-normal">{t('st.profiles.effort')}</th>
            <th scope="col" className="w-[11rem] border-b border-hairline py-2 font-normal">{t('st.profiles.colDispatches')}</th>
          </tr>
        </thead>
        {groups.map((group, groupIndex) => {
          const folded = view.isFolded(group.id);
          const label = t(KIND_LABEL[group.id]);
          return <tbody key={group.id} data-team-group={group.id}>
            {/* ListGroup is a <section> and cannot wrap a tbody, so the table keeps
                its own fold header in the ListGroup look (chevron, label, count). */}
            <tr className="max-sm:block">
              <th scope="colgroup" colSpan={4} className={`border-b border-hairline pb-1 text-left font-medium max-sm:block ${groupIndex === 0 ? 'pt-3' : 'pt-7'}`}>
                <button type="button" aria-expanded={!folded} data-team-group-toggle={group.id}
                  aria-label={folded ? t('sidebar.expandGroup', { label }) : t('sidebar.collapseGroup', { label })}
                  onClick={() => { view.toggleFold(group.id); }}
                  className="-ml-1 flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink">
                  <DisclosureChevron open={!folded} className="text-ink-faint" />
                  <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{label}</span>
                  <span className="shrink-0 text-[12px] font-normal tabular-nums text-ink-faint">
                    {group.rows.length === group.total ? group.rows.length : t('st.list.countOf', { shown: group.rows.length, total: group.total })}
                  </span>
                </button>
              </th>
            </tr>
            {folded ? null : group.rows.map(renderRow)}
          </tbody>;
        })}
      </table>
      {view.visible.length === 0 && !loading ? <ListEmpty kind={view.narrowed ? 'no-match' : 'none'}
        title={t(view.narrowed ? 'st.profiles.teamNoMatch' : 'st.profiles.teamEmpty')}
        action={view.narrowed ? undefined : newButton} onClear={view.narrowed ? view.clear : undefined} /> : null}
    </div>
    {pendingModel !== undefined && pendingRow !== undefined ? (
      <AnchoredPopover open id="team-menu-review" anchorRef={pendingAnchor} onClose={() => setPendingModel(undefined)}
        label={t('st.profiles.modelFor', { name: pendingRow.profile.name })} widthClassName="w-[26rem]"
        data={{ 'data-team-menu-review': pendingRow.profile.name }}>
        <QuickModelMenuReview profile={pendingRow.profile} alias={pendingModel.alias} disabled={savingKey === pendingRow.key}
          onCancel={() => setPendingModel(undefined)} onSave={() => {
            onQuickSave(pendingRow, { pinned_model_alias: pendingModel.alias === '' ? null : pendingModel.alias });
            setPendingModel(undefined);
          }} />
      </AnchoredPopover>
    ) : null}
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
    // Where the file lives is a quiet tag; the common case (your own folder) carries none.
    const sourceTag = profile.source === 'user' ? undefined
      : profile.source === 'workspace' ? t('st.profiles.tagProject') : sourceBadgeLabel(t, profile.source);
    const muted = shadowed || profile.disabled;
    return <Fragment key={row.key}><tr data-team-row={profile.name} data-team-source={profile.source}
      className={`align-top max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:border-b max-sm:border-hairline max-sm:py-2.5 ${muted ? 'text-ink-faint' : ''}`}>
      <td className="border-b border-hairline py-2 pr-3 max-sm:w-full max-sm:border-0 max-sm:p-0">
        <button type="button" onClick={() => onOpen(row)} data-team-open={profile.name} data-detail-trigger={profile.name}
          className="group -mx-1 flex min-h-10 w-full min-w-0 flex-col items-start justify-center rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/50">
          <span className="flex w-full min-w-0 items-center gap-1.5">
            <span className={`min-w-0 truncate font-medium group-hover:underline group-hover:decoration-ink-faint group-hover:underline-offset-2 ${shadowed ? 'line-through decoration-ink-faint/60' : muted ? '' : 'text-ink'}`}>{displayName(profile, locale)}</span>
            {warn.length > 0 ? <span data-team-warning className="shrink-0 text-amber-ink" title={tp('st.profiles.rowWarnings', warn.length)}>
              <Icon name="warning" size={12} /><span className="sr-only">{tp('st.profiles.rowWarnings', warn.length)}</span>
            </span> : null}
            {external ? <span data-team-engine className={TAG_OUTLINE}>{row.engineLabel ?? profile.executor}</span> : null}
            {sourceTag !== undefined ? <span data-team-tag="source" className={TAG}>{sourceTag}</span> : null}
            {row.shipped && profile.source !== 'builtin' ? <span data-team-tag="shipped" className={TAG}>{t('st.profiles.shippedCopy')}</span> : null}
            {!row.writable && profile.source !== 'builtin' ? <span data-team-tag="readonly" className={TAG}>{t('st.agentManager.readOnlyShort')}</span> : null}
            {shadowed ? <span data-team-tag="shadowed" className={TAG}>{t('st.profiles.tagInactive')}</span> : null}
            {profile.disabled ? <span data-team-tag="disabled" className={TAG}>{t('st.namedAgents.disabledBadge')}</span> : null}
          </span>
          {profile.description !== undefined && profile.description !== ''
            ? <span className="w-full truncate text-[12px] text-ink-faint">{profile.description}</span> : null}
        </button>
      </td>
      <td className="border-b border-hairline py-2 pr-3 max-sm:border-0 max-sm:p-0" data-team-model
        ref={(node) => { if (pendingModel?.key === row.key) pendingAnchor.current = node; }}>
        {quickEditable && !external ? <SearchableSelect id={`team-model-${row.key}`} value={alias} allowCustomValue
          options={modelChoices(alias)} ariaLabel={t('st.profiles.modelFor', { name: profile.name })} searchPlaceholder="provider/model"
          triggerSuffix={aliasMissing ? <Icon name="warning" size={12} className="shrink-0 text-amber-ink" /> : undefined}
          triggerLabel={alias === '' ? <span className="font-sans text-ink-faint">{t('st.profiles.modelUnset')}</span>
            : <span className="min-w-0 truncate font-mono">{alias}</span>}
          buttonClassName={`${SETTINGS_SELECT_TRIGGER} w-full max-w-[12rem] text-[12px] ${aliasMissing ? 'text-amber-ink' : ''}`}
          onChange={(next) => {
            if (next === alias) { setPendingModel(undefined); return; }
            if (profile.restrict_models_to_menu === true) setPendingModel({ key: row.key, alias: next });
            else onQuickSave(row, { pinned_model_alias: next === '' ? null : next });
          }} />
          : <span className={`inline-flex h-8 max-w-full items-center gap-1 font-mono text-[12px] ${aliasMissing ? 'text-amber-ink' : ''}`}>
            <span className="font-sans text-ink-faint sm:hidden">{t('st.profiles.model')}</span>
            {aliasMissing ? <Icon name="warning" size={12} /> : null}
            {alias === '' ? <span className="font-sans text-ink-faint">{t('st.profiles.modelUnset')}</span> : <span className="min-w-0 truncate">{alias}</span>}
          </span>}
      </td>
      <td className="border-b border-hairline py-2 pr-3 max-sm:border-0 max-sm:p-0" data-team-effort>
        {quickEditable ? <SearchableSelect id={`team-effort-${row.key}`} value={effort} hideFilter
          options={[{ value: '', label: t('st.profiles.effortUnset') }, ...EFFORTS.map((level) => ({ value: level, label: effortLabel(level, t) })),
            ...(effort !== '' && !(EFFORTS as readonly string[]).includes(effort) ? [{ value: effort, label: effortLabel(effort, t) }] : [])]}
          triggerLabel={effort === '' ? <span className="text-ink-faint">{t('st.profiles.effortUnset')}</span> : effortLabel(effort, t)}
          ariaLabel={t('st.profiles.effortFor', { name: profile.name })} buttonClassName={`${SETTINGS_SELECT_TRIGGER} text-[12px]`}
          onChange={(next) => { if (next !== effort) onQuickSave(row, { thinking_effort: next === '' ? null : next }); }} />
          : <span className="inline-flex h-8 items-center gap-1 text-[12px]"><span className="text-ink-faint sm:hidden">{t('st.profiles.effort')}</span>{effort === '' ? <span className="text-ink-faint">{t('st.profiles.effortUnset')}</span> : effortLabel(effort, t)}</span>}
      </td>
      <td className="min-w-0 border-b border-hairline py-2 text-[12px] max-sm:w-full max-sm:border-0 max-sm:p-0" data-team-dispatch
        title={dispatch.names.length > DISPATCH_SHOWN ? dispatch.text : undefined}>
        <span className="flex h-8 min-w-0 items-center gap-1 whitespace-nowrap">
          <span className="shrink-0 text-ink-faint sm:hidden">{t('st.profiles.colDispatches')}</span>
          <span className={`min-w-0 truncate ${dispatch.quiet ? 'text-ink-faint' : 'text-ink-soft'}`}>
            {dispatch.names.length > 0 ? dispatch.names.slice(0, DISPATCH_SHOWN).join(', ') : dispatch.text}
          </span>
          {dispatch.names.length > DISPATCH_SHOWN ? <span data-team-dispatch-more className="shrink-0 rounded-[4px] bg-ink/[0.05] px-1 text-[11px] text-ink-soft">
            {t('st.profiles.dispatchMore', { count: dispatch.names.length - DISPATCH_SHOWN })}
            <span className="sr-only">: {dispatch.names.slice(DISPATCH_SHOWN).join(', ')}</span>
          </span> : null}
        </span>
      </td>
    </tr>
    </Fragment>;
  }
}

function QuickModelMenuReview({ profile, alias, disabled, onSave, onCancel }: {
  profile: NamedAgentProfile; alias: string; disabled: boolean; onSave: () => void; onCancel: () => void;
}) {
  const { t } = useI18n();
  const preview = useModelMenuPreview(profile, { pinned_model_alias: alias === '' ? null : alias }, true);
  return <div className="max-w-[40rem] space-y-2" data-team-pending-model={alias}>
    <p className="text-[12px] font-medium text-ink">{t('st.profiles.modelFor', { name: profile.name })}: <span className="break-all font-mono">{alias || t('st.profiles.modelUnset')}</span></p>
    <ModelMenuPreview value={preview.value} pending={preview.pending} error={preview.error} onRetry={preview.retry} />
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" data-team-menu-save className={PRIMARY_BUTTON} disabled={disabled || !preview.ready} onClick={onSave}>{t('common.save')}</button>
      <button type="button" className={SECONDARY_BUTTON} disabled={disabled} onClick={onCancel}>{t('common.cancel')}</button>
    </div>
  </div>;
}
