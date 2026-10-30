/**
 * 搜索引擎: the service list, not the protocol.
 *
 * One card per service the engine can search or fetch through. A card says
 * whether the service works, holds its key and enable switch in the body, and
 * offers an explicit 设为默认 — clicking a row only opens it. What a lane id
 * or a schema id is never appears on a row; the advanced method and preset
 * editors (the lane/preset model a power user composes) sit in their own
 * disclosure at the bottom.
 *
 * Everything writes the page's single draft and commits with the page save.
 */

import { useMemo, useState } from 'react';
import type { NbSearchCapabilities } from '@kiki/protocol';
import {
  resolveEffectiveDefaultLane,
  type NbSearchDraft,
} from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { Hint } from '../../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SectionCard } from '../SectionCard';
import { AdvancedDetails } from '../fields';
import { ListEmpty, ListToolbar, useListView } from '../list';
import { nbSearchServiceCards, providerLabelKey, type ServiceCard } from './types';
import type { KeyDraft } from './NbSearchMultiKeyEditor';
import { NbSearchServiceCard } from './NbSearchServiceCard';
import { NbSearchLaneComposer } from './NbSearchLaneComposer';
import { addLaneService, addPipelineService, clearDefaultLane, engineLaneProfiles, makeDefaultLane, removeService } from './serviceCards';
import type { NbSearchAdvancedBinding } from './advancedSupport';

type ReadCredential = (instanceId: string, reveal: boolean) => Promise<import('@kiki/protocol').NbSearchManagedCredentialView>;
type ReadKeyUsage = (instanceId: string, refresh: boolean) => Promise<import('@kiki/protocol').NbSearchKeyUsageView>;

