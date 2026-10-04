import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import type { SpaceDetail, SpaceDomain, SpacePlanRequest } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { applyDeviceAppearanceToSpace, useSpaceAuthorityState } from '../../../lib/spacePreferences';
import {
  SPACE_GROUP_ORDER,
  SPACE_RESOURCE_DOMAIN,
  spaceGroupLabelKey,
  spaceGroupSummaryText,
  spaceItemLabel,
  spaceItemRoute,
  spaceOwnChoices,
  spaceSettingsApi,
  spaceSettingsKeys,
  spaceValueLabel,
  spaceSettingsClientKey,
  spaceSettingsTargetOf,
  type SpaceSettingsTarget,
} from '../../../lib/spaceSettings';
import { readSpacePreferenceDetail, resolveSpaceDeviceConflict, spaceIdentityKey } from '../../../lib/spaceAuthority';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, InlineError, type Feedback } from '../../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SpaceChangeDialog } from './SpaceChangeDialog';

/**
 * One space's settings, flat (design 2026-10-02 §5.1): the eight domains a
 * space can follow or fix, the one resource-source row that is about this
 * machine, and what the space holds for itself. No card inside a card, no
 * per-row chrome — spacing and weight carry the structure.
 *
 * The same component serves the row menu (in a dialog) and the page of the
 * space the window is already in (inline), so both read one fact.
 */
interface SpaceSettingsDetailProps {
  target: SpaceSettingsTarget | null;
  name: string;
  onDetailChange?: (detail: SpaceDetail) => void;
}

export function SpaceSettingsDetail(props: SpaceSettingsDetailProps) {
  const key = props.target === null ? 'unidentified' : `${spaceSettingsClientKey(props.target.client)}|${props.target.identity.serverId}|${props.target.identity.homeId}`;
  return <SpaceSettingsDetailContext key={key} {...props} />;
}

