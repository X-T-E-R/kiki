/**
 * Subagent tool settings: pick an object — the server-wide default rule or one
 * agent profile — then read and edit that object's tool permissions.
 *
 * The list is one row per tool (name, one line of the engine's own purpose, this
 * object's status, and the edit action that actually exists for it); the detail
 * pane carries the reason behind the status and the actions a row cannot hold.
 * Nothing here previews "what a subagent can really call": the server rule and a
 * profile's two lists are configuration, and the tools a live session really has
 * are shown in that session's agent panel.
 */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  agentProfileSourceLabelKey,
  mergeNamedAgentProfiles,
  namedAgentNewSessionBlocked,
  namedAgentSessionHref,
  saveSubagentProfileToolSettings,
  searchSubagentToolCatalog,
  subagentProfileToolDraft,
  subagentProfileToolFields,
  type SubagentProfileToolDraft,
} from '@kiki/session-core/settings';
import { subagentToolsDraftFromConfig, subagentToolsPatch } from '@kiki/session-core/settings/subagentToolsSettings';
import type { ListNamedAgentProfilesResponse, NamedAgentProfile, ToolDescriptor } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { invalidateAgentProfileCatalogs, loadAgentProfileCatalog } from '../../../lib/agentProfileCatalog';
import { toolDisplayName } from '../../../lib/pluginCatalog';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../../controls';
import { useDirtyGuard, useGuardedNavigate } from '../../dirtyGuard';
import { Icon } from '../../icons';
import { SECONDARY_BUTTON } from '../../ui';
import { AgentProfileEditorDialog } from '../AgentProfileEditorDialog';
import { AdvancedDetails, SettingField } from '../fields';
import { SectionCard } from '../SectionCard';
import { SettingsDetailLayout, SettingsDraftFooter, SettingsSelect } from '../SettingsPrimitives';
import { useSavedTick } from '../useSavedTick';
import {
  DEFAULT_TOOL_OBJECT,
  defaultRuleToolState,
  orderSubagentTools,
  profileToolState,
  profileToolsAllowingTool,
  profileToolsWithOptIn,
  sameToolLists,
  serverToolsWithOptIn,
  toolPurpose,
  type ToolRowState,
} from './toolState';

/** The editor id this card's draft transaction reports under (see `dirtyGuard`). */
const DRAFT_EDITOR_ID = 'subagent-tool-draft';

type ToolDraft =
  | { readonly kind: 'rule'; readonly allowedTools: readonly string[] }
  | { readonly kind: 'profile'; readonly object: string; readonly target: NamedAgentProfile; readonly profile: SubagentProfileToolDraft };

