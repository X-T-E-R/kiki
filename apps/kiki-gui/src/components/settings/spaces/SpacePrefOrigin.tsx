import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import type { SpaceDetail, SpacePlanRequest } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import {
  SPACE_ITEM_IDS,
  spaceItem,
  spaceSettingsApi,
  spaceSettingsKeys,
  type SpacePreferenceItem,
  type SpaceSettingsTarget,
  spaceSettingsTargetOf,
  spaceSettingsClientKey,
} from '../../../lib/spaceSettings';
import { readSpacePreferenceDetail } from '../../../lib/spaceAuthority';
import { useSpaceAuthorityState } from '../../../lib/spacePreferences';
import { backgroundIsDeviceOnly } from '../../../lib/skins/background';
import { useConnection } from '../../../state/connection';
import { Icon } from '../../icons';
import { SpaceChangeDialog } from './SpaceChangeDialog';
import { SpaceRowMenu } from './SpaceRowMenu';

/**
 * Where one setting's value comes from, next to the control it belongs to
 * (design §4.2, §5.2). A word and a menu — not a chip, not a dot, not a second
 * underline per row.
 *
 * It reads the space detail, the same fact the settings page reads, so the two
 * never disagree; the word is the space's own state, and a save the server has
 * not confirmed is shown as exactly that.
 */
interface SpacePrefOriginProps {
  item: SpacePreferenceItem;
  label: string;
}

export function SpacePrefOrigin(props: SpacePrefOriginProps) {
  const { client, meta } = useConnection();
  const target = spaceSettingsTargetOf(client, meta);
  return <SpacePrefOriginContext key={`${spaceSettingsClientKey(client)}|${target?.identity.serverId ?? 'unidentified'}|${target?.identity.homeId ?? 'unidentified'}`} target={target} {...props} />;
}

