import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  RequestIdentityCatalog,
  RequestIdentityHeader,
  RequestIdentityParam,
  RequestIdentityPresetWire,
  RequestIdentityPreview,
  RequestIdentityProfile,
  RequestIdentityProfileDraft,
  RequestIdentityTrack,
  RequestIdentityTrackId,
  RequestIdentityUpdateSource,
} from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, SaveStatus, Toggle, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { DANGER_GHOST_BUTTON, INPUT, SECONDARY_BUTTON } from '../ui';
import { AdvancedDetails, SettingField } from './fields';
import { GlobalRequestIdentityCard } from './ModelsSection';
import { SectionCard } from './SectionCard';
import { groupItems, ListEmpty, ListGroup, ListToolbar, useListView } from './list';
import {
  CommitInput,
  FORM_LABEL,
  SettingsDetailLayout,
  SettingsDraftFooter,
  SettingsSegmented,
  SettingsSelect,
} from './SettingsPrimitives';
import { useInstantSave } from './useInstantSave';
import { useSavedTick } from './useSavedTick';

export const REQUEST_IDENTITY_QUERY_KEY = ['request-identity'] as const;

const PROTOCOL_LABELS = ['openai_responses', 'anthropic', 'openai'] as const;
type PreviewProtocol = (typeof PROTOCOL_LABELS)[number];

const PRESETS: readonly RequestIdentityPresetWire[] = [
  'codex_compatible', 'claude_code_compatible', 'grok_build_compatible', 'opencode_compatible', 'kimi_code',
];

const TRACKS: readonly RequestIdentityTrackId[] = ['codex_cli', 'claude_code', 'grok_cli', 'opencode_cli'];

const PREVIEW_MODEL = 'example-model';

const MONO_VALUE = 'min-w-0 break-all font-mono text-[12px] leading-5 text-ink';

function useIdentityCatalog() {
  const { client } = useConnection();
  return useQuery({ queryKey: REQUEST_IDENTITY_QUERY_KEY, queryFn: () => client.requestIdentity.get(), staleTime: 10_000 });
}

/** Custom identities for the layer pickers on the provider and model editors; empty until the catalog loads. */
export function useCustomIdentityChoices(): readonly { id: string; label: string }[] {
  const { client } = useConnection();
  const query = useQuery({
    queryKey: REQUEST_IDENTITY_QUERY_KEY,
    queryFn: () => client.requestIdentity.get(),
    staleTime: 30_000,
  });
  return useMemo(
    () => (query.data?.profiles ?? []).filter((profile) => !profile.builtin).map(({ id, label }) => ({ id, label })),
    [query.data],
  );
}

function draftOf(profile: RequestIdentityProfile): RequestIdentityProfileDraft {
  return {
    label: profile.label,
    description: profile.description,
    base_preset: profile.base_preset,
    track: profile.track,
    version: profile.version,
    user_agent: profile.user_agent,
    headers: profile.headers.map((header) => ({ ...header })),
    params: profile.params.map((param) => ({ ...param })),
  };
}

function defaultProtocol(preset: RequestIdentityPresetWire): PreviewProtocol {
  return preset === 'claude_code_compatible' ? 'anthropic' : 'openai_responses';
}

function overridesText(overrides: RequestIdentityProfileDraft['overrides']): string {
  return overrides === undefined ? '' : JSON.stringify(overrides, null, 2);
}

/** Empty text clears the overrides; anything else must be a JSON object (the server checks its shape). */
function parseOverrides(text: string): RequestIdentityProfileDraft['overrides'] {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value: unknown = JSON.parse(trimmed);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('overrides must be an object');
  return value as RequestIdentityProfileDraft['overrides'];
}

/** The draft the preview renders; overrides that do not parse yet are left out until they do. */
function previewDraft(draft: RequestIdentityProfileDraft, overridesJson: string): RequestIdentityProfileDraft {
  try {
    return { ...draft, overrides: parseOverrides(overridesJson) };
  } catch {
    return draft;
  }
}