export function SubagentToolSettingsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useGuardedNavigate();
  const guard = useDirtyGuard();
  const [object, setObject] = useState<string>(DEFAULT_TOOL_OBJECT);
  const [draft, setDraft] = useState<ToolDraft | null>(null);
  const [query, setQuery] = useState('');
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [narrowPane, setNarrowPane] = useState<'list' | 'detail'>('list');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const [editorOpen, setEditorOpen] = useState(false);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });
  const profilesQuery = useQuery({
    queryKey: ['named-agent-profiles', 'global'],
    queryFn: () => loadAgentProfileCatalog(client, { mode: 'global' }),
    staleTime: 15_000,
  });
  const toolsQuery = useQuery({
    queryKey: ['tools', 'global'],
    queryFn: () => client.listTools(),
    staleTime: 30_000,
  });

  const profiles = useMemo(() => {
    const merged = mergeNamedAgentProfiles(profilesQuery.data?.items ?? []);
    return preferredProfilesByName(merged.filter((profile) => !profile.main && !profile.disabled))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }, [profilesQuery.data]);
  const storedRule = useMemo(
    () => subagentToolsDraftFromConfig(configQuery.data).serverAllowedTools,
    [configQuery.data],
  );
  const ruleAllowed = draft !== null && draft.kind === 'rule' ? draft.allowedTools : storedRule;
  // The owner a profile draft was made on, re-read from the freshest catalog
  // row, so a save that has already been read back compares clean.
  const draftOwner = draft !== null && draft.kind === 'profile'
    ? profiles.find((candidate) => profileIdentityKey(candidate) === profileIdentityKey(draft.target)) ?? draft.target
    : null;
  const draftBaseline = draft === null ? null
    : draft.kind === 'rule' ? null
    : subagentProfileToolDraft(draftOwner ?? draft.target);
  // One editor, one transaction: the draft belongs to the object it was made on,
  // so changing the object is a discard decision, asked through the app's guard.
  const pending = draft === null ? false
    : draft.kind === 'rule'
      ? !sameToolLists(draft.allowedTools, storedRule)
      : draftBaseline === null
        || !sameToolLists(draft.profile.tools, draftBaseline.tools)
        || !sameToolLists(draft.profile.disallowedTools, draftBaseline.disallowedTools);

  const profile = object === DEFAULT_TOOL_OBJECT ? undefined : profiles.find((candidate) => profileIdentityKey(candidate) === object);
  const profileFields = useMemo(
    () => (profile === undefined ? [] : subagentProfileToolFields(profile)),
    [profile],
  );
  const profileEditable = profileFields.some((field) => field.editable);
  const nativeExecutor = (profile?.executor ?? 'native') === 'native';
  const liveProfileDraft = useMemo(
    () => (profile === undefined ? null : subagentProfileToolDraft(profile)),
    [profile],
  );
  const draftBelongsToProfile = draft !== null && draft.kind === 'profile' && draft.object === object;
  const profileDraft = draftBelongsToProfile ? draft.profile : liveProfileDraft;

  const catalog = toolsQuery.data?.tools;
  const matched = useMemo(
    () => (catalog === undefined ? [] : orderSubagentTools(searchSubagentToolCatalog(catalog, query))),
    [catalog, query],
  );
  const rows = useMemo(() => {
    if (object === DEFAULT_TOOL_OBJECT) {
      const allowed = new Set(ruleAllowed);
      // The saved rule is the baseline a rule draft is compared against, so a
      // row can say "this is what Save will change" instead of only the bar.
      const baseline = draft !== null && draft.kind === 'rule' ? new Set(storedRule) : null;
      return matched.map((tool) => {
        const state = defaultRuleToolState(tool, allowed);
        const changed = baseline !== null && defaultRuleToolState(tool, baseline).status !== state.status;
        return { tool, state, changed };
      });
    }
    const allowed = new Set(storedRule);
    const lists = profileDraft ?? { tools: null, disallowedTools: null };
    // A profile that never wrote a list baselines as both fields unset, so a
    // first opt-in still marks the row it will change.
    const baselineLists = draftBelongsToProfile ? draftBaseline ?? { tools: null, disallowedTools: null } : null;
    return matched.map((tool) => {
      const state = profileToolState(tool, lists, { editable: profileEditable, native: nativeExecutor, serverAllowed: allowed });
      const changed = baselineLists !== null
        && profileToolState(tool, baselineLists, { editable: profileEditable, native: nativeExecutor, serverAllowed: allowed }).status !== state.status;
      return { tool, state, changed };
    });
  }, [matched, object, ruleAllowed, storedRule, profileDraft, draftBelongsToProfile, draftBaseline, profileEditable, nativeExecutor, draft]);
  const changedCount = useMemo(() => rows.filter((row) => row.changed).length, [rows]);

  const selected = rows.find((row) => row.tool.name === selectedTool);
  const matchCount = matched.length;
  const catalogTotal = catalog?.length ?? 0;

  const toggleRuleOptIn = (name: string, allowed: boolean) => {
    setDraft({ kind: 'rule', allowedTools: serverToolsWithOptIn(ruleAllowed, name, allowed) });
    setFeedback(null);
  };

  /**
   * Deny writes the profile's deny list. Lifting a deny only names the tool
   * when its own list did not already select it, so the two lists stay apart.
   */
  const setProfileTool = (name: string, allow: boolean) => {
    if (profile === undefined || profileDraft === null) return;
    const lists: SubagentProfileToolDraft = profileDraft;
    const next: SubagentProfileToolDraft = allow
      ? {
        tools: profileToolsAllowingTool(lists.tools, name),
        disallowedTools: lists.disallowedTools?.filter((tool) => tool !== name) ?? null,
      }
      : {
        tools: lists.tools,
        disallowedTools: [...new Set([...(lists.disallowedTools ?? []), name])],
      };
    setDraft({ kind: 'profile', object: profileIdentityKey(profile), target: profile, profile: next });
    setFeedback(null);
  };

  /** Flip only the subagent opt-in of one tool, leaving every other entry as written. */
  const setProfileOptIn = (name: string, allowed: boolean) => {
    if (profile === undefined || profileDraft === null) return;
    setDraft({
      kind: 'profile',
      object: profileIdentityKey(profile),
      target: profile,
      profile: { ...profileDraft, tools: profileToolsWithOptIn(profileDraft.tools, name, allowed) },
    });
    setFeedback(null);
  };

  const persist = async () => {
    if (draft === null) return;
    setSaving(true);
    setFeedback(null);
    try {
      if (draft.kind === 'rule') {
        const echoed = await client.patchConfig(subagentToolsPatch([...draft.allowedTools]));
        queryClient.setQueryData(['config'], echoed);
      } else {
        // Save the exact object the draft was made on; a same-named file in
        // another workspace is a different object and must not capture it.
        const saved = await saveSubagentProfileToolSettings(client, draft.target, draft.profile);
        queryClient.setQueryData<ListNamedAgentProfilesResponse | undefined>(
          ['named-agent-profiles', 'global'],
          (current) => current === undefined ? current : {
            ...current,
            items: current.items.map((item) =>
              item.name === saved.name && item.source === saved.source && item.source_file === saved.source_file
                ? saved
                : item),
          },
        );
        // The catalog is the truth after a write: re-read it instead of trusting
        // the patch echo (a renamed file must leave no stale row behind).
        await invalidateAgentProfileCatalogs(queryClient);
      }
      // The draft stays: the footer's check mark is the affirmation, and the
      // rows keep reading the saved values until the next edit.
      pingSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(null);
    setFeedback(null);
  };

  /** Browse freely; only a pending draft makes switching a discard decision. */
  const switchObject = (next: string) => {
    const apply = () => {
      setObject(next);
      setSelectedTool(null);
      setNarrowPane('list');
      setFeedback(null);
    };
    if (!pending) {
      apply();
      return;
    }
    if (guard?.confirmDiscard === undefined) {
      setDraft(null);
      apply();
      return;
    }
    guard.confirmDiscard(DRAFT_EDITOR_ID, () => {
      setDraft(null);
      apply();
    });
  };

  const objectChoices = [
    {
      value: DEFAULT_TOOL_OBJECT,
      label: t('st.subagentTools.objectDefault'),
      hint: t('st.subagentTools.objectDefaultHint'),
      group: t('st.subagentTools.objectGroupDefault'),
    },
    ...profiles.map((candidate) => ({
      value: profileIdentityKey(candidate),
      label: candidate.name,
      // Several objects can share a name; the hint and title say which file each is.
      hint: candidate.source_file ?? candidate.workspace_id
        ?? t('st.subagentTools.objectSourceBuiltin', { source: candidate.source }),
      title: `${candidate.name} · ${candidate.source_file ?? t('st.subagentTools.objectSourceBuiltin', { source: candidate.source })}`,
      group: t('st.subagentTools.objectGroupProfiles'),
    })),
  ];

  const listPending = toolsQuery.isPending || (object === DEFAULT_TOOL_OBJECT && configQuery.isPending);
  const listFailed = toolsQuery.isError || (object === DEFAULT_TOOL_OBJECT && configQuery.isError);
  const queryEmpty = query.trim() === '';

  const list = (
    <div className="space-y-2">
      <ul data-tool-list className="space-y-0.5">
        {rows.map(({ tool, state, changed }) => (
          <ToolRow
            key={tool.name}
            tool={tool}
            state={state}
            changed={changed}
            selected={tool.name === selectedTool}
            onSelect={() => { setSelectedTool(tool.name); setNarrowPane('detail'); }}
            onRuleOptIn={toggleRuleOptIn}
            onProfileTool={setProfileTool}
            onProfileOptIn={setProfileOptIn}
            onEdit={() => { setEditorOpen(true); }}
            profileName={object === DEFAULT_TOOL_OBJECT ? undefined : profile?.name}
          />
        ))}
      </ul>
      {rows.length === 0 && !queryEmpty ? (
        <div className="space-y-2 px-2 py-1">
          <p data-subagent-tools-empty className="text-[12px] leading-snug text-ink-faint">
            {t('st.subagentTools.noMatches', { query: query.trim() })}
          </p>
          <button type="button" data-subagent-tools-clear
            className="h-7 rounded-md px-2 text-[12.5px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
            onClick={() => { setQuery(''); }}>
            {t('st.subagentTools.clearSearch')}
          </button>
        </div>
      ) : null}
    </div>
  );

  const detail = (() => {
    if (selected !== undefined) {
      const toolsField = profileFields.find((candidate) => candidate.field === 'tools');
      const executorNote = toolsField === undefined || toolsField.executor === 'native'
        ? undefined
        : toolsField.reason ?? t(
          toolsField.applicability === 'mapped' ? 'st.profiles.fieldMapped'
            : toolsField.applicability === 'ignored' ? 'st.subagentTools.applicabilityIgnored'
              : 'st.subagentTools.applicabilityUnknown',
          { engine: toolsField.executor },
        );
      return (
        <ToolDetail
          tool={selected.tool}
          state={selected.state}
          objectName={object === DEFAULT_TOOL_OBJECT ? t('st.subagentTools.objectDefault') : profile?.name ?? object}
          profileName={profile === undefined ? undefined : profile.name}
          executor={profile?.executor ?? ''}
          executorNote={executorNote}
          onRuleOptIn={toggleRuleOptIn}
          onProfileTool={setProfileTool}
          onProfileOptIn={setProfileOptIn}
          onEdit={() => { setEditorOpen(true); }}
        />
      );
    }
    if (object === DEFAULT_TOOL_OBJECT) {
      return (
        <RuleDetail
          allowedTools={storedRule}
          pending={pending && draft !== null && draft.kind === 'rule'}
          rowCount={catalogTotal}
          mainOnlyCount={rows.filter((row) => row.state.reason === 'main-only').length}
          configurableCount={rows.filter((row) => row.state.action === 'opt-in').length}
          onReset={() => { setDraft({ kind: 'rule', allowedTools: [] }); setFeedback(null); }}
        />
      );
    }
    if (profile === undefined) return <p className="text-[12px] text-ink-faint">{t('st.subagentTools.profileMissing')}</p>;
    return (
      <ProfileDetail
        profile={profile}
        fields={profileFields}
        editable={profileEditable}
        native={nativeExecutor}
        onEdit={() => { setEditorOpen(true); }}
        onNewSession={() => { navigate(namedAgentSessionHref(profile)); }}
        sessionBlocked={namedAgentNewSessionBlocked(profile)}
      />
    );
  })();

  return (
    <SectionCard id="st-card-subagent-tool-defaults" title={t('st.subagentTools.title')}>
      <div className="space-y-3">
        <Hint>{t('st.subagentTools.hint')}</Hint>
        <fieldset disabled={saving} className="min-w-0 space-y-3 disabled:opacity-60">
          <div className="space-y-1" data-subagent-tools-object-row>
            <SettingField label={t('st.subagentTools.objectLabel')} labelId="subagent-tools-object-label">
              <SettingsSelect
                id="subagent-tools-object"
                dataAttr="data-subagent-tools-object"
                ariaLabel={t('st.subagentTools.objectLabel')}
                value={object}
                choices={objectChoices}
                emptyText={object === DEFAULT_TOOL_OBJECT ? undefined : object}
                onChange={switchObject}
              />
            </SettingField>
            <button
              type="button"
              data-subagent-tools-object-source
              title={t('st.subagentTools.objectDetailOpen')}
              aria-label={t('st.subagentTools.objectDetailOpen')}
              onClick={() => { setSelectedTool(null); setNarrowPane('detail'); }}
              className="block max-w-[62ch] break-all text-left font-mono text-[11.5px] leading-[17px] text-ink-faint transition-colors hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink sm:truncate"
            >
              {objectSourceText(t, profile, object)}
            </button>
          </div>
          <div className="space-y-1">
            <label className="relative flex h-8 min-w-0 items-center">
              <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 text-ink-faint" />
              <input
                type="search"
                data-subagent-tools-search
                aria-label={t('st.subagentTools.searchLabel')}
                placeholder={t('st.subagentTools.searchPlaceholder')}
                value={query}
                onChange={(event) => { setQuery(event.target.value); }}
                className="h-8 w-full min-w-0 rounded-md bg-ink/[0.04] pl-8 pr-20 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint hover:bg-ink/[0.06] focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)] [&::-webkit-search-cancel-button]:hidden"
              />
              <span data-subagent-tools-count className="pointer-events-none absolute right-2.5 text-[12px] tabular-nums text-ink-faint">
                {query.trim() === '' ? t('st.list.count', { total: catalogTotal }) : t('st.list.countOf', { shown: matchCount, total: catalogTotal })}
              </span>
            </label>
          </div>
          {listPending ? <p role="status" className="text-[12.5px] text-ink-faint">{t('st.subagentTools.catalogLoading')}</p> : null}
          {listFailed || (!listPending && catalogTotal === 0) ? (
            <div className="space-y-2">
              {toolsQuery.isError ? <InlineError error={toolsQuery.error} /> : null}
              {!listFailed && catalogTotal === 0 ? (
                <p data-subagent-tools-empty className="max-w-[62ch] text-[12px] leading-snug text-ink-soft">
                  {t('st.subagentTools.catalogEmptyTitle')} {t('st.subagentTools.catalogEmptyBody')}
                </p>
              ) : null}
              {object === DEFAULT_TOOL_OBJECT && configQuery.isError ? <InlineError error={configQuery.error} /> : null}
              <button type="button" className={SECONDARY_BUTTON} data-subagent-tools-retry
                onClick={() => { void toolsQuery.refetch(); if (object === DEFAULT_TOOL_OBJECT) void configQuery.refetch(); }}>
                {t('st.subagentTools.catalogRetry')}
              </button>
            </div>
          ) : null}
          {listPending || listFailed || catalogTotal === 0 ? null : (
            <SettingsDetailLayout narrowPane={narrowPane} columns="md:grid-cols-[minmax(0,9fr)_minmax(0,7fr)]" list={list} detail={(
              <div className="space-y-4">
                <button type="button" data-subagent-tools-back className={`${SECONDARY_BUTTON} md:hidden`}
                  onClick={() => { setNarrowPane('list'); }}>
                  <span className="inline-flex items-center gap-1">
                    <Icon name="arrowLeft" size={12} />{t('st.subagentTools.backToList')}
                  </span>
                </button>
                {detail}
              </div>
            )} />
          )}
          {profilesQuery.isError ? <InlineError error={profilesQuery.error} /> : null}
        </fieldset>
        {draft !== null ? (
          <SettingsDraftFooter
            id={DRAFT_EDITOR_ID}
            persistent
            dirty={pending}
            saving={saving}
            saved={justSaved}
            saveLabel={t(draft.kind === 'rule' ? 'st.subagentTools.saveRule' : 'st.subagentTools.saveProfile')}
            onSave={() => { void persist(); }}
            onDiscard={discard}
            extra={changedCount > 0 ? (
              // The save bar says "unsaved"; this says how much of the list it
              // is, so the blast radius is read before the click, not after.
              <span data-subagent-tools-pending className="flex items-center gap-1.5 text-[12px] text-ink-faint">
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                {t('st.subagentTools.pendingChanges', { count: changedCount })}
              </span>
            ) : undefined}
          />
        ) : null}
        <FeedbackLine feedback={feedback} />
        {editorOpen && profile !== undefined ? (
          <AgentProfileEditorDialog
            profile={profile}
            onClose={() => { setEditorOpen(false); }}
            onSaved={(updated) => {
              queryClient.setQueryData<ListNamedAgentProfilesResponse | undefined>(
                ['named-agent-profiles', 'global'],
                (current) => current === undefined ? current : {
                  ...current,
                  items: current.items.map((item) =>
                    item.name === updated.name && item.source === updated.source && item.source_file === updated.source_file
                      ? updated
                      : item),
                },
              );
              void invalidateAgentProfileCatalogs(queryClient);
              setEditorOpen(false);
            }}
          />
        ) : null}
      </div>
    </SectionCard>
  );
}

