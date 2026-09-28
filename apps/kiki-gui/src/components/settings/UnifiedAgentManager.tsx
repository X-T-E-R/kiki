import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { disabledProfilePatch, mergeNamedAgentProfiles, namedAgentOverrideRelations, parseNamedAgentTools, shippedEntryForProfile, type NamedAgentOverrideRelation } from '@kiki/session-core/settings';
import { sortWorkspacesByRecency } from '@kiki/session-core/sessions';
import { useI18n } from '../../i18n';
import { agentProfileCatalogQueryKey, invalidateAgentProfileCatalogs, loadAgentProfileCatalog } from '../../lib/agentProfileCatalog';
import type { CreateNamedAgentProfileRequest, NamedAgentProfile, ShippedAgentProfile, UpdateNamedAgentProfileRequest } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { useDirtyGuard } from '../dirtyGuard';
import { Icon } from '../icons';
import { sourceBadgeLabel } from '../agent-panel/SourceBadge';
import { SearchableSelect } from '../SearchableSelect';
import { INPUT, PRIMARY_BUTTON } from '../ui';
import { NamedAgentProfileRow } from './AgentsSection';
import { SectionCard } from './SectionCard';
import { ShippedProfileControls } from './ShippedProfileControls';
import { SETTINGS_SELECT_TRIGGER, SettingsDetailLayout, SettingsDraftFooter, SettingsSegmented, SettingsSelect } from './SettingsPrimitives';

type Filter = 'all' | 'main' | 'subagent';
type Tab = 'basics' | 'instructions' | 'tools' | 'model' | 'advanced';
type Template = 'blank' | 'implementer' | 'reviewer' | 'duplicate';
const TABS: readonly Tab[] = ['basics', 'instructions', 'tools', 'model', 'advanced'];
const TEMPLATES: readonly Template[] = ['blank', 'implementer', 'reviewer', 'duplicate'];
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const profileKey = (profile: NamedAgentProfile) => `${profile.source}:${profile.source_file ?? ''}:${profile.workspace_id ?? ''}:${profile.name}`;
const displayName = (profile: NamedAgentProfile, locale: string) => profile.name === 'agent' && profile.main
  ? locale === 'zh' ? 'Kiki（默认）' : 'Kiki'
  : profile.name;
const editorValues = (profile: NamedAgentProfile) => ({
  description: profile.description ?? '', whenToUse: profile.when_to_use ?? '', prompt: profile.prompt ?? '',
  tools: profile.tools?.join(', ') ?? '', disallowedTools: profile.disallowed_tools?.join(', ') ?? '',
  modelAlias: profile.pinned_model_alias ?? '', effort: profile.thinking_effort ?? '',
});

