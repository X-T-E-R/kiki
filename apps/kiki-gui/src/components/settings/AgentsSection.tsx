import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import { errorText, type I18nKey } from '../../i18n/locale';
import {
  disabledProfilePatch,
  mergeNamedAgentProfiles,
  namedAgentNewSessionBlocked,
  namedAgentOverrideRelations,
  namedAgentSessionHref,
  partitionNamedAgentProfiles,
  subagentGovernanceFromConfig,
  subagentGovernancePatch,
  summarizeNamedAgentLease,
  summarizeNamedAgentModelProfile,
  workspaceChipDisplay,
  type NamedAgentLeaseDetailLabel,
  type NamedAgentOverrideRelation,
  type SubagentGovernanceDraft,
} from '../../lib/agentSettings';
import type {
  ListNamedAgentProfilesResponse,
  NamedAgentProfile,
} from '../../lib/client';
import { sortWorkspacesByRecency } from '../../lib/sorting';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

const LEASE_DETAIL_LABEL_KEYS: Record<NamedAgentLeaseDetailLabel, I18nKey> = {
  description: 'st.namedAgents.description',
  whenToUse: 'st.namedAgents.whenToUse',
  serviceTier: 'st.namedAgents.serviceTier',
  delegationNotice: 'st.namedAgents.delegationNotice',
  promptMode: 'st.namedAgents.promptMode',
  allowedModels: 'st.namedAgents.allowedModels',
  deniedModels: 'st.namedAgents.deniedModels',
  allowedEfforts: 'st.namedAgents.allowedEfforts',
  tools: 'st.namedAgents.tools',
  disallowedTools: 'st.namedAgents.disallowedTools',
  subagents: 'st.namedAgents.subagentLease',
  prompt: 'st.namedAgents.prompt',
  requestParams: 'st.namedAgents.requestParams',
  modelProfile: 'st.namedAgents.modelProfile',
  leaseSource: 'st.namedAgents.leaseSource',
};

const EMPTY_SUBAGENT_GOVERNANCE: SubagentGovernanceDraft = { denyModels: '' };

