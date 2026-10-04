/**
 * Persona editor — one sheet, five sections in the order a person decides:
 * who it is (face, name, title, job, the words it opens with), how it runs
 * (profile, model, effort, default workspace, reply mode), how it shows up
 * (pinned / hidden), what it remembers (read policy plus the memory console),
 * and what it is attached to (scheduled tasks, rooms).
 *
 * Everything but 可见性 rides one save transaction guarded by the snapshot
 * revision; a 40946 conflict offers a reload instead of overwriting, and a
 * failed write keeps the draft exactly as typed. 可见性 writes its own two
 * switches straight to the persona's state, because that is a different
 * resource with its own endpoint.
 *
 * The form is held by the persona, not by its revision. Another window's save
 * re-reads into the same query while this one is open, and re-seeding on that
 * would throw away whatever is being typed here: a dirty form keeps its draft
 * and the revision it started from, and only a save, a discard or an explicit
 * reload takes the newer fact.
 *
 * Destructive and rare actions (duplicate, export, archive, delete) live in
 * the masthead's overflow menu.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PersonaSnapshot, PersonaSummary, Workspace } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { resolveCatalogModel } from '@kiki/session-core/settings';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { ApiError, PERSONA_ALREADY_EXISTS, PERSONA_REVISION_CONFLICT } from '../../lib/client';
import { pushToast } from '../../lib/toasts';
import { registerOverlay } from '../../lib/uiBusy';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { DEFAULT_AGENT_PROFILE } from '../Composer';
import { FeedbackLine, Hint, Toggle } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { SearchableSelect, POPOVER_SURFACE_CLASS, type SearchableSelectOption } from '../SearchableSelect';
import { AdvancedDetails, SettingField } from '../settings/fields';
import { SectionCard } from '../settings/SectionCard';
import { SettingHelp } from '../settings/SettingHelp';
import { FieldIssue, FORM_LABEL, FORM_SELECT_TRIGGER, SettingsDraftFooter, SettingsSegmented, SettingsSelect } from '../settings/SettingsPrimitives';
import { useSavedTick } from '../settings/useSavedTick';
import { INPUT } from '../ui';
import { personaAvatarOf } from './PersonaAvatar';
import { PersonaAvatarControl } from './PersonaAvatarControl';
import { PersonaTasksSection } from './PersonaTasksSection';
import { PersonaVisibilitySection } from './PersonaVisibilitySection';
import {
  DEFAULT_MEMORY_SHARED,
  HOME_WORKSPACE_AUTO,
  definitionFromDraft,
  draftFromDefinition,
  draftsEqual,
  EMPTY_PERSONA_DRAFT,
  personaIdFromName,
  validatePersonaDraft,
  type PersonaDeliveryMode,
  type PersonaDraft,
  type PersonaMemoryScope,
} from './personaDraft';
import { downloadBlob, invalidatePersonas, personaQueryKey } from './usePersonas';

const TEXTAREA = `${INPUT} resize-y leading-relaxed`;
/** Stable stand-in while the workspace list is on its way. */
const NO_WORKSPACES: readonly Workspace[] = [];

