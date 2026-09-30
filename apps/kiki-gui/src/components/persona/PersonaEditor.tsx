/**
 * Persona editor — one card, three short sections in the order a person
 * decides: who it is (face, name, title, job), how it runs (profile, model,
 * effort, memory), and what it says (greeting, description). The
 * description is the long field and gets the width; everything else is a
 * sentence.
 *
 * Save is one transaction guarded by the snapshot revision; a 40946 conflict
 * offers a reload instead of overwriting. Destructive and rare actions
 * (duplicate, export, archive, delete) live in one overflow menu.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PersonaSnapshot, PersonaSummary } from '@kiki/protocol';
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
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { SearchableSelect, POPOVER_SURFACE_CLASS, type SearchableSelectOption } from '../SearchableSelect';
import { FieldIssue, FORM_LABEL, FORM_SELECT_TRIGGER, SettingsDraftFooter } from '../settings/SettingsPrimitives';
import { useSavedTick } from '../settings/useSavedTick';
import { INPUT } from '../ui';
import { segmentClass } from '../WorkspaceScopeControl';
import { personaAvatarOf } from './PersonaAvatar';
import { PersonaAvatarControl } from './PersonaAvatarControl';
import {
  definitionFromDraft,
  draftFromDefinition,
  draftsEqual,
  EMPTY_PERSONA_DRAFT,
  personaIdFromName,
  validatePersonaDraft,
  type PersonaDraft,
} from './personaDraft';
import { downloadBlob, invalidatePersonas, personaQueryKey } from './usePersonas';

const TEXTAREA = `${INPUT} resize-y leading-relaxed`;

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
      <div className="rounded-xl border border-danger/30 bg-danger/5 p-4">
        <p className="text-[13px] font-medium text-danger">{t('persona.loadFailed')}</p>
        <p className="mt-1 font-mono text-[11px] text-danger">{errorText(locale, snapshotQuery.error)}</p>
        <button type="button" onClick={() => { void snapshotQuery.refetch(); }} className="mt-2 text-[12px] font-medium text-danger underline">{t('common.retry')}</button>
      </div>
    );
  }
  return (
    <PersonaForm
      key={snapshot?.revision ?? 'new'}
      snapshot={snapshot}
      summary={summary}
      takenIds={takenIds}
      onSaved={(next) => {
        queryClient.setQueryData(personaQueryKey(next.definition.id), next);
        void invalidatePersonas(queryClient);
        onSaved(next.definition.id);
      }}
      onReload={() => { void snapshotQuery.refetch(); }}
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
  readonly onReload: () => void;
  readonly onClosed: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const navigate = useGuardedNavigate();
  const formId = useId();
  const creating = snapshot === undefined;
  const initial = useMemo(() => (snapshot === undefined ? EMPTY_PERSONA_DRAFT : draftFromDefinition(snapshot.definition)), [snapshot]);
  const [draft, setDraft] = useState<PersonaDraft>(initial);
  // A new persona's id follows its name until the user edits the id itself.
  const [idTouched, setIdTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saved, pingSaved] = useSavedTick();
  const dirty = !draftsEqual(draft, initial);
  const issues = validatePersonaDraft(draft, { creating, takenIds });
  const shownIssues = attempted ? issues : { ...(issues.id === 'idTaken' ? { id: issues.id } : {}) };

  const set = <K extends keyof PersonaDraft>(key: K, value: PersonaDraft[K]) => {
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
      definition: definitionFromDraft(draft, snapshot?.definition),
      ...(snapshot !== undefined ? { revision: snapshot.revision } : {}),
      ...(snapshot?.examples !== undefined ? { examples: snapshot.examples } : {}),
    }),
    onSuccess: (next) => {
      pingSaved();
      pushToast({ tone: 'success', text: t(creating ? 'persona.createdToast' : 'persona.savedToast', { name: next.definition.name }) });
      onSaved(next);
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.code === PERSONA_REVISION_CONFLICT) { setConflict(true); return; }
      if (error instanceof ApiError && error.code === PERSONA_ALREADY_EXISTS) { setAttempted(true); return; }
      pushToast({ tone: 'error', text: t('persona.saveFailed', { detail: errorText(locale, error) }) });
    },
  });
  const save = () => {
    setAttempted(true);
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
          <PersonaActions snapshot={snapshot} dirty={dirty} onChanged={() => { void invalidatePersonas(queryClient, snapshot.definition.id); }} onClosed={onClosed} onStartChat={() => { navigate(`/new?persona=${encodeURIComponent(snapshot.definition.id)}`); }} />
        ) : null}
      </div>

      <Section title={t('persona.section.identity')}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Field id={fieldId('name')} label={t('persona.name')} issue={issueText('name')}>
            <input id={fieldId('name')} data-persona-field="name" value={draft.name} onChange={(event) => { set('name', event.target.value); }} aria-invalid={shownIssues.name !== undefined} aria-describedby={shownIssues.name !== undefined ? `${fieldId('name')}-issue` : undefined} className={INPUT} autoComplete="off" />
          </Field>
          <Field id={fieldId('title')} label={t('persona.label')}>
            <input id={fieldId('title')} data-persona-field="title" value={draft.title} placeholder={t('persona.titlePlaceholder')} onChange={(event) => { set('title', event.target.value); }} className={INPUT} autoComplete="off" />
          </Field>
          <Field id={fieldId('job')} label={t('persona.job')} wide>
            <input id={fieldId('job')} data-persona-field="job" value={draft.job} placeholder={t('persona.jobPlaceholder')} onChange={(event) => { set('job', event.target.value); }} className={INPUT} autoComplete="off" />
          </Field>
          {creating ? (
            <Field id={fieldId('id')} label={t('persona.id')} issue={issueText('id')} hint={t('persona.idHint')} wide>
              <input id={fieldId('id')} data-persona-field="id" value={draft.id} onChange={(event) => { setIdTouched(true); set('id', event.target.value.toLowerCase()); }} aria-invalid={shownIssues.id !== undefined} aria-describedby={`${fieldId('id')}-hint${shownIssues.id !== undefined ? ` ${fieldId('id')}-issue` : ''}`} className={`${INPUT} font-mono`} autoComplete="off" spellCheck={false} />
            </Field>
          ) : null}
        </div>
      </Section>

      <Section title={t('persona.section.work')}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-3">
          <Field id={fieldId('profile')} label={t('persona.profile')}>
            <SearchableSelect id={fieldId('profile')} options={profileOptions} value={draft.profile} onChange={(value) => { set('profile', value); }} ariaLabel={t('persona.profile')} buttonClassName={FORM_SELECT_TRIGGER} />
          </Field>
          <Field id={fieldId('model')} label={t('persona.model')}>
            <SearchableSelect id={fieldId('model')} options={modelOptions} value={draft.modelAlias} onChange={(value) => { setDraft((current) => ({ ...current, modelAlias: value, thinkingEffort: '' })); }} ariaLabel={t('persona.model')} buttonClassName={FORM_SELECT_TRIGGER} panelClassName={`anim-enter absolute right-0 z-40 mt-1 w-72 max-w-[calc(100vw-32px)] overflow-hidden ${POPOVER_SURFACE_CLASS}`} density="compact" />
          </Field>
          <Field id={fieldId('effort')} label={t('persona.effort')}>
            <SearchableSelect id={fieldId('effort')} options={effortOptions} value={draft.thinkingEffort} onChange={(value) => { set('thinkingEffort', value); }} ariaLabel={t('persona.effort')} buttonClassName={FORM_SELECT_TRIGGER} hideFilter disabled={effortOptions.length <= 1 && draft.thinkingEffort === ''} />
          </Field>
        </div>
        <p className="text-[12px] leading-relaxed text-ink-faint">{t('persona.profileHint')}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span id={fieldId('memory')} className={FORM_LABEL}>{t('persona.memory')}</span>
          <div role="group" aria-labelledby={fieldId('memory')} className="flex items-center gap-0.5 rounded-[9px] border border-hairline bg-paper p-0.5">
            {(['shared', 'own'] as const).map((mode) => (
              <button key={mode} type="button" data-persona-memory={mode} aria-pressed={draft.memory === mode} onClick={() => { set('memory', mode); }} className={segmentClass(draft.memory === mode, 'h-7 px-3 text-[13px] pointer-coarse:h-10')}>
                {t(mode === 'shared' ? 'persona.memoryShared' : 'persona.memoryOwnOnly')}
              </button>
            ))}
          </div>
          <p className="basis-full text-[12px] leading-relaxed text-ink-faint">{t('persona.memoryHint')}</p>
        </div>
      </Section>

      <Section title={t('persona.section.words')}>
        <Field id={fieldId('greeting')} label={t('persona.greeting')} hint={t('persona.greetingHint')}>
          <textarea id={fieldId('greeting')} data-persona-field="greeting" rows={2} value={draft.greeting} onChange={(event) => { set('greeting', event.target.value); }} aria-describedby={`${fieldId('greeting')}-hint`} className={TEXTAREA} />
        </Field>
        <Field id={fieldId('description')} label={t('persona.description')} hint={t('persona.descriptionHint')} issue={issueText('description')}>
          <textarea id={fieldId('description')} data-persona-field="description" rows={10} value={draft.description} onChange={(event) => { set('description', event.target.value); }} aria-invalid={shownIssues.description !== undefined} aria-describedby={`${fieldId('description')}-hint${shownIssues.description !== undefined ? ` ${fieldId('description')}-issue` : ''}`} className={`${TEXTAREA} min-h-[180px] font-mono text-[12.5px]`} spellCheck={false} />
        </Field>
      </Section>

      <div className="space-y-2 border-t border-hairline pt-4">
        {!creating ? (
          <p data-persona-frozen-notice className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-soft">
            <Icon name="clock" size={14} className="mt-0.5 shrink-0 text-ink-faint" />
            {t('persona.frozenNotice')}
          </p>
        ) : null}
        {conflict ? (
          <div role="alert" data-persona-conflict className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-rule/60 bg-amber-card px-3 py-2 text-[12px] text-amber-ink">
            {t('persona.conflict')}
            <button type="button" onClick={() => { setConflict(false); onReload(); }} className="font-medium underline underline-offset-2">{t('persona.reload')}</button>
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
          onDiscard={() => { if (creating) onClosed(); else { setDraft(initial); setAttempted(false); } }}
        />
      </div>
    </form>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="min-w-0 space-y-3">
      <h3 className="text-[11.5px] font-semibold tracking-[0.08em] text-section-ink uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Field({ id, label, hint, issue = null, wide = false, children }: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly issue?: string | null;
  readonly wide?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <div className={`min-w-0 space-y-1.5 ${wide ? 'sm:col-span-full' : ''}`}>
      <label htmlFor={id} className={FORM_LABEL}>{label}</label>
      {children}
      {hint !== undefined ? <p id={`${id}-hint`} className="text-[12px] leading-relaxed text-ink-faint">{hint}</p> : null}
      <FieldIssue id={`${id}-issue`} text={issue} />
    </div>
  );
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
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  // The confirmation names what goes with it: every entry in the persona's
  // own namespaces (cross-project plus each workspace). Counted on open only.
  const memoryCount = useQuery({
    queryKey: ['persona-memory-count', id],
    enabled: confirmDelete,
    staleTime: 0,
    queryFn: async () => {
      const workspaces = (await client.listWorkspaces()).items;
      const lists = await Promise.all([
        client.listMemory({ scope: 'persona', personaId: id }, { include_inactive: true }),
        ...workspaces.map((workspace) => client.listMemory({ scope: 'persona_workspace', workspaceId: workspace.id, personaId: id }, { include_inactive: true })
          .catch(() => ({ items: [] }))),
      ]);
      return lists.reduce((sum, list) => sum + list.items.length, 0);
    },
  });
  const fail = (error: unknown) => { pushToast({ tone: 'error', text: t('persona.actionFailed', { detail: errorText(locale, error) }) }); };
  const remove = useMutation({
    mutationFn: () => client.deletePersona(id, snapshot.revision),
    onSuccess: () => {
      setConfirmDelete(false);
      pushToast({ tone: 'success', text: t('persona.deletedToast', { name }) });
      onChanged();
      onClosed();
    },
    onError: (error: unknown) => { setConfirmDelete(false); fail(error); },
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
      if (action === 'archive') {
        await client.archivePersona(id, !archived);
        pushToast({ tone: 'success', text: t(archived ? 'persona.unarchivedToast' : 'persona.archivedToast', { name }) });
        onChanged();
        return;
      }
      if (action === 'delete') { setConfirmDelete(true); return; }
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
        open={confirmDelete}
        title={t('persona.deleteTitle', { name })}
        consequences={[
          memoryCount.data === undefined ? t('persona.deleteMemoryUnknown') : t('persona.deleteConfirm', { count: memoryCount.data }),
          t('persona.deleteIrreversible'),
        ]}
        confirmLabel={t('persona.delete')}
        tone="danger"
        busy={remove.isPending}
        overlayId="persona-delete-confirm"
        onCancel={() => { setConfirmDelete(false); }}
        onConfirm={() => { remove.mutate(); }}
      />
    </div>
  );
}
