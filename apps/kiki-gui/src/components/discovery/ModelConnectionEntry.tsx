/**
 * ModelConnectionEntry — the model connection as one compact row, wherever the
 * guide meets it: the welcome's closing page and the tour's own map.
 *
 * The state is the server's own — the `auth` summary and the provider list, the
 * same two probes the App shell's auto-popup rule reads. "Ready" means a
 * connection exists; a probe still in flight, or one that failed, says exactly
 * that instead of guessing, and the row still offers the real page.
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

export type ModelConnectionState = 'checking' | 'ready' | 'missing' | 'unknown';

export interface ModelConnectionInfo {
  readonly state: ModelConnectionState;
  /** Save a connection exists; a probe may still be running or have failed. */
  readonly connected: boolean;
  /** The model the server names as the current default, when it names one. */
  readonly model: string | null;
}

/**
 * A saved connection outranks a probe problem: the row reads "connected" from
 * either probe's success, because that connection is the fact the user cares
 * about.
 */
export function useModelConnection(): ModelConnectionInfo {
  const { client } = useConnection();
  const authQuery = useQuery({ queryKey: ['auth'], queryFn: () => client.getAuth(), staleTime: 10_000 });
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });

  const connected = authQuery.data?.ready === true || (providersQuery.data?.items.length ?? 0) > 0;
  const failed = authQuery.isError || providersQuery.isError;
  const checking = authQuery.isPending || providersQuery.isPending;
  const state: ModelConnectionState = connected ? 'ready' : failed ? 'unknown' : checking ? 'checking' : 'missing';

  return { state, connected, model: authQuery.data?.default_model ?? null };
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
    : info.state === 'checking'
      ? t('discovery.model.checking')
      : info.state === 'unknown'
        ? t('discovery.model.unknown')
        : t('discovery.model.missing');

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
        {t(info.state === 'missing' ? 'discovery.model.connect' : 'discovery.model.manage')}
        <Icon name="arrowUpRight" size={12} />
      </button>
    </div>
  );
}
