/**
 * Services & keys tab.
 *
 * The old page rendered every provider instance the engine knows as a form,
 * auto-opened whatever it judged "needs attention", and sorted the failures to
 * the top, so a user with one configured service met sixteen open forms and a
 * wall of red. This page inverts that:
 *
 *   - The list holds the services the user actually configured. With one
 *     service set up, that is one compact row.
 *   - Two ways to add: "Add service" browses the real instances the server
 *     reports, while "new instance" builds a second instance of one service with
 *     its own id, slot and variable — the catalogue cannot express that, because
 *     the instance does not exist on the server yet.
 *   - An instance created in this draft is listed and editable before the server
 *     has ever seen it. Its status says "not saved yet" rather than borrowing a
 *     readiness or a credential state the server never reported.
 *   - Selecting a row opens the single editing surface (`NbSearchServiceEditor`)
 *     with address, key variable, keys, key order and on-demand key status.
 *
 * Side by side from `md`; below that one pane at a time, so a 390-wide screen
 * goes list → detail → back.
 */

import { useCallback, useMemo, useState } from 'react';
import type { NbSearchCapabilities, NbSearchKeyUsageView, NbSearchManagedCredentialView } from '@kiki/protocol';
import type { NbSearchDraft, NbSearchProviderDraft } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { Hint } from '../../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SettingsDetailLayout } from '../SettingsPrimitives';
import { SectionCard } from '../SectionCard';import { ListEmpty, ListToolbar, useListView } from '../list';
import { NbSearchServiceEditor } from './NbSearchServiceEditor';
import { NbSearchInstanceEditor } from './NbSearchInstanceEditor';
import type { KeyDraft } from './NbSearchMultiKeyEditor';
import { providerLabelKey, serviceState, serviceStateKey, SERVICE_STATE_CLASS } from './types';

type ProviderInstance = NbSearchCapabilities['providers']['instances'][number];
type ReadCredential = (instanceId: string, reveal: boolean) => Promise<NbSearchManagedCredentialView>;
type ReadKeyUsage = (instanceId: string, refresh: boolean) => Promise<NbSearchKeyUsageView>;

interface DirectoryEntry {
  readonly instance: ProviderInstance;
  readonly added: boolean;
  readonly label: string;
}

/** One row: a service the server reports, or one this draft just created. */
interface ServiceEntry {
  readonly instance: ProviderInstance;
  /** True while the instance exists only in the draft. */
  readonly unsaved: boolean;
}

/**
 * A draft instance the server has not reported yet, shaped like a capability
 * instance so the list and the editor can treat it the same way. Nothing is
 * invented: availability is unknown (not ready), the key is not configured
 * (nothing has been stored), and the requirement comes from the real provider
 * descriptor.
 */
function projectDraftInstance(
  instanceId: string,
  draft: NbSearchProviderDraft,
  capabilities: NbSearchCapabilities,
): ProviderInstance {
  const providerId = draft.providerId ?? '';
  const descriptor = capabilities.providers.descriptors.find((entry) => entry.provider_id === providerId);
  return {
    id: instanceId,
    provider_id: providerId,
    enabled: draft.enabled,
    availability: 'unavailable',
    issues: [],
    credential: {
      requirement: descriptor?.activation.credential ?? 'required',
      configured: false,
      slot_id: draft.credentialSlotId ?? instanceId,
    },
    endpoint: {
      requirement: descriptor?.activation.endpoint ?? 'none',
      configured: draft.baseUrl.trim() !== '',
    },
  };
}

