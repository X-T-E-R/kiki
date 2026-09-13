import { useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';
import { parseNamedAgentTools } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import type { NamedAgentProfile } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { FeedbackLine, type Feedback } from '../controls';
import { useDirtyReporter } from '../dirtyGuard';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';

/**
 * Dedicated pop-up editor for one named agent profile (main or subagent).
 * Collects every field the structured PATCH contract opens — description,
 * when-to-use, pinned model, thinking effort, service tier, tool lists, and
 * per-route model aliases — and saves them in one shot, replacing the old
 * scattered inline fieldset. Read-only projections (budgets, spawn
 * constraints, model profiles) stay on the row's technical-details fold; the
 * raw-file editor remains a separate entry.
 */
export function AgentProfileEditorDialog({
  profile,
  onClose,
  onSaved,
}: {
  profile: NamedAgentProfile;
  onClose: () => void;
  /** Called with the server echo after a successful save. */
  onSaved: (profile: NamedAgentProfile) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Frozen opening values: the dirty baseline must not drift if a background
  // refetch replaces the profile prop while the editor is open.
  const [baseline] = useState(() => ({
    description: profile.description ?? '',
    whenToUse: profile.when_to_use ?? '',
    modelAlias: profile.pinned_model_alias ?? '',
    thinkingEffort: profile.thinking_effort ?? '',
    serviceTier: (profile.service_tier ?? '') as NamedAgentProfile['service_tier'] | '',
    tools: (profile.tools ?? []).join(', '),
    disallowedTools: (profile.disallowed_tools ?? []).join(', '),
    routeAliases: Object.fromEntries(profile.routes.map((route) => [route.id, route.model_alias ?? ''])),
  }));
  const [description, setDescription] = useState(baseline.description);
  const [whenToUse, setWhenToUse] = useState(baseline.whenToUse);
  const [modelAlias, setModelAlias] = useState(baseline.modelAlias);
  const [thinkingEffort, setThinkingEffort] = useState(baseline.thinkingEffort);
  const [serviceTier, setServiceTier] = useState(baseline.serviceTier);
  const [tools, setTools] = useState(baseline.tools);
  const [disallowedTools, setDisallowedTools] = useState(baseline.disallowedTools);
  const [routeAliases, setRouteAliases] = useState(baseline.routeAliases);

  const dirty = description !== baseline.description
    || whenToUse !== baseline.whenToUse
    || modelAlias !== baseline.modelAlias
    || thinkingEffort !== baseline.thinkingEffort
    || serviceTier !== baseline.serviceTier
    || tools !== baseline.tools
    || disallowedTools !== baseline.disallowedTools
    || Object.entries(baseline.routeAliases).some(([id, value]) => (routeAliases[id] ?? '') !== value);
  useDirtyReporter(`agent-profile-editor:${profile.source}:${profile.name}`, dirty);

  const save = async () => {
    if (profile.workspace_id === undefined) return;
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.updateNamedAgentProfile(profile.name, {
        scope: profile.source === 'workspace' ? 'project' : profile.source === 'user' ? 'user' : 'extra',
        workspace_id: profile.workspace_id,
        source_file: profile.source_file,
        description: description.trim(),
        when_to_use: whenToUse.trim() === '' ? null : whenToUse.trim(),
        pinned_model_alias: modelAlias.trim() === '' ? null : modelAlias.trim(),
        thinking_effort: thinkingEffort === '' ? null : thinkingEffort,
        service_tier: serviceTier === '' ? null : serviceTier,
        tools: parseNamedAgentTools(tools),
        disallowed_tools: parseNamedAgentTools(disallowedTools),
        routes: profile.routes.map((route) => ({
          id: route.id,
          model_alias: routeAliases[route.id]?.trim() === ''
            ? null
            : routeAliases[route.id]?.trim(),
        })),
      });
      onSaved(echoed);
      onClose();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={t('st.namedAgents.editProfileTitle', { name: profile.name })}
      overlayId={`agent-profile-editor:${profile.source}:${profile.name}`}
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md}`}
    >
      <h2 className="font-display text-[15px] font-semibold tracking-tight text-ink">
        {t('st.namedAgents.editProfileTitle', { name: profile.name })}
      </h2>
      <fieldset disabled={saving} className="mt-3 max-h-[70vh] space-y-3 overflow-y-auto pr-1 disabled:opacity-60">
        <label className="block text-[11px] font-medium text-ink-soft">
          {t('st.namedAgents.description')}
          <textarea data-autofocus className={`${INPUT} mt-1 min-h-20`} value={description} onChange={(event) => { setDescription(event.target.value); }} />
        </label>
        <label className="block text-[11px] font-medium text-ink-soft">
          {t('st.namedAgents.whenToUse')}
          <textarea className={`${INPUT} mt-1 min-h-16`} value={whenToUse} onChange={(event) => { setWhenToUse(event.target.value); }} />
        </label>
        <label className="block text-[11px] font-medium text-ink-soft">
          {t('st.namedAgents.modelPin')}
          <input data-agent-model-alias className={`${INPUT} mt-1 font-mono`} value={modelAlias} placeholder="provider/model" onChange={(event) => {
            const next = event.target.value;
            if (next.trim() !== modelAlias.trim()) setThinkingEffort('');
            setModelAlias(next);
          }} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.defaultModelThinkingEffort')}
            <select data-agent-thinking-effort className={`${INPUT} mt-1`} value={thinkingEffort} onChange={(event) => { setThinkingEffort(event.target.value); }}>
              <option value="">{t('st.namedAgents.inherit')}</option>
              {['low', 'medium', 'high', 'xhigh', 'max'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.serviceTier')}
            <select className={`${INPUT} mt-1`} value={serviceTier} onChange={(event) => { setServiceTier(event.target.value as typeof serviceTier); }}>
              <option value="">{t('st.namedAgents.inherit')}</option>
              {['auto', 'default', 'flex', 'priority'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <label className="block text-[11px] font-medium text-ink-soft">
          {t('st.namedAgents.tools')}
          <textarea className={`${INPUT} mt-1 min-h-16 font-mono`} value={tools} placeholder={t('st.namedAgents.toolsPlaceholder')} onChange={(event) => { setTools(event.target.value); }} />
        </label>
        <label className="block text-[11px] font-medium text-ink-soft">
          {t('st.namedAgents.disallowedTools')}
          <textarea className={`${INPUT} mt-1 min-h-16 font-mono`} value={disallowedTools} placeholder={t('st.namedAgents.toolsPlaceholder')} onChange={(event) => { setDisallowedTools(event.target.value); }} />
        </label>
        {profile.routes.map((route) => (
          <label key={route.id} className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.routeModel', { route: route.id })}
            <input
              className={`${INPUT} mt-1 font-mono`}
              value={routeAliases[route.id] ?? ''}
              placeholder="provider/model"
              onChange={(event) => { setRouteAliases((current) => ({ ...current, [route.id]: event.target.value })); }}
            />
          </label>
        ))}
      </fieldset>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={PRIMARY_BUTTON} disabled={description.trim() === '' || saving} onClick={() => void save()}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
      <FeedbackLine feedback={feedback} />
    </Dialog>
  );
}