function AgentDetail({ profile, workspaceId, onSaved, onToggleEnabled, toggleSaving, effective, overrideRelation, shippedEntry, onShippedChanged, onBack }: {
  profile: NamedAgentProfile;
  /** Narrow widths: return to the list (the pane replaces it). */
  onBack?: () => void;
  workspaceId?: string;
  onSaved: () => void;
  onToggleEnabled: (profile: NamedAgentProfile, enabled: boolean) => Promise<void>;
  toggleSaving: boolean;
  effective: boolean;
  overrideRelation?: NamedAgentOverrideRelation;
  shippedEntry?: ShippedAgentProfile;
  onShippedChanged: () => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>('basics');
  const [baseline, setBaseline] = useState(() => editorValues(profile));
  const [draft, setDraft] = useState(baseline);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const writable = profile.workspace_id !== undefined && profile.source_file !== undefined
    && ['user', 'workspace', 'extra'].includes(profile.source);
  const dirty = Object.keys(baseline).some((key) => draft[key as keyof typeof draft] !== baseline[key as keyof typeof baseline]);
  useEffect(() => {
    if (dirty) return;
    const next = editorValues(profile);
    setBaseline(next);
    setDraft(next);
  }, [profile]);
  const change = (key: keyof typeof draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const discard = () => { setDraft(baseline); setFeedback(null); };
  const save = async () => {
    if (!writable || profile.workspace_id === undefined || !dirty
      || (draft.description !== baseline.description && draft.description.trim() === '')) return;
    setSaving(true);
    setFeedback(null);
    try {
      const body: UpdateNamedAgentProfileRequest = {
        scope: profile.source === 'workspace' ? 'project' : profile.source === 'user' ? 'user' : 'extra',
        workspace_id: profile.workspace_id,
        source_file: profile.source_file,
        description: draft.description !== baseline.description ? draft.description.trim() : undefined,
        when_to_use: draft.whenToUse !== baseline.whenToUse ? (draft.whenToUse.trim() || null) : undefined,
        prompt: draft.prompt !== baseline.prompt ? draft.prompt : undefined,
        pinned_model_alias: draft.modelAlias !== baseline.modelAlias ? (draft.modelAlias.trim() || null) : undefined,
        thinking_effort: draft.effort !== baseline.effort ? (draft.effort.trim() || null) : undefined,
        tools: draft.tools !== baseline.tools ? (draft.tools.trim() ? parseNamedAgentTools(draft.tools) ?? [] : []) : undefined,
        disallowed_tools: draft.disallowedTools !== baseline.disallowedTools
          ? (draft.disallowedTools.trim() ? parseNamedAgentTools(draft.disallowedTools) ?? [] : []) : undefined,
      };
      const updated = await client.updateNamedAgentProfile(profile.name, body);
      const next = {
        description: updated.description ?? '', whenToUse: updated.when_to_use ?? '', prompt: updated.prompt ?? '',
        tools: updated.tools?.join(', ') ?? '', disallowedTools: updated.disallowed_tools?.join(', ') ?? '',
        modelAlias: updated.pinned_model_alias ?? '', effort: updated.thinking_effort ?? '',
      };
      setBaseline(next);
      setDraft(next);
      setFeedback({ tone: 'success', text: t('st.agentManager.saved') });
      onSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setSaving(false); }
  };
  // Read-only agents show their values as text: an empty disabled textarea
  // reads as a form to fill, not a fact. Empty optional values collapse to
  // one quiet "Not set" line.
  const field = (label: string, key: keyof typeof draft, multi = false, mono = false) => writable ? (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {multi ? <textarea className={`${INPUT} min-h-24 text-[13px] leading-relaxed ${mono ? 'font-mono' : ''}`} value={draft[key]} disabled={saving}
        onChange={(event) => change(key, event.target.value)} />
        : <input className={`${INPUT} text-[13px]`} value={draft[key]} disabled={saving}
          onChange={(event) => change(key, event.target.value)} />}
    </label>
  ) : (
    <div className="space-y-1" data-agent-readonly-field={key}>
      <p className="text-[12px] font-medium text-ink-faint">{label}</p>
      {draft[key].trim() === ''
        ? <p className="text-[13px] text-ink-faint">{t('st.agentManager.notSet')}</p>
        : <p className={`whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink ${mono ? 'font-mono text-[12px]' : ''} ${multi ? 'max-h-72 overflow-y-auto' : ''}`}>{draft[key]}</p>}
    </div>
  );
  return <div data-agent-detail={profile.name} className="min-w-0 space-y-4">
    {onBack !== undefined ? <button type="button" onClick={onBack} data-agent-back
      className="-ml-1 inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-[13px] text-ink-soft transition-colors hover:text-ink md:hidden">
      <span aria-hidden>‹</span>{t('st.agentManager.back')}
    </button> : null}
    <div className="space-y-0.5"><h3 className="font-display text-[22px] leading-tight text-ink">{displayName(profile, locale)}</h3>
      <p className="text-[12px] text-ink-faint">
        {t(profile.main ? 'st.agentManager.main' : 'st.agentManager.subagent')} · {sourceBadgeLabel(t, profile.source)}
        {!writable ? <> · {t('st.agentManager.readOnlyShort')}</> : null}
      </p>
      {profile.source_file !== undefined ? <p className="truncate font-mono text-[11px] text-ink-faint" title={profile.source_file}>{profile.source_file}</p> : null}
    </div>
    <div role="tablist" aria-label={t('st.agentManager.title')} className="-mx-1 flex gap-1 overflow-x-auto border-b border-hairline px-1">
      {TABS.map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item}
        onClick={() => setTab(item)} className={`-mb-px shrink-0 border-b-2 px-2.5 py-1.5 text-[13px] ${tab === item ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}>
        {t(`st.agentManager.${item}` as I18nKey)}
      </button>)}
    </div>
    <div role="tabpanel" className="space-y-4">
      {tab === 'basics' ? <>{field(t('st.namedAgents.description'), 'description', true)}{field(t('st.namedAgents.whenToUse'), 'whenToUse', true)}</> : null}
      {tab === 'instructions' ? field(t('st.agentManager.prompt'), 'prompt', true, true) : null}
      {tab === 'tools' ? <>{field(t('st.namedAgents.tools'), 'tools', true, true)}{field(t('st.namedAgents.disallowedTools'), 'disallowedTools', true, true)}
        {writable ? <Hint>{t('st.namedAgents.toolsPlaceholder')}</Hint> : null}</> : null}
      {tab === 'model' ? <>{field(t('st.namedAgents.modelPin'), 'modelAlias', false, true)}
        {writable ? <div className="space-y-1.5">
          <span id="agent-effort-label" className="block text-[13px] font-medium text-ink">{t('st.namedAgents.defaultModelThinkingEffort')}</span>
          <SettingsSelect id="agent-effort" ariaLabel={t('st.namedAgents.defaultModelThinkingEffort')} value={draft.effort} disabled={saving}
            onChange={(value) => change('effort', value)}
            choices={[{ value: '', label: t('st.namedAgents.inherit') },
              ...['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value }))]} />
        </div> : field(t('st.namedAgents.defaultModelThinkingEffort'), 'effort')}</> : null}
      {tab === 'advanced' ? <NamedAgentProfileRow profile={profile} workspaceFallbackId={workspaceId}
        effective={effective} overrideRelation={overrideRelation} shippedEntry={shippedEntry}
        onUpdated={onSaved} onToggleEnabled={onToggleEnabled} onShippedChanged={onShippedChanged}
        toggleSaving={toggleSaving} showEditor={false} /> : null}
    </div>
    {writable ? <SettingsDraftFooter id={`agent-detail:${profileKey(profile)}`} dirty={dirty} saving={saving}
      saveDisabled={(draft.description !== baseline.description && draft.description.trim() === '')
        || (profile.main && draft.modelAlias.trim() === 'inherit')}
      onSave={() => void save()} onDiscard={discard} /> : null}
    <FeedbackLine feedback={feedback} />
  </div>;
}

function NewAgent({ workspaceId, current, names, onCreated, onBack }: {
  workspaceId?: string; current?: NamedAgentProfile; names: readonly string[]; onCreated: (profile: NamedAgentProfile) => void;
  onBack?: () => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [template, setTemplate] = useState<Template>('blank');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [main, setMain] = useState(false);
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const validName = NAME_PATTERN.test(name) && !names.includes(name);
  const validBlank = template !== 'blank' || (description.trim() !== '' && prompt.trim() !== '');
  const dirty = name !== '' || template !== 'blank' || scope !== 'user' || main || description !== '' || prompt !== '';
  const create = async () => {
    if (!workspaceId || !validName || !validBlank) return;
    setSaving(true);
    setFeedback(null);
    try {
      const body: CreateNamedAgentProfileRequest = {
        workspace_id: workspaceId, name, scope, main,
        template: template === 'duplicate' ? `duplicate:${current!.name}` : template,
        description: description.trim() || undefined,
        prompt: template === 'blank' ? prompt : undefined,
      };
      onCreated(await client.createAgentProfile(body));
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setSaving(false); }
  };
  const discard = () => { setName(''); setTemplate('blank'); setScope('user'); setMain(false); setDescription(''); setPrompt(''); setFeedback(null); };
  const labelClass = 'block space-y-1.5';
  const labelText = 'text-[13px] font-medium text-ink';
  return <div data-agent-create className="min-w-0 space-y-4">
    {onBack !== undefined ? <button type="button" onClick={onBack} data-agent-back
      className="-ml-1 inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-[13px] text-ink-soft transition-colors hover:text-ink md:hidden">
      <span aria-hidden>‹</span>{t('st.agentManager.back')}
    </button> : null}
    <h3 className="font-display text-[22px] leading-tight text-ink">{t('st.agentManager.new')}</h3>
    <div className="space-y-1.5">
      <span id="agent-template-label" className={labelText}>{t('st.agentManager.template')}</span>
      <div><SettingsSegmented<Template> ariaLabel={t('st.agentManager.template')} value={template} onChange={setTemplate}
        choices={TEMPLATES.map((item) => ({ value: item, label: t(`st.agentManager.${item}` as I18nKey),
          disabled: item === 'duplicate' && current === undefined }))} /></div>
    </div>
    <label className={labelClass}><span className={labelText}>{t('st.agentManager.name')}</span>
      <input className={`${INPUT} text-[13px]`} value={name} onChange={(event) => setName(event.target.value)} />
    </label>
    {name !== '' && !validName ? <p role="alert" className="text-[12px] text-danger">{t('st.agentManager.nameRequired')}</p> : null}
    <div className="space-y-1.5">
      <span className={labelText}>{t('st.agentManager.scope')}</span>
      <div><SettingsSegmented<'user' | 'project'> ariaLabel={t('st.agentManager.scope')} value={scope} onChange={setScope}
        choices={[{ value: 'user', label: t('st.agentManager.userScope') }, { value: 'project', label: t('st.agentManager.projectScope') }]} /></div>
    </div>
    <Toggle label={t('st.agentManager.main')} checked={main} onChange={setMain} />
    {template === 'blank' ? <>
      <label className={labelClass}><span className={labelText}>{t('st.namedAgents.description')}</span>
        <textarea className={`${INPUT} min-h-16 text-[13px]`} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <label className={labelClass}><span className={labelText}>{t('st.agentManager.prompt')}</span>
        <textarea className={`${INPUT} min-h-32 font-mono text-[12px] leading-relaxed`} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      {!validBlank && dirty ? <Hint>{t('st.agentManager.promptRequired')}</Hint> : null}
    </> : null}
    {!workspaceId ? <Hint>{t('st.agentManager.noWorkspace')}</Hint> : null}
    <SettingsDraftFooter id="agent-create" persistent dirty={dirty} saving={saving} saveLabel={t('st.agentManager.create')}
      saveDisabled={!workspaceId || !validName || !validBlank || (template === 'duplicate' && current === undefined)}
      onSave={() => void create()} onDiscard={discard} />
    <FeedbackLine feedback={feedback} />
  </div>;
}

export function UnifiedAgentManager() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const guard = useDirtyGuard();
  const [filter, setFilter] = useState<Filter>('all');
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [selectedKey, setSelectedKey] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [toggleSaving, setToggleSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  const selectedWorkspaceId = workspaceId ?? sortWorkspacesByRecency(workspacesQuery.data?.items ?? [])[0]?.id;
  const profilesQuery = useQuery({
    queryKey: ['named-agent-profiles', selectedWorkspaceId ?? 'global'],
    queryFn: () => loadAgentProfileCatalog(client, selectedWorkspaceId
      ? { mode: 'workspace', workspaceId: selectedWorkspaceId } : { mode: 'global' }),
    enabled: !workspacesQuery.isPending, staleTime: 15_000,
  });
  const effectiveMode = selectedWorkspaceId === undefined ? { mode: 'disabled' as const }
    : { mode: 'workspace' as const, workspaceId: selectedWorkspaceId, effective: true };
  const effectiveQuery = useQuery({ queryKey: agentProfileCatalogQueryKey(effectiveMode),
    queryFn: () => loadAgentProfileCatalog(client, effectiveMode), enabled: selectedWorkspaceId !== undefined, staleTime: 15_000 });
  const shippedQuery = useQuery({ queryKey: ['shipped-agent-profiles'],
    queryFn: () => client.listShippedAgentProfiles(), staleTime: 15_000, retry: false });
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const profiles = useMemo(() => mergeNamedAgentProfiles(profilesQuery.data?.items ?? []), [profilesQuery.data]);
  const shippedEntries = shippedQuery.data?.items ?? [];
  const isEffective = (profile: NamedAgentProfile) => selectedWorkspaceId === undefined
    ? shippedEntryForProfile(profile, shippedEntries) !== undefined && !profile.disabled
    : effectiveQuery.data?.items.some((item) => item.name === profile.name
      && item.source === profile.source && item.source_file === profile.source_file) === true;
  const overrideRelations = useMemo(() => {
    const winners = effectiveQuery.data?.items ?? [];
    const relations = new Map(namedAgentOverrideRelations(profiles.filter((profile) =>
      profile.source === 'builtin' || winners.some((winner) => winner.name === profile.name
        && winner.source === profile.source && winner.source_file === profile.source_file))));
    for (const profile of profiles) {
      if (profile.source !== 'builtin' && profile.override !== true
        && winners.some((winner) => winner.name === profile.name && winner.source === 'builtin')) {
        relations.set(profile, { kind: 'shadowed', builtinName: profile.name });
      }
    }
    return relations;
  }, [profiles, effectiveQuery.data]);
  const visible = profiles.filter((profile) => filter === 'all' || (filter === 'main') === profile.main)
    .toSorted((a, b) => Number(b.name === 'agent' && b.main) - Number(a.name === 'agent' && a.main)
      || a.name.localeCompare(b.name));
  const selected = visible.find((profile) => profileKey(profile) === selectedKey) ?? visible[0];
  const switchTo = (key: string | undefined, action: () => void) => {
    if (guard?.confirmDiscard === undefined) { action(); return; }
    const afterRaw = () => key === undefined ? action() : guard.confirmDiscard!(key, action);
    if (!creating && selected?.source_file !== undefined) {
      guard.confirmDiscard(`agent-raw:${selected.source_file}`, afterRaw);
    } else afterRaw();
  };
  const selectedDraft = creating ? 'agent-create' : selected ? `agent-detail:${profileKey(selected)}` : undefined;
  const onSaved = () => {
    void invalidateAgentProfileCatalogs(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['shipped-agent-profiles'] });
  };
  const onShippedChanged = () => { onSaved(); };
  const toggleEnabled = async (profile: NamedAgentProfile, enabled: boolean) => {
    setToggleSaving(true);
    try {
      const echoed = await client.patchConfig(disabledProfilePatch(configQuery.data ?? {}, profile, enabled));
      queryClient.setQueryData(['config'], echoed);
      await invalidateAgentProfileCatalogs(queryClient);
    } finally { setToggleSaving(false); }
  };
  const workspaceOptions = useMemo(() => (workspacesQuery.data?.items ?? []).map((workspace) => ({
    value: workspace.id, label: workspace.name ?? workspace.root, hint: workspace.root, title: workspace.root,
  })), [workspacesQuery.data]);
  // Narrow widths show one pane at a time: a row tap opens the detail, Back returns.
  const [narrowPane, setNarrowPane] = useState<'list' | 'detail'>('list');
  const back = () => switchTo(selectedDraft, () => { setCreating(false); setNarrowPane('list'); });
  return <SectionCard id="st-card-main-agents" title={t('st.agentManager.title')}>
    <div className="space-y-4">
      <SettingsDetailLayout narrowPane={narrowPane} list={<div className="space-y-3">
        {workspaceOptions.length > 0 ? <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-ink-soft">{t('new.workspace')}</span>
          <SearchableSelect id="agents-workspace-select" options={workspaceOptions} value={selectedWorkspaceId ?? ''}
            ariaLabel={t('new.workspace')} buttonClassName={SETTINGS_SELECT_TRIGGER}
            onChange={(next) => { if (next !== selectedWorkspaceId) switchTo(selectedDraft, () => { setWorkspaceId(next); setSelectedKey(undefined); setCreating(false); }); }} />
        </div> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SettingsSegmented<Filter> ariaLabel={t('st.agentManager.title')} value={filter}
            onChange={(item) => switchTo(selectedDraft, () => { setFilter(item); setSelectedKey(undefined); setCreating(false); })}
            choices={(['all', 'main', 'subagent'] as const).map((item) => ({ value: item, label: t(`st.agentManager.${item}`) }))} />
          <button type="button" className={PRIMARY_BUTTON} aria-pressed={creating}
            onClick={() => switchTo(selectedDraft, () => { setCreating(true); setNarrowPane('detail'); })}>
            {t('st.agentManager.new')}</button>
        </div>
        <div className="-mx-2 space-y-px" data-agent-list>
          {visible.map((profile) => {
            const current = !creating && selected === profile;
            return <button key={profileKey(profile)} type="button" data-agent-list-item={profile.name}
              aria-current={current ? 'true' : undefined}
              onClick={() => switchTo(selectedDraft, () => { setSelectedKey(profileKey(profile)); setCreating(false); setNarrowPane('detail'); })}
              className={`relative flex min-h-11 w-full flex-col justify-center rounded-md px-3 py-1.5 text-left transition-colors ${current
                ? 'bg-panel shadow-[var(--kiki-sheet-shadow)]'
                : 'hover:bg-ink/[0.04]'}`}>
              <span className={`flex items-center gap-2 text-[13px] ${current ? 'font-medium text-ink' : 'text-ink'}`}>
                <span className="min-w-0 truncate">{displayName(profile, locale)}</span>
                {profile.disabled ? <span className="shrink-0 text-[12px] font-normal text-ink-faint">{t('st.namedAgents.disabledBadge')}</span> : null}
                <Icon name="chevron" size={12} className="ml-auto shrink-0 text-ink-faint md:hidden" />
              </span>
              <span className="text-[12px] text-ink-faint">{t(profile.main ? 'st.agentManager.main' : 'st.agentManager.subagent')} · {sourceBadgeLabel(t, profile.source)}</span>
            </button>;
          })}
          {shippedEntries.filter((entry) => entry.managed && entry.status === 'removed'
            && (filter === 'all' || (filter === 'main') === entry.main)).map((entry) =>
            <div key={entry.template_id} data-shipped-removed={entry.template_id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="text-[13px] text-ink-faint">{entry.template_id}</span>
              <ShippedProfileControls entry={entry} onRestored={() => {
                onShippedChanged(); setFeedback({ tone: 'success', text: t('st.shipped.restored') });
              }} onError={(error) => setFeedback({ tone: 'error', text: errorText(locale, error) })} />
            </div>)}
        </div>
        {profilesQuery.isLoading ? <Hint>{t('st.namedAgents.loading')}</Hint> : null}
        {profilesQuery.isError ? <InlineError error={profilesQuery.error} /> : null}
        {effectiveQuery.isError ? <InlineError error={effectiveQuery.error} /> : null}
      </div>} detail={creating ? <NewAgent workspaceId={selectedWorkspaceId} current={selected} onBack={back}
        names={profiles.map((profile) => profile.name)} onCreated={(created) => {
          setCreating(false); setSelectedKey(profileKey(created));
          setFeedback({ tone: 'success', text: t('st.agentManager.created') }); onSaved();
        }} /> : selected ? <AgentDetail key={profileKey(selected)} profile={selected} workspaceId={selectedWorkspaceId}
        onBack={back}
        onSaved={onSaved} onToggleEnabled={toggleEnabled} toggleSaving={toggleSaving || configQuery.isLoading}
        effective={isEffective(selected)} overrideRelation={overrideRelations.get(selected)}
        shippedEntry={shippedEntryForProfile(selected, shippedEntries)} onShippedChanged={onShippedChanged} />
        : <Hint>{t('st.agentManager.select')}</Hint>} />
      {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
      <FeedbackLine feedback={feedback} />
    </div>
  </SectionCard>;
}
