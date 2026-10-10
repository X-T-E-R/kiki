/**
 * ModelConnectionEntry — the model connection as one compact row, wherever the
 * guide meets it: the tour's own map, next to "start with a real task".
 *
 * The state is the server's own: readiness comes from the `auth` summary's
 * `ready` flag, and the provider list only says whether a connection is saved.
 * A saved connection is not a usable one — a managed sign-in can be configured
 * while its login chain is not — so a provider record never upgrades the row to
 * "ready". A probe still in flight says it is checking; a failed probe, or one
 * that cannot tell saved from missing, says it could not read the connection
 * instead of guessing. The row still offers the real page in every state.
 *
 * Nothing is configured here. The row opens the existing Connections card in
 * Settings, which already owns account sign-in and the API-key form, so there
 * stays one place that writes a provider and the current model and settings are
 * untouched until something is saved there.
 */

import { useQuery } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { Icon } from '../icons';

/** The Connections card: account sign-in, the API-key form, and the provider list. */
export const MODEL_SETTINGS_HREF = '/settings/ai?tab=providers#st-card-providers-add';

export type ModelConnectionState = 'checking' | 'ready' | 'configured' | 'missing' | 'unknown';

export interface ModelConnectionInfo {
  readonly state: ModelConnectionState;
  /** The model the server names as the current default, when a ready connection names one. */
  readonly model: string | null;
}

/**
 * Readiness is `auth.ready` and nothing else: that flag is the server's own
 * answer to "can a request run", and it is false for a configured connection
 * whose login is not usable. `providers` answers the different question of
 * whether a record is saved, which is what tells "nothing set up yet" apart
 * from "set up, but not usable right now".
 */
export function useModelConnection(): ModelConnectionInfo {
  const { client } = useConnection();
  const authQuery = useQuery({ queryKey: ['auth'], queryFn: () => client.getAuth(), staleTime: 10_000 });
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });

  const ready = authQuery.data?.ready === true;
  const failed = authQuery.isError || providersQuery.isError;
  const saved = (providersQuery.data?.items.length ?? 0) > 0;
  const state: ModelConnectionState = ready
    ? 'ready'
    : failed
      ? 'unknown'
      : authQuery.isPending || providersQuery.isPending
        ? 'checking'
        : saved
          ? 'configured'
          : 'missing';

  return { state, model: ready ? authQuery.data?.default_model ?? null : null };
}

const ROW_BUTTON =
  'inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-hairline bg-paper px-2 text-[12px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none';

export function ModelConnectionEntry({ info, onOpen }: {
  readonly info: ModelConnectionInfo;
  readonly onOpen: () => void;
}) {
  const { t } = useI18n();
  const line = info.state === 'ready'
    ? t('discovery.model.ready')
    : info.state === 'configured'
      ? t('discovery.model.configured')
      : info.state === 'checking'
        ? t('discovery.model.checking')
        : info.state === 'unknown'
          ? t('discovery.model.unknown')
          : t('discovery.model.missing');
  // A saved-but-unusable connection needs the same page as a missing one, but
  // "Connect a model" would misdescribe it: that record is already there.
  const action = info.state === 'missing'
    ? t('discovery.model.connect')
    : info.state === 'configured'
      ? t('discovery.model.review')
      : t('discovery.model.manage');

  return (
    <div
      data-model-connection={info.state}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
    >
      <div className="min-w-0">
        <p className="flex items-baseline gap-x-2 gap-y-0.5">
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink">
            <Icon name="settings" size={14} className="text-ink-faint" />
            {t('discovery.model.title')}
          </span>
          {info.state === 'ready' && info.model !== null ? (
            <span className="font-mono text-[11px] text-ink-faint">{info.model}</span>
          ) : null}
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-soft">{line}</p>
      </div>
      <button
        type="button"
        data-model-connection-open
        onClick={onOpen}
        className={ROW_BUTTON}
      >
        {action}
        <Icon name="arrowUpRight" size={12} />
      </button>
    </div>
  );
}