export function NbSearchLanesTab({
  capabilities,
  saving = false,
  advanced,
  keyDrafts,
  onKeyDraftChange,
  readCredential,
  readKeyUsage,
}: {
  capabilities: NbSearchCapabilities;
  saving?: boolean;
  advanced: NbSearchAdvancedBinding;
  keyDrafts: Readonly<Record<string, KeyDraft>>;
  onKeyDraftChange: (instanceId: string, draft: KeyDraft) => void;
  readCredential: ReadCredential;
  readKeyUsage: ReadKeyUsage;
}) {
  const { t } = useI18n();
  const draft = advanced.draft;
  const bindingConfig = advanced.config;
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const labelOf = (providerId: string) => {
    const key = providerLabelKey(providerId);
    return key === undefined ? providerId : t(key);
  };
  const [methodsOpen, setMethodsOpen] = useState(
    () => draft.defaultSearchLane === '' || Object.keys(draft.advanced?.presets ?? {}).length > 0,
  );

  // Service cards come from the engine's own catalog view (every lane it
  // reports), not from Kiki's draft — otherwise a lane the server already
  // declares would hide until the user re-declares it.
  const allCards = useMemo(() => {
    const engineProfiles = engineLaneProfiles(capabilities);
    const descriptorProvider = new Map(
      capabilities.providers.descriptors.map((descriptor) => [descriptor.provider_id, descriptor.provider_id]),
    );
    const searchCards = capabilities.search.lanes.flatMap((lane) => {
      const profile = engineProfiles[lane.id];
      if (profile === undefined) return [];
      // A profile that names no real provider (a projection pointing at an
      // instance id as if it were a provider) is not a service card.
      const providerId = descriptorProvider.get(profile.provider_id);
      if (providerId === undefined) return [];
      const operationWord = lane.output.channel === 'results' ? t('st.nbSearch.operation.search') : profile.operation_id;
      return [{
        id: lane.id,
        title: `${labelOf(providerId)} ${operationWord}`.trim(),
        subtitle: operationWord,
        operationId: profile.operation_id,
        providerId,
        latency: lane.latency,
        cost: lane.cost,
      }];
    });
    return searchCards;
  }, [capabilities, t]);

  // The directory adds anything the engine reports that the list does not
  // already hold — including fetch pipelines, which become fetch services.
  const directoryCardsAll = useMemo(() => {
    const engineProfiles = engineLaneProfiles(capabilities);
    const descriptorProvider = new Map(
      capabilities.providers.descriptors.map((descriptor) => [descriptor.provider_id, descriptor.provider_id]),
    );
    const pipelineCards = capabilities.fetch.pipelines.flatMap((pipeline) => {
      if (allCards.some((card) => card.id === pipeline.id)) return [];
      const profile = engineProfiles[pipeline.id];
      const providerId = profile !== undefined
        ? descriptorProvider.get(profile.provider_id)
        : descriptorProvider.get(pipeline.stages[0]?.id ?? '');
      if (providerId === undefined) return [];
      return [{
        id: pipeline.id,
        title: labelOf(providerId),
        subtitle: t('st.nbSearch.role.fetchShort'),
        operationId: profile?.operation_id,
        providerId,
        latency: pipeline.latency,
        cost: pipeline.cost,
      }];
    });
    return [...allCards, ...pipelineCards];
  }, [capabilities, allCards, t]);

  const ownLanes = draft.advanced?.lanes ?? {};
  // An override that already reached the server (`provider_instances` in the
  // saved config) is a configuration even before the next read-back: the
  // engine's projection only catches up after a save.
  const configuredInstanceIds = new Set([
    ...Object.keys((bindingConfig?.provider_instances ?? {}) as Record<string, unknown>),
    ...Object.entries(draft.providers)
      .filter(([, provider]) => provider.isDeleted !== true && provider.isNew === true)
      .map(([id]) => id),
  ]);
  // The service is in the list when Kiki's draft registers it (adding a
  // service is exactly that), when the layer below declares its method, or
  // when the instance behind it carries a saved override — the saved key has
  // to stay reachable without a lane declaration.
  const activeCards = useMemo(() => {
    const inherited = capabilities.inherited_configuration?.lanes;
    const overriddenInstances = new Set([
      ...Object.keys((bindingConfig?.provider_instances ?? {}) as Record<string, unknown>),
      ...((capabilities.configuration as { provider_instance_ids?: readonly string[] } | undefined)?.provider_instance_ids ?? []),
    ]);
    return allCards.filter((card) =>
      Object.prototype.hasOwnProperty.call(ownLanes, card.id)
      || inherited?.[card.id] !== undefined
      || (inherited === undefined && capabilities.configuration?.lanes[card.id] !== undefined)
      || (card.providerId !== undefined
        && capabilities.providers.instances.some((instance) =>
          instance.provider_id === card.providerId
          && (overriddenInstances.has(instance.id) || configuredInstanceIds.has(instance.id)))));
  }, [allCards, ownLanes, capabilities, bindingConfig, configuredInstanceIds]);
  const directoryCards = useMemo(
    () => directoryCardsAll.filter((card) => !activeCards.some((active) => active.id === card.id)),
    [directoryCardsAll, activeCards],
  );

  // A saved override for an instance whose method no projection describes
  // (e.g. exa.default without a lane config) is still the user's service:
  // the card is the provider, keyed by its instance.
  const instanceCards = useMemo(() => {
    const overridden = new Set([
      ...configuredInstanceIds,
      ...((capabilities.configuration as { provider_instance_ids?: readonly string[] } | undefined)?.provider_instance_ids ?? []),
    ]);
    const coveredProviders = new Set(
      activeCards.map((card) => card.providerId).filter((id): id is string => id !== undefined),
    );
    // The lane card edits the provider's saved instance when there is one,
    // its first instance otherwise; a second configured instance of that
    // provider keeps its own card.
    const laneCoveredInstances = new Set(
      activeCards.flatMap((card) => {
        const providerId = card.providerId;
        if (providerId === undefined) return [];
        const saved = capabilities.providers.instances.find((instance) =>
          instance.provider_id === providerId && draft.providers[instance.id] !== undefined);
        const first = saved ?? capabilities.providers.instances.find((instance) => instance.provider_id === providerId);
        return first === undefined ? [] : [first.id];
      }),
    );
    const cards: ServiceCard[] = [];
    const cardFor = (instanceId: string, providerId: string) => {
      const descriptor = capabilities.providers.descriptors.find((candidate) => candidate.provider_id === providerId);
      const searches = (descriptor?.query_operations.length ?? 0) > 0;
      cards.push({
        id: `instance:${instanceId}`,
        title: searches ? `${labelOf(providerId)} ${t('st.nbSearch.operation.search')}`.trim() : labelOf(providerId),
        subtitle: searches ? t('st.nbSearch.operation.search') : t('st.nbSearch.role.service'),
      });
    };
    for (const instance of capabilities.providers.instances) {
      if (!overridden.has(instance.id)) continue;
      if (coveredProviders.has(instance.provider_id) && laneCoveredInstances.has(instance.id)) continue;
      cardFor(instance.id, instance.provider_id);
    }
    // An instance this draft created exists nowhere on the server yet; it
    // still joins the list so its key and address can be set before the save.
    for (const [instanceId, provider] of Object.entries(draft.providers)) {
      if (provider.isNew !== true || provider.isDeleted === true || provider.providerId === undefined) continue;
      if (capabilities.providers.instances.some((instance) => instance.id === instanceId)) continue;
      cardFor(instanceId, provider.providerId);
    }
    return cards;
  }, [bindingConfig, capabilities, allCards, activeCards, draft.providers, labelOf, t]);

  // Single-open: opening a row closes the previous one, like the browser
  // list. A row that holds an unsaved key is never hidden behind a sibling:
  // it stays open next to the new one until its keys are saved or dropped.
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [pinnedOpen, setPinnedOpen] = useState<readonly string[]>([]);
  const dirtyCards = new Set(
    Object.entries(keyDrafts)
      .filter(([, entry]) => entry.mode !== 'keep')
      .map(([instanceId]) => cardIdForInstance(instanceId, capabilities, activeCards, instanceCards)),
  );
  const selectOpen = (cardId: string, next: boolean) => {
    if (next) {
      // Rows that already hold pending keys stay open next to the new one —
      // an unsaved key is never hidden behind a sibling. A clean row closes.
      setPinnedOpen((pinned) => {
        const keep = new Set(pinned.filter((id) => dirtyCards.has(id)));
        if (openCardId !== null && openCardId !== cardId && dirtyCards.has(openCardId)) keep.add(openCardId);
        return [...keep];
      });
      setOpenCardId(cardId);
    } else {
      if (openCardId === cardId) setOpenCardId(null);
      setPinnedOpen((pinned) => pinned.filter((id) => id !== cardId && dirtyCards.has(id)));
    }
  };
  const isOpen = (cardId: string) => openCardId === cardId || (pinnedOpen.includes(cardId) && dirtyCards.has(cardId));

  const effective = useMemo(
    () => resolveEffectiveDefaultLane(capabilities, draft.defaultSearchLane),
    [capabilities, draft.defaultSearchLane],
  );
  const defaultLaneId = draft.defaultSearchLane === '' ? effective.laneId : draft.defaultSearchLane;
  const inheritedDefault = draft.defaultSearchLane === '' && effective.laneId !== undefined;

  const directoryView = useListView({
    listId: 'nb-search-service-directory',
    items: directoryCards,
    keyOf: (card) => card.id,
    textOf: (card) => [card.title, card.subtitle, card.id],
  });

  return (
    <SectionCard
      id="st-card-search-providers"
      title={t('st.nbSearch.providersTitle')}
      actions={directoryOpen ? (
        <button
          type="button"
          className={`${SECONDARY_BUTTON} shrink-0`}
          aria-expanded={directoryOpen}
          data-nb-search-add-service
          onClick={() => { setDirectoryOpen(false); }}
        >
          <span className="inline-flex items-center gap-1">
            <Icon name="close" size={12} />
            {t('st.nbSearch.services.cancelAdd')}
          </span>
        </button>
      ) : activeCards.length + instanceCards.length > 0 ? (
        <button
          type="button"
          className={`${SECONDARY_BUTTON} shrink-0`}
          aria-expanded={directoryOpen}
          data-nb-search-add-service
          onClick={() => { setDirectoryOpen(true); }}
        >
          <span className="inline-flex items-center gap-1">
            <Icon name="plus" size={12} />
            {t('st.nbSearch.services.add')}
          </span>
        </button>
      ) : undefined}
    >
      <div className="space-y-4" data-nb-search-services-tab>
        {directoryOpen ? (
          <div className="space-y-2" data-nb-search-directory>
            <Hint>{t('st.nbSearch.services.directoryHint')}</Hint>
            <ListToolbar
              view={directoryView}
              total={directoryCards.length}
              searchLabel={t('st.nbSearch.services.directoryTitle')}
              searchPlaceholder={t('st.nbSearch.services.searchPlaceholder')}
              showDensity={false}
            />
            {directoryCards.length === 0 ? (
              <ListEmpty kind="none" title={t('st.nbSearch.services.directoryEmpty')} />
            ) : directoryView.visible.length === 0 ? (
              <ListEmpty
                kind="no-match"
                title={t('st.nbSearch.services.noMatch', { query: directoryView.query.trim() })}
                onClear={directoryView.clear}
              />
            ) : (
              <ul className="space-y-0.5">
                {directoryView.visible.map((card) => (
                  <li key={card.id}>
                    <button
                      type="button"
                      data-nb-search-directory-row={card.id}
                      disabled={saving}
                      onClick={() => {
                        const isPipeline = capabilities.fetch.pipelines.some((pipeline) => pipeline.id === card.id);
                        advanced.onChange(isPipeline
                          ? addPipelineService(draft, capabilities, card.id, [])
                          : addLaneService(draft, card.id));
                        setDirectoryOpen(false);
                      }}
                      className="row-interactive flex w-full min-w-0 items-center gap-2 py-1.5 pl-3 pr-2 text-left"
                    >
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{card.title}</span>
                      <span className="shrink-0 text-[12px] font-medium text-ink-soft">
                        {t('st.nbSearch.services.addOne')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {activeCards.length + instanceCards.length === 0 ? (
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
          <div className="divide-y divide-hairline rounded-lg border border-hairline" data-nb-search-service-cards>
            {activeCards.map((card) => (
              <NbSearchServiceCard
                key={card.id}
                card={card}
                kind="lane"
                capabilities={capabilities}
                draft={draft}
                onChange={advanced.onChange}
                keyDraft={cardKeyDraft(keyDrafts, capabilities, card.providerId)}
                onKeyDraftChange={(next) => {
                  const instanceId = cardInstanceId(capabilities, card.providerId);
                  if (instanceId !== undefined) onKeyDraftChange(instanceId, next);
                }}
                readCredential={readCredential}
                readKeyUsage={readKeyUsage}
                saving={saving}
                open={isOpen(card.id)}
                onOpenChange={(next) => { selectOpen(card.id, next); }}
                defaultState={defaultLaneId === card.id ? (inheritedDefault ? 'inherit' : 'default') : 'none'}
                // 设为默认 stays available on every other card even while the
                // current default is inherited: choosing one is exactly how the
                // user overrides the source default. The inherited default's own
                // card offers nothing — it already is the default.
                onMakeDefault={defaultLaneId === card.id ? undefined : () => {
                  advanced.onChange(makeDefaultLane(draft, card.id));
                }}
                onRemoveService={() => {
                  advanced.onChange(removeService(draft, capabilities, 'lane', card.id, []));
                }}
                removeTitle={t('st.nbSearch.services.removeServiceTitle', { name: card.title })}
              />
            ))}
            {instanceCards.map((card) => {
              const instanceId = card.id.slice('instance:'.length);
              return (
                <NbSearchServiceCard
                  key={card.id}
                  card={card}
                  kind="instance"
                  instanceId={instanceId}
                  capabilities={capabilities}
                  draft={draft}
                  onChange={advanced.onChange}
                  keyDraft={keyDrafts[instanceId] ?? { mode: 'keep' }}
                  onKeyDraftChange={(next) => { onKeyDraftChange(instanceId, next); }}
                  readCredential={readCredential}
                  readKeyUsage={readKeyUsage}
                  saving={saving}
                  open={isOpen(card.id)}
                  onOpenChange={(next) => { selectOpen(card.id, next); }}
                />
              );
            })}
          </div>
        )}
        {draft.defaultSearchLane !== '' ? (
          <div className="flex flex-wrap items-center gap-2 px-1">
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={saving}
              data-nb-search-clear-default
              onClick={() => {
                advanced.onChange(clearDefaultLane(draft));
              }}
            >
              {t('st.nbSearch.services.followSourceDefault')}
            </button>
          </div>
        ) : null}

        <AdvancedDetails
          summary={t('st.nbSearch.services.advancedMethods')}
          data-nb-search-methods
          open={methodsOpen}
          onToggle={(event) => {
            setMethodsOpen((event.target as HTMLDetailsElement).open);
          }}
        >
          <NbSearchLaneComposer binding={advanced} saving={saving} />
        </AdvancedDetails>
      </div>
    </SectionCard>
  );
}

function cardInstanceId(
  capabilities: NbSearchCapabilities,
  providerId: string | undefined,
): string | undefined {
  if (providerId === undefined) return undefined;
  return capabilities.providers.instances.find((instance) => instance.provider_id === providerId)?.id;
}

function cardKeyDraft(
  keyDrafts: Readonly<Record<string, KeyDraft>>,
  capabilities: NbSearchCapabilities,
  providerId: string | undefined,
): KeyDraft {
  const instanceId = cardInstanceId(capabilities, providerId);
  return instanceId === undefined ? { mode: 'keep' } : keyDrafts[instanceId] ?? { mode: 'keep' };
}

/** The card that edits one instance: its own `instance:<id>` card, or the lane card of its provider. */
function cardIdForInstance(
  instanceId: string,
  capabilities: NbSearchCapabilities,
  activeCards: readonly ServiceCard[],
  instanceCards: readonly ServiceCard[],
): string {
  if (instanceCards.some((card) => card.id === `instance:${instanceId}`)) return `instance:${instanceId}`;
  const providerId = capabilities.providers.instances.find((instance) => instance.id === instanceId)?.provider_id;
  const lane = activeCards.find((card) => card.providerId !== undefined && card.providerId === providerId);
  return lane?.id ?? `instance:${instanceId}`;
}