export function NbSearchProvidersTab({
  capabilities,
  configuredInstanceIds,
  draftProviders,
  credentialSlots,
  keyDrafts,
  nbSearchDraft,
  onUpdateProvider,
  onUpdateCredentialEnv,
  onKeyDraftChange,
  onAddService,
  onRemoveService,
  onDraftChange,
  readCredential,
  readKeyUsage,
  saving = false,
}: {
  capabilities: NbSearchCapabilities;
  /** Instances the server has a saved override for. */
  configuredInstanceIds: ReadonlySet<string>;
  draftProviders: Readonly<Record<string, NbSearchProviderDraft>>;
  credentialSlots: unknown;
  keyDrafts: Readonly<Record<string, KeyDraft>>;
  /** The whole nb_search draft, for the S2 surfaces that hand back a new one. */
  nbSearchDraft: NbSearchDraft;
  onUpdateProvider: (id: string, patch: Partial<NbSearchProviderDraft>) => void;
  onUpdateCredentialEnv: (instanceId: string, providerId: string, credentialEnv: string) => void;
  onKeyDraftChange: (instanceId: string, draft: KeyDraft) => void;
  onAddService: (instanceId: string) => void;
  onRemoveService: (instanceId: string) => void;
  onDraftChange: (next: NbSearchDraft) => void;
  readCredential: ReadCredential;
  /** One typed on-demand key-status read; only a click reaches it. */
  readKeyUsage: ReadKeyUsage;
  saving?: boolean;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [narrowPane, setNarrowPane] = useState<'list' | 'detail'>('list');
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [instanceDraftOpen, setInstanceDraftOpen] = useState(false);

  const descriptors = useMemo(
    () => new Map(capabilities.providers.descriptors.map((entry) => [entry.provider_id, entry])),
    [capabilities.providers.descriptors],
  );
  const labelOf = useCallback((providerId: string) => {
    const key = providerLabelKey(providerId);
    return key === undefined ? providerId : t(key);
  }, [t]);

  /**
   * Saved override, a draft the user just added, or an instance this draft
   * created before the server knew about it. Deleted drafts drop out.
   */
  const added = useMemo<readonly ServiceEntry[]>(() => {
    const reported = new Set(capabilities.providers.instances.map((instance) => instance.id));
    const entries: ServiceEntry[] = [];
    for (const instance of capabilities.providers.instances) {
      const draft = draftProviders[instance.id];
      if (draft?.isDeleted === true) continue;
      if (draft?.isNew === true || configuredInstanceIds.has(instance.id)) {
        entries.push({ instance, unsaved: false });
      }
    }
    for (const [instanceId, draft] of Object.entries(draftProviders)) {
      if (draft.isDeleted === true || draft.isNew !== true || reported.has(instanceId)) continue;
      entries.push({ instance: projectDraftInstance(instanceId, draft, capabilities), unsaved: true });
    }
    return entries;
  }, [capabilities, configuredInstanceIds, draftProviders]);

  const directory = useMemo<readonly DirectoryEntry[]>(
    () => capabilities.providers.instances.map((instance) => ({
      instance,
      added: added.some((entry) => entry.instance.id === instance.id),
      label: labelOf(instance.provider_id),
    })),
    [capabilities.providers.instances, added, labelOf],
  );

  const directoryView = useListView({
    listId: 'nb-search-service-directory',
    items: directory,
    keyOf: (entry) => entry.instance.id,
    textOf: (entry) => [entry.label, entry.instance.id, entry.instance.provider_id],
  });

  // The list pane swaps to the directory or the new-instance form while either
  // is open; the detail pane keeps showing the service being edited instead of
  // going blank.
  const selected = selectedId === null
    ? added[0]
    : added.find((entry) => entry.instance.id === selectedId);
  const detail = selected === undefined ? null : (
    <NbSearchServiceEditor
      key={selected.instance.id}
      instance={selected.instance}
      descriptor={descriptors.get(selected.instance.provider_id)}
      providerDraft={draftProviders[selected.instance.id]!}
      credentialEnv={credentialEnvOf(credentialSlots, draftProviders[selected.instance.id]!)}
      keyDraft={keyDrafts[selected.instance.id] ?? { mode: 'keep' }}
      saving={saving}
      unsaved={selected.unsaved}
      readCredential={readCredential}
      readKeyUsage={readKeyUsage}
      onProviderChange={(patch) => { onUpdateProvider(selected.instance.id, patch); }}
      onCredentialEnvChange={(env) => { onUpdateCredentialEnv(selected.instance.id, selected.instance.provider_id, env); }}
      onKeyDraftChange={(next) => { onKeyDraftChange(selected.instance.id, next); }}
      onRemove={() => { onRemoveService(selected.instance.id); setSelectedId(null); setNarrowPane('list'); }}
      onBack={() => { setNarrowPane('list'); }}
    />
  );

  const openService = (instanceId: string) => {
    setSelectedId(instanceId);
    setNarrowPane('detail');
  };

  const serviceRow = (entry: ServiceEntry) => {
    const { instance, unsaved } = entry;
    const draft = draftProviders[instance.id];
    const state = serviceState(instance, draft?.enabled ?? instance.enabled, { unsaved });
    return (
      <li key={instance.id}>
        <button
          type="button"
          data-nb-search-service-row={instance.id}
          data-nb-search-service-unsaved={unsaved ? 'true' : undefined}
          aria-current={instance.id === selectedId ? 'true' : undefined}
          onClick={() => { openService(instance.id); }}
          className="row-interactive flex w-full min-w-0 flex-col items-start gap-0.5 py-1.5 pl-3 pr-2 text-left"
        >
          <span className="flex w-full min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{labelOf(instance.provider_id)}</span>
            <span className={`shrink-0 text-[12px] ${SERVICE_STATE_CLASS[state]}`} data-nb-search-row-state={state}>
              {t(serviceStateKey(state))}
            </span>
          </span>
          <span className="max-w-full truncate font-mono text-[11px] text-ink-faint">{instance.id}</span>
        </button>
      </li>
    );
  };

  const directoryRow = (entry: DirectoryEntry) => {
    const { instance, added: alreadyAdded } = entry;
    const draft = draftProviders[instance.id];
    const state = serviceState(instance, draft?.enabled ?? instance.enabled);
    return (
      <li key={instance.id}>
        <button
          type="button"
          data-nb-search-directory-row={instance.id}
          aria-current={instance.id === selectedId ? 'true' : undefined}
          onClick={() => {
            setDirectoryOpen(false);
            if (!alreadyAdded) onAddService(instance.id);
            openService(instance.id);
          }}
          className="row-interactive flex w-full min-w-0 flex-col items-start gap-0.5 py-1.5 pl-3 pr-2 text-left"
        >
          <span className="flex w-full min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{entry.label}</span>
            <span className={`shrink-0 text-[12px] ${alreadyAdded ? SERVICE_STATE_CLASS[state] : 'text-ink-faint'}`}>
              {alreadyAdded
                ? t(serviceStateKey(state))
                : instance.credential.requirement === 'none'
                  ? t('st.nbSearch.services.keyless')
                  : t('st.nbSearch.services.needsKey')}
            </span>
          </span>
          <span className="flex w-full min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={instance.id}>
              {instance.id}
            </span>
            {alreadyAdded ? null : (
              <span className="shrink-0 text-[12px] font-medium text-ink-soft">
                {t('st.nbSearch.services.addOne')}
              </span>
            )}
          </span>
        </button>
      </li>
    );
  };

  const list = (
    <nav aria-label={t('st.nbSearch.services.listTitle')} className="space-y-2" data-nb-search-services>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-ink-soft">{t('st.nbSearch.services.listTitle')}</p>
        {/* With nothing configured the empty state owns the single action, so
            the header does not offer a second way to do the same thing. */}
        {added.length === 0 && !directoryOpen && !instanceDraftOpen ? null : (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            {/* Two different jobs, so two entries: the catalogue lists instances
                the server already reports, this one builds a second instance of
                one service that does not exist yet. */}
            <button
              type="button"
              className={`${SECONDARY_BUTTON} shrink-0`}
              aria-expanded={instanceDraftOpen}
              data-nb-search-new-instance
              onClick={() => {
                setInstanceDraftOpen((open) => !open);
                setDirectoryOpen(false);
              }}
            >
              <span className="inline-flex items-center gap-1">
                <Icon name={instanceDraftOpen ? 'close' : 'plus'} size={12} />
                {instanceDraftOpen ? t('st.nbSearch.custom.close') : t('st.nbSearch.services.addInstance')}
              </span>
            </button>
            <button
              type="button"
              className={`${SECONDARY_BUTTON} shrink-0`}
              aria-expanded={directoryOpen}
              data-nb-search-add-service
              onClick={() => {
                setDirectoryOpen((open) => !open);
                setInstanceDraftOpen(false);
              }}
            >
              <span className="inline-flex items-center gap-1">
                <Icon name={directoryOpen ? 'close' : 'plus'} size={12} />
                {directoryOpen ? t('st.nbSearch.services.cancelAdd') : t('st.nbSearch.services.add')}
              </span>
            </button>
          </span>
        )}
      </div>

      {directoryOpen ? (
        <div className="space-y-2" data-nb-search-directory>
          <Hint>{t('st.nbSearch.services.directoryHint')}</Hint>
          <ListToolbar
            view={directoryView}
            total={directory.length}
            searchLabel={t('st.nbSearch.services.directoryTitle')}
            searchPlaceholder={t('st.nbSearch.services.searchPlaceholder')}
            showDensity={false}
          />
          {directory.length === 0 ? (
            <ListEmpty kind="none" title={t('st.nbSearch.services.directoryEmpty')} />
          ) : directoryView.visible.length === 0 ? (
            <ListEmpty
              kind="no-match"
              title={t('st.nbSearch.services.noMatch', { query: directoryView.query.trim() })}
              onClear={directoryView.clear}
            />
          ) : (
            <ul className="space-y-0.5">{directoryView.visible.map(directoryRow)}</ul>
          )}
        </div>
      ) : instanceDraftOpen ? (
        <NbSearchInstanceEditor
          capabilities={capabilities}
          draft={nbSearchDraft}
          saving={saving}
          onCancel={() => { setInstanceDraftOpen(false); }}
          onCreated={(next, instanceId) => {
            // The editor hands back a complete draft (this instance's own slot
            // and variable included). Adding it to the list must not drop that,
            // nor anything else already drafted.
            onDraftChange(next);
            onAddService(instanceId);
            setInstanceDraftOpen(false);
            openService(instanceId);
          }}
        />
      ) : added.length === 0 ? (
        <ListEmpty
          kind="none"
          title={t('st.nbSearch.services.emptyTitle')}
          body={t('st.nbSearch.services.emptyBody')}
          action={(
            <button
              type="button"
              className={PRIMARY_BUTTON}
              data-nb-search-add-service-empty
              onClick={() => { setDirectoryOpen(true); }}
            >
              {t('st.nbSearch.services.emptyAction')}
            </button>
          )}
        />
      ) : (
        <ul className="space-y-0.5" data-nb-search-service-rows>{added.map(serviceRow)}</ul>
      )}

      <p className="px-3 text-[12px] leading-snug text-ink-faint" data-nb-search-default-summary>
        {defaultSummary(t, capabilities)}
      </p>
    </nav>
  );

  return (
    <SectionCard id="st-card-search-providers" title={t('st.nbSearch.providersTitle')}>
      <SettingsDetailLayout
        narrowPane={directoryOpen || instanceDraftOpen ? 'list' : narrowPane}
        list={list}
        detail={detail}
      />
    </SectionCard>
  );
}

function credentialEnvOf(credentialSlots: unknown, draft: NbSearchProviderDraft): string {
  const slots = (credentialSlots as Record<string, { env?: string } | null> | undefined) ?? {};
  return slots[draft.credentialSlotId]?.env ?? '';
}

/**
 * One quiet line stating what search currently runs on. Inheriting the default
 * is the difference the old page got wrong — it printed "off" for a lane the
 * engine was in fact providing.
 */
function defaultSummary(
  t: ReturnType<typeof useI18n>['t'],
  capabilities: NbSearchCapabilities,
): string {
  const lane = capabilities.search.default_lane;
  return lane === undefined
    ? t('st.nbSearch.inheritDefaultNone')
    : t('st.nbSearch.inheritDefault', { lane });
}
