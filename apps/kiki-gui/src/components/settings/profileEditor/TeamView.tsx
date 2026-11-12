import { useMemo } from 'react';

import type { ModelCatalogItem } from '@kiki/protocol';
import { useI18n } from '../../../i18n';
import type { NamedAgentProfile } from '../../../lib/client';
import { Icon } from '../../icons';
import { sourceBadgeLabel } from '../../agent-panel/SourceBadge';
import { SettingsLoading, TEXT_BUTTON } from '../SettingsPrimitives';
import { ListEmpty, ListGroup, ListToolbar, useListView, type ListSortSpec } from '../list';
import { diagnosticTone, type ProfileDiagnostic } from './diagnostics';
import { DiagnosticsList } from './DiagnosticsList';
import { effortLabel, isExternalExecutor } from './profileDraft';

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

const TAG = 'shrink-0 rounded-[4px] bg-ink/[0.05] px-1.5 text-[11px] leading-[18px] text-ink-soft';
const TAG_OUTLINE = 'shrink-0 rounded-[4px] border border-hairline px-1.5 text-[11px] leading-[16px] text-ink-soft';

/**
 * The agents, in the two groups a person actually keeps apart: the agents
 * they talk to, and the helpers those agents dispatch. Each row is two lines:
 * the name with its small tags (where the file lives, whether it runs), and
 * the values in effect — the model it answers with, its thinking level, and
 * whether it can be dispatched. "Default" always says what it resolves to
 * ("Default model (Kiki Pro)"), or "Default (unknown)" when this page cannot
 * tell; a bare "Default" never appears. Changing the model or the thinking
 * level happens in the agent's own detail, which the row opens.
 *
 * Problems are said once, above the list, next to the agent they are about,
 * with the way to fix them; the row itself only carries the warning mark.
 */
