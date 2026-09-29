import type { ReactNode } from 'react';

import { useI18n } from '../../../i18n';
import type { NamedAgentProfile } from '../../../lib/client';
import { Icon } from '../../icons';
import { diagnosticTone } from './diagnostics';
import { isExternalExecutor } from './profileDraft';
import type { TeamRow } from './TeamView';

interface Member {
  readonly name: string;
  readonly row?: TeamRow;
  readonly model?: string;
  readonly effort?: string;
  /** The lead's lease pins this member's model or effort. */
  readonly leased: boolean;
}

function membersOf(lead: NamedAgentProfile, byName: ReadonlyMap<string, TeamRow>): Member[] | 'any' | 'none' {
  if (lead.subagents === undefined) return 'any';
  if (lead.subagents.length === 0) return 'none';
  return lead.subagents.map((entry) => {
    const name = typeof entry === 'string' ? entry : entry.name;
    const row = byName.get(name);
    const lease = typeof entry === 'string' ? undefined : entry;
    return {
      name, row,
      model: lease?.model_alias ?? row?.profile.pinned_model_alias,
      effort: lease?.thinking_effort ?? row?.profile.thinking_effort,
      leased: lease?.model_alias !== undefined || lease?.thinking_effort !== undefined,
    };
  });
}

/** The list view's badge, verbatim, so both views read as one table. */
const BADGE = 'shrink-0 rounded-[4px] bg-ink/[0.05] px-1.5 text-[11px] text-ink-soft';
const ENGINE_BADGE = 'shrink-0 rounded-[4px] border border-hairline px-1.5 text-[11px] text-ink-soft';
const ROW = 'grid min-w-0 grid-cols-[minmax(0,1fr)_12rem_7rem] items-center gap-x-3 border-b border-hairline py-2 max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-y-0.5';

/**
 * Teams: each main agent with the agents it may dispatch, in dispatch order,
 * and what each one would run on under that lead (a lease pin wins over the
 * member's own pin). Same row type, columns and badges as the list view;
 * read-only, and a name opens that agent's editor.
 */
export function TeamRoster({ rows, onOpen, displayName }: {
  rows: readonly TeamRow[];
  onOpen: (row: TeamRow) => void;
  displayName: (profile: NamedAgentProfile) => string;
}) {
  const { t, tp } = useI18n();
  const byName = new Map(rows.map((row) => [row.profile.name, row]));
  const leads = rows.filter((row) => row.profile.main && row.diagnostics.every((item) => item.kind !== 'shadowedBy'));
  const nameButton = (row: TeamRow, label: string, className: string) => <button type="button" onClick={() => onOpen(row)}
    data-roster-open={row.profile.name}
    className={`min-w-0 truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/50 ${className}`}>{label}</button>;
  const modelCell = (model: string | undefined, external: boolean, engine: string | undefined): ReactNode =>
    <span className="flex min-w-0 items-center gap-1.5 text-[12px]" data-roster-model>
      {external && engine !== undefined ? <span className={ENGINE_BADGE}>{engine}</span> : null}
      {model !== undefined ? <span className="min-w-0 truncate font-mono text-ink">{model}</span>
        : <span className="truncate text-ink-soft">{t('st.profiles.modelUnset')}</span>}
    </span>;
  const effortCell = (effort: string | undefined) => <span className="text-[12px] max-sm:hidden" data-roster-effort>
    {effort ?? <span className="text-ink-soft">—</span>}
  </span>;

  if (leads.length === 0) return <p className="py-6 text-center text-[12.5px] text-ink-faint">{t('st.profiles.rosterEmpty')}</p>;
  return <div className="min-w-0 text-[13px]" data-team-roster>
    <div className="grid grid-cols-[minmax(0,1fr)_12rem_7rem] gap-x-3 border-b border-hairline py-2 text-[11.5px] font-medium text-ink-faint max-sm:hidden">
      <span>{t('st.profiles.colRole')}</span><span>{t('st.profiles.model')}</span><span>{t('st.profiles.effort')}</span>
    </div>
    {leads.map((lead) => {
      const { profile } = lead;
      const members = membersOf(profile, byName);
      const warnCount = lead.diagnostics.filter((item) => diagnosticTone(item) === 'warning').length;
      return <section key={lead.key} data-roster-team={profile.name} aria-label={t('st.profiles.rosterTeam', { name: displayName(profile) })}
        className={`min-w-0 pt-3 ${profile.disabled ? 'text-ink-faint' : ''}`}>
        <div className={ROW}>
          <span className="flex min-w-0 items-center gap-1.5">
            {nameButton(lead, displayName(profile), 'font-medium text-ink')}
            <span className={BADGE}>{t('st.agentManager.main')}</span>
            {profile.subagent_policy === 'strict' ? <span className={BADGE}>{t('st.profiles.rosterStrict')}</span> : null}
            {warnCount > 0 ? <span className="shrink-0 text-amber-ink" title={tp('st.profiles.rowWarnings', warnCount)}><Icon name="warning" size={12} />
              <span className="sr-only">{tp('st.profiles.rowWarnings', warnCount)}</span></span> : null}
            {profile.disabled ? <span className="shrink-0 text-[11.5px] text-ink-faint">{t('st.namedAgents.disabledBadge')}</span> : null}
          </span>
          {modelCell(profile.pinned_model_alias, isExternalExecutor(profile.executor), lead.engineLabel)}
          {effortCell(profile.thinking_effort)}
        </div>
        {members === 'any' || members === 'none'
          ? <p className="border-b border-hairline py-2 pl-5 text-[12px] text-ink-soft">
            {t(members === 'any' ? 'st.profiles.subagentsAnyHint' : 'st.profiles.subagentsNoneHint')}
          </p>
          : <ol data-roster-members>
            {members.map((member, index) => {
              const target = member.row?.profile;
              return <li key={member.name} data-roster-member={member.name} className={`${ROW} pl-5`}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-ink-faint">{index + 1}</span>
                  {member.row !== undefined ? nameButton(member.row, member.name, 'text-ink')
                    : <span className="min-w-0 truncate text-ink-faint">{member.name}</span>}
                  {target?.main === true ? <span className={BADGE} title={t('st.profiles.rosterMainMemberHint')}>{t('st.agentManager.main')}</span> : null}
                  {member.leased ? <span className="shrink-0 truncate text-[11.5px] text-ink-faint">{t('st.profiles.rosterLeased', { name: profile.name })}</span> : null}
                </span>
                {member.row === undefined
                  ? <span className="inline-flex items-center gap-1 text-[12px] text-amber-ink"><Icon name="warning" size={12} />{t('st.profiles.subagentMissing')}</span>
                  : modelCell(member.model, isExternalExecutor(target?.executor), member.row.engineLabel)}
                {member.row === undefined ? <span className="max-sm:hidden" /> : effortCell(member.effort)}
              </li>;
            })}
          </ol>}
      </section>;
    })}
  </div>;
}
