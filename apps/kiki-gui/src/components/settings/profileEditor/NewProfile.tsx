import { useState } from 'react';

import { AGENT_NAME_PATTERN } from '@kiki/protocol/agentName';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../../i18n';
import type { CreateNamedAgentProfileRequest, NamedAgentProfile, ShippedAgentProfile } from '../../../lib/client';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Hint, Toggle, type Feedback } from '../../controls';
import { Icon } from '../../icons';
import { SearchableSelect } from '../../SearchableSelect';
import { INPUT } from '../../ui';
import { FORM_SELECT_TRIGGER, SettingsDraftFooter, SettingsSegmented } from '../SettingsPrimitives';

type Start = 'copy' | 'template' | 'blank';
type Template = 'implementer' | 'reviewer';

/**
 * New profile in three starts. Copying is first: most real profiles are a
 * built-in or a sibling with a different prompt and pin. The copy keeps every
 * field of the source file; only the name (and optionally the role) changes.
 */
export function NewProfile({ workspaceId, profiles, shipped, initialSource, onCreated, onCancel }: {
  workspaceId?: string;
  profiles: readonly NamedAgentProfile[];
  shipped: readonly ShippedAgentProfile[];
  initialSource?: string;
  onCreated: (profile: NamedAgentProfile) => void;
  onCancel: () => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [start, setStart] = useState<Start>('copy');
  // Most new profiles are subagents; default the copy source to a built-in one.
  const defaultSource = initialSource
    ?? profiles.find((profile) => profile.source === 'builtin' && !profile.main)?.name
    ?? profiles.find((profile) => !profile.main)?.name ?? profiles[0]?.name ?? '';
  const [source, setSource] = useState(defaultSource);
  const [template, setTemplate] = useState<Template>('implementer');
  const [name, setName] = useState(defaultSource === '' ? '' : `${defaultSource}-copy`);
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [main, setMain] = useState<boolean | undefined>(undefined);
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const committedName = name.trim();
  const taken = profiles.some((profile) => profile.name === committedName);
  const validName = AGENT_NAME_PATTERN.test(committedName) && !taken;
  const sourceProfile = profiles.find((profile) => profile.name === source);
  const effectiveMain = main ?? (start === 'copy' ? sourceProfile?.main === true : false);
  const blankOk = start !== 'blank' || (description.trim() !== '' && prompt.trim() !== '');
  const ready = workspaceId !== undefined && validName && blankOk && (start !== 'copy' || sourceProfile !== undefined);
  const shippedIds = new Set(shipped.map((entry) => entry.template_id));
  const sources = [...new Map(profiles.map((profile) => [profile.name, profile])).values()]
    .toSorted((a, b) => Number(b.source === 'builtin') - Number(a.source === 'builtin') || a.name.localeCompare(b.name));

  const create = async () => {
    if (!ready) return;
    setSaving(true); setFeedback(null);
    try {
      const body: CreateNamedAgentProfileRequest = {
        workspace_id: workspaceId!, name: committedName, scope,
        template: start === 'copy' ? `duplicate:${source}` : start === 'template' ? template : 'blank',
        ...(main !== undefined || start !== 'copy' ? { main: effectiveMain } : {}),
        ...(description.trim() !== '' ? { description: description.trim() } : {}),
        ...(start === 'blank' ? { prompt } : {}),
      };
      onCreated(await client.createAgentProfile(body));
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setSaving(false); }
  };

  const startCard = (value: Start, icon: 'agent' | 'notes' | 'edit') => <button key={value} type="button" aria-pressed={start === value}
    data-new-start={value} onClick={() => setStart(value)}
    className={`flex min-h-[4.5rem] flex-1 basis-[11rem] flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${start === value
      ? 'border-hairline-strong bg-panel shadow-[var(--kiki-sheet-shadow)]' : 'border-hairline hover:border-hairline-strong'}`}>
    <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink"><Icon name={icon} size={12} />{t(`st.profiles.start.${value}` as I18nKey)}</span>
    <span className="text-[12px] leading-snug text-ink-faint">{t(`st.profiles.start.${value}Hint` as I18nKey)}</span>
  </button>;

  return <div data-agent-create className="min-w-0 max-w-[44rem] space-y-5">
    <header className="flex items-center gap-3">
      <button type="button" onClick={onCancel} data-agent-back
        className="-ml-1 inline-flex min-h-9 items-center gap-1 rounded-md px-1 text-[13px] text-ink-soft hover:text-ink">
        <span className="flex rotate-180"><Icon name="chevron" size={12} /></span>{t('st.profiles.team')}
      </button>
      <h3 className="font-display text-[18px] leading-tight text-ink">{t('st.agentManager.new')}</h3>
    </header>
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('st.agentManager.template')}>
      {startCard('copy', 'agent')}{startCard('template', 'notes')}{startCard('blank', 'edit')}
    </div>
    {start === 'copy' ? <div className="space-y-1.5">
      <label htmlFor="new-profile-source" className="text-[12px] font-medium text-ink-soft">{t('st.profiles.copyFrom')}</label>
      <SearchableSelect id="new-profile-source" value={source} ariaLabel={t('st.profiles.copyFrom')} buttonClassName={FORM_SELECT_TRIGGER}
        options={sources.map((profile) => ({
          value: profile.name, label: profile.name, description: profile.description, hint: profile.pinned_model_alias,
          group: profile.source === 'builtin' || shippedIds.has(profile.name) ? t('st.profiles.shipped') : t('st.profiles.yours'),
        }))}
        onChange={(next) => { setSource(next); if (name === '' || name.endsWith('-copy')) setName(`${next}-copy`); }} />
      <Hint>{t('st.profiles.copyHint')}</Hint>
    </div> : null}
    {start === 'template' ? <div className="space-y-1.5">
      <span id="new-profile-template" className="text-[12px] font-medium text-ink-soft">{t('st.agentManager.template')}</span>
      <div><SettingsSegmented<Template> ariaLabelledBy="new-profile-template" value={template} onChange={setTemplate}
        choices={[{ value: 'implementer', label: t('st.agentManager.implementer') }, { value: 'reviewer', label: t('st.agentManager.reviewer') }]} /></div>
    </div> : null}
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <label htmlFor="new-profile-name" className="text-[12px] font-medium text-ink-soft">{t('st.agentManager.name')}</label>
        <input id="new-profile-name" className={`${INPUT} font-mono text-[13px]`} value={name} spellCheck={false}
          aria-invalid={name !== '' && !validName} aria-describedby="new-profile-name-issue" onChange={(event) => setName(event.target.value)} />
        {name !== '' && !validName ? <p id="new-profile-name-issue" role="alert" className="text-[12px] text-danger">
          {t(taken ? 'st.profiles.nameTaken' : 'st.agentManager.nameRequired', { name })}</p> : null}
      </div>
      <div className="space-y-1.5">
        <span id="new-profile-scope" className="text-[12px] font-medium text-ink-soft">{t('st.agentManager.scope')}</span>
        <div><SettingsSegmented<'user' | 'project'> ariaLabelledBy="new-profile-scope" value={scope} onChange={setScope}
          choices={[{ value: 'user', label: t('st.agentManager.userScope') }, { value: 'project', label: t('st.agentManager.projectScope') }]} /></div>
      </div>
    </div>
    <div className="space-y-1">
      <Toggle layout="row" label={t('st.profiles.mainToggle')} checked={effectiveMain} onChange={setMain} />
      <p className="text-[11.5px] text-ink-faint">{t(effectiveMain ? 'st.profiles.mainOnHint' : 'st.profiles.mainOffHint')}</p>
    </div>
    <div className="space-y-1.5">
      <label htmlFor="new-profile-description" className="text-[12px] font-medium text-ink-soft">
        {t('st.namedAgents.description')}{start !== 'blank' ? <span className="font-normal text-ink-faint"> · {t('st.profiles.optionalKeep')}</span> : null}
      </label>
      <textarea id="new-profile-description" rows={2} className={`${INPUT} text-[13px]`} value={description}
        placeholder={start === 'copy' ? sourceProfile?.description : undefined} onChange={(event) => setDescription(event.target.value)} />
    </div>
    {start === 'blank' ? <div className="space-y-1.5">
      <label htmlFor="new-profile-prompt" className="text-[12px] font-medium text-ink-soft">{t('st.profiles.prompt')}</label>
      <textarea id="new-profile-prompt" className={`${INPUT} min-h-40 font-mono text-[12.5px] leading-relaxed`} value={prompt}
        placeholder={t('st.profiles.promptPlaceholder')} onChange={(event) => setPrompt(event.target.value)} />
    </div> : null}
    {workspaceId === undefined ? <Hint>{t('st.agentManager.noWorkspace')}</Hint> : null}
    {start === 'blank' && !blankOk && (description !== '' || prompt !== '') ? <Hint>{t('st.agentManager.promptRequired')}</Hint> : null}
    <SettingsDraftFooter id="agent-create" persistent saving={saving}
      dirty={(name !== '' && !name.endsWith('-copy')) || description !== '' || prompt !== '' || main !== undefined}
      saveLabel={t('st.agentManager.create')} saveDisabled={!ready} onSave={() => void create()} onDiscard={onCancel} />
    <FeedbackLine feedback={feedback} />
  </div>;
}
