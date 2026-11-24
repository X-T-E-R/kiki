import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type {
  PortableSpaceDomain,
  PortableSpaceEndpoint,
  PortableSpaceInspectResult,
  PortableSpaceItemSummary,
  PortableSpaceSourceRecord,
  PortableSpaceUnlock,
} from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { formatBytes } from '@kiki/session-core/util';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import {
  PORTABLE_DOMAIN_LABEL_KEY,
  endpointKey,
  endpointSubtitle,
  parseScalarValue,
  portableSpaceKeys,
  portableSpacesApi,
  usePortableInspect,
} from '../../../lib/portableSpaces';
import type { SpaceListItem } from '../../../lib/spaces';
import { FeedbackLine, InlineError, type Feedback } from '../../controls';
import { DisclosureChevron, Icon } from '../../icons';
import { DetailBack } from '../../overlays';
import { INPUT_BOX, SECONDARY_BUTTON } from '../../ui';
import { SettingsTabs, TEXT_BUTTON } from '../SettingsPrimitives';
import { PortableColabTab } from './PortableColabTab';
import { PortableCompareTab } from './PortableCompareTab';

export type PortableDetailTab = 'contents' | 'compare' | 'colab';

export interface PortableSpaceDetailProps {
  readonly client: KikiClient;
  readonly token?: string;
  readonly source: PortableSpaceSourceRecord;
  readonly spaces: readonly SpaceListItem[];
  readonly portableSources: readonly PortableSpaceSourceRecord[];
  readonly deviceRecipient?: string;
  readonly tab: PortableDetailTab;
  readonly compareMode?: 'sync' | 'merge' | 'override';
  readonly compareRightEndpoint?: PortableSpaceEndpoint;
  readonly onTabChange: (tab: PortableDetailTab) => void;
  readonly onClose: () => void;
  readonly onFork: (source: PortableSpaceSourceRecord) => void;
  readonly onPackUnpack: (source: PortableSpaceSourceRecord, action: 'pack' | 'unpack') => void;
  readonly onMutated: () => void;
}

