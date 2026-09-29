import { useState } from 'react';

import type { ModelCatalogItem } from '@kiki/protocol';
import { useI18n } from '../../../i18n';
import type { NamedAgentProfile } from '../../../lib/client';
import { Icon } from '../../icons';
import { SearchableSelect } from '../../SearchableSelect';
import { SettingsSegmented } from '../SettingsPrimitives';
import { EffortPicker, ModelPicker } from './fields';
import type { ProfileDraft, SubagentDraft, SubagentsMode } from './profileDraft';

/**
 * `subagents`: the dispatch whitelist, in dispatch order, and per entry the
 * lease pins the parent imposes on that child (model / effort). A lease pin
 * wins over the child's own pin, so an unset cell shows the value the child
 * would run on anyway.
 */
export function SubagentsField({ draft, onChange, profiles, models, disabled, self }: {
  draft: ProfileDraft;
  onChange: (next: Pick<ProfileDraft, 'subagentsMode' | 'subagents'>) => void;
  profiles: readonly NamedAgentProfile[];
  models: readonly ModelCatalogItem[];
  disabled: boolean;
  self: string;
}) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  const listed = new Set(draft.subagents.map((entry) => entry.name));
  const candidates = [...new Map(profiles.filter((profile) => profile.name !== self && !listed.has(profile.name))
    .map((profile) => [profile.name, profile])).values()].toSorted((a, b) => Number(a.main) - Number(b.main) || a.name.localeCompare(b.name));
  const setEntries = (subagents: readonly SubagentDraft[]) => onChange({ subagentsMode: 'list', subagents });
  const update = (index: number, patch: Partial<SubagentDraft>) =>
    setEntries(draft.subagents.map((entry, at) => at === index ? { ...entry, ...patch } : entry));
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= draft.subagents.length) return;
    const next = [...draft.subagents];
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry!);
    setEntries(next);
  };
  const last = draft.subagents.length - 1;
  return <div className="space-y-2.5" data-subagents-field>
    <SettingsSegmented<SubagentsMode> ariaLabel={t('st.profiles.subagents')} value={draft.subagentsMode} disabled={disabled}
      dataAttr="data-subagents-mode"
      onChange={(mode) => onChange({ subagentsMode: mode, subagents: draft.subagents })}
      choices={[
        { value: 'list', label: t('st.profiles.subagentsList') },
        { value: 'none', label: t('st.profiles.subagentsNone') },
        { value: 'unrestricted', label: t('st.profiles.subagentsAny') },
      ]} />
    <p className="text-[11.5px] leading-snug text-ink-faint">{t(draft.subagentsMode === 'list' ? 'st.profiles.leaseHint'
      : draft.subagentsMode === 'none' ? 'st.profiles.subagentsNoneHint' : 'st.profiles.subagentsAnyHint')}</p>
    {draft.subagentsMode === 'list' ? <>
      <ol className="divide-y divide-hairline rounded-lg border border-hairline" data-subagent-rows>
        {draft.subagents.map((entry, index) => {
          const target = byName.get(entry.name);
          const missing = target === undefined && entry.source === undefined;
          const ownModel = target?.pinned_model_alias;
          const ownEffort = target?.thinking_effort;
          return <li key={entry.name} data-subagent-row={entry.name}
            draggable={!disabled}
            onDragStart={(event) => { setDragging(index); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', entry.name); }}
            onDragOver={(event) => { if (dragging === null) return; event.preventDefault(); setDropAt(index); }}
            onDrop={(event) => { event.preventDefault(); if (dragging !== null) move(dragging, index); setDragging(null); setDropAt(null); }}
            onDragEnd={() => { setDragging(null); setDropAt(null); }}
            className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-1.5 pb-2 pt-1 ${
              dragging === index ? 'opacity-50' : ''} ${dropAt === index && dragging !== null && dragging !== index ? 'bg-ink/[0.04]' : ''}`}>
            <span aria-hidden className={`flex h-8 w-5 items-center justify-center text-ink-faint ${disabled ? '' : 'cursor-grab active:cursor-grabbing'}`}>
              <Icon name="grip" size={12} />
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-ink-faint">{index + 1}</span>
              <span className="min-w-0 truncate font-mono text-[12.5px] text-ink" title={entry.name}>{entry.name}</span>
              {target?.main === true ? <span className={BADGE} title={t('st.profiles.rosterMainMemberHint')}>{t('st.agentManager.main')}</span> : null}
              {entry.source !== undefined ? <span className={BADGE} title={entry.source}>{t('st.profiles.scopedLease')}</span> : null}
              {missing ? <span data-subagent-missing className="inline-flex shrink-0 items-center text-amber-ink" title={t('st.profiles.subagentMissing')}>
                <Icon name="warning" size={12} /><span className="sr-only">{t('st.profiles.subagentMissing')}</span></span> : null}
            </span>
            <div className="col-span-3 col-start-1 grid min-w-0 grid-cols-[minmax(0,1fr)_6.5rem] gap-2 pl-7">
              <div className="min-w-0">
                <ModelPicker id={`lease-model-${entry.name}`} value={entry.modelAlias} models={models} allowInherit disabled={disabled}
                  unsetLabel={t('st.profiles.leaseInherits', { value: ownModel ?? t('st.profiles.modelUnset') })}
                  unsetTrigger={<span className="truncate font-mono text-ink-soft">{ownModel ?? <span className="font-sans">{t('st.profiles.modelUnset')}</span>}</span>}
                  ariaLabel={`${entry.name} · ${t('st.profiles.leaseModel')}`}
                  missing={entry.modelAlias !== '' && entry.modelAlias !== 'inherit' && models.length > 0 && !models.some((model) => model.id === entry.modelAlias)}
                  onChange={(value) => update(index, { modelAlias: value })} />
              </div>
              <EffortPicker id={`lease-effort-${entry.name}`} value={entry.effort} disabled={disabled}
                unsetLabel={t('st.profiles.leaseInherits', { value: ownEffort ?? t('st.profiles.effortUnset') })}
                unsetTrigger={<span className="truncate text-ink-soft">{ownEffort ?? t('st.profiles.effortUnset')}</span>}
                ariaLabel={`${entry.name} · ${t('st.profiles.leaseEffort')}`}
                onChange={(value) => update(index, { effort: value })} />
            </div>
            <span className="col-start-3 row-start-1 flex shrink-0 items-center">
              <button type="button" data-subagent-up={entry.name} disabled={disabled || index === 0} aria-label={t('st.profiles.moveUp', { item: entry.name })}
                onClick={() => move(index, index - 1)} className={ROW_BUTTON}><Icon name="arrowUp" size={12} /></button>
              <button type="button" data-subagent-down={entry.name} disabled={disabled || index === last} aria-label={t('st.profiles.moveDown', { item: entry.name })}
                onClick={() => move(index, index + 1)} className={ROW_BUTTON}><Icon name="arrowDown" size={12} /></button>
              <button type="button" disabled={disabled} aria-label={t('st.profiles.removeItem', { item: entry.name })}
                onClick={() => setEntries(draft.subagents.filter((_, at) => at !== index))} className={ROW_BUTTON}>
                <Icon name="close" size={12} />
              </button>
            </span>
          </li>;
        })}
        {draft.subagents.length === 0 ? <li className="px-3 py-3 text-[12px] text-ink-faint">{t('st.profiles.subagentsEmpty')}</li> : null}
      </ol>
      <SearchableSelect id="subagent-add" value="" disabled={disabled} hideChevron
        options={candidates.map((profile) => ({
          value: profile.name, label: profile.name, description: profile.description,
          hint: profile.pinned_model_alias, group: profile.main ? t('st.agentManager.main') : t('st.agentManager.subagent'),
        }))}
        ariaLabel={t('st.profiles.addSubagent')} searchPlaceholder={t('st.profiles.searchAgents')} emptyText={t('st.profiles.noMoreAgents')}
        triggerLabel={<span className="inline-flex items-center gap-1"><Icon name="plus" size={12} />{t('st.profiles.addSubagent')}</span>}
        buttonClassName="inline-flex h-8 items-center rounded-md px-2 text-[12.5px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50"
        onChange={(name) => { if (name !== '') setEntries([...draft.subagents, { name, modelAlias: '', effort: '' }]); }} />
    </> : null}
  </div>;
}

const BADGE = 'shrink-0 rounded-[4px] bg-ink/[0.05] px-1.5 text-[11px] text-ink-soft';
const ROW_BUTTON = 'flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-ink/[0.05] hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent';