export function SubagentGovernanceCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SubagentGovernanceDraft>(EMPTY_SUBAGENT_GOVERNANCE);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined) setDraft(subagentGovernanceFromConfig(configQuery.data));
  }, [configQuery.data]);

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(subagentGovernancePatch(draft));
      queryClient.setQueryData(['config'], echoed);
      setDraft(subagentGovernanceFromConfig(echoed));
      setFeedback({ tone: 'success', text: t('st.subagents.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-subagents" title={t('st.subagents.title')}>
      <div className="space-y-4">
        <Hint>{t('st.subagents.hint')}</Hint>
        <fieldset disabled={configQuery.isLoading || saving} className="space-y-4 disabled:opacity-60">
          <label className="block text-[11px] font-medium text-ink-soft">{t('st.subagents.denyModels')}
            <textarea
              className={`${INPUT} mt-1 min-h-24 font-mono`}
              value={draft.denyModels}
              placeholder={t('st.subagents.denyPlaceholder')}
              onChange={(event) => { setDraft((current) => ({ ...current, denyModels: event.target.value })); }}
            />
          </label>
        </fieldset>
        <button type="button" className={PRIMARY_BUTTON} disabled={configQuery.isLoading || saving} onClick={() => void save()}>{saving ? t('common.saving') : t('st.subagents.save')}</button>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
export function parseNamedAgentTools(value: string): string[] | null {
  const tools = value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return tools.length === 0 ? null : tools;
}

function NamedAgentProfileRow({
  profile,
  workspaceFallbackId,
  overrideRelation,
  onUpdated,
  onToggleEnabled,
  toggleSaving,
}: {
  profile: NamedAgentProfile;
  workspaceFallbackId?: string;
  overrideRelation?: NamedAgentOverrideRelation;
  onUpdated: (profile: NamedAgentProfile) => void;
  onToggleEnabled: (profile: NamedAgentProfile, enabled: boolean) => Promise<void>;
  toggleSaving: boolean;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const writable =
    profile.workspace_id !== undefined &&
    profile.source_file !== undefined &&
    (profile.source === 'user' || profile.source === 'workspace' || profile.source === 'extra');
  // Built-ins and named profiles toggle through different config lists, but
  // the switch reads the same either way. For a main profile, "off" only
  // stops subagent calls — main sessions keep working.
  const toggleTitle = profile.source === 'builtin'
    ? profile.main === true
      ? t('st.namedAgents.defaultToggleHint')
      : t('st.namedAgents.builtinToggleHint')
    : t('st.namedAgents.namedToggleHint');
  const workspaceIds = profile.workspace_ids ?? (profile.workspace_id === undefined ? [] : [profile.workspace_id]);
  const workspaceChips = workspaceChipDisplay(workspaceIds);
  const sessionHref = namedAgentSessionHref(profile, workspaceFallbackId);
  // A disabled main profile keeps its new-session button (main sessions
  // still run it); a disabled subagent profile loses it. A shadowed file
  // profile loses it too: a session under its name would silently run the
  // same-named built-in instead.
  const shadowed = overrideRelation?.kind === 'shadowed';
  const newSessionBlocked = namedAgentNewSessionBlocked(profile, overrideRelation);
  const newSessionTitle = shadowed
    ? t('st.namedAgents.newSessionShadowed')
    : newSessionBlocked
      ? t('st.namedAgents.newSessionDisabled')
      : profile.disabled
        ? t('st.namedAgents.newSessionDisabledMain')
        : t('st.namedAgents.newSession');
  // Read-only projections the structured editor cannot write (the PATCH
  // schema does not open them): surface them in the summary and point at the
  // raw file instead of silently hiding them.
  const constraints = profile.spawn_constraints;
  const spawnSummary = constraints === undefined ? '' : [
    constraints.allowed_models === undefined ? null : `${t('st.namedAgents.allowedModels')} ${constraints.allowed_models.join(', ')}`,
    constraints.deny_models === undefined ? null : `${t('st.namedAgents.deniedModels')} ${constraints.deny_models.join(', ')}`,
    constraints.allowed_efforts === undefined ? null : `${t('st.namedAgents.allowedEfforts')} ${constraints.allowed_efforts.join(', ')}`,
    constraints.disallowed_tools === undefined ? null : `${t('st.namedAgents.disallowedTools')} ${constraints.disallowed_tools.join(', ')}`,
  ].filter((segment) => segment !== null).join(' · ');
  const hasProjection =
    (profile.model_profiles?.length ?? 0) > 0
    || spawnSummary !== ''
    || (profile.subagents?.length ?? 0) > 0;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [description, setDescription] = useState(profile.description ?? '');
  const [whenToUse, setWhenToUse] = useState(profile.when_to_use ?? '');
  const [modelAlias, setModelAlias] = useState(profile.pinned_model_alias ?? '');
  const [thinkingEffort, setThinkingEffort] = useState(profile.thinking_effort ?? '');
  const [serviceTier, setServiceTier] = useState<NamedAgentProfile['service_tier'] | ''>(profile.service_tier ?? '');
  const [tools, setTools] = useState((profile.tools ?? []).join(', '));
  const [disallowedTools, setDisallowedTools] = useState((profile.disallowed_tools ?? []).join(', '));
  const [routeAliases, setRouteAliases] = useState<Record<string, string>>(() =>
    Object.fromEntries(profile.routes.map((route) => [route.id, route.model_alias ?? ''])),
  );
  const [rawOpen, setRawOpen] = useState(false);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawSaving, setRawSaving] = useState(false);
  const [rawText, setRawText] = useState('');

  const resetDraft = () => {
    setDescription(profile.description ?? '');
    setWhenToUse(profile.when_to_use ?? '');
    setModelAlias(profile.pinned_model_alias ?? '');
    setThinkingEffort(profile.thinking_effort ?? '');
    setServiceTier(profile.service_tier ?? '');
    setTools((profile.tools ?? []).join(', '));
    setDisallowedTools((profile.disallowed_tools ?? []).join(', '));
    setRouteAliases(Object.fromEntries(profile.routes.map((route) => [route.id, route.model_alias ?? ''])));
    setFeedback(null);
  };
  const save = async () => {
    if (!writable || profile.workspace_id === undefined) return;
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.updateNamedAgentProfile(profile.name, {
        scope: profile.source === 'workspace' ? 'project' : profile.source === 'user' ? 'user' : 'extra',
        workspace_id: profile.workspace_id,
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
      onUpdated(echoed);
      setEditing(false);
      setFeedback({ tone: 'success', text: t('st.namedAgents.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };
  const toggleRaw = async () => {
    if (rawOpen) {
      setRawOpen(false);
      return;
    }
    if (profile.source_file === undefined) return;
    setRawOpen(true);
    setRawLoading(true);
    setFeedback(null);
    try {
      setRawText(await client.readHostFile(profile.source_file));
    } catch (error) {
      setRawOpen(false);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRawLoading(false);
    }
  };
  const saveRaw = async () => {
    if (!writable || profile.workspace_id === undefined) return;
    setRawSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.updateNamedAgentProfile(profile.name, {
        scope: profile.source === 'workspace' ? 'project' : profile.source === 'user' ? 'user' : 'extra',
        workspace_id: profile.workspace_id,
        raw_text: rawText,
      });
      onUpdated(echoed);
      setFeedback({ tone: 'success', text: t('st.namedAgents.rawSaved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRawSaving(false);
    }
  };

  const overriddenBy = overrideRelation?.kind === 'overridden' ? overrideRelation : undefined;
  const overrideState =
    overrideRelation?.kind === 'overrides_builtin'
      ? 'overrides'
      : overrideRelation?.kind === 'shadowed'
        ? 'shadowed'
        : undefined;

  // A built-in shadowed by an overriding same-name file profile collapses to
  // a single muted line — rendering it as a normal enabled row would suggest
  // two live profiles where only the file actually runs.
  if (overriddenBy !== undefined) {
    return (
      <div
        data-agent-profile={profile.name}
        data-agent-source={profile.source}
        data-override-state="overridden"
        className="rounded-lg border border-hairline bg-panel px-3 py-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono text-[12.5px] text-ink-faint">{profile.name}</p>
          <span className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[9.5px] text-ink-faint">
            {profile.source}
          </span>
          <span className="min-w-0 truncate text-[10.5px] text-ink-faint" title={overriddenBy.file}>
            {t('st.namedAgents.overriddenByFile', { file: overriddenBy.file })}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-agent-profile={profile.name}
      data-agent-source={profile.source}
      data-override-state={overrideState}
      className={`rounded-lg border border-hairline bg-paper px-3 py-2 transition-opacity ${profile.disabled ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[12.5px] font-medium text-ink">
            {profile.name}
            {profile.disabled ? (
              <span className="ml-2 rounded-full border border-hairline bg-panel px-1.5 py-px align-middle text-[9px] font-medium uppercase tracking-wide text-ink-faint">
                {t('st.namedAgents.disabledBadge')}
              </span>
            ) : null}
          </p>
          {profile.disabled && profile.main === true ? (
            <p className="mt-0.5 text-[10.5px] text-ink-faint">{t('st.namedAgents.disabledMainHint')}</p>
          ) : null}
          {!editing && profile.description !== undefined ? <p className="text-[11.5px] text-ink-soft">{profile.description}</p> : null}
          {overrideRelation?.kind === 'overrides_builtin' ? (
            <p className="mt-0.5 text-[10.5px] text-ink-faint">{t('st.namedAgents.overridesBuiltin')}</p>
          ) : null}
          {overrideRelation?.kind === 'shadowed' ? (
            <p className="mt-0.5 text-[10.5px] text-danger">{t('st.namedAgents.shadowedByBuiltin')}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div title={toggleTitle}>
            <Toggle
              label={t('st.namedAgents.enabled')}
              checked={!profile.disabled}
              disabled={toggleSaving}
              onChange={(enabled) => {
                setFeedback(null);
                void onToggleEnabled(profile, enabled).catch((error: unknown) => {
                  setFeedback({ tone: 'error', text: errorText(locale, error) });
                });
              }}
            />
          </div>
          <span className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[9.5px] text-ink-faint">
            {profile.source}{writable ? '' : ` · ${t('st.namedAgents.readOnly')}`}
          </span>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={newSessionBlocked}
            title={newSessionTitle}
            data-new-session-href={sessionHref}
            onClick={() => void navigate(sessionHref)}
          >
            {t('st.namedAgents.newSession')}
          </button>
          {writable && !editing ? (
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { resetDraft(); setEditing(true); }}>
              {t('st.namedAgents.edit')}
            </button>
          ) : null}
        </div>
      </div>
      {editing ? (
        <fieldset disabled={saving} className="mt-3 space-y-3 disabled:opacity-60">
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.description')}
            <textarea className={`${INPUT} mt-1 min-h-20`} value={description} onChange={(event) => { setDescription(event.target.value); }} />
          </label>
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.whenToUse')}
            <textarea className={`${INPUT} mt-1 min-h-16`} value={whenToUse} onChange={(event) => { setWhenToUse(event.target.value); }} />
          </label>
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.namedAgents.modelPin')}
            <input className={`${INPUT} mt-1 font-mono`} value={modelAlias} placeholder="provider/model" onChange={(event) => { setModelAlias(event.target.value); }} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-[11px] font-medium text-ink-soft">
              {t('st.namedAgents.thinkingEffort')}
              <select className={`${INPUT} mt-1`} value={thinkingEffort} onChange={(event) => { setThinkingEffort(event.target.value); }}>
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
          <div className="flex flex-wrap gap-2">
            <button type="button" className={PRIMARY_BUTTON} disabled={description.trim() === '' || saving} onClick={() => void save()}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
            <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={() => { resetDraft(); setEditing(false); }}>
              {t('common.cancel')}
            </button>
          </div>
        </fieldset>
      ) : (
        <>
          <details className="mt-2 rounded-lg border border-hairline bg-panel px-2.5 py-1.5" data-technical-details>
            <summary className="cursor-pointer select-none text-[10.5px] font-medium text-ink-faint hover:text-ink-soft">
              {t('st.namedAgents.technicalDetails')}
            </summary>
            <div className="mt-2 space-y-1 break-all font-mono text-[10px] text-ink-faint">
            <p>{t('st.namedAgents.sourceFile')}: {profile.source_file ?? t('st.namedAgents.builtin')}</p>
            {workspaceChips.shown.length > 0 ? (
              <p className="flex flex-wrap items-center gap-1">
                {workspaceChips.shown.map((id) => (
                  <span key={id} title={id} className="max-w-40 truncate rounded-full border border-hairline bg-paper px-1.5 py-px font-mono text-[9.5px] text-ink-faint">
                    {id}
                  </span>
                ))}
                {workspaceChips.extra > 0 ? (
                  <span
                    title={workspaceIds.join(', ')}
                    className="rounded-full border border-hairline bg-paper px-1.5 py-px font-mono text-[9.5px] text-ink-faint"
                  >
                    +{workspaceChips.extra} {t('st.namedAgents.workspaces')}
                  </span>
                ) : null}
              </p>
            ) : null}
            {profile.when_to_use !== undefined ? <p>{t('st.namedAgents.whenToUse')}: {profile.when_to_use}</p> : null}
            {profile.pinned_model_alias !== undefined ? <p>{t('st.namedAgents.modelPin')}: {profile.pinned_model_alias}</p> : null}
            {profile.thinking_effort !== undefined ? <p>{t('st.namedAgents.thinkingEffort')}: {profile.thinking_effort}</p> : null}
            {profile.service_tier !== undefined ? <p>{t('st.namedAgents.serviceTier')}: {profile.service_tier}</p> : null}
            {profile.routes.map((route) => (
              <p key={route.id}>
                {t('st.namedAgents.route')}: {route.id}
                {route.model_alias === undefined ? '' : ` → ${route.model_alias}`}
                {' · '}{route.source_file}
              </p>
            ))}
            {profile.model_profiles?.map((entry) => {
              const modelProfile = summarizeNamedAgentModelProfile(entry);
              return (
                <div key={entry.alias} className="space-y-1">
                  <p>{t('st.namedAgents.modelProfile')}: {modelProfile.headline}</p>
                  {modelProfile.details.map((detail, detailIndex) => (
                    <p key={`${detail.label}:${detailIndex}`} className="pl-3">
                      {t(LEASE_DETAIL_LABEL_KEYS[detail.label])}: {detail.value}
                    </p>
                  ))}
                </div>
              );
            })}
            {spawnSummary !== '' ? <p>{t('st.namedAgents.spawnConstraints')}: {spawnSummary}</p> : null}
            {profile.subagents?.map((lease, index) => {
              if (typeof lease === 'string') {
                return <p key={lease}>{t('st.namedAgents.subagentLease')}: {lease}</p>;
              }
              const leaseSummary = summarizeNamedAgentLease(lease);
              return (
                <div key={`${lease.name}:${index}`} className="space-y-1">
                  <p>
                    {t('st.namedAgents.subagentLease')}:
                    {leaseSummary.scoped ? (
                      <span className="mx-1 rounded-full border border-accent/40 bg-accent-soft px-1.5 py-px align-middle text-[9px] font-medium uppercase tracking-wide text-accent">
                        {t('st.namedAgents.scopedBadge')}
                      </span>
                    ) : null}
                    {' '}{leaseSummary.headline}
                  </p>
                  {leaseSummary.status !== undefined ? (
                    <p className={`pl-3${leaseSummary.status === 'unavailable' ? ' text-danger' : ''}`}>
                      {t('st.namedAgents.leaseStatus')}: {t(leaseSummary.status === 'unavailable' ? 'st.namedAgents.leaseUnavailable' : 'st.namedAgents.leaseReady')}
                    </p>
                  ) : null}
                  {leaseSummary.diagnostic !== undefined ? (
                    <p className="pl-3 text-danger">{leaseSummary.diagnostic}</p>
                  ) : null}
                  {leaseSummary.details.map((detail, detailIndex) => (
                    <p key={`${detail.label}:${detailIndex}`} className="pl-3">
                      {t(LEASE_DETAIL_LABEL_KEYS[detail.label])}: {detail.value}
                    </p>
                  ))}
                </div>
              );
            })}
            </div>
            {hasProjection ? <Hint>{t('st.namedAgents.projectionHint')}</Hint> : null}
          </details>
        </>
      )}
      {profile.source_file !== undefined ? (
        <div className="mt-3 border-t border-hairline pt-3">
          <button type="button" className={SECONDARY_BUTTON} onClick={() => void toggleRaw()}>
            {rawOpen ? t('st.namedAgents.hideRaw') : writable ? t('st.namedAgents.editRaw') : t('st.namedAgents.viewRaw')}
          </button>
          {rawOpen ? (
            <div className="mt-2 space-y-2">
              {rawLoading ? <Hint>{t('st.namedAgents.rawLoading')}</Hint> : (
                <textarea
                  className={`${INPUT} min-h-64 font-mono text-[11px]`}
                  value={rawText}
                  readOnly={!writable}
                  onChange={(event) => { setRawText(event.target.value); }}
                />
              )}
              {writable && !rawLoading ? (
                <button type="button" className={PRIMARY_BUTTON} disabled={rawSaving} onClick={() => void saveRaw()}>
                  {rawSaving ? t('common.saving') : t('st.namedAgents.saveRaw')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

/**
 * One named-profile card per bucket (redesign §10.3): `main` stays on the
 * Agents leaf, `sub` moves to the Subagents leaf. Both buckets share the
 * query/merge/override pipeline — only the wrapping card and row set differ.
 */
export function NamedAgentProfilesCard({ bucket }: { bucket: 'main' | 'sub' }) {
  const { client } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [toggleSaving, setToggleSaving] = useState<string | null>(null);
  const profilesQuery = useQuery({
    queryKey: ['named-agent-profiles'],
    queryFn: () => client.listNamedAgentProfiles(),
    staleTime: 15_000,
  });
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });
  // Workspace-less (builtin) profiles still need a workspace for the
  // new-session deep link: fall back to the most recent one.
  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const updateEcho = (updated: NamedAgentProfile) => {
    queryClient.setQueryData<ListNamedAgentProfilesResponse>(
      ['named-agent-profiles'],
      (current) => current === undefined
        ? { items: [updated] }
        : {
            items: current.items.map((profile) =>
              profile.name === updated.name &&
              profile.source === updated.source &&
              profile.source_file === updated.source_file
                ? updated
                : profile,
            ),
          },
    );
  };
  const toggleEnabled = async (profile: NamedAgentProfile, enabled: boolean) => {
    setToggleSaving(profile.name);
    try {
      const echoed = await client.patchConfig(disabledProfilePatch(configQuery.data ?? {}, profile, enabled));
      queryClient.setQueryData(['config'], echoed);
      // Named profiles disable globally by name; built-ins only by name+source.
      queryClient.setQueryData<ListNamedAgentProfilesResponse>(
        ['named-agent-profiles'],
        (current) => current === undefined
          ? current
          : {
              items: current.items.map((item) =>
                item.name === profile.name && (profile.source !== 'builtin' || item.source === 'builtin')
                  ? { ...item, disabled: !enabled }
                  : item,
              ),
            },
      );
    } finally {
      setToggleSaving(null);
    }
  };
  // Merged view: one row per name+source+file across workspaces. Idempotent
  // over servers that already return the merged /agents payload.
  const profiles = useMemo(
    () => mergeNamedAgentProfiles(profilesQuery.data?.items ?? []),
    [profilesQuery.data],
  );
  const fallbackWorkspaceId = useMemo(
    () => sortWorkspacesByRecency(workspacesQuery.data?.items ?? [])[0]?.id,
    [workspacesQuery.data],
  );
  // `main === true` lands in the main-agent card; everything else is a
  // subagent profile. Enabled toggle and edit affordances are identical.
  const buckets = useMemo(() => partitionNamedAgentProfiles(profiles), [profiles]);
  // Same-name built-in/file override relations: an overriding file profile is
  // the effective row, its built-in collapses to a shadow note, and a
  // non-override same-name file row carries a not-in-effect warning.
  const overrideRelations = useMemo(() => namedAgentOverrideRelations(profiles), [profiles]);

  const renderRow = (profile: NamedAgentProfile, index: number) => (
    <NamedAgentProfileRow
      key={`${profile.name}:${profile.source}:${profile.source_file ?? profile.workspace_id ?? ''}:${index}`}
      profile={profile}
      workspaceFallbackId={fallbackWorkspaceId}
      overrideRelation={overrideRelations.get(profile)}
      onUpdated={updateEcho}
      onToggleEnabled={toggleEnabled}
      toggleSaving={toggleSaving !== null || configQuery.isLoading}
    />
  );

  if (bucket === 'sub') {
    return (
      <SectionCard id="st-card-subagent-profiles" title={t('st.subagentProfiles.title')}>
        <div className="space-y-3">
          <div className="space-y-2">
            {buckets.sub.map(renderRow)}
            {profilesQuery.data !== undefined && buckets.sub.length === 0 ? <Hint>{t('st.subagentProfiles.empty')}</Hint> : null}
          </div>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard id="st-card-main-agents" title={t('st.mainAgents.title')}>
      <div className="space-y-3">
        <Hint>{t('st.namedAgents.editHint')}</Hint>
        <div className="space-y-2">
          {buckets.main.map(renderRow)}
          {profilesQuery.data !== undefined && buckets.main.length === 0 ? <Hint>{t('st.mainAgents.empty')}</Hint> : null}
          {profilesQuery.isLoading ? <Hint>{t('st.namedAgents.loading')}</Hint> : null}
          {profilesQuery.isError ? <InlineError error={profilesQuery.error} /> : null}
          {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        </div>
      </div>
    </SectionCard>
  );
}

export function AgentsSection() {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <Hint>{t('st.agents.webHint')}</Hint>
      <NamedAgentProfilesCard bucket="main" />
    </div>
  );
}
