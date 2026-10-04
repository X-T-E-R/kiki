import { useState } from 'react';

import type { ModelCatalogItem } from '@kiki/protocol';
import { useI18n } from '../../../i18n';
import type { NamedAgentProfile } from '../../../lib/client';
import { Icon } from '../../icons';
import { SearchableSelect } from '../../SearchableSelect';
import { SettingsSegmented } from '../SettingsPrimitives';
import { allowedSubagentsOpen, isOpenDomain, openAllowedSubagents, PRESET_DOMAIN_OPEN as WILDCARD, type ProfileDraft, type SubagentLeaseDraft, type SubagentPolicyDraft } from './profileDraft';
import { EffortPicker, ModelPicker } from './fields';

/**
 * Child agents, as one switch and three lists.
 *
 * The switch is the only thing that decides whether this profile starts child
 * agents at all, so it stands alone with a plain on/off reading; the three
 * lists beneath it only narrow the named presets and routes. A list that is
 * not declared is drawn as "not limited here" rather than as an empty list,
 * because the two bind differently and an empty allowed list still leaves
 * preset files dispatchable by path.
 *
 * Preference and denial are names, so they read as chips with a plain text
 * add; the preset list is the only one carrying lease pins, so it keeps the
 * ordered table the dispatcher order needs.
 */
export function SubagentsField({ draft, onChange, profiles, models, disabled, self }: {
  draft: ProfileDraft;
  onChange: (next: Pick<ProfileDraft, 'subagentPolicy'>) => void;
  profiles: readonly NamedAgentProfile[];
  models: readonly ModelCatalogItem[];
  disabled: boolean;
  self: string;
}) {
  const { t } = useI18n();
  const policy = draft.subagentPolicy;
  return <div className="space-y-3" data-subagents-field>
    <CanSpawnSwitch policy={policy} disabled={disabled}
      onChange={(canSpawnSubagents) => onChange({ subagentPolicy: { ...policy, canSpawnSubagents } })} />
    {policy.canSpawnSubagents === false ? null : <div className="space-y-4" data-dispatch-lists>
      <PresetListField policy={policy} onChange={onChange} profiles={profiles} models={models} disabled={disabled} self={self} />
      <NameListField id="preferred" list={policy.preferredSubagents} policy={policy} known={policy.allowedSubagents?.map((entry) => entry.name)}
        onChange={onChange} disabled={disabled}
        titleKey="st.profiles.dispatchPreferred" hintKey="st.profiles.dispatchPreferredHint" emptyKey="st.profiles.dispatchEmptyPreferred"
        addLabel={t('st.profiles.dispatchAddToPreferred')} />
      <NameListField id="deny" list={policy.denySubagents} policy={policy} known={policy.allowedSubagents?.map((entry) => entry.name)}
        onChange={onChange} disabled={disabled}
        titleKey="st.profiles.dispatchDeny" hintKey="st.profiles.dispatchDenyHint" emptyKey="st.profiles.dispatchEmptyDeny"
        addLabel={t('st.profiles.dispatchAddToDeny')} />
    </div>}
  </div>;
}

/**
 * The switch, plus where its value comes from. `undefined` is drawn as its own
 * state rather than folded into "on": a profile that says nothing is not the
 * same as one that grants, and the user needs to see which they are editing.
 */