export function PersonaEditor({
  personaId,
  summary,
  takenIds,
  onSaved,
  onClosed,
}: {
  /** `undefined` = a new persona. */
  readonly personaId: string | undefined;
  readonly summary?: PersonaSummary;
  readonly takenIds: ReadonlySet<string>;
  readonly onSaved: (id: string) => void;
  readonly onClosed: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const creating = personaId === undefined;
  const snapshotQuery = useQuery({
    queryKey: personaQueryKey(personaId ?? ''),
    queryFn: () => client.getPersona(personaId!),
    enabled: !creating,
    staleTime: 5_000,
  });
  const snapshot = snapshotQuery.data;

  if (!creating && snapshotQuery.isPending) {
    return <p role="status" className="py-8 text-[13px] text-ink-faint">{t('persona.loading')}</p>;
  }
  if (!creating && snapshotQuery.isError) {
    return (
      <div className="space-y-1 py-2" data-persona-load-error>
        <p className="text-[13px] font-medium text-danger">{t('persona.loadFailed')}</p>
        <FeedbackLine feedback={{ tone: 'error', text: errorText(locale, snapshotQuery.error) }} />
        <button type="button" onClick={() => { void snapshotQuery.refetch(); }} className="text-[12px] text-ink-faint underline underline-offset-2 hover:text-ink">{t('common.retry')}</button>
      </div>
    );
  }
  return (
    <PersonaForm
      key={personaId ?? 'new'}
      snapshot={snapshot}
      summary={summary}
      takenIds={takenIds}
      onSaved={(next) => {
        queryClient.setQueryData(personaQueryKey(next.definition.id), next);
        void invalidatePersonas(queryClient);
        onSaved(next.definition.id);
      }}
      onReload={() => snapshotQuery.refetch().then((result) => result.data)}
      onClosed={onClosed}
    />
  );
}

function PersonaForm({
  snapshot,
  summary,
  takenIds,
  onSaved,
  onReload,
  onClosed,
}: {
  readonly snapshot: PersonaSnapshot | undefined;
  readonly summary?: PersonaSummary;
  readonly takenIds: ReadonlySet<string>;
  readonly onSaved: (snapshot: PersonaSnapshot) => void;
  /** Re-read the persona; resolves with the fact the server returned. */
  readonly onReload: () => Promise<PersonaSnapshot | undefined>;
  readonly onClosed: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const navigate = useGuardedNavigate();
  const formId = useId();
  const creating = snapshot === undefined;

  // The workspace list is what turns a stored location into a picker choice;
  // until it arrives the draft keeps whatever the asset holds. Both the array
  // and the draft derived from it keep a stable identity until the data really
  // changes, so the baseline below is not rebuilt on every render.
  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 60_000 });
  const workspaceItems = workspacesQuery.data?.items;
  const workspaces = useMemo<readonly Workspace[]>(() => workspaceItems ?? NO_WORKSPACES, [workspaceItems]);

  const initial = useMemo(
    () => (snapshot === undefined ? EMPTY_PERSONA_DRAFT : draftFromDefinition(snapshot.definition, workspaces)),
    [snapshot, workspaces],
  );
  const [draft, setDraft] = useState<PersonaDraft>(initial);
  const [baseline, setBaseline] = useState<PersonaDraft>(initial);
  // The revision the draft started from. A save sends this, so it is the fact
  // the reader was looking at when they began typing — never a newer one that
  // arrived from a background read while they worked.
  const [expected, setExpected] = useState<string | undefined>(snapshot?.revision);
  const touched = useRef(false);

  // Take the server's word for the form only when the reader has nothing of
  // their own in it: the workspace list landing after the first paint, or a
  // read-back of a new revision against a clean form. A dirty form keeps its
  // draft and its expected revision until a save, a discard or an explicit
  // reload says otherwise, so a second window's edit cannot overwrite typing.
  if (baseline !== initial && !touched.current) {
    setBaseline(initial);
    setDraft(initial);
    setExpected(snapshot?.revision);
  }

  /** Replace the form with a real server fact: no draft, nothing to lose. */
  const adopt = (next: PersonaDraft, revision: string | undefined) => {
    touched.current = false;
    setDraft(next);
    setBaseline(next);
    setExpected(revision);
    setAttempted(false);
    setSaveFailure(null);
    setConflict(false);
  };

  const [idTouched, setIdTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [saved, pingSaved] = useSavedTick();
  const dirty = !draftsEqual(draft, baseline);
  const issues = validatePersonaDraft(draft, { creating, takenIds });
  const shownIssues = attempted ? issues : (issues.id === 'idTaken' ? { id: issues.id } : {});

  const set = <K extends keyof PersonaDraft>(key: K, value: PersonaDraft[K]) => {
    touched.current = true;
    setSaveFailure(null);
    setDraft((current) => {
      const next = { ...current, [key]: value };
      if (creating && key === 'name' && !idTouched) return { ...next, id: value === '' ? '' : personaIdFromName(String(value)) };
      return next;
    });
  };

  const profilesQuery = useQuery({
    queryKey: ['agentProfiles', 'global'],
    queryFn: () => client.listNamedAgentProfiles(),
    staleTime: 60_000,
  });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });

  const workspaceOptions: SearchableSelectOption[] = useMemo(() => {
    const choices: SearchableSelectOption[] = [
      { value: HOME_WORKSPACE_AUTO, label: t('persona.homeWorkspaceAuto') },
      ...workspaces.map((workspace) => ({ value: `ws:${workspace.id}`, label: workspace.name, hint: workspace.root })),
      // A persona may carry a plain path that no longer corresponds to a
      // registered workspace (an older asset, or a directory this server does
      // not list). It stays selectable and editable exactly as stored — the
      // editor is not a registration gate.
      ...(draft.homeWorkspace.startsWith('path:')
        ? [{
          value: draft.homeWorkspace,
          label: draft.homeWorkspace.slice('path:'.length),
          hint: t('persona.homeWorkspacePath'),
        }]
        : []),
    ];
    return choices;
  }, [workspaces, t, draft.homeWorkspace]);

  const profileOptions: SearchableSelectOption[] = useMemo(() => [
    { value: '', label: t('persona.profileDefault') },
    ...(profilesQuery.data?.items ?? [])
      .filter((item) => item.main === true && !item.disabled && item.name !== DEFAULT_AGENT_PROFILE)
      .map((item) => ({ value: item.name, label: item.name, description: item.description ?? undefined })),
  ], [profilesQuery.data, t]);
  const models = modelsQuery.data?.items ?? [];
  const modelOptions: SearchableSelectOption[] = useMemo(() => [
    { value: '', label: t('persona.modelFollow') },
    ...models.map((item) => ({ value: item.id, label: item.display_name ?? item.id, hint: item.id, keywords: item.remote_id })),
  ], [models, t]);
  const selectedModel = draft.modelAlias === '' ? undefined : resolveCatalogModel(models, draft.modelAlias);
  const effortOptions: SearchableSelectOption[] = [
    { value: '', label: t('persona.effortFollow') },
    ...(selectedModel?.support_efforts ?? []).map((effort) => ({ value: effort, label: effort })),
  ];

  const saveMutation = useMutation({
    mutationFn: () => client.putPersona({
      definition: definitionFromDraft(draft, snapshot?.definition, workspaces),
      ...(expected !== undefined ? { revision: expected } : {}),
      ...(snapshot?.examples !== undefined ? { examples: snapshot.examples } : {}),
    }),
    onSuccess: (next) => {
      pingSaved();
      // The server's echo is the new truth: rebase on it, so the bar reads
      // clean and the next save carries this revision rather than the old one.
      adopt(draftFromDefinition(next.definition, workspaces), next.revision);
      pushToast({ tone: 'success', text: t(creating ? 'persona.createdToast' : 'persona.savedToast', { name: next.definition.name }) });
      onSaved(next);
    },
    onError: (error: unknown) => {
      // Nothing is discarded: the draft, the pickers and the field values stay
      // exactly as typed, and the reason lands under the save row.
      if (error instanceof ApiError && error.code === PERSONA_REVISION_CONFLICT) { setConflict(true); return; }
      if (error instanceof ApiError && error.code === PERSONA_ALREADY_EXISTS) { setAttempted(true); return; }
      setSaveFailure(t('persona.saveFailed', { detail: errorText(locale, error) }));
    },
  });
  const save = () => {
    setAttempted(true);
    setSaveFailure(null);
    if (Object.keys(issues).length > 0) {
      document.getElementById(`${formId}-${Object.keys(issues)[0]}`)?.focus();
      return;
    }
    saveMutation.mutate();
  };

  const identity = personaAvatarOf({
    id: snapshot?.definition.id ?? (draft.id === '' ? 'new' : draft.id),
    name: draft.name.trim() === '' ? (snapshot?.definition.name ?? '?') : draft.name,
    avatarMime: summary?.avatarMime,
    avatarShape: summary?.avatarShape,
  });

  const fieldId = (key: string) => `${formId}-${key}`;
  const issueText = (key: 'name' | 'description' | 'id') => {
    const issue = shownIssues[key];
    return issue === undefined ? null : t(`persona.${issue}`);
  };

  return (
    <form
      data-persona-editor={snapshot?.definition.id ?? 'new'}
      aria-label={creating ? t('persona.newTitle') : draft.name}
      noValidate
      onSubmit={(event) => { event.preventDefault(); save(); }}
      className="min-w-0 space-y-6"
    >
      {/* Masthead: the face and the name, set large — this is the card. */}
      <div className="flex min-w-0 items-start gap-4">
        <PersonaAvatarControl persona={identity} personaId={snapshot?.definition.id} />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="truncate font-display text-[22px] leading-7 font-semibold tracking-tight text-ink">
            {draft.name.trim() === '' ? t('persona.newTitle') : draft.name}
          </h2>
          <p className="mt-0.5 truncate text-[13px] text-ink-soft">
            {[draft.title.trim(), draft.job.trim()].filter((part) => part !== '').join(' · ') || '\u00a0'}
          </p>
        </div>
        {snapshot !== undefined ? (
          <PersonaActions snapshot={snapshot} dirty={dirty} onChanged={() => { void invalidatePersonas(queryClient, snapshot.definition.id); }} onClosed={onClosed} onStartChat={() => { navigate(`/p/${encodeURIComponent(snapshot.definition.id)}/daily`); }} />
        ) : null}
      </div>

      {/* ① 身份 */}
      <SectionCard id="persona-card-identity" title={t('persona.section.identity')}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <label htmlFor={fieldId('name')} className={FORM_LABEL}>{t('persona.name')}</label>
            <input id={fieldId('name')} data-persona-field="name" value={draft.name} onChange={(event) => { set('name', event.target.value); }} aria-invalid={shownIssues.name !== undefined} aria-describedby={shownIssues.name !== undefined ? `${fieldId('name')}-issue` : undefined} className={INPUT} autoComplete="off" />
            <FieldIssue id={`${fieldId('name')}-issue`} text={issueText('name')} />
          </div>
          <div className="min-w-0 space-y-1.5">
            <label htmlFor={fieldId('title')} className={FORM_LABEL}>{t('persona.label')}</label>
            <input id={fieldId('title')} data-persona-field="title" value={draft.title} placeholder={t('persona.titlePlaceholder')} onChange={(event) => { set('title', event.target.value); }} className={INPUT} autoComplete="off" />
          </div>
          <div className="min-w-0 space-y-1.5 sm:col-span-full">
            <label htmlFor={fieldId('job')} className={FORM_LABEL}>{t('persona.job')}</label>
            <input id={fieldId('job')} data-persona-field="job" value={draft.job} placeholder={t('persona.jobPlaceholder')} onChange={(event) => { set('job', event.target.value); }} className={INPUT} autoComplete="off" />
          </div>
          {creating ? (
            <div className="min-w-0 space-y-1.5 sm:col-span-full">
              <label htmlFor={fieldId('id')} className={FORM_LABEL}>{t('persona.id')}</label>
              <input id={fieldId('id')} data-persona-field="id" value={draft.id} onChange={(event) => { setIdTouched(true); set('id', event.target.value.toLowerCase()); }} aria-invalid={shownIssues.id !== undefined} aria-describedby={`${fieldId('id')}-hint${shownIssues.id !== undefined ? ` ${fieldId('id')}-issue` : ''}`} className={`${INPUT} font-mono`} autoComplete="off" spellCheck={false} />
              <p id={`${fieldId('id')}-hint`} className="text-[12px] leading-relaxed text-ink-faint">{t('persona.idHint')}</p>
              <FieldIssue id={`${fieldId('id')}-issue`} text={issueText('id')} />
            </div>
          ) : null}
        </div>

        <div className="space-y-3 pt-4">
          <div className="min-w-0 space-y-1.5">
            {/* What the text becomes is what the reader is deciding when they are
                done writing it, not while they write: the label's `i` carries it. */}
            <div className="flex items-center gap-1.5">
              <label htmlFor={fieldId('description')} className={FORM_LABEL}>{t('persona.description')}</label>
              <SettingHelp>{t('persona.descriptionHint')}</SettingHelp>
            </div>
            <textarea id={fieldId('description')} data-persona-field="description" rows={10} value={draft.description} onChange={(event) => { set('description', event.target.value); }} aria-invalid={shownIssues.description !== undefined} aria-describedby={shownIssues.description !== undefined ? `${fieldId('description')}-issue` : undefined} className={`${TEXTAREA} min-h-[180px] font-mono text-[12.5px]`} spellCheck={false} />
            <FieldIssue id={`${fieldId('description')}-issue`} text={issueText('description')} />
          </div>
          <div className="min-w-0 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <label htmlFor={fieldId('greeting')} className={FORM_LABEL}>{t('persona.greeting')}</label>
              <SettingHelp>{t('persona.greetingHint')}</SettingHelp>
            </div>
            <textarea id={fieldId('greeting')} data-persona-field="greeting" rows={2} value={draft.greeting} onChange={(event) => { set('greeting', event.target.value); }} className={TEXTAREA} />
          </div>
        </div>

        {/* The rest of the persona file, one line away for whoever needs it. */}
        <div className="pt-4">
          <AdvancedDetails summary={t('persona.advanced')} data-persona-advanced>
            <div className="space-y-3 pt-1">
              <div className="min-w-0 space-y-1.5">
                <label htmlFor={fieldId('greetings')} className={FORM_LABEL}>{t('persona.greetings')}</label>
                <textarea id={fieldId('greetings')} data-persona-field="greetings" rows={3} value={draft.greetings} onChange={(event) => { set('greetings', event.target.value); }} aria-describedby={`${fieldId('greetings')}-hint`} className={TEXTAREA} />
                <p id={`${fieldId('greetings')}-hint`} className="text-[12px] leading-relaxed text-ink-faint">{t('persona.greetingsHint')}</p>
              </div>
              <div className="min-w-0 space-y-1.5">
                <label htmlFor={fieldId('roomGreeting')} className={FORM_LABEL}>{t('persona.roomGreeting')}</label>
                <input id={fieldId('roomGreeting')} data-persona-field="roomGreeting" value={draft.roomGreeting} onChange={(event) => { set('roomGreeting', event.target.value); }} className={INPUT} autoComplete="off" />
              </div>
              <div className="min-w-0 space-y-1.5">
                <label htmlFor={fieldId('tags')} className={FORM_LABEL}>{t('persona.tags')}</label>
                <input id={fieldId('tags')} data-persona-field="tags" value={draft.tags} onChange={(event) => { set('tags', event.target.value); }} className={INPUT} autoComplete="off" />
              </div>
              <div className="min-w-0 space-y-1.5">
                <label htmlFor={fieldId('notes')} className={FORM_LABEL}>{t('persona.notes')}</label>
                <textarea id={fieldId('notes')} data-persona-field="notes" rows={2} value={draft.notes} onChange={(event) => { set('notes', event.target.value); }} className={TEXTAREA} />
              </div>
            </div>
          </AdvancedDetails>
        </div>
      </SectionCard>

      {/* ② 默认工作 */}
      <SectionCard id="persona-card-work" title={t('persona.section.work')}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-3">
          <div className="min-w-0 space-y-1.5">
            <span className={FORM_LABEL} id={fieldId('profile')}>{t('persona.profile')}</span>
            <SearchableSelect id={fieldId('profile')} options={profileOptions} value={draft.profile} onChange={(value) => { set('profile', value); }} ariaLabel={t('persona.profile')} buttonClassName={FORM_SELECT_TRIGGER} />
          </div>
          <div className="min-w-0 space-y-1.5">
            <span className={FORM_LABEL} id={fieldId('model')}>{t('persona.model')}</span>
            <SearchableSelect id={fieldId('model')} options={modelOptions} value={draft.modelAlias} onChange={(value) => { setDraft((current) => { touched.current = true; setSaveFailure(null); return { ...current, modelAlias: value, thinkingEffort: '' }; }); }} ariaLabel={t('persona.model')} buttonClassName={FORM_SELECT_TRIGGER} panelClassName={`anim-enter absolute right-0 z-40 mt-1 w-72 max-w-[calc(100vw-32px)] overflow-hidden ${POPOVER_SURFACE_CLASS}`} density="compact" />
          </div>
          <div className="min-w-0 space-y-1.5">
            <span className={FORM_LABEL} id={fieldId('effort')}>{t('persona.effort')}</span>
            <SearchableSelect id={fieldId('effort')} options={effortOptions} value={draft.thinkingEffort} onChange={(value) => { set('thinkingEffort', value); }} ariaLabel={t('persona.effort')} buttonClassName={FORM_SELECT_TRIGGER} hideFilter disabled={effortOptions.length <= 1 && draft.thinkingEffort === ''} />
          </div>
        </div>
        <div className="pt-3"><Hint>{t('persona.profileHint')}</Hint></div>

        <div className="space-y-3 pt-4">
          <SettingField label={t('persona.homeWorkspace')} layout="row" help={t('persona.homeWorkspaceHint')}>
            <div className="w-[min(100%,16rem)]" data-persona-field="homeWorkspace" data-value={draft.homeWorkspace}>
              <SettingsSelect
                id={fieldId('homeWorkspace')}
                variant="form"
                ariaLabel={t('persona.homeWorkspace')}
                value={draft.homeWorkspace}
                mono={draft.homeWorkspace.startsWith('path:')}
                choices={workspaceOptions.map((option) => ({ value: String(option.value), label: String(option.label), hint: option.hint }))}
                onChange={(value) => { set('homeWorkspace', value); }}
              />
            </div>
          </SettingField>
          <SettingField label={t('persona.delivery')} layout="row" help={t('persona.deliveryHint')}>
            <SettingsSegmented<PersonaDeliveryMode>
              ariaLabel={t('persona.delivery')}
              dataAttr="data-persona-delivery"
              value={draft.delivery}
              choices={[
                { value: 'reply', label: t('persona.deliveryReply') },
                { value: 'message', label: t('persona.deliveryMessage') },
              ]}
              onChange={(value) => { set('delivery', value); }}
            />
          </SettingField>
        </div>
      </SectionCard>

      {/* ③ 可见性 — its own resource, so it saves itself. */}
      {snapshot !== undefined && summary !== undefined ? (
        <SectionCard id="persona-card-visibility" title={t('persona.section.visibility')}>
          <PersonaVisibilitySection persona={summary} />
        </SectionCard>
      ) : null}

      {/* ④ 记忆 */}
      <SectionCard id="persona-card-memory" title={t('persona.section.memory')}>
        <SettingField label={t('persona.memory')} layout="row" help={t('persona.memoryHint')}>
          <div className="flex items-center gap-4">
            {DEFAULT_MEMORY_SHARED.map((scope) => (
              <Toggle
                key={scope}
                id={fieldId(`memory-${scope}`)}
                label={t(`memory.scopeTag.${scope}`)}
                checked={draft.memoryShared.includes(scope)}
                onChange={(enabled) => { set('memoryShared', toggleScope(draft.memoryShared, scope, enabled)); }}
              />
            ))}
          </div>
        </SettingField>
        {snapshot !== undefined ? (
          <div className="pt-3">
            <button
              type="button"
              data-persona-memory-open
              onClick={() => { navigate(`/memory?persona=${encodeURIComponent(snapshot.definition.id)}`); }}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              {t('persona.memoryOpen')}
              <Icon name="arrowRight" size={12} />
            </button>
          </div>
        ) : null}
      </SectionCard>

      {/* ⑤ 任务与连接 — reads and writes the persona's own server state. */}
      {snapshot !== undefined && summary !== undefined ? (
        <SectionCard id="persona-card-tasks" title={t('persona.section.tasks')}>
          <PersonaTasksSection persona={summary} />
        </SectionCard>
      ) : null}

      <div className="space-y-2 border-t border-hairline pt-4">
        {!creating ? (
          <p data-persona-frozen-notice className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-soft">
            <Icon name="clock" size={14} className="mt-0.5 shrink-0 text-ink-faint" />
            {t('persona.frozenNotice')}
          </p>
        ) : null}
        {conflict ? (
          <div role="alert" data-persona-conflict className="flex flex-wrap items-center gap-2 py-1 text-[12px] text-amber-ink">
            {t('persona.conflict')}
            {/* Reload is the reader saying "take theirs": the form follows the
                fact that comes back, and the draft goes with it. */}
            <button
              type="button"
              onClick={() => {
                setConflict(false);
                void onReload().then((fresh) => {
                  if (fresh !== undefined) adopt(draftFromDefinition(fresh.definition, workspaces), fresh.revision);
                });
              }}
              className="font-medium underline underline-offset-2"
            >
              {t('persona.reload')}
            </button>
          </div>
        ) : null}
        {saveFailure !== null ? (
          <div data-persona-save-failure>
            <FeedbackLine feedback={{ tone: 'error', text: saveFailure }} />
          </div>
        ) : null}
        <SettingsDraftFooter
          id={`persona-${snapshot?.definition.id ?? 'new'}`}
          dirty={dirty || creating}
          persistent={creating}
          saving={saveMutation.isPending}
          saved={saved}
          saveLabel={creating ? t('persona.create') : t('persona.save')}
          onSave={save}
          onDiscard={() => {
            if (creating) { onClosed(); return; }
            touched.current = false;
            setDraft(baseline);
            setAttempted(false);
            setSaveFailure(null);
            setConflict(false);
          }}
        />
      </div>
    </form>
  );
}