function SpaceSettingsDetailContext({ target, name, onDetailChange }: SpaceSettingsDetailProps) {
  const { client: activeClient, meta } = useConnection();
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const authority = useSpaceAuthorityState();
  const client = target?.client ?? null;
  const identity = target?.identity ?? null;
  const serverId = identity?.serverId;
  const id = identity?.homeId ?? 'unidentified';
  const activeTarget = spaceSettingsTargetOf(activeClient, meta);
  const isCurrent = target !== null && activeTarget !== null && client === activeClient && spaceIdentityKey(target.identity) === spaceIdentityKey(activeTarget.identity);
  const ownsAppearance = isCurrent && authority.identity !== null && identity !== null && spaceIdentityKey(authority.identity) === spaceIdentityKey(identity);
  // One entry per server and home: a detail read from one server is never this
  // one's, and an unidentified connection keeps its own slot rather than
  // borrowing a confirmed server's.
  const detailKey = [...spaceSettingsKeys.detail(id), serverId ?? 'unidentified'];
  const [dialog, setDialog] = useState<{ domain: SpaceDomain; action: SpacePlanRequest['action'] } | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const detail = useQuery({
    queryKey: detailKey,
    queryFn: async ({ signal }) => {
      if (client === null || identity === null) throw new Error('Space server is unidentified');
      const next = isCurrent
        ? await readSpacePreferenceDetail(client, identity)
        : await spaceSettingsApi(client).detail(id);
      signal.throwIfAborted();
      if (active.current) onDetailChange?.(next);
      return next;
    },
    enabled: target !== null,
    staleTime: 10_000,
    retry: false,
  });

  // An apply from anywhere returns the new detail into this query's cache, so
  // the surface follows the server instead of holding a stale copy.
  const data = detail.data;
  const groupRow = (domain: SpaceDomain) => {
    if (data === undefined) return null;
    return (
      <div key={domain} data-space-group={domain}
        className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-0.5 py-1.5 sm:grid-cols-[10.5rem_1fr_auto]">
        <span className="text-[13px] text-ink">{t(spaceGroupLabelKey(domain))}</span>
        <span data-space-group-summary={domain}
          className="col-span-2 col-start-1 row-start-2 text-[12px] leading-4 text-ink-soft sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:truncate sm:text-right">
          {spaceGroupSummaryText(data, domain, t)}
        </span>
        {data.primary ? null : (
          <button type="button" data-space-change={domain} className={CHANGE_BUTTON}
            onClick={() => { setFeedback(null); setDialog({ domain, action: 'follow' }); }}>
            {t('st.spaces.change')}
          </button>
        )}
      </div>
    );
  };

  const undo = async () => {
    if (data?.undo_id === undefined || busy || client === null || identity === null) return;
    setBusy(true);
    setFeedback(null);
    try {
      const api = spaceSettingsApi(client);
      const result = await api.undo(id, data.undo_id);
      if (!active.current) return;
      queryClient.setQueryData(detailKey, result.detail);
      setFeedback({ tone: 'success', text: t('st.spaces.undone') });
    } catch (error) {
      if (active.current) setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      if (active.current) setBusy(false);
    }
  };

  const useDeviceAppearance = async () => {
    if (!ownsAppearance || identity === null || client === null || busy) return;
    setBusy(true);
    setFeedback(null);
    const done = await applyDeviceAppearanceToSpace(client, identity);
    if (!active.current) return;
    setBusy(false);
    if (done) {
      // The write settles this conflict for the identity it used; clearing it
      // here again could answer for a space the person has since left.
      void queryClient.invalidateQueries({ queryKey: detailKey });
      setFeedback({ tone: 'success', text: t('st.spaces.device.used') });
      return;
    }
    setFeedback({ tone: 'error', text: t('st.spaces.device.failed') });
  };

  if (detail.isLoading) return <p className="py-2 text-[12px] text-ink-faint" data-space-settings-loading>{t('st.spaces.settingsLoading')}</p>;
  if (detail.isError || data === undefined) {
    return (
      <div className="space-y-2 py-2" data-space-settings-failed>
        {target === null ? <p className="text-[12px] text-ink-faint">{t('st.spaces.origin.unknown')}</p> : <InlineError error={detail.error} />}
        <button type="button" className={SECONDARY_BUTTON} onClick={() => {
          if (target === null) void queryClient.invalidateQueries({ queryKey: ['space-settings', 'meta'] });
          else void detail.refetch();
        }}>{t('st.spaces.settingsRetry')}</button>
      </div>
    );
  }

  const own = spaceOwnChoices(data);
  const pendingItems = data.items.filter((item) => item.pending);

  return (
    <div className="space-y-7" data-space-settings={id}>
      <div className="space-y-0.5">
        <h3 className="font-display text-[17px] font-semibold text-ink" data-space-settings-name>{name}</h3>
        <p className="text-[12px] text-ink-faint">{t('st.spaces.settings')}</p>
      </div>

      <div data-space-groups>{SPACE_GROUP_ORDER.map(groupRow)}</div>

      <div className="space-y-0.5" data-space-resource-sources>
        <p className="text-[12px] font-medium text-ink-faint">{t('st.spaces.resourceSources')}</p>
        <p className="pb-1 text-[12px] leading-4 text-ink-faint">{t('st.spaces.resourceSourcesHint')}</p>
        {groupRow(SPACE_RESOURCE_DOMAIN)}
      </div>

      <div className="space-y-1" data-space-own-choices>
        <p className="text-[12px] font-medium text-ink-faint">{t('st.spaces.ownChoices')}</p>
        {own.length === 0 ? (
          <p className="text-[12.5px] text-ink-faint" data-space-own-empty>{t('st.spaces.ownChoicesEmpty')}</p>
        ) : (
          <div>
            {own.map((item) => {
              const route = spaceItemRoute(item.id);
              const name = spaceItemLabel(item.id, item.name, t);
              return (
                <div key={item.id} data-space-own-item={item.id}
                  className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-0.5 py-1 sm:grid-cols-[10.5rem_1fr_auto]">
                  <span className="min-w-0 truncate text-[13px] text-ink" title={name}>{name}</span>
                  <span className="col-span-2 col-start-1 row-start-2 text-[12px] leading-4 text-ink-soft sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:truncate sm:text-right">
                    {spaceValueLabel(item.id, item.effective, t)}
                  </span>
                  {route === undefined ? null : (
                    <a data-space-own-open={item.id} className={CHANGE_BUTTON} href={route}>{t('st.spaces.ownOpen')}</a>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {data.primary ? <p className="text-[12px] leading-4 text-ink-faint">{t('st.spaces.mainNote')}</p> : null}

      {pendingItems.length > 0 ? (
        <p className="text-[12px] leading-4 text-amber-ink" data-space-pending-note>
          {tp('st.spaces.pending', pendingItems.length)} · {t('st.spaces.pendingNote')}
        </p>
      ) : null}

      {data.undo_id === undefined ? null : (
        <button type="button" data-space-undo disabled={busy} className={CHANGE_BUTTON} onClick={() => { void undo(); }}>
          {t('st.spaces.undoLast')}
        </button>
      )}

      {ownsAppearance && authority.deviceConflict ? (
        <div className="space-y-2 border-t border-hairline pt-4" data-space-device-conflict>
          <p className="text-[13px] font-medium text-ink">{t('st.spaces.device.title')}</p>
          <p className="text-[12px] leading-4 text-ink-soft">{t('st.spaces.device.body')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-space-device-keep className={SECONDARY_BUTTON} onClick={() => { if (ownsAppearance && identity !== null) resolveSpaceDeviceConflict(identity); }}>
              {t('st.spaces.device.keep')}
            </button>
            <button type="button" data-space-device-use className={PRIMARY_BUTTON} disabled={busy} onClick={() => { void useDeviceAppearance(); }}>
              {t('st.spaces.device.use')}
            </button>
          </div>
        </div>
      ) : null}

      <FeedbackLine feedback={feedback} />

      {dialog === null || target === null ? null : (
        <SpaceChangeDialog target={target} spaceName={name} canPush={!data.primary}
          request={{ action: dialog.action, groups: [dialog.domain] }}
          onClose={() => { setDialog(null); }}
          onApplied={(result) => {
            if (!active.current) return;
            queryClient.setQueryData(detailKey, result.detail);
            setFeedback({ tone: 'success', text: t('st.spaces.applied', { count: result.applied.length }) });
          }} />
      )}
    </div>
  );
}

const CHANGE_BUTTON = 'shrink-0 rounded px-1 py-0.5 text-[12px] font-medium text-ink-soft outline-none transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink';