function CanSpawnSwitch({ policy, disabled, onChange }: {
  policy: SubagentPolicyDraft;
  disabled: boolean;
  onChange: (value: boolean | undefined) => void;
}) {
  const { t } = useI18n();
  const declared = policy.canSpawnSubagents;
  // One control, three states. A switch cannot say "this profile declares
  // nothing", and drawing it as on would be a claim the profile never made, so
  // the segments carry the whole value and there is no separate toggle.
  return <div data-dispatch-can-spawn data-declared={declared === undefined ? 'false' : 'true'} className="space-y-1.5">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
      <span className="min-w-0 text-[12px] font-medium text-ink-soft">{t('st.profiles.dispatchCanSpawn')}</span>
      <SettingsSegmented<'inherit' | 'on' | 'off'> ariaLabel={t('st.profiles.dispatchCanSpawn')}
        value={declared === undefined ? 'inherit' : declared ? 'on' : 'off'}
        disabled={disabled} dataAttr="data-dispatch-can-spawn-mode"
        onChange={(mode) => onChange(mode === 'inherit' ? undefined : mode === 'on')}
        choices={[
          { value: 'inherit', label: t('st.profiles.dispatchNotDeclared') },
          { value: 'on', label: t('st.profiles.dispatchCanSpawnOn') },
          { value: 'off', label: t('st.profiles.dispatchCanSpawnOff') },
        ]} />
    </div>
    <p className="text-[11.5px] leading-snug text-ink-faint">{t(declared === false
      ? 'st.profiles.dispatchCanSpawnOffHint'
      : declared === undefined ? 'st.profiles.dispatchCanSpawnInheritHint' : 'st.profiles.dispatchHint')}</p>
  </div>;
}

/**
 * The preset list: ordered, and each row carries the lease pins this profile
 * imposes on that child. Undeclared and empty are drawn apart, and the clear
 * button is what turns a written list back into "not limited here".
 */