function toggleScope(
  current: readonly PersonaMemoryScope[],
  scope: PersonaMemoryScope,
  enabled: boolean,
): readonly PersonaMemoryScope[] {
  return DEFAULT_MEMORY_SHARED.filter((candidate) => (candidate === scope ? enabled : current.includes(candidate)));
}

type PersonaAction = 'start' | 'duplicate' | 'export-png' | 'export-json' | 'export-charx' | 'archive' | 'delete';

function PersonaActions({ snapshot, dirty, onChanged, onClosed, onStartChat }: {
  readonly snapshot: PersonaSnapshot;
  readonly dirty: boolean;
  readonly onChanged: () => void;
  readonly onClosed: () => void;
  readonly onStartChat: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const host = useHost();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | { readonly kind: 'archive'; readonly archived: boolean } | { readonly kind: 'delete' }>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { id, name } = snapshot.definition;
  const listed = queryClient.getQueryData<readonly PersonaSummary[]>(['personas', { includeArchived: true }]);
  const archived = listed?.find((item) => item.id === id)?.archived === true;

  useEffect(() => {
    if (!open) return;
    const unregister = registerOverlay('persona-actions');
    const onDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { unregister(); document.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [open]);

  // The confirmation names what goes with it, from the server's own effects:
  // archive pauses her scheduled tasks (unarchiving does not restart them);
  // delete removes her tasks, her rooms' seats and her own conversations, and
  // leaves ordinary conversation history and project directories alone.
  const fail = (error: unknown) => { pushToast({ tone: 'error', text: t('persona.actionFailed', { detail: errorText(locale, error) }) }); };
  const remove = useMutation({
    mutationFn: () => client.deletePersona(id, snapshot.revision),
    onSuccess: () => {
      setConfirm(null);
      pushToast({ tone: 'success', text: t('persona.deletedToast', { name }) });
      onChanged();
      onClosed();
    },
    onError: (error: unknown) => { setConfirm(null); fail(error); },
  });
  const setArchived = useMutation({
    mutationFn: (next: boolean) => client.archivePersona(id, next),
    onSuccess: (_result, next) => {
      setConfirm(null);
      pushToast({ tone: 'success', text: t(next ? 'persona.archivedToast' : 'persona.unarchivedToast', { name }) });
      onChanged();
    },
    onError: (error: unknown) => { setConfirm(null); fail(error); },
  });

  const run = async (action: PersonaAction) => {
    setOpen(false);
    try {
      if (action === 'start') { onStartChat(); return; }
      if (action === 'duplicate') {
        const copy = await client.duplicatePersona(id);
        pushToast({ tone: 'success', text: t('persona.duplicatedToast', { name: copy.definition.name }) });
        onChanged();
        return;
      }
      if (action === 'archive') { setConfirm({ kind: 'archive', archived }); return; }
      if (action === 'delete') { setConfirm({ kind: 'delete' }); return; }
      const format = action.slice('export-'.length) as 'png' | 'json' | 'charx';
      const file = await client.exportPersonaCard(id, format);
      const savedByHost = await host.saveBlob?.(file.blob, file.filename);
      if (savedByHost === false) return;
      if (host.saveBlob === undefined) downloadBlob(file.blob, file.filename);
      pushToast({ tone: 'success', text: t('persona.exportedToast', { file: file.filename }) });
    } catch (error) {
      fail(error);
    }
  };

  const items: readonly { key: PersonaAction; label: string; danger?: boolean; separatorBefore?: boolean }[] = [
    { key: 'start', label: t('persona.startChat') },
    { key: 'duplicate', label: t('persona.duplicate'), separatorBefore: true },
    { key: 'export-png', label: t('persona.exportAs', { format: 'PNG' }) },
    { key: 'export-json', label: t('persona.exportAs', { format: 'JSON' }) },
    { key: 'export-charx', label: t('persona.exportAs', { format: 'CHARX' }) },
    { key: 'archive', label: t(archived ? 'persona.unarchive' : 'persona.archive'), separatorBefore: true },
    { key: 'delete', label: t('persona.delete'), danger: true },
  ];

  const archiving = confirm?.kind === 'archive' ? confirm : null;
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        data-persona-actions
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('persona.more')}
        title={t('persona.more')}
        onClick={() => { setOpen((value) => !value); }}
        className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <Icon name="more" size={16} />
      </button>
      {open ? (
        <div role="menu" data-persona-actions-menu className={`anim-enter absolute right-0 top-full z-30 mt-1 w-52 p-1 ${POPOVER_SURFACE_CLASS}`}>
          {items.map((item) => (
            <div key={item.key}>
              {item.separatorBefore === true ? <div role="separator" className="my-1 h-px bg-hairline" /> : null}
              <button
                type="button"
                role="menuitem"
                data-persona-action={item.key}
                disabled={item.key === 'start' && dirty}
                onClick={() => { void run(item.key); }}
                className={`flex w-full items-center rounded-md px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-ink/[0.05] focus-visible:bg-ink/[0.05] focus-visible:outline-none disabled:opacity-50 pointer-coarse:min-h-11 ${item.danger === true ? 'text-danger' : 'text-ink'}`}
              >
                {item.label}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <ConfirmDialog
        open={archiving !== null}
        title={archiving?.archived === true ? t('persona.archiveTitle', { name }) : t('persona.unarchiveTitle', { name })}
        consequences={archiving?.archived === true
          ? [t('persona.archiveCron'), t('persona.archiveNoRestart'), t('persona.archiveKeeps')]
          : [t('persona.archiveNoRestart'), t('persona.archiveKeeps')]}
        confirmLabel={archiving?.archived === true ? t('persona.archive') : t('persona.unarchive')}
        tone="default"
        busy={setArchived.isPending}
        overlayId="persona-archive-confirm"
        onCancel={() => { setConfirm(null); }}
        onConfirm={() => { setArchived.mutate(archiving?.archived !== true); }}
      />
      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        title={t('persona.deleteTitle', { name })}
        consequences={[
          t('persona.deleteCron'),
          t('persona.deleteRooms'),
          t('persona.deleteMemory'),
          t('persona.deleteKeeps'),
          t('persona.deleteIrreversible'),
        ]}
        confirmLabel={t('persona.delete')}
        tone="danger"
        busy={remove.isPending}
        overlayId="persona-delete-confirm"
        onCancel={() => { setConfirm(null); }}
        onConfirm={() => { remove.mutate(); }}
      />
    </div>
  );
}