export function PortableSpaceDetail({
  client,
  token,
  source,
  spaces,
  portableSources,
  deviceRecipient,
  tab,
  compareMode,
  compareRightEndpoint,
  onTabChange,
  onClose,
  onFork,
  onPackUnpack,
  onMutated,
}: PortableSpaceDetailProps) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [passphraseDraft, setPassphraseDraft] = useState('');
  const [unlock, setUnlock] = useState<PortableSpaceUnlock | undefined>(undefined);
  const [unlockNonce, setUnlockNonce] = useState(0);
  const [expandedDomains, setExpandedDomains] = useState<ReadonlySet<PortableSpaceDomain>>(new Set(['config']));
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const inspectQuery = usePortableInspect(
    client,
    { endpoint: source.endpoint, unlock },
    { token, unlockNonce },
  );
  const data = inspectQuery.data;

  const groupedItems = useMemo(() => {
    const map = new Map<PortableSpaceDomain, PortableSpaceItemSummary[]>();
    for (const item of data?.items ?? []) {
      const list = map.get(item.domain) ?? [];
      list.push(item);
      map.set(item.domain, list);
    }
    return map;
  }, [data?.items]);

  const toggleDomain = (domain: PortableSpaceDomain) => {
    setExpandedDomains((current) => {
      const next = new Set(current);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  const isReadOnly = source.endpoint.kind === 'git' || source.endpoint.kind === 'url';

  const updateInspectCache = (
    next: PortableSpaceInspectResult,
    options?: { readonly nextUnlock?: PortableSpaceUnlock; readonly updateUnlock?: boolean },
  ) => {
    const effectiveUnlock = options?.updateUnlock ? options.nextUnlock : unlock;
    const effectiveNonce = options?.updateUnlock ? unlockNonce + 1 : unlockNonce;
    if (options?.updateUnlock) {
      setUnlock(effectiveUnlock);
      setUnlockNonce(effectiveNonce);
    }
    const unlockKey = `${effectiveNonce}:${effectiveUnlock?.passphrase ? 'pw' : ''}:${effectiveUnlock?.identity ? 'id' : ''}`;
    queryClient.setQueryData(portableSpaceKeys.inspect(client, source.endpoint, unlockKey), next);
    onMutated();
  };

  const commitScalarEdit = async (item: PortableSpaceItemSummary) => {
    if (mutatingId !== null || isReadOnly) return;
    setMutatingId(item.id);
    setFeedback(null);
    try {
      const receipt = await portableSpacesApi(client, { token }).mutate({
        target: source.endpoint,
        unlock,
        actions: [{ op: 'set', key: item.path, value: parseScalarValue(editDraft, item.scalarValue) }],
      });
      setEditingItemId(null);
      updateInspectCache(receipt.inspect);
      setFeedback(
        receipt.changed
          ? { tone: 'success', text: t('st.portable.editSaved') }
          : { tone: 'error', text: t('st.portable.mutateUnchanged') },
      );
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setMutatingId(null);
    }
  };

  const removeItem = async (item: PortableSpaceItemSummary) => {
    if (mutatingId !== null || isReadOnly) return;
    setMutatingId(item.id);
    setFeedback(null);
    try {
      const action = item.bytes === undefined
        ? { op: 'unset' as const, key: item.id, recordOverlayUnset: data?.spaceMode === 'overlay' }
        : { op: 'rm' as const, paths: [item.path] };
      const receipt = await portableSpacesApi(client, { token }).mutate({
        target: source.endpoint,
        unlock,
        actions: [action],
      });
      updateInspectCache(receipt.inspect);
      setFeedback(
        receipt.changed
          ? { tone: 'success', text: t('st.portable.removeItemDone') }
          : { tone: 'error', text: t('st.portable.mutateUnchanged') },
      );
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setMutatingId(null);
    }
  };

  const canPack = source.endpoint.kind === 'dir' && source.format === 'dir';
  const canUnpack = source.endpoint.kind === 'archive' && (source.format === 'age' || source.format === 'tgz');
  const subtitle = endpointSubtitle(source.endpoint, source.gitBranch);

  return (
    <div className="space-y-4" data-portable-detail={source.id}>
      <div className="md:hidden">
        <DetailBack label={t('st.portable.title')} onClick={onClose} data={{ 'data-portable-detail-back': '' }} />
      </div>

      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            data-detail-heading
            tabIndex={-1}
            className="flex min-w-0 items-center gap-2 font-display text-[18px] font-semibold text-ink outline-none"
          >
            <Icon
              name={source.endpoint.kind === 'url' ? 'web' : source.endpoint.kind === 'git' ? 'branch' : source.format === 'age' ? 'lock' : 'folder'}
              size={16}
              className="text-ink-soft"
            />
            <span className="min-w-0 break-words">{source.label}</span>
          </h3>
          <p className="mt-0.5 truncate font-mono text-[11.5px] text-ink-faint" title={subtitle}>{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
          data-detail-close
          className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink md:flex"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <SettingsTabs<PortableDetailTab>
        tabs={['contents', 'compare', 'colab']}
        current={tab}
        ariaLabel={source.label}
        dataAttr="data-portable-tab"
        labelOf={(entry) =>
          entry === 'contents'
            ? t('st.portable.tab.contents')
            : entry === 'compare'
              ? t('st.portable.tab.compare')
              : t('st.portable.tab.colab')
        }
        onSelect={onTabChange}
      />

      {tab === 'contents' ? (
        <div className="space-y-4" data-portable-contents-tab>
          <div className="flex flex-wrap items-center gap-2">
            {canUnpack ? (
              <button
                type="button"
                data-portable-unpack-trigger
                className={SECONDARY_BUTTON}
                onClick={() => { onPackUnpack(source, 'unpack'); }}
              >
                {t('st.portable.unpackAction')}
              </button>
            ) : null}
            {canPack ? (
              <button
                type="button"
                data-portable-pack-trigger
                className={SECONDARY_BUTTON}
                onClick={() => { onPackUnpack(source, 'pack'); }}
              >
                {t('st.portable.packAction')}
              </button>
            ) : null}
            <button
              type="button"
              data-portable-detail-fork
              className={SECONDARY_BUTTON}
              onClick={() => { onFork(source); }}
            >
              {t('st.portable.forkMenu')}
            </button>
          </div>

          {inspectQuery.isLoading ? (
            <p className="py-2 text-[12.5px] text-ink-faint" data-portable-inspect-loading>
              {t('st.portable.inspectLoading')}
            </p>
          ) : null}

          {inspectQuery.isError ? (
            <div className="space-y-3" data-portable-inspect-error>
              <InlineError error={inspectQuery.error} />
              {source.format === 'age' || source.encryptionMode === 'passphrase' ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (passphraseDraft.trim() === '') return;
                    setUnlock({ passphrase: passphraseDraft.trim() });
                    setUnlockNonce((value) => value + 1);
                  }}
                >
                  <input
                    type="password"
                    data-portable-unlock-input
                    value={passphraseDraft}
                    placeholder={t('st.portable.unlockHint')}
                    onChange={(event) => { setPassphraseDraft(event.target.value); }}
                    className={`${INPUT_BOX} w-64`}
                  />
                  <button type="submit" data-portable-unlock-submit className={SECONDARY_BUTTON}>
                    {t('st.portable.unlockAction')}
                  </button>
                </form>
              ) : (
                <button type="button" className={SECONDARY_BUTTON} onClick={() => { void inspectQuery.refetch(); }}>
                  {t('common.retry')}
                </button>
              )}
            </div>
          ) : null}

          {data !== undefined ? (
            data.domains.length === 0 ? (
              <p className="text-[13px] text-ink-faint">{t('st.portable.inspectEmpty')}</p>
            ) : (
              <div className="divide-y divide-hairline border-t border-b border-hairline" data-portable-domain-list>
                {data.domains.map(({ domain, count }) => {
                  const items = groupedItems.get(domain) ?? [];
                  const expanded = expandedDomains.has(domain);
                  return (
                    <div key={domain} data-portable-domain-row={domain}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => { toggleDomain(domain); }}
                        className="flex w-full items-baseline justify-between gap-4 py-2.5 text-left outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
                      >
                        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink">
                          <DisclosureChevron open={expanded} />
                          <span>{t(PORTABLE_DOMAIN_LABEL_KEY[domain])}</span>
                        </span>
                        <span className="text-right text-[12px] tabular-nums text-ink-soft">
                          {t('st.portable.itemCount', { count })}
                        </span>
                      </button>

                      {expanded && items.length > 0 ? (
                        <ul className="mb-2 space-y-1 pl-5">
                          {items.map((item) => {
                            const isEditing = editingItemId === item.id;
                            const isScalar = item.scalarValue !== undefined;
                            return (
                              <li
                                key={item.id}
                                data-portable-item-row={item.id}
                                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1 text-[12.5px]"
                              >
                                <div className="min-w-0 flex-1">
                                  <span className="inline-flex items-center gap-1.5 text-ink">
                                    <span>{item.label}</span>
                                    {item.masked ? <Icon name="lock" size={12} className="text-ink-faint" /> : null}
                                  </span>
                                  <span className="ml-2 font-mono text-[11px] text-ink-faint">{item.path}</span>
                                </div>

                                <div className="flex shrink-0 items-center gap-2">
                                  {isEditing ? (
                                    <form
                                      className="flex items-center gap-1.5"
                                      onSubmit={(event) => {
                                        event.preventDefault();
                                        void commitScalarEdit(item);
                                      }}
                                    >
                                      <input
                                        data-portable-item-edit-input={item.id}
                                        value={editDraft}
                                        onChange={(event) => { setEditDraft(event.target.value); }}
                                        className={`${INPUT_BOX} w-40 py-1 font-mono text-[11.5px]`}
                                      />
                                      <button
                                        type="submit"
                                        data-portable-item-edit-save={item.id}
                                        disabled={mutatingId !== null}
                                        className={TEXT_BUTTON}
                                      >
                                        {t('common.save')}
                                      </button>
                                      <button
                                        type="button"
                                        className="text-[12px] text-ink-faint hover:text-ink"
                                        onClick={() => { setEditingItemId(null); }}
                                      >
                                        {t('common.cancel')}
                                      </button>
                                    </form>
                                  ) : (
                                    <>
                                      {item.summary !== undefined ? (
                                        <span className="max-w-[14rem] truncate font-mono text-[11.5px] text-ink-soft" title={item.summary}>
                                          {item.summary}
                                        </span>
                                      ) : item.bytes !== undefined ? (
                                        <span className="text-[11.5px] tabular-nums text-ink-faint">{formatBytes(item.bytes)}</span>
                                      ) : null}
                                      {!isReadOnly && isScalar && !item.masked ? (
                                        <button
                                          type="button"
                                          data-portable-item-edit={item.id}
                                          disabled={mutatingId !== null}
                                          className={TEXT_BUTTON}
                                          onClick={() => {
                                            setEditingItemId(item.id);
                                            setEditDraft(item.scalarValue === null ? 'null' : String(item.scalarValue));
                                          }}
                                        >
                                          {t('st.portable.editItem')}
                                        </button>
                                      ) : null}
                                      {!isReadOnly ? (
                                        <button
                                          type="button"
                                          data-portable-item-remove={item.id}
                                          disabled={mutatingId !== null}
                                          className="text-[12px] text-ink-faint transition-colors hover:text-danger disabled:opacity-50"
                                          onClick={() => { void removeItem(item); }}
                                        >
                                          {t('st.portable.removeItem')}
                                        </button>
                                      ) : null}
                                    </>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )
          ) : null}

          {data?.excluded && data.excluded.length > 0 ? (
            <ul className="space-y-1 text-[12px] text-ink-soft" data-portable-excluded-list>
              {data.excluded.map((entry) => (
                <li key={entry.id} data-portable-excluded-item={entry.id} className="flex flex-wrap gap-x-2">
                  <span className="font-mono text-ink">{entry.path}</span>
                  <span className="text-ink-faint">{entry.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <FeedbackLine feedback={feedback} />
        </div>
      ) : null}

      {tab === 'compare' ? (
        <PortableCompareTab
          key={`${source.id}:${compareMode ?? 'sync'}:${compareRightEndpoint === undefined ? 'main' : endpointKey(compareRightEndpoint)}`}
          client={client}
          token={token}
          source={source}
          spaces={spaces}
          portableSources={portableSources}
          initialMode={compareMode}
          initialRightEndpoint={compareRightEndpoint}
          sourceUnlock={unlock}
          onApplied={() => {
            void inspectQuery.refetch();
            onMutated();
          }}
        />
      ) : null}

      {tab === 'colab' ? (
        <PortableColabTab
          client={client}
          token={token}
          source={source}
          inspect={data}
          deviceRecipient={deviceRecipient}
          portableSources={portableSources}
          unlock={unlock}
          onRekeyed={(next, nextUnlock) => {
            updateInspectCache(next, { nextUnlock, updateUnlock: true });
          }}
        />
      ) : null}
    </div>
  );
}