function PresetListField({ policy, onChange, profiles, models, disabled, self }: {
  policy: SubagentPolicyDraft;
  onChange: (next: Pick<ProfileDraft, 'subagentPolicy'>) => void;
  profiles: readonly NamedAgentProfile[];
  models: readonly ModelCatalogItem[];
  disabled: boolean;
  self: string;
}) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const entries = policy.allowedSubagents;
  const declared = entries !== undefined;
  // An open domain stays open while presets are added or removed: the list is
  // still "no scope here, plus these pins", not a scope that grew by accident.
  const open = allowedSubagentsOpen(entries);
  const rowEntries = (open ? (entries ?? []).filter((entry) => !isOpenDomain(entry.name)) : entries) ?? [];
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  const listed = new Set((entries ?? []).map((entry) => entry.name));
  const denied = new Set(policy.denySubagents ?? []);
  const candidates = [...new Map(profiles.filter((profile) => profile.name !== self && !listed.has(profile.name))
    .map((profile) => [profile.name, profile])).values()]
    .toSorted((a, b) => Number(a.main) - Number(b.main) || a.name.localeCompare(b.name));
  const setEntries = (next: readonly SubagentLeaseDraft[]) => onChange({
    subagentPolicy: { ...policy, allowedSubagents: open ? [{ name: WILDCARD, modelAlias: '', effort: '' }, ...next] : next },
  });
  const update = (index: number, patch: Partial<SubagentLeaseDraft>) =>
    setEntries(rowEntries.map((entry, at) => at === index ? { ...entry, ...patch } : entry));
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= rowEntries.length) return;
    const next = [...rowEntries];
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry!);
    setEntries(next);
  };
  const last = rowEntries.length - 1;
  return <div className="space-y-2" data-dispatch-allowed data-declared={declared ? 'true' : 'false'}>
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="min-w-0 text-[12px] font-medium text-ink-soft">{t('st.profiles.dispatchAllowed')}</span>
      {open ? <button type="button" data-dispatch-allowed-narrow disabled={disabled}
        onClick={() => onChange({ subagentPolicy: { ...policy, allowedSubagents: rowEntries } })}
        className={HEADER_BUTTON}>{t('st.profiles.dispatchNarrowToList')}</button> : null}
      {declared ? <button type="button" data-dispatch-allowed-clear disabled={disabled}
        onClick={() => onChange({ subagentPolicy: { ...policy, allowedSubagents: openAllowedSubagents(entries) } })}
        className={HEADER_BUTTON}>{t('st.profiles.dispatchClearList')}</button> : null}
    </div>
    {!declared || allowedSubagentsOpen(entries) ? <p data-dispatch-allowed-unset className="text-[11.5px] leading-snug text-ink-soft">
      {t(allowedSubagentsOpen(entries) ? 'st.profiles.dispatchAllowedOpen' : 'st.profiles.dispatchAllowedUnset')}</p>
      : entries!.length === 0 ? <p data-dispatch-allowed-empty className="text-[11.5px] leading-snug text-ink-soft">
        {t('st.profiles.dispatchAllowedEmpty')}</p> : null}
    {rowEntries.length > 0 ? <ol className="divide-y divide-hairline rounded-lg border border-hairline" data-subagent-rows>
      {rowEntries.map((entry, index) => {
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
            {denied.has(entry.name) ? <span className={BADGE} title={t('st.profiles.dispatchDenyHint')}>{t('st.profiles.dispatchDeny')}</span> : null}
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
          {entry.modelProfiles !== undefined ? <div className="col-span-3 min-w-0 space-y-1 pl-7 pt-2" data-lease-model-prompts={entry.name}>
            <p className="text-[12px] text-ink-soft">{t('st.promptIdentity.leaseTitle')}</p>
            <SettingsSegmented<'preserve' | 'replace'> value={entry.modelPrompts ?? 'preserve'} disabled={disabled}
              ariaLabel={`${entry.name}: ${t('st.promptIdentity.leaseTitle')}`}
              onChange={(modelPrompts) => update(index, { modelPrompts })}
              choices={[{ value: 'preserve', label: t('st.promptIdentity.leasePreserve') }, { value: 'replace', label: t('st.promptIdentity.leaseReplace') }]} />
          </div> : null}
          <span className="col-start-3 row-start-1 flex shrink-0 items-center">
            <button type="button" data-subagent-up={entry.name} disabled={disabled || index === 0} aria-label={t('st.profiles.moveUp', { item: entry.name })}
              onClick={() => move(index, index - 1)} className={ROW_BUTTON}><Icon name="arrowUp" size={12} /></button>
            <button type="button" data-subagent-down={entry.name} disabled={disabled || index === last} aria-label={t('st.profiles.moveDown', { item: entry.name })}
              onClick={() => move(index, index + 1)} className={ROW_BUTTON}><Icon name="arrowDown" size={12} /></button>
            <button type="button" data-subagent-remove={entry.name} disabled={disabled} aria-label={t('st.profiles.removeItem', { item: entry.name })}
              onClick={() => setEntries(rowEntries.filter((_, at) => at !== index))} className={ROW_BUTTON}>
              <Icon name="close" size={12} />
            </button>
          </span>
        </li>;
      })}
    </ol> : null}
    {declared && entries!.length === 0 ? <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.profiles.dispatchEmptyPresets')}</p> : null}
    <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.profiles.dispatchAllowedHint')}</p>
    <SearchableSelect id="dispatch-add-preset" value="" disabled={disabled} hideChevron allowCustomValue
      options={candidates.map((profile) => ({
        value: profile.name, label: profile.name, description: profile.description,
        hint: profile.pinned_model_alias, group: profile.main ? t('st.agentManager.main') : t('st.agentManager.subagent'),
      }))}
      ariaLabel={t('st.profiles.dispatchAddToAllowed')} searchPlaceholder={t('st.profiles.searchAgents')} emptyText={t('st.profiles.noMoreAgents')}
      triggerLabel={<span className="inline-flex items-center gap-1"><Icon name="plus" size={12} />{t('st.profiles.dispatchAddToAllowed')}</span>}
      buttonClassName="inline-flex h-8 items-center rounded-md px-2 text-[12.5px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50"
      onChange={(name) => { if (name !== '') setEntries([...rowEntries, { name, modelAlias: '', effort: '' }]); }} />
  </div>;
}

/**
 * One name list: recommended order, or names refused outright. Both are pure
 * name sets, so both are chips plus a free-text add — a name the catalog does
 * not carry is still a legal entry, and it is marked rather than refused.
 */