/** The picker's object value; identical to the key `preferredProfilesByName` dedupes on. */
function profileIdentityKey(profile: Pick<NamedAgentProfile, 'name' | 'source' | 'source_file' | 'workspace_id'>): string {
  return `${profile.name}
${profile.source}
${profile.source_file ?? ''}
${profile.workspace_id ?? ''}`;
}

/**
 * The objects this page can act on: one row per profile identity, so two
 * editable files that carry the same name in different workspaces stay two
 * objects. Rows a subagent dispatch cannot use (a main-agent row, a disabled
 * one) sort after the usable rows, so resolving one never shadows the row the
 * picker displayed.
 *
 * Self-contained on purpose: the identity key is written out here so this
 * chooser can be exercised on its own, and it must stay identical to
 * `profileIdentityKey` above, which the picker values use.
 */
function preferredProfilesByName(profiles: readonly NamedAgentProfile[]): NamedAgentProfile[] {
  const seen = new Set<string>();
  const unique = profiles.filter((profile) => {
    const key = `${profile.name}
${profile.source}
${profile.source_file ?? ''}
${profile.workspace_id ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.toSorted((left, right) =>
    Number(left.main === true || left.disabled) - Number(right.main === true || right.disabled));
}

/** One line naming where this object's settings live: the config key, or the profile's file and workspace. */
function objectSourceText(
  t: ReturnType<typeof useI18n>['t'],
  profile: NamedAgentProfile | undefined,
  object: string,
): string {
  if (object === DEFAULT_TOOL_OBJECT || profile === undefined) return t('st.subagentTools.objectDefaultHint');
  const workspace = profile.workspace_ids?.[0] ?? profile.workspace_id;
  const sourceKey = agentProfileSourceLabelKey(profile.source);
  const source = sourceKey === undefined ? profile.source : t(sourceKey);
  const parts = [
    profile.source_file === undefined
      ? t('st.subagentTools.objectSourceBuiltin', { source })
      : t('st.subagentTools.objectSource', { source, file: profile.source_file }),
  ];
  if (workspace !== undefined) parts.push(t('st.subagentTools.objectWorkspace', { id: workspace }));
  if (profile.executor !== undefined && profile.executor !== 'native') {
    parts.push(t('st.subagentTools.objectExecutor', { executor: profile.executor }));
  }
  return parts.join(' · ');
}

function statusText(t: ReturnType<typeof useI18n>['t'], state: ToolRowState): string {
  if (state.status === 'allowed') return t('st.subagentTools.statusAllowed');
  if (state.status === 'blocked') return t('st.subagentTools.statusBlocked');
  if (state.status === 'inherit') return t('st.subagentTools.statusInherit');
  return t('st.subagentTools.statusFixed');
}

/** The short reason a row carries: it explains the status without leaving the line. */
function reasonShort(t: ReturnType<typeof useI18n>['t'], state: ToolRowState): string {
  switch (state.reason) {
    case 'default-allowed': return t('st.subagentTools.reasonDefaultAllowed');
    case 'server-opt-in': return t('st.subagentTools.reasonServerOptIn');
    case 'opt-in-off': return t('st.subagentTools.reasonOptInOff');
    case 'profile-explicit': return t('st.subagentTools.reasonProfileExplicit');
    case 'profile-pattern': return t('st.subagentTools.reasonProfilePattern');
    case 'profile-denied': return t('st.subagentTools.reasonProfileDenied');
    case 'profile-allowlist': return t('st.subagentTools.reasonProfileAllowlist');
    case 'inherit': return t('st.subagentTools.reasonInheritBase', { base: t(state.inheritAllows === false ? 'st.subagentTools.statusBlocked' : 'st.subagentTools.statusAllowed') });    case 'main-only': return t('st.subagentTools.reasonMainOnly');
    case 'executor': return t('st.subagentTools.reasonExecutor');
  }
}

/** The full sentence the detail pane prints, including what a fix would require. */
function reasonLong(t: ReturnType<typeof useI18n>['t'], name: string, state: ToolRowState, executor: string): string {
  const base = t(state.inheritAllows === false ? 'st.subagentTools.statusBlocked' : 'st.subagentTools.statusAllowed');
  switch (state.reason) {
    case 'default-allowed': return t('st.subagentTools.detailDefaultAllowed', { name });
    case 'server-opt-in': return t('st.subagentTools.detailServerOptIn', { name });
    case 'opt-in-off': return t('st.subagentTools.detailOptInOff', { name });
    case 'profile-explicit': return t('st.subagentTools.detailProfileExplicit', { name });
    case 'profile-pattern': return t('st.subagentTools.detailProfilePattern', { name });
    case 'profile-denied': return t('st.subagentTools.detailProfileDenied', { name });
    case 'profile-allowlist': return t('st.subagentTools.detailProfileAllowlist', { name });
    case 'inherit': return t('st.subagentTools.detailInherit', { name, base });
    case 'main-only': return t('st.subagentTools.detailMainOnly', { name });
    case 'executor': return t('st.subagentTools.detailExecutor', { name, executor });
  }
}

function ToolRow({ tool, state, changed, selected, onSelect, onRuleOptIn, onProfileTool, onProfileOptIn, onEdit, profileName }: {
  tool: ToolDescriptor;
  state: ToolRowState;
  /** The draft will change this row's status on save; the dot says so in place. */
  changed: boolean;
  selected: boolean;
  onSelect: () => void;
  onRuleOptIn: (name: string, allowed: boolean) => void;
  onProfileTool: (name: string, allow: boolean) => void;
  onProfileOptIn: (name: string, allowed: boolean) => void;
  onEdit: () => void;
  profileName: string | undefined;
}) {
  const { t } = useI18n();
  const purpose = toolPurpose(tool);
  // One checkbox, two objects: the server rule and a profile's own opt-in are
  // different writes, so the row's object decides which one this control is.
  const onServerRule = profileName === undefined;
  const optInLabel = t(
    onServerRule
      ? 'st.subagentTools.actionOptInAria'
      : 'st.subagentTools.actionProfileOptInAria',
    { name: tool.name },
  );
  return (
    <li data-tool-row={tool.name} className="flex items-start gap-1.5">
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        title={reasonShort(t, state)}
        className="row-interactive min-w-0 flex-1 px-2 py-1.5 text-left"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          {/* The list shows the name as the model calls it, without the transport prefix. */}
          <span className="min-w-0 truncate font-mono text-[12.5px] text-ink" title={tool.name}>{toolDisplayName(tool.name)}</span>
          {tool.source === 'builtin' ? null : (
            <span className="shrink-0 text-[11px] text-ink-faint">{t(`st.subagentTools.sourceTag.${tool.source}`)}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-soft">
            {changed ? (
              <span role="img" aria-label={t('st.subagentTools.changedMark')} title={t('st.subagentTools.changedMark')}
                data-tool-changed={tool.name}
                className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
            ) : null}
            {statusText(t, state)}
          </span>
        </span>
        {/* Two lines, so the sentence a row is judged by is not cut off
            mid-clause; the full text stays in the detail pane. */}
        <span className="mt-0.5 block line-clamp-2 text-[11.5px] leading-[16px] text-ink-faint">
          {purpose === '' ? reasonShort(t, state) : purpose}
        </span>
      </button>
      {state.action === 'opt-in' ? (
        <input
          type="checkbox"
          data-server-allow={onServerRule ? tool.name : undefined}
          data-profile-opt-in={onServerRule ? undefined : tool.name}
          checked={state.status === 'allowed'}
          aria-label={optInLabel}
          className="mt-2 shrink-0"
          onChange={(event) => {
            const allowed = event.target.checked;
            if (onServerRule) onRuleOptIn(tool.name, allowed);
            else onProfileOptIn(tool.name, allowed);
          }}
        />
      ) : null}
      {state.action === 'allow' && profileName !== undefined ? (
        <button type="button" data-tool-allow={tool.name}
          className="h-7 shrink-0 self-center rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
          onClick={() => { onProfileTool(tool.name, true); }}>
          {t('st.subagentTools.actionAllow')}
        </button>
      ) : null}
      {state.action === 'deny' && profileName !== undefined ? (
        <button type="button" data-tool-deny={tool.name}
          className="h-7 shrink-0 self-center rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
          onClick={() => { onProfileTool(tool.name, false); }}>
          {t('st.subagentTools.actionDeny')}
        </button>
      ) : null}
      {state.action === 'editor' && profileName !== undefined ? (
        <button type="button" data-tool-editor={tool.name}
          title={t('st.subagentTools.actionEditorAria', { name: tool.name })}
          aria-label={t('st.subagentTools.actionEditorAria', { name: tool.name })}
          className="h-7 shrink-0 self-center rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
          onClick={onEdit}>
          {t('st.subagentTools.actionEditor')}
        </button>
      ) : null}
    </li>
  );
}

function ToolDetail({ tool, state, objectName, profileName, executor, executorNote, onRuleOptIn, onProfileTool, onProfileOptIn, onEdit }: {
  tool: ToolDescriptor;
  state: ToolRowState;
  objectName: string;
  profileName: string | undefined;
  executor: string;
  executorNote?: string;
  onRuleOptIn: (name: string, allowed: boolean) => void;
  onProfileTool: (name: string, allow: boolean) => void;
  onProfileOptIn: (name: string, allowed: boolean) => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const description = tool.description.trim();
  const onServerRule = profileName === undefined;
  return (
    <div className="space-y-3" data-tool-detail={tool.name}>
      <div className="min-w-0">
        <h3 className="break-all font-mono text-[13px] text-ink">{tool.name}</h3>
        <p className="mt-0.5 text-[11.5px] text-ink-faint">
          {t(`cap.tools.${tool.source}`)}
          {tool.mcp_server_id === undefined ? '' : ` · ${t('st.subagentTools.toolServer', { id: tool.mcp_server_id })}`}
        </p>
      </div>
      {description === '' ? null : (
        <p className="max-w-[72ch] whitespace-pre-line text-[12.5px] leading-5 text-ink-soft">{description}</p>
      )}
      <div className="space-y-1">
        <p data-tool-state={state.reason} className="text-[12.5px] text-ink">
          {objectName} · {statusText(t, state)}
        </p>
        <p className="max-w-[72ch] text-[12px] leading-[18px] text-ink-soft">
          {reasonLong(t, tool.name, state, executor)}
        </p>
        {executorNote === undefined ? null : (
          <p data-tool-executor-note className="max-w-[72ch] text-[11.5px] leading-[18px] text-ink-faint">{executorNote}</p>
        )}
      </div>
      {state.action === 'opt-in' ? (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-[12.5px] text-ink">
            <input type="checkbox" data-tool-detail-opt-in={tool.name} checked={state.status === 'allowed'}
              aria-label={t(onServerRule ? 'st.subagentTools.actionOptInAria' : 'st.subagentTools.actionProfileOptInAria', { name: tool.name })}
              onChange={(event) => {
                const allowed = event.target.checked;
                if (onServerRule) onRuleOptIn(tool.name, allowed);
                else onProfileOptIn(tool.name, allowed);
              }} />
            <span>{t(onServerRule ? 'st.subagentTools.actionOptInAria' : 'st.subagentTools.actionProfileOptInAria', { name: tool.name })}</span>
          </label>
          {onServerRule ? null : <Hint>{t('st.subagentTools.profileOptInScopeHint')}</Hint>}
        </div>
      ) : null}
      {state.action === 'allow' && profileName !== undefined ? (
        <button type="button" className={SECONDARY_BUTTON} data-tool-detail-allow={tool.name}
          onClick={() => { onProfileTool(tool.name, true); }}>
          {t('st.subagentTools.detailAllow', { name: tool.name })}
        </button>
      ) : null}
      {state.action === 'deny' && profileName !== undefined ? (
        <button type="button" className={SECONDARY_BUTTON} data-tool-detail-deny={tool.name}
          onClick={() => { onProfileTool(tool.name, false); }}>
          {t('st.subagentTools.detailDeny', { name: tool.name })}
        </button>
      ) : null}
      {state.action === 'editor' && profileName !== undefined ? (
        <button type="button" className={SECONDARY_BUTTON} data-tool-detail-editor={tool.name} onClick={onEdit}>
          {t('st.subagentTools.editToolLists')}
        </button>
      ) : null}
    </div>
  );
}

function RuleDetail({ allowedTools, pending, rowCount, mainOnlyCount, configurableCount, onReset }: {
  allowedTools: readonly string[];
  pending: boolean;
  rowCount: number;
  mainOnlyCount: number;
  configurableCount: number;
  onReset: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3" data-subagent-tools-rule-detail>
      <div className="min-w-0">
        <h3 className="text-[13px] text-ink">{t('st.subagentTools.objectDefault')}</h3>
        <p className="mt-0.5 max-w-[72ch] text-[12px] leading-[18px] text-ink-faint">
          {t('st.subagentTools.objectDefaultDescription')}
        </p>
      </div>
      <p className="text-[12px] text-ink-soft">
        {t('st.subagentTools.summary', { configurable: configurableCount, mainOnly: mainOnlyCount, total: rowCount })}
      </p>
      {pending ? <Hint>{t('st.subagentTools.rulePending')}</Hint> : null}
      <AdvancedDetails summary={t('st.subagentTools.ruleConfigKeyLabel')}>
        <p className="font-mono text-[11px] leading-5 text-ink-soft">[subagent].allowed_tools</p>
        <p className="font-mono text-[11px] leading-5 text-ink">
          {allowedTools.length === 0 ? t('st.subagentTools.ruleValuesEmpty') : allowedTools.join(', ')}</p>
      </AdvancedDetails>
      {allowedTools.length === 0 ? null : (
        <button type="button" className={SECONDARY_BUTTON} data-subagent-tools-reset onClick={onReset}>
          {t('st.subagentTools.reset')}
        </button>
      )}
      <Hint>{t('st.subagentTools.detailRuleNote')}</Hint>
    </div>
  );
}

function ProfileDetail({ profile, fields, editable, native, onEdit, onNewSession, sessionBlocked }: {
  profile: NamedAgentProfile;
  fields: ReturnType<typeof subagentProfileToolFields>;
  editable: boolean;
  native: boolean;
  onEdit: () => void;
  onNewSession: () => void;
  sessionBlocked: boolean;
}) {
  const { t } = useI18n();
  const description = profile.description ?? profile.when_to_use;
  return (
    <div className="space-y-3" data-subagent-tools-profile-detail={profile.name}>
      <div className="min-w-0">
        <h3 className="text-[13px] text-ink">{profile.name}</h3>
        {description === undefined || description === '' ? null : (
          <p className="mt-0.5 max-w-[72ch] text-[12px] leading-[18px] text-ink-faint">{description}</p>
        )}
      </div>
      {fields.map((field) => (
        <AdvancedDetails key={field.field} summary={t(field.field === 'tools' ? 'st.subagentTools.listsTools' : 'st.subagentTools.listsDisallowedTools')}>
          <p className="font-mono text-[11px] leading-5 text-ink">
            {field.values === null
              ? t('st.subagentTools.valuesUnset')
              : field.values.length === 0
                ? t(field.field === 'tools' ? 'st.subagentTools.valuesEmptyTools' : 'st.subagentTools.valuesEmptyDeny')
                : field.values.join(', ')}
          </p>
          {field.applicability === 'ignored' || field.applicability === 'unknown' ? (
            <p className="text-[11px] leading-5 text-ink-faint">
              {field.reason ?? t(field.applicability === 'ignored' ? 'st.subagentTools.applicabilityIgnored' : 'st.subagentTools.applicabilityUnknown', { engine: field.executor })}
            </p>
          ) : null}
        </AdvancedDetails>
      ))}
      <div className="flex flex-wrap gap-2">
        {editable ? (
          <button type="button" className={SECONDARY_BUTTON} data-subagent-tools-edit-lists onClick={onEdit}>
            {t('st.subagentTools.editToolLists')}
          </button>
        ) : null}
        <button type="button" className={SECONDARY_BUTTON} data-subagent-tools-new-session
          disabled={sessionBlocked} onClick={onNewSession}>
          {t('st.subagentTools.newSession', { name: profile.name })}
        </button>
      </div>
      {editable ? null : <Hint>{t('st.subagentTools.unwritableProfile')}</Hint>}
      {native ? null : <Hint>{t('st.subagentTools.detailExecutorFieldOff', { executor: profile.executor ?? '' })}</Hint>}
      <Hint>{t('st.subagentTools.sessionCapabilityHint')}</Hint>
    </div>
  );
}