function when(locale: string, at: string): string {
  return new Date(at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

type Translate = ReturnType<typeof useI18n>['t'];

/** `fixed`, `kiki`, or `track:<origin>` from the preview, in the page's words. */
function versionOriginText(t: Translate, origin: string, track: RequestIdentityTrackId | null): string {
  if (origin === 'fixed') return t('st.identity.versionMode.fixed');
  if (origin === 'kiki') return t('st.identity.versionMode.kiki');
  const source = origin.startsWith('track:') ? origin.slice('track:'.length) : origin;
  const name = track === null ? '' : t(`st.identity.track.${track}`);
  return t('st.identity.versionFromTrack', { track: name, origin: t(`st.identity.origin.${source}` as I18nKey) });
}

/** Headers a built-in renders: its own templates with any applied track replacements on top. */
function builtinHeaders(profile: RequestIdentityProfile, track: RequestIdentityTrack | undefined): RequestIdentityHeader[] {
  const merged = profile.headers.map((header) => ({ ...header }));
  if (profile.version.mode !== 'track') return merged;
  for (const header of track?.current.headers ?? []) {
    const index = merged.findIndex((candidate) => candidate.name.toLowerCase() === header.name.toLowerCase());
    if (index === -1) merged.push({ ...header });
    else merged[index] = { ...header };
  }
  return merged;
}

/**
 * Settings → Request identity. One place for which client each request
 * presents itself as: the identities (built-in, read-only; custom, fully
 * editable), the exact values each sends, where client versions come from,
 * where each identity is in use, and what recent requests actually sent.
 */
export function IdentitySection() {
  const { t } = useI18n();
  const query = useIdentityCatalog();
  if (query.isError) {
    return <div className="space-y-2"><p className="text-[13px] text-ink">{t('st.identity.loadFailed')}</p><InlineError error={query.error} /></div>;
  }
  const catalog = query.data;
  return (
    <div className="space-y-6">
      <ProfilesCard catalog={catalog} />
      <TracksCard catalog={catalog} />
      <UsageCard catalog={catalog} />
      <GlobalRequestIdentityCard />
      <RecentCard catalog={catalog} />
    </div>
  );
}

function ProfilesCard({ catalog }: { catalog: RequestIdentityCatalog | undefined }) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const profiles = catalog?.profiles ?? [];
  const [selectedId, setSelectedId] = useState<string>('codex');
  const [narrowPane, setNarrowPane] = useState<'list' | 'detail'>('list');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const selected = profiles.find((profile) => profile.id === selectedId) ?? profiles[0];

  const duplicate = async (from: RequestIdentityProfile) => {
    setFeedback(null);
    try {
      const next = await client.requestIdentity.duplicateProfile(from.id, t('st.identity.copyLabel', { label: from.label }));
      queryClient.setQueryData(REQUEST_IDENTITY_QUERY_KEY, next);
      const created = next.profiles.filter((profile) => !profile.builtin).at(-1);
      if (created !== undefined) setSelectedId(created.id);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  const row = (profile: RequestIdentityProfile) => (
    <li key={profile.id}>
      <button type="button" data-identity-row={profile.id}
        aria-current={profile.id === selected?.id ? 'true' : undefined}
        onClick={() => { setSelectedId(profile.id); setNarrowPane('detail'); }}
        className="row-interactive flex w-full min-w-0 flex-col items-start gap-0.5 py-1.5 pl-3 pr-2 text-left">
        <span className="max-w-full truncate text-[13px] text-ink">{profile.label}</span>
        {view.density === 'compact' ? null : (
          <span className="max-w-full truncate font-mono text-[11px] text-ink-faint">{profile.id}</span>
        )}
      </button>
    </li>
  );

  const keyOf = (profile: RequestIdentityProfile) => profile.id;
  const textOf = (profile: RequestIdentityProfile) => [profile.label, profile.id];
  const view = useListView({ listId: 'identity-profiles', items: profiles, keyOf, textOf });
  const groups = useMemo(
    () => groupItems(profiles, view.visible, (profile) => [
      profile.builtin
        ? { key: 'builtin', label: t('st.identity.builtinGroup') }
        : { key: 'custom', label: t('st.identity.customGroup') },
    ], ['builtin', 'custom']),
    [profiles, view.visible, t],
  );

  const list = (
    <nav aria-label={t('st.identity.listTitle')} className="space-y-2">
      <ListToolbar view={view} total={profiles.length}
        searchLabel={t('st.identity.search')} searchPlaceholder={t('st.identity.searchPlaceholder')} />
      {profiles.length > 0 && view.visible.length === 0 ? (
        <ListEmpty kind="no-match" title={t('st.identity.noMatchTitle')}
          body={view.query.trim() !== '' ? t('st.identity.noMatches', { query: view.query.trim() }) : undefined}
          onClear={view.clear} />
      ) : (
        groups.map((group) => (
          <ListGroup key={group.key} groupKey={group.key} label={group.label} count={group.items.length} total={group.total}
            folded={view.isFolded(group.key)} onToggle={() => { view.toggleFold(group.key); }}>
            {group.key === 'custom' && group.items.length === 0 && !view.narrowed
              ? <p className="px-3 text-[12px] leading-snug text-ink-faint">{t('st.identity.customEmpty')}</p>
              : <ul className="space-y-0.5">{group.items.map(row)}</ul>}
          </ListGroup>
        ))
      )}
    </nav>
  );

  return (
    <SectionCard id="st-card-identity-profiles" title={t('st.identity.listTitle')}>
      {catalog === undefined ? <p className="text-[12px] text-ink-faint">{t('st.identity.loading')}</p> : (
        <SettingsDetailLayout narrowPane={narrowPane} list={list} detail={selected === undefined ? null : (
          <div className="space-y-4">
            <button type="button" data-identity-back className={`${SECONDARY_BUTTON} md:hidden`} onClick={() => { setNarrowPane('list'); }}>
              <span className="inline-flex items-center gap-1"><Icon name="arrowLeft" size={12} />{t('st.identity.listTitle')}</span>
            </button>
            {selected.builtin
              ? <BuiltinProfileDetail key={selected.id} profile={selected} catalog={catalog} onDuplicate={() => void duplicate(selected)} />
              : <CustomProfileEditor key={selected.id} profile={selected} catalog={catalog}
                  onDuplicate={() => void duplicate(selected)}
                  onDeleted={() => { setSelectedId(selected.duplicated_from ?? 'codex'); }} />}
            <FeedbackLine feedback={feedback} />
          </div>
        )} />
      )}
    </SectionCard>
  );
}

function trackOf(catalog: RequestIdentityCatalog, id: RequestIdentityTrackId | null): RequestIdentityTrack | undefined {
  return id === null ? undefined : catalog.tracks.find((track) => track.id === id);
}

function versionSummary(t: ReturnType<typeof useI18n>['t'], draft: RequestIdentityProfileDraft, catalog: RequestIdentityCatalog): string {
  if (draft.version.mode === 'fixed') return `${draft.version.value} · ${t('st.identity.versionMode.fixed')}`;
  if (draft.version.mode === 'kiki') return t('st.identity.versionMode.kiki');
  const track = trackOf(catalog, draft.track);
  return track === undefined ? '' : `${track.current.version} · ${t(`st.identity.track.${track.id}`)}`;
}

function BuiltinProfileDetail({ profile, catalog, onDuplicate }: {
  profile: RequestIdentityProfile;
  catalog: RequestIdentityCatalog;
  onDuplicate: () => void;
}) {
  const { t } = useI18n();
  const draft = draftOf(profile);
  const track = trackOf(catalog, profile.track);
  const userAgent = profile.version.mode === 'track' && track?.current.user_agent !== undefined ? track.current.user_agent : profile.user_agent;
  const headers = builtinHeaders(profile, track);
  return (
    <div className="space-y-4" data-identity-detail={profile.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium text-ink">{profile.label}</h3>
          <Hint>{t('st.identity.readOnly')}</Hint>
        </div>
        {profile.base_preset === 'none' ? null
          : <button type="button" className={SECONDARY_BUTTON} data-identity-duplicate onClick={onDuplicate}>{t('st.identity.duplicate')}</button>}
      </div>
      <dl className="grid grid-cols-[minmax(96px,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
        <dt className="text-ink-soft">{t('st.identity.baseLabel')}</dt>
        <dd className="text-ink">{t(`st.requestIdentity.option.${profile.base_preset}`)}</dd>
        <dt className="text-ink-soft">{t('st.identity.versionLabel')}</dt>
        <dd className="text-ink">{versionSummary(t, draft, catalog)}</dd>
        <dt className="text-ink-soft">{t('st.identity.userAgentLabel')}</dt>
        <dd className={userAgent === '' ? 'text-ink-faint' : MONO_VALUE}>{userAgent === '' ? t('st.identity.nativeUserAgent') : userAgent}</dd>
        {headers.length > 0 ? <>
          <dt className="text-ink-soft">{t('st.identity.headersLabel')}</dt>
          <dd className="space-y-0.5">{headers.map((header) => (
            <div key={header.name} className={MONO_VALUE}><span className="text-ink-soft">{header.name}:</span> {header.value}</div>
          ))}</dd>
        </> : null}
      </dl>
      <IdentityPreview profileId={profile.id} basePreset={profile.base_preset} track={profile.track} />
    </div>
  );
}

function CustomProfileEditor({ profile, catalog, onDuplicate, onDeleted }: {
  profile: RequestIdentityProfile;
  catalog: RequestIdentityCatalog;
  onDuplicate: () => void;
  onDeleted: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const baseline = useMemo(() => draftOf(profile), [profile]);
  const [draft, setDraft] = useState<RequestIdentityProfileDraft>(baseline);
  const [saving, setSaving] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, markSaved] = useSavedTick();
  const baselineOverrides = useMemo(() => overridesText(profile.overrides), [profile.overrides]);
  const [overridesJson, setOverridesJson] = useState(baselineOverrides);
  const [overridesIssue, setOverridesIssue] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || overridesJson !== baselineOverrides;
  useEffect(() => { if (!dirty) { setDraft(baseline); setOverridesJson(baselineOverrides); } }, [baseline, baselineOverrides, dirty]);
  const set = (patch: Partial<RequestIdentityProfileDraft>) => { setDraft((current) => ({ ...current, ...patch })); setIssue(null); };
  const track = trackOf(catalog, draft.track);

  const save = async () => {
    let overrides: RequestIdentityProfileDraft['overrides'];
    try {
      overrides = parseOverrides(overridesJson);
    } catch {
      setOverridesIssue(t('st.identity.overridesInvalid'));
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const next = await client.requestIdentity.updateProfile(profile.id, { ...draft, overrides });
      queryClient.setQueryData(REQUEST_IDENTITY_QUERY_KEY, next);
      markSaved();
    } catch (error) {
      setIssue(errorText(locale, error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      const next = await client.requestIdentity.deleteProfile(profile.id);
      queryClient.setQueryData(REQUEST_IDENTITY_QUERY_KEY, next);
      setConfirmDelete(false);
      onDeleted();
    } catch (error) {
      setConfirmDelete(false);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setDeleting(false);
    }
  };

  const versionMode = draft.version.mode;
  return (
    <div className="space-y-4" data-identity-detail={profile.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium text-ink">{profile.label}</h3>
          <p className="font-mono text-[11px] text-ink-faint">{profile.id}{profile.duplicated_from === undefined ? '' : ` ← ${profile.duplicated_from}`}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={SECONDARY_BUTTON} onClick={onDuplicate}>{t('st.identity.duplicate')}</button>
          <button type="button" className={DANGER_GHOST_BUTTON} onClick={() => { setConfirmDelete(true); }}>{t('st.identity.delete')}</button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className={FORM_LABEL}>{t('st.identity.nameLabel')}
          <input className={`${INPUT} mt-1`} value={draft.label} maxLength={64} data-identity-label
            onChange={(event) => { set({ label: event.target.value }); }} />
        </label>
        <div>
          <span className={FORM_LABEL}>{t('st.identity.baseLabel')}</span>
          <div className="mt-1">
            <SettingsSelect<RequestIdentityPresetWire> variant="form" ariaLabel={t('st.identity.baseLabel')}
              value={draft.base_preset} dataAttr="data-identity-base"
              choices={PRESETS.map((preset) => ({ value: preset, label: t(`st.requestIdentity.option.${preset}`) }))}
              onChange={(base_preset) => { set({ base_preset }); }} />
          </div>
        </div>
      </div>
      <Hint>{t('st.identity.baseHelp')}</Hint>

      <div className="space-y-1.5">
        <span className={FORM_LABEL} id={`identity-version-${profile.id}`}>{t('st.identity.versionLabel')}</span>
        <div className="flex flex-wrap items-center gap-2">
          <SettingsSegmented<'track' | 'fixed' | 'kiki'> ariaLabelledBy={`identity-version-${profile.id}`} dataAttr="data-identity-version-mode"
            value={versionMode}
            choices={[
              { value: 'track', label: t('st.identity.versionMode.track') },
              { value: 'fixed', label: t('st.identity.versionMode.fixed') },
              { value: 'kiki', label: t('st.identity.versionMode.kiki') },
            ]}
            onChange={(mode) => {
              if (mode === 'fixed') set({ version: { mode, value: track?.current.version ?? '1.0.0' } });
              else if (mode === 'track') set({ version: { mode }, track: draft.track ?? 'codex_cli' });
              else set({ version: { mode } });
            }} />
          {versionMode === 'track' ? (
            <SettingsSelect<RequestIdentityTrackId> ariaLabel={t('st.identity.trackLabel')} value={draft.track ?? 'codex_cli'}
              choices={TRACKS.map((id) => ({ value: id, label: `${t(`st.identity.track.${id}`)} · ${trackOf(catalog, id)?.current.version ?? ''}` }))}
              onChange={(next) => { set({ track: next }); }} />
          ) : null}
          {draft.version.mode === 'fixed' ? (
            <input className={`${INPUT} h-8 w-36 py-0 font-mono`} aria-label={t('st.identity.versionFixedAria')} data-identity-version
              value={draft.version.value} spellCheck={false}
              onChange={(event) => { set({ version: { mode: 'fixed', value: event.target.value.trim() } }); }} />
          ) : null}
        </div>
        <Hint>{t('st.identity.versionHelp')}</Hint>
      </div>

      <label className={`${FORM_LABEL} block`}>{t('st.identity.userAgentLabel')}
        <input className={`${INPUT} mt-1 font-mono`} value={draft.user_agent} spellCheck={false} data-identity-user-agent
          onChange={(event) => { set({ user_agent: event.target.value }); }} />
      </label>
      <Hint>{t('st.identity.userAgentHelp')}</Hint>

      <PairList kind="header" rows={draft.headers}
        onChange={(headers) => { set({ headers: headers as RequestIdentityHeader[] }); }} />
      <PairList kind="param" rows={draft.params}
        onChange={(params) => { set({ params: params as RequestIdentityParam[] }); }} />

      <AdvancedDetails summary={t('st.identity.placeholders')}>
        <p className="mt-1 font-mono text-[11px] leading-5 text-ink-soft">{t('st.identity.placeholdersList')}</p>
      </AdvancedDetails>

      <AdvancedDetails summary={t('st.identity.overridesLabel')} open={baselineOverrides !== '' ? true : undefined}>
        <div className="mt-2 space-y-1.5">
          <Hint>{t('st.identity.overridesHelp')}</Hint>
          <textarea className={`${INPUT} min-h-[96px] font-mono ${overridesIssue === null ? '' : 'border-danger'}`}
            aria-label={t('st.identity.overridesLabel')} aria-invalid={overridesIssue !== null} spellCheck={false}
            data-identity-overrides value={overridesJson} placeholder={'{\n  "lineage": { "thread_identity": "none" }\n}'}
            onChange={(event) => { setOverridesJson(event.target.value); setOverridesIssue(null); setIssue(null); }} />
          {overridesIssue !== null ? <p role="alert" data-field-issue className="text-[12px] leading-4 text-danger">{overridesIssue}</p> : null}
        </div>
      </AdvancedDetails>

      {issue !== null ? <p role="alert" data-field-issue className="text-[12px] leading-4 text-danger">{issue}</p> : null}
      <SettingsDraftFooter id={`identity-${profile.id}`} dirty={dirty} saving={saving} saved={saved}
        saveDisabled={draft.label.trim() === ''}
        onSave={() => void save()}
        onDiscard={() => { setDraft(baseline); setOverridesJson(baselineOverrides); setIssue(null); setOverridesIssue(null); }} />
      <FeedbackLine feedback={feedback} />

      <IdentityPreview profileId={profile.id} basePreset={draft.base_preset} track={draft.track}
        draft={dirty ? previewDraft(draft, overridesJson) : undefined} />

      <ConfirmDialog open={confirmDelete} busy={deleting}
        title={t('st.identity.deleteTitle', { label: profile.label })}
        body={t('st.identity.deleteBody')}
        confirmLabel={t('st.identity.delete')}
        onConfirm={() => void remove()}
        onCancel={() => { setConfirmDelete(false); }} />
    </div>
  );
}

function PairList({ kind, rows, onChange }: {
  kind: 'header' | 'param';
  rows: readonly (RequestIdentityHeader | RequestIdentityParam)[];
  onChange: (rows: (RequestIdentityHeader | RequestIdentityParam)[]) => void;
}) {
  const { t } = useI18n();
  const label = t(kind === 'header' ? 'st.identity.headersLabel' : 'st.identity.paramsLabel');
  const update = (index: number, patch: Partial<RequestIdentityHeader>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return (
    <fieldset className="space-y-1.5" data-identity-pairs={kind}>
      <legend className={FORM_LABEL}>{label}</legend>
      {rows.length === 0 ? <p className="text-[12px] text-ink-faint">{t('st.identity.none')}</p> : (
        <div className="space-y-1.5">
          {rows.map((row, index) => (
            <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5">
              <input className={`${INPUT} font-mono`} value={row.name} spellCheck={false}
                aria-label={t(kind === 'header' ? 'st.identity.headerName' : 'st.identity.paramName')}
                onChange={(event) => { update(index, { name: event.target.value }); }} />
              <input className={`${INPUT} font-mono`} value={String(row.value)} spellCheck={false}
                aria-label={t(kind === 'header' ? 'st.identity.headerValue' : 'st.identity.paramValue')}
                placeholder={kind === 'header' ? t('st.identity.removedPlaceholder') : undefined}
                onChange={(event) => { update(index, { value: event.target.value }); }} />
              <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink"
                aria-label={t('st.identity.removeRow', { name: row.name || label })}
                onClick={() => { onChange(rows.filter((_, i) => i !== index)); }}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Hint>{t(kind === 'header' ? 'st.identity.headersHelp' : 'st.identity.paramsHelp')}</Hint>
        <button type="button" className={SECONDARY_BUTTON}
          onClick={() => { onChange([...rows, { name: '', value: '' }]); }}>
          <span className="inline-flex items-center gap-1"><Icon name="plus" size={12} />{t(kind === 'header' ? 'st.identity.addHeader' : 'st.identity.addParam')}</span>
        </button>
      </div>
    </fieldset>
  );
}

function IdentityPreview({ profileId, basePreset, track, draft }: {
  profileId: string;
  basePreset: RequestIdentityPresetWire;
  track: RequestIdentityTrackId | null;
  draft?: RequestIdentityProfileDraft;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const [protocol, setProtocol] = useState<PreviewProtocol>(defaultProtocol(basePreset));
  useEffect(() => { setProtocol(defaultProtocol(basePreset)); }, [basePreset]);
  const draftKey = draft === undefined ? null : JSON.stringify(draft);
  const [debouncedDraft, setDebouncedDraft] = useState(draftKey);
  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedDraft(draftKey); }, 300);
    return () => { clearTimeout(timer); };
  }, [draftKey]);
  const query = useQuery({
    queryKey: [...REQUEST_IDENTITY_QUERY_KEY, 'preview', profileId, protocol, debouncedDraft],
    queryFn: () => client.requestIdentity.preview(debouncedDraft === null
      ? { profile: profileId, protocol, model: PREVIEW_MODEL }
      : { draft: JSON.parse(debouncedDraft) as RequestIdentityProfileDraft, protocol, model: PREVIEW_MODEL }),
    placeholderData: (previous) => previous,
  });
  const preview: RequestIdentityPreview | undefined = query.data;
  const params = preview === undefined ? [] : Object.entries(preview.params);
  return (
    <section aria-labelledby={`identity-preview-${profileId}`} className="space-y-2 border-t border-hairline pt-4" data-identity-preview>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`identity-preview-${profileId}`} className="text-[13px] font-medium text-ink">{t('st.identity.previewTitle')}</h4>
        <SettingsSegmented<PreviewProtocol> ariaLabel={t('st.identity.previewProtocol')} value={protocol}
          dataAttr="data-identity-preview-protocol"
          choices={PROTOCOL_LABELS.map((value) => ({ value, label: t(`st.identity.protocol.${value}`) }))}
          onChange={setProtocol} />
      </div>
      {draft !== undefined ? <Hint>{t('st.identity.previewUnsaved')}</Hint> : null}
      {query.isError ? <InlineError error={query.error} /> : null}
      {preview === undefined ? <p className="text-[12px] text-ink-faint">{t('st.identity.previewLoading')}</p> : preview.error !== undefined ? (
        <p role="alert" data-preview-error className="text-[12px] leading-5 text-danger">{t('st.identity.previewUnsupported', { error: preview.error })}</p>
      ) : (
        <div className="space-y-2" aria-busy={query.isFetching}>
          {preview.headers.length === 0 && params.length === 0
            ? <p className="text-[12px] text-ink-faint">{t('st.identity.noHeaders')}</p>
            : (
              <table className="w-full table-fixed border-collapse text-left">
                <tbody>
                  {preview.headers.map((header) => (
                    <PreviewRow key={`h:${header.name}`} name={header.name} value={header.value} attr={{ 'data-preview-header': header.name }}
                      note={<>
                        {t(header.origin === 'profile' ? 'st.identity.fromProfile' : 'st.identity.fromLineage')}
                        {header.kind === 'per_request' ? <> · <span title={t('st.identity.perRequestHelp')}>{t('st.identity.perRequest')}</span></> : null}
                      </>} />
                  ))}
                  {params.length > 0 ? (
                    <tr><th scope="rowgroup" colSpan={2} className="pb-1 pt-3 text-left text-[12px] font-medium text-ink-soft">{t('st.identity.paramsLabel')}</th></tr>
                  ) : null}
                  {params.map(([name, value]) => (
                    <PreviewRow key={`p:${name}`} name={name} value={String(value)} attr={{ 'data-preview-param': name }} />
                  ))}
                </tbody>
              </table>
            )}
          {preview.suppressed_user_agent ? <Hint>{t('st.identity.suppressedUa')}</Hint> : null}
          <p className="text-[11px] text-ink-faint" data-preview-version>
            {t('st.identity.previewVersion', { version: preview.version, origin: versionOriginText(t, preview.version_origin, track), model: PREVIEW_MODEL })}
          </p>
        </div>
      )}
    </section>
  );
}

function PreviewRow({ name, value, note, attr }: {
  name: string;
  value: string;
  note?: React.ReactNode;
  attr: Record<string, string>;
}) {
  return (
    <tr className="border-t border-hairline/70 align-top first:border-t-0" {...attr}>
      <th scope="row" className="w-[36%] py-1.5 pr-3 font-mono text-[12px] font-normal leading-5 text-ink-soft">
        <span className="break-all">{name}</span>
      </th>
      <td className="py-1.5">
        <span className={`block select-all ${MONO_VALUE}`}>{value}</span>
        {note === undefined ? null : <span className="text-[11px] text-ink-faint">{note}</span>}
      </td>
    </tr>
  );
}

function TracksCard({ catalog }: { catalog: RequestIdentityCatalog | undefined }) {
  const { t } = useI18n();
  return (
    <SectionCard id="st-card-identity-tracks" title={t('st.identity.tracksTitle')}>
      <div className="mb-3"><Hint>{t('st.identity.tracksHint')}</Hint></div>
      {catalog === undefined ? null : (
        <div className="divide-y divide-hairline">
          {catalog.tracks.map((track) => <TrackRow key={track.id} track={track} />)}
        </div>
      )}
      {catalog === undefined ? null : <ManifestField url={catalog.manifest_url} />}
    </SectionCard>
  );
}

function TrackRow({ track }: { track: RequestIdentityTrack }) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const act = async (name: string, call: () => Promise<RequestIdentityCatalog>) => {
    setBusy(name);
    setFeedback(null);
    try {
      queryClient.setQueryData(REQUEST_IDENTITY_QUERY_KEY, await call());
      void queryClient.invalidateQueries({ queryKey: [...REQUEST_IDENTITY_QUERY_KEY, 'preview'] });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(null);
    }
  };
  const origin = (value: string) => t(`st.identity.origin.${value}` as I18nKey);
  const check = (source: RequestIdentityUpdateSource) => act(`check:${source}`, () => client.requestIdentity.checkTrack(track.id, source));
  const previous = track.history[0];
  const last = track.last_check;
  return (
    <div className="space-y-2 py-3 first:pt-0" data-identity-track={track.id}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <p className="text-[13px] text-ink">{t(`st.identity.track.${track.id}`)} <span className="font-mono text-[11px] text-ink-faint">{track.npm_package}</span></p>
          <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-[15px] tabular-nums text-ink" data-track-current>{track.current.version}</span>
            <span className="text-[12px] text-ink-faint">
              {t('st.identity.trackSourceLine', { origin: origin(track.current.origin), at: when(locale, track.current.at) })}
              {track.current.source_detail !== undefined && track.current.origin !== 'builtin' ? ` · ${track.current.source_detail}` : ''}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={SECONDARY_BUTTON} data-track-check="npm" disabled={busy !== null} onClick={() => void check('npm')}>
            {busy === 'check:npm' ? t('st.identity.checking') : t('st.identity.checkNpm')}
          </button>
          <button type="button" className={SECONDARY_BUTTON} data-track-check="local_cli" disabled={busy !== null} onClick={() => void check('local_cli')}>
            {busy === 'check:local_cli' ? t('st.identity.checking') : t('st.identity.checkLocal')}
          </button>
          <Toggle label={t('st.identity.pin')} checked={track.pinned} disabled={busy !== null}
            onChange={(pinned) => void act('pin', () => client.requestIdentity.pinTrack(track.id, pinned))} />
        </div>
      </div>
      {track.candidate !== null ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-attention-soft/60 px-3 py-2" data-track-candidate role="status">
          <span className="mr-auto min-w-0 text-[13px] text-ink">
            <span className="font-medium text-attention">{t('st.identity.candidate', { version: track.candidate.version, origin: origin(track.candidate.origin) })}</span>
            <span className="ml-2 text-[12px] text-ink-faint">{when(locale, track.candidate.at)}{track.candidate.source_detail === undefined ? '' : ` · ${track.candidate.source_detail}`}</span>
            {track.candidate.user_agent !== undefined ? <span className={`block ${MONO_VALUE}`}>User-Agent: {track.candidate.user_agent}</span> : null}
            {(track.candidate.headers ?? []).map((header) => <span key={header.name} className={`block ${MONO_VALUE}`}>{header.name}: {header.value}</span>)}
          </span>
          <button type="button" className={SECONDARY_BUTTON} data-track-apply disabled={busy !== null || track.pinned}
            onClick={() => void act('apply', () => client.requestIdentity.applyTrack(track.id, track.candidate!.version))}>
            {t('st.identity.apply', { version: track.candidate.version })}
          </button>
          <button type="button" className={SECONDARY_BUTTON} disabled={busy !== null}
            onClick={() => void act('dismiss', () => client.requestIdentity.trackAction(track.id, 'dismiss'))}>
            {t('st.identity.dismiss')}
          </button>
        </div>
      ) : null}
      {last !== null && track.candidate === null ? (
        <p className={`text-[12px] ${last.ok ? 'text-ink-faint' : 'text-danger'}`} role={last.ok ? undefined : 'alert'}>
          {last.ok
            ? t('st.identity.lastCheckOk', { at: when(locale, last.at), version: last.version ?? track.current.version })
            : t('st.identity.lastCheckFailed', { at: when(locale, last.at), error: last.error ?? '' })}
        </p>
      ) : null}
      {track.pinned ? <Hint>{t('st.identity.pinnedNote')}</Hint> : null}
      {previous === undefined && track.current.origin === 'builtin' ? null : <div className="flex flex-wrap items-center gap-2">
        {previous !== undefined ? (
          <button type="button" className={SECONDARY_BUTTON} disabled={busy !== null || track.pinned} data-track-rollback
            onClick={() => void act('rollback', () => client.requestIdentity.trackAction(track.id, 'rollback'))}>
            {t('st.identity.rollback', { version: previous.version })}
          </button>
        ) : null}
        {track.current.origin !== 'builtin' ? (
          <button type="button" className={SECONDARY_BUTTON} disabled={busy !== null || track.pinned} data-track-reset
            onClick={() => void act('reset', () => client.requestIdentity.trackAction(track.id, 'reset'))}>
            {t('st.identity.reset')}
          </button>
        ) : null}
        {track.history.length > 0 ? (
          <AdvancedDetails summary={t('st.identity.history')}>
            <ul className="space-y-0.5">
              {track.history.map((entry, index) => (
                <li key={`${entry.version}-${String(index)}`} className="font-mono text-[11px]">
                  {entry.version} <span className="font-sans text-ink-faint">· {origin(entry.origin)} · {when(locale, entry.at)}{entry.source_detail !== undefined && entry.origin !== 'builtin' ? ` · ${entry.source_detail}` : ''}</span>
                </li>
              ))}
            </ul>
          </AdvancedDetails>
        ) : null}
      </div>}
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

function ManifestField({ url }: { url: string | null }) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const save = useInstantSave();
  const [checkFeedback, setCheckFeedback] = useState<Feedback>(null);
  const [checking, setChecking] = useState(false);
  const checkAll = async () => {
    setChecking(true);
    setCheckFeedback(null);
    try {
      let latest: RequestIdentityCatalog | undefined;
      for (const track of TRACKS) latest = await client.requestIdentity.checkTrack(track, 'manifest');
      if (latest !== undefined) queryClient.setQueryData(REQUEST_IDENTITY_QUERY_KEY, latest);
    } catch (error) {
      setCheckFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="mt-4 border-t border-hairline pt-4">
      <SettingField label={t('st.identity.manifestLabel')} help={t('st.identity.manifestHelp')} layout="stack">
        <div className="flex flex-wrap items-start gap-2">
          <CommitInput value={url ?? ''} className="w-[min(100%,28rem)] font-mono" ariaLabel={t('st.identity.manifestLabel')}
            placeholder="https://example.com/request-identity.json"
            validate={(text) => (text === '' || text.startsWith('https://') ? null : t('st.identity.manifestHttps'))}
            onCommit={(text) => void save.run(async () => {
              queryClient.setQueryData(REQUEST_IDENTITY_QUERY_KEY, await client.requestIdentity.setManifestUrl(text === '' ? null : text));
            })} />
          <SaveStatus saving={save.saving} saved={save.saved} />
          <button type="button" className={SECONDARY_BUTTON} disabled={url === null || checking} onClick={() => void checkAll()}>
            {checking ? t('st.identity.checking') : t('st.identity.checkManifest')}
          </button>
        </div>
      </SettingField>
      <FeedbackLine feedback={save.error} />
      <FeedbackLine feedback={checkFeedback} />
    </div>
  );
}

function UsageCard({ catalog }: { catalog: RequestIdentityCatalog | undefined }) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const labelOf = (id: string | null) => catalog?.profiles.find((profile) => profile.id === id)?.label ?? id ?? '—';
  const authored = (row: RequestIdentityCatalog['usage'][number]) => {
    if (row.authored === undefined) return t('st.identity.usageInherit');
    if (row.authored.profile !== undefined) return labelOf(row.authored.profile);
    if (row.authored.preset !== undefined) return t(`st.requestIdentity.option.${row.authored.preset}`);
    return t('st.requestIdentity.option.custom_overrides');
  };
  const rows = catalog?.usage ?? [];
  return (
    <SectionCard id="st-card-identity-usage" title={t('st.identity.usageTitle')}>
      {rows.length === 0 ? null : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] table-fixed border-collapse text-left text-[13px]">
            <colgroup><col className="w-[34%]" /><col className="w-[30%]" /><col /></colgroup>
            <thead>
              <tr className="text-[12px] text-ink-soft">
                <th scope="col" className="pb-1.5 pr-4 font-medium">{t('st.identity.usageLayer')}</th>
                <th scope="col" className="pb-1.5 pr-4 font-medium">{t('st.identity.usageSetting')}</th>
                <th scope="col" className="pb-1.5 font-medium">{t('st.identity.usageEffective')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.scope}:${row.provider_id ?? ''}:${row.model_id ?? ''}`} className="border-t border-hairline align-top" data-identity-usage={row.scope}>
                  <td className="py-1.5 pr-4">
                    <span className={row.scope === 'model' ? 'block pl-4 text-ink' : 'block text-ink'}>
                      {row.scope === 'global' ? t('st.identity.usageGlobal') : row.label}
                    </span>
                    {row.scope === 'model' && row.provider_id !== undefined
                      ? <span className="block truncate pl-4 font-mono text-[11px] text-ink-faint" title={row.provider_id}>{row.provider_id}</span> : null}
                  </td>
                  <td className={`py-1.5 pr-4 ${row.authored === undefined ? 'text-ink-faint' : 'text-ink'}`}>{authored(row)}</td>
                  <td className="py-1.5">
                    {row.error !== undefined
                      ? <span className="text-danger" role="alert">{row.error}</span>
                      : <span className="text-ink">{labelOf(row.effective_profile)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pt-3">
        <button type="button" className={SECONDARY_BUTTON} onClick={() => { navigate('/settings/ai?tab=providers'); }}>
          {t('st.identity.usageEdit')}
        </button>
      </div>
    </SectionCard>
  );
}

function RecentCard({ catalog }: { catalog: RequestIdentityCatalog | undefined }) {
  const { t, locale } = useI18n();
  const observations = catalog?.observations ?? [];
  const protocolLabel = (protocol: string) => (PROTOCOL_LABELS as readonly string[]).includes(protocol)
    ? t(`st.identity.protocol.${protocol as PreviewProtocol}`)
    : protocol;
  return (
    <SectionCard id="st-card-identity-recent" title={t('st.identity.recentTitle')} scope="readOnly">
      {observations.length === 0 ? <Hint>{t('st.identity.recentEmpty')}</Hint> : (
        <div className="space-y-3">
          {observations.slice(0, 5).map((entry, index) => (
            <details key={`${entry.at}-${String(index)}`} open={index === 0} data-identity-observation>
              <summary className="flex cursor-pointer select-none flex-wrap items-baseline gap-x-2 text-[13px] text-ink">
                <span className="font-medium">{catalog?.profiles.find((profile) => profile.id === entry.profile)?.label ?? entry.profile}</span>
                <span className="text-[12px] text-ink-faint">
                  {t('st.identity.recentMeta', { provider: entry.provider_id, model: entry.model, at: when(locale, entry.at) })} · {protocolLabel(entry.protocol)}
                </span>
              </summary>
              <table className="mt-1.5 w-full table-fixed border-collapse text-left">
                <tbody>
                  {entry.headers.map((header) => (
                    <PreviewRow key={`h:${header.name}`} name={header.name} value={header.value} attr={{ 'data-observed-header': header.name }} />
                  ))}
                  {Object.entries(entry.params).map(([name, value]) => (
                    <PreviewRow key={`p:${name}`} name={name} value={String(value)} attr={{ 'data-observed-param': name }} />
                  ))}
                  {entry.cache_key === undefined ? null : (
                    <PreviewRow name={t('st.identity.cacheKey')} value={entry.cache_key} attr={{ 'data-observed-param': 'cache_key' }} />
                  )}
                </tbody>
              </table>
              {entry.suppressed_user_agent ? <Hint>{t('st.identity.suppressedUa')}</Hint> : null}
            </details>
          ))}
          {observations.length > 5 ? <Hint>{t('st.identity.recentMore', { count: observations.length - 5 })}</Hint> : null}
        </div>
      )}
    </SectionCard>
  );
}