function NameListField({ id, list, policy, known, onChange, disabled, titleKey, hintKey, emptyKey, addLabel }: {
  id: string;
  list: readonly string[] | undefined;
  policy: SubagentPolicyDraft;
  /** Names the preset list carries; a name outside it is marked, not refused. */
  known?: readonly string[];
  onChange: (next: Pick<ProfileDraft, 'subagentPolicy'>) => void;
  disabled: boolean;
  titleKey: 'st.profiles.dispatchPreferred' | 'st.profiles.dispatchDeny';
  hintKey: 'st.profiles.dispatchPreferredHint' | 'st.profiles.dispatchDenyHint';
  emptyKey: 'st.profiles.dispatchEmptyPreferred' | 'st.profiles.dispatchEmptyDeny';
  addLabel: string;
}) {
  const { t } = useI18n();
  const listed = new Set(known);
  const setList = (next: readonly string[]) => onChange({
    subagentPolicy: { ...policy, [id === 'deny' ? 'denySubagents' : 'preferredSubagents']: next },
  });
  return <div className="space-y-1.5" data-dispatch-names={id} data-declared={list === undefined ? 'false' : 'true'}>
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="min-w-0 text-[12px] font-medium text-ink-soft">{t(titleKey)}</span>
      {list !== undefined && list.length > 0 ? <button type="button" data-dispatch-clear={id} disabled={disabled}
        onClick={() => setList([])}
        className="h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50">
        {t(id === 'deny' ? 'st.profiles.dispatchClearDeny' : 'st.profiles.dispatchClearPreferred')}</button> : null}
    </div>
    <p className="text-[11.5px] leading-snug text-ink-faint">{t(hintKey)}</p>
    <div className="flex flex-wrap items-center gap-1.5">
      {(list ?? []).map((name, index) => {
        const unknown = known !== undefined && !listed.has(name);
        return <span key={name} data-dispatch-chip={id} data-dispatch-name={name} title={unknown ? t('st.profiles.dispatchCustomName') : name}
          className={`inline-flex h-7 max-w-full items-center gap-1 rounded-md border pl-2 pr-0.5 font-mono text-[11.5px] ${
            unknown ? 'border-hairline text-ink-soft' : 'border-hairline text-ink'}`}>
          {id === 'preferred' ? <span className="w-3.5 shrink-0 text-right text-[10.5px] tabular-nums text-ink-faint">{index + 1}</span> : null}
          <span className="min-w-0 truncate">{name}</span>
          <button type="button" disabled={disabled} aria-label={t('st.profiles.removeItem', { item: name })}
            onClick={() => setList((list ?? []).filter((value) => value !== name))}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-ink/[0.06] hover:text-ink disabled:opacity-50">
            <Icon name="close" size={12} />
          </button>
        </span>;
      })}
      <SearchableSelect id={`dispatch-add-${id}`} value="" options={[]} allowCustomValue disabled={disabled} hideFilter
        ariaLabel={addLabel} searchPlaceholder={addLabel} emptyText={t('st.profiles.noMoreAgents')}
        triggerLabel={<span className="inline-flex items-center gap-1"><Icon name="plus" size={12} />{addLabel}</span>}
        buttonClassName="inline-flex h-7 items-center rounded-md px-2 text-[12px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50"
        onChange={(name) => {
          const value = name.trim();
          if (value !== '' && !(list ?? []).includes(value)) setList([...(list ?? []), value]);
        }} />
    </div>
    {(list ?? []).length === 0 ? <p className="text-[11.5px] leading-snug text-ink-faint">{t(emptyKey)}</p> : null}
  </div>;
}

const HEADER_BUTTON = 'h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50';
const BADGE = 'shrink-0 rounded-[4px] bg-ink/[0.05] px-1.5 text-[11px] text-ink-soft';
const ROW_BUTTON = 'flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-ink/[0.05] hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent';