function SpacePrefOriginContext({ item, label, target }: SpacePrefOriginProps & { target: SpaceSettingsTarget | null }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const client = target?.client ?? null;
  const identity = target?.identity ?? null;
  const spaceId = identity?.homeId ?? 'unidentified';
  const inSpace = spaceId !== 'main';
  const serverId = identity?.serverId;
  // One entry per server and home, and an unidentified connection keeps its own
  // slot rather than borrowing a confirmed server's read.
  const detailKey = [...spaceSettingsKeys.detail(spaceId), serverId ?? 'unidentified'];
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [dialog, setDialog] = useState<SpacePlanRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [justSaved, setJustSaved] = useState(false);
  const authority = useSpaceAuthorityState();
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    if (!justSaved) return undefined;
    const timer = setTimeout(() => { setJustSaved(false); }, 2_500);
    return () => { clearTimeout(timer); };
  }, [justSaved]);

  const detail = useQuery({
    queryKey: detailKey,
    queryFn: async ({ signal }) => {
      if (identity === null || client === null) throw new Error('Space server is unidentified');
      // The authority-aware read, so a save that completed while this was in
      // flight is not undone by the answer.
      const next = await readSpacePreferenceDetail(client, identity);
      signal.throwIfAborted();
      return next;
    },
    enabled: inSpace && identity !== null,
    staleTime: 10_000,
    retry: false,
  });

  if (!inSpace) return null;
  if (detail.isError || identity === null) {
    return (
      <span data-pref-origin={`${item}-unknown`} className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-faint">
        {t('st.spaces.origin.unknown')}
        <button type="button" className="rounded px-1 underline decoration-hairline-strong underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
          onClick={() => { void detail.refetch(); }}>
          {t('st.spaces.settingsRetry')}
        </button>
      </span>
    );
  }

  const row = spaceItem(detail.data, SPACE_ITEM_IDS[item]);
  if (row === undefined) return null;

  const fixed = row.selection.mode === 'fixed';
  const stateText = fixed
    ? t(row.selection.reason === 'edited' ? 'st.spaces.origin.edited' : 'st.spaces.origin.fixed')
    : t('st.spaces.origin.follow');
  const write = authority.writes[item];
  const saving = busy || write?.state === 'saving';
  const writeError = write?.state === 'error' ? errorText(locale, write.error) : undefined;
  const deviceOnly = item === 'background' && backgroundIsDeviceOnly();

  const remember = (next: SpaceDetail) => {
    if (!active.current) return;
    queryClient.setQueryData(detailKey, next);
    void queryClient.invalidateQueries({ queryKey: detailKey });
  };

  const change = async (action: 'follow' | 'fixed' | 'push-to-main') => {
    if (client === null || identity === null) return;
    setBusy(true);
    setFailure(null);
    setJustSaved(false);
    const wireId = SPACE_ITEM_IDS[item];
    try {
      const api = spaceSettingsApi(client);
      const plan = await api.preview(spaceId, { action, items: [wireId] });
      if (!active.current) return;
      const rows = plan.rows.filter((candidate) => !candidate.id.startsWith('group:'));
      const blocked = rows.find((candidate) => candidate.blocked_reason !== undefined);
      if (blocked !== undefined || rows.length === 0) {
        setFailure(new Error(blocked?.blocked_reason ?? t('st.spaces.change.nothingToChange')));
        return;
      }
      // Fixing an item that already holds the target value needs no list to
      // read: it completes, and the space's own undo covers the way back.
      const only = rows[0]!;
      if (rows.length === 1 && only.same_value && !only.conflict) {
        const result = await api.apply(spaceId, { token: plan.token, selected: [only.id] });
        if (!active.current) return;
        remember(result.detail);
        setJustSaved(true);
        return;
      }
      setDialog({ action, items: [wireId] });
    } catch (error) {
      if (active.current) setFailure(error);
    } finally {
      if (active.current) setBusy(false);
    }
  };

  const menuItems = [
    ...(fixed
      ? [{ key: 'follow', label: t('st.spaces.origin.refollow'), run: () => { void change('follow'); } }]
      : [{ key: 'fixed', label: t('st.spaces.origin.fixHere'), run: () => { void change('fixed'); } }]),
    {
      key: 'push',
      label: t('st.spaces.origin.push'),
      separatorBefore: true,
      blockedReason: row.can_push ? undefined : t('st.spaces.blocked.notShareable'),
      run: () => { void change('push-to-main'); },
    },
  ];

  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5" data-pref-origin={`${item}-${fixed ? 'fixed' : 'follow'}`}>
      <span className="text-[11.5px] text-ink-faint">{stateText}</span>
      {row.pending ? <span className="text-[11.5px] text-amber-ink">{t('st.spaces.origin.restart')}</span> : null}
      {saving ? <span className="text-[11.5px] text-ink-faint">{t('st.spaces.origin.saving')}</span> : null}
      {!saving && justSaved ? <span className="text-[11.5px] text-ink-faint">{t('st.spaces.origin.saved')}</span> : null}
      {writeError === undefined ? null : (
        <span role="alert" className="flex items-center gap-1 text-[11.5px] text-danger">
          {t('st.spaces.origin.unsaved')}
          <span className="text-ink-faint">{writeError}</span>
        </span>
      )}
      <button type="button" data-pref-origin-menu={item} aria-haspopup="menu" aria-label={t('st.spaces.origin.menuAria', { name: label })}
        disabled={busy}
        className="flex h-5 w-5 items-center justify-center rounded text-ink-faint outline-none transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50"
        onClick={(event) => { setMenu(event.currentTarget.getBoundingClientRect()); }}>
        <Icon name="more" size={12} />
      </button>
      {deviceOnly ? (
        <span className="basis-full text-[11.5px] leading-4 text-ink-faint">
          {t('st.spaces.origin.deviceOnlyBackground')}{' '}
          <a data-pref-origin-packs href="/settings/appearance"
            className="rounded text-ink-soft underline decoration-hairline-strong underline-offset-2 outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink">
            {t('st.spaces.origin.backgroundPacks')}
          </a>
        </span>
      ) : null}
      {failure === null ? null : (
        <span role="alert" className="basis-full text-[11.5px] leading-4 text-danger">{errorText(locale, failure)}</span>
      )}

      {menu === null ? null : (
        <SpaceRowMenu anchor={menu} items={menuItems} ariaLabel={t('st.spaces.origin.menuAria', { name: label })}
          onClose={() => { setMenu(null); }} />
      )}
      {dialog === null || target === null ? null : (
        <SpaceChangeDialog target={target} spaceName={label} canPush={row.can_push}
          request={dialog}
          onClose={() => { setDialog(null); }}
          onApplied={(result) => { if (active.current) { remember(result.detail); setJustSaved(true); } }} />
      )}
    </span>
  );
}