export function TeamView({ rows, models, defaultModelId, onOpen, onNew, newActions, loading = false }: {
  rows: readonly TeamRow[];
  models: readonly ModelCatalogItem[];
  /** The model new conversations use, which an agent without its own model answers with. */
  defaultModelId?: string;
  onOpen: (row: TeamRow) => void;
  onNew: () => void;
  /** Verbs that stand in for creating an agent by hand sit beside "New agent". */
  newActions?: React.ReactNode;
  /** While the catalog is still answering, an empty list is not the empty state. */
  loading?: boolean;
}) {
  const { t, locale } = useI18n();
  const modelsById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const sorts = useMemo<readonly ListSortSpec<TeamRow>[]>(() => [
    { id: 'order', label: t('st.list.sort.order'), compare: () => 0 },
    { id: 'name', label: t('st.list.sort.name'), compare: (a, b) => a.profile.name.localeCompare(b.profile.name) },
  ], [t]);
  const view = useListView({
    listId: 'agent-profiles', items: rows, keyOf: (row) => row.key, sorts,
    textOf: (row) => [row.profile.name, row.profile.description],
  });
  const kindOf = (row: TeamRow): KindGroup => row.profile.main ? 'main' : 'subagent';
  const groups = KIND_ORDER.map((id) => ({
    id,
    rows: view.visible.filter((row) => kindOf(row) === id),
    total: rows.filter((row) => kindOf(row) === id).length,
  })).filter((group) => group.rows.length > 0);
  const attention = rows
    .map((row) => ({ row, warnings: row.diagnostics.filter((item) => diagnosticTone(item) === 'warning') }))
    .filter((entry) => entry.warnings.length > 0);
  const warningCount = attention.reduce((count, entry) => count + entry.warnings.length, 0);
  const newButton = <button type="button" data-profile-new onClick={onNew}
    className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-accent px-3 text-[12.5px] font-medium text-on-accent transition-colors hover:bg-accent-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink">
    <Icon name="plus" size={12} />{t('st.agentManager.new')}
  </button>;
  const onlyMain = !loading && !view.narrowed && rows.length > 0 && rows.every((row) => row.profile.main);

  return <div className="space-y-3" data-team-view>
    <ListToolbar view={view} total={rows.length} searchLabel={t('st.profiles.search')} searchPlaceholder={t('st.profiles.search')}
      sorts={sorts} showDensity={false} actions={<>{newButton}{newActions}</>} />
    {attention.length > 0 ? (
      <section data-team-warnings aria-label={t('st.attention.count', { count: warningCount })} className="space-y-1">
        <p className="text-[12px] font-medium text-attention">{t('st.attention.count', { count: warningCount })}</p>
        <ul className="divide-y divide-hairline">
          {attention.map(({ row, warnings }) => (
            <li key={row.key} data-team-attention={row.profile.name}
              className="flex flex-wrap items-start gap-x-3 gap-y-1 py-1.5">
              <span className="w-full shrink-0 truncate text-[13px] font-medium text-ink sm:w-32">{displayName(row.profile, locale)}</span>
              <div className="min-w-0 flex-1"><DiagnosticsList diagnostics={warnings} /></div>
              <button type="button" data-team-attention-open={row.profile.name} onClick={() => onOpen(row)}
                className={`h-7 shrink-0 pointer-coarse:h-10 ${TEXT_BUTTON}`}>
                {t('st.profiles.openThere')}
              </button>
            </li>
          ))}
        </ul>
      </section>
    ) : null}
    {loading && rows.length === 0 ? <SettingsLoading label={t('st.namedAgents.loading')} rows={2} /> : null}
    <div data-team-list>
      {groups.map((group) => {
        const label = t(KIND_LABEL[group.id]);
        return <div key={group.id} data-team-group={group.id}>
          <ListGroup groupKey={group.id} label={label} count={group.rows.length} total={group.total}
            folded={view.isFolded(group.id)} onToggle={() => { view.toggleFold(group.id); }}>
            <ul className="border-t border-hairline">{group.rows.map(renderRow)}</ul>
          </ListGroup>
        </div>;
      })}
    </div>
    {onlyMain ? <ListEmpty kind="none" title={t('st.agents.empty')} /> : null}
    {view.visible.length === 0 && !loading ? <ListEmpty kind={view.narrowed ? 'no-match' : 'none'}
      title={t(view.narrowed ? 'st.profiles.teamNoMatch' : 'st.profiles.teamEmpty')}
      action={view.narrowed ? undefined : newButton} onClear={view.narrowed ? view.clear : undefined} /> : null}
  </div>;

  /**
   * The model a row answers with, as words. An agent's own model is named;
   * without one, a native agent uses the model new conversations use, and an
   * external engine picks its own, which this page cannot see.
   */
  function modelPart(profile: NamedAgentProfile, aliasMissing: boolean): { text: string; model?: ModelCatalogItem; warn: boolean } {
    const alias = profile.pinned_model_alias ?? '';
    if (alias === 'inherit') return { text: t('st.namedAgents.followCallerModel'), warn: false };
    if (alias !== '') {
      const model = modelsById.get(alias);
      return { text: model?.display_name ?? alias, model, warn: aliasMissing };
    }
    if (isExternalExecutor(profile.executor) || defaultModelId === undefined || defaultModelId === '') {
      return { text: t('common.defaultUnknown'), warn: false };
    }
    const model = modelsById.get(defaultModelId);
    return { text: t('st.agents.row.model', { model: model?.display_name ?? defaultModelId }), model, warn: false };
  }

  /**
   * The thinking level in effect: the agent's own, or the default of the
   * model it answers with. When neither is known the part is left out rather
   * than guessed.
   */
  function thinkingPart(profile: NamedAgentProfile, model: ModelCatalogItem | undefined): string | undefined {
    const effort = profile.thinking_effort ?? '';
    if (effort !== '') return t('st.agents.row.thinking', { effort: effortLabel(effort, t) });
    const fallback = model?.default_effort ?? '';
    if (fallback === '') return undefined;
    return t('st.agents.row.thinking', { effort: t('common.defaultWithValue', { value: effortLabel(fallback, t) }) });
  }

  function renderRow(row: TeamRow) {
    const { profile } = row;
    const external = isExternalExecutor(profile.executor);
    const warn = row.diagnostics.filter((item) => diagnosticTone(item) === 'warning');
    const aliasMissing = row.diagnostics.some((item) => item.kind === 'aliasMissing' && item.field === 'model_alias');
    const shadowed = row.diagnostics.some((item) => item.kind === 'shadowedBy');
    // Where the file lives is a quiet tag; the common case (your own folder) carries none.
    const sourceTag = profile.source === 'user' ? undefined
      : profile.source === 'workspace' ? t('st.profiles.tagProject') : sourceBadgeLabel(t, profile.source);
    const muted = shadowed || profile.disabled;
    const model = modelPart(profile, aliasMissing);
    const thinking = thinkingPart(profile, model.model);
    // A helper that runs can be sent out; a disabled or shadowed one cannot,
    // and its tag already says why.
    const dispatchable = !profile.main && !profile.disabled && !shadowed;
    return <li key={row.key} data-team-row={profile.name} data-team-source={profile.source}
      className={`border-b border-hairline ${muted ? 'text-ink-faint' : ''}`}>
      <button type="button" onClick={() => onOpen(row)} data-team-open={profile.name} data-detail-trigger={profile.name}
        className="group flex min-h-11 w-full min-w-0 flex-col items-start justify-center gap-0.5 rounded-md px-1 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/50">
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span className={`min-w-0 shrink truncate text-[13px] font-medium group-hover:underline group-hover:decoration-ink-faint group-hover:underline-offset-2 ${shadowed ? 'line-through decoration-ink-faint/60' : muted ? '' : 'text-ink'}`}>{displayName(profile, locale)}</span>
          {warn.length > 0 ? <span data-team-warning className="shrink-0 text-amber-ink">
            <Icon name="warning" size={12} /><span className="sr-only">{t('st.attention.count', { count: warn.length })}</span>
          </span> : null}
          {external ? <span data-team-engine className={TAG_OUTLINE}>{row.engineLabel ?? profile.executor}</span> : null}
          {sourceTag !== undefined ? <span data-team-tag="source" className={TAG}>{sourceTag}</span> : null}
          {row.shipped && profile.source !== 'builtin' ? <span data-team-tag="shipped" className={TAG}>{t('st.profiles.shippedCopy')}</span> : null}
          {!row.writable && profile.source !== 'builtin' ? <span data-team-tag="readonly" className={TAG}>{t('st.agentManager.readOnlyShort')}</span> : null}
          {shadowed ? <span data-team-tag="shadowed" className={TAG}>{t('st.profiles.tagInactive')}</span> : null}
          {profile.disabled ? <span data-team-tag="disabled" className={TAG}>{t('st.namedAgents.disabledBadge')}</span> : null}
          {/* What the agent is for, beside its name where there is room; the
              phone keeps the two lines for name and values, and the detail
              the row opens has the full description. */}
          {profile.description !== undefined && profile.description !== ''
            ? <span className="hidden min-w-0 flex-1 truncate text-[12px] text-ink-faint sm:inline">{profile.description}</span> : null}
        </span>
        <span data-team-effective className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 text-[12px] text-ink-soft">
          <span data-team-model className={`inline-flex min-w-0 items-center gap-1 ${model.warn ? 'text-amber-ink' : ''}`}>
            {model.warn ? <Icon name="warning" size={12} /> : null}
            <span className="min-w-0 truncate">{model.text}</span>
          </span>
          {thinking !== undefined ? <><span aria-hidden className="text-ink-faint">·</span><span data-team-effort>{thinking}</span></> : null}
          {dispatchable ? <><span aria-hidden className="text-ink-faint">·</span><span data-team-dispatchable>{t('st.agents.row.dispatchable')}</span></> : null}
        </span>
      </button>
    </li>;
  }
}
