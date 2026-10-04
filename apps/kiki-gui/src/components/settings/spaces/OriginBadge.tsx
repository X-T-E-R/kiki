import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { SpaceMutationResponse } from '@kiki/protocol';

import type { KikiConfigResponse } from '../../../lib/client';

import { useI18n } from '../../../i18n';
import { readSpacePreferenceDetail } from '../../../lib/spaceAuthority';
import {
  spaceConfigItemId,
  spaceItem,
  spaceSettingsKeys,
  spaceSettingsTargetOf,
  spaceSettingsClientKey,
} from '../../../lib/spaceSettings';
import { configOrigins, originOf } from '../../../lib/spaces';
import { useConnection } from '../../../state/connection';
import { SpaceChangeDialog } from './SpaceChangeDialog';

/**
 * §9.3 source mark for one setting, shown only inside an independent space.
 * From the main space: a quiet "From main space". Set here: an accent
 * "This space" chip with Restore inheritance.
 *
 * Restoring is a space change like any other: the server plans it, the person
 * confirms the list, and only then is the setting written back to following —
 * the same panel the rest of this surface uses. Deleting the key from the
 * space's config.toml would leave the space still holding the setting for
 * itself, so this never claims the setting follows until the server says so.
 */
export function OriginBadge(props: Parameters<typeof OriginBadgeContext>[0]) {
  const { client, meta } = useConnection();
  const target = spaceSettingsTargetOf(client, meta);
  return <OriginBadgeContext key={`${spaceSettingsClientKey(client)}|${target?.identity.serverId ?? 'unidentified'}|${target?.identity.homeId ?? 'unidentified'}`} {...props} />;
}

function OriginBadgeContext({ config, domain, keyPath = [], label }: {
  config: KikiConfigResponse | undefined;
  /** Snake-case config domain as the wire uses it (`default_model`, `subagent`). */
  domain: string;
  /** Leaf path inside the domain; empty for a scalar domain. */
  keyPath?: readonly string[];
  /** Setting name for the restore button's accessible label. */
  label: string;
}) {
  const { client, meta } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const target = spaceSettingsTargetOf(client, meta);
  const identity = target?.identity ?? null;
  const spaceId = identity?.homeId ?? 'unidentified';
  const inSpace = spaceId !== 'main';
  const serverId = identity?.serverId;
  // One entry per server and home: a read from another server is never this
  // one's, and an unidentified connection keeps its own slot.
  const detailKey = [...spaceSettingsKeys.detail(spaceId), serverId ?? 'unidentified'];
  const [restoring, setRestoring] = useState(false);
  const itemId = spaceConfigItemId(domain, keyPath);

  const detail = useQuery({
    queryKey: detailKey,
    queryFn: async ({ signal }) => {
      if (identity === null) throw new Error('Space server is unidentified');
      const next = await readSpacePreferenceDetail(client, identity);
      signal.throwIfAborted();
      return next;
    },
    enabled: inSpace && identity !== null,
    staleTime: 10_000,
    retry: false,
  });

  if (!inSpace) return null;
  const origin = originOf(configOrigins(config), domain, keyPath.join('.'));
  if (origin === undefined || origin === 'default' || origin === 'memory') return null;

  if (origin === 'env') {
    return <span data-origin="env" className="text-[11.5px] text-ink-faint">{t('st.origin.env')}</span>;
  }
  if (origin === 'base') {
    return <span data-origin="base" className="text-[11.5px] text-ink-faint">{t('st.origin.inherited')}</span>;
  }

  const chip = (
    <span className="inline-flex items-center gap-1 rounded-[4px] bg-ink/[0.05] px-1.5 text-[11px] leading-4 font-medium text-ink-soft">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ink-faint" />{t('st.origin.local')}
    </span>
  );

  // The space's own settings list is what a restore acts on, so the mark waits
  // for it: until it answers, and when it does not hold this path at all, the
  // chip stays a statement about the config file and no change is offered.
  const row = detail.data === undefined ? undefined : spaceItem(detail.data, itemId);
  if (row === undefined) {
    // A failed read offers a retry; a server that has not identified itself
    // cannot be read at all, and says only that the mark's source is unknown.
    const unknown = detail.isError || identity === null;
    return (
      <span data-origin="home" data-origin-unavailable={itemId} className="inline-flex flex-wrap items-center gap-1.5">
        {chip}
        <span className="text-[11.5px] text-ink-faint">
          {t(unknown ? 'st.spaces.origin.unknown' : detail.data === undefined ? 'st.spaces.origin.reading' : 'st.spaces.origin.notListed')}
        </span>
        {detail.isError ? (
          <button type="button"
            className="rounded px-1 text-[11.5px] text-ink-soft underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
            onClick={() => { void detail.refetch(); }}>
            {t('st.spaces.origin.retry')}
          </button>
        ) : null}
      </span>
    );
  }

  const applied = (result: SpaceMutationResponse) => {
    queryClient.setQueryData(detailKey, result.detail);
    void queryClient.invalidateQueries({ queryKey: detailKey });
    // The space's config.toml changed underneath the config page too.
    void queryClient.invalidateQueries({ queryKey: ['config'] });
  };

  return (
    <span data-origin="home" className="inline-flex flex-wrap items-center gap-1.5">
      {chip}
      <button type="button" data-origin-restore={itemId} disabled={restoring}
        aria-label={t('st.origin.restoreAria', { name: label })}
        onClick={() => { setRestoring(true); }}
        className="rounded px-1 text-[11.5px] text-ink-soft underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink disabled:opacity-50">
        {t('st.origin.restore')}
      </button>
      {restoring && target !== null ? (
        <SpaceChangeDialog target={target} spaceName={label} canPush={false}
          request={{ action: 'follow', items: [itemId] }}
          onClose={() => { setRestoring(false); }}
          onApplied={applied} />
      ) : null}
    </span>
  );
}
