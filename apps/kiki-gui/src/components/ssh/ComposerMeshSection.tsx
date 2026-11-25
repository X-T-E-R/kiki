/**
 * Compact session Mesh section rendered inside the upward `[data-composer-ssh-list]`
 * popover when this session holds pinned Mesh targets (nodes, seats, COW copies)
 * or active loopback port tunnels. Zero defensive prose, zero UI Emoji.
 */

import { useI18n } from '../../i18n';
import {
  formatCopyLabel,
  formatTunnelEndpoint,
  type HumanTakeoverLease,
  type LeasedPortTunnel,
  type MeshLeaseUnpinInput,
  type MeshSessionLease,
} from '../../lib/mesh';
import { Icon } from '../icons';

const ROW_ACTION_BUTTON =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-8 pointer-coarse:w-8';

function TakeoverMark({ lease }: { readonly lease: HumanTakeoverLease | undefined }) {
  const { t } = useI18n();
  if (lease === undefined) return null;
  const label = lease.reason !== undefined && lease.reason.trim() !== ''
    ? `${t('composer.mesh.humanControlling')} · ${lease.reason}`
    : t('composer.mesh.humanControlling');
  return (
    <span
      data-composer-mesh-takeover="human"
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 items-center text-amber-ink"
    >
      <Icon name="lock" size={12} />
    </span>
  );
}

export function ComposerMeshSection({
  lease,
  humanTakeovers,
  pendingKeys,
  onUnpin,
  onCloseTunnel,
}: {
  readonly lease: MeshSessionLease;
  readonly humanTakeovers: ReadonlyMap<string, HumanTakeoverLease>;
  readonly pendingKeys: ReadonlySet<string>;
  readonly onUnpin: (kind: MeshLeaseUnpinInput['kind'], id: string, label: string) => void;
  readonly onCloseTunnel: (tunnel: LeasedPortTunnel) => void;
}) {
  const { t } = useI18n();
  const hasPinnedTargets =
    lease.nodes.length > 0 || lease.seats.length > 0 || lease.workspaceCopies.length > 0;
  const hasTunnels = lease.portTunnels.length > 0;

  if (!hasPinnedTargets && !hasTunnels) return null;

  return (
    <div data-composer-mesh-section className="divide-y divide-hairline/50">
      {hasPinnedTargets ? (
        <div className="pb-1">
          <p className="px-3 pt-1.5 pb-1 text-[12px] font-normal text-ink-faint">
            {t('composer.mesh.pinnedHeading')}
          </p>
          <div className="divide-y divide-hairline/40">
            {lease.nodes.map((node) => {
              const key = `node:${node.nodeId}`;
              const isBusy = pendingKeys.has(key);
              const takeover = humanTakeovers.get(node.nodeId);
              const detail = node.platform !== undefined ? `${node.nodeId} · ${node.platform}` : node.nodeId;
              return (
                <div
                  key={key}
                  data-composer-mesh-item={key}
                  className={`flex items-center justify-between gap-2 px-3 py-1.5 text-[13px] ${isBusy ? 'opacity-60' : ''}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Icon name="cpu" size={12} className="text-ink-faint" />
                      <span className="truncate font-normal text-ink">{node.label}</span>
                      {node.state === 'offline' ? (
                        <span
                          role="img"
                          aria-label={t('composer.mesh.nodeOffline')}
                          title={t('composer.mesh.nodeOffline')}
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
                        />
                      ) : node.state === 'degraded' ? (
                        <span
                          role="img"
                          aria-label={t('composer.mesh.nodeDegraded')}
                          title={t('composer.mesh.nodeDegraded')}
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-rule"
                        />
                      ) : null}
                      <TakeoverMark lease={takeover} />
                    </div>
                    {detail !== node.label ? (
                      <div className="mt-0.5 truncate pl-[18px] font-mono text-[11px] leading-4 text-ink-faint">
                        {detail}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    data-composer-mesh-unpin={key}
                    aria-label={t('composer.mesh.unpin', { name: node.label })}
                    title={t('composer.mesh.unpin', { name: node.label })}
                    disabled={isBusy}
                    onClick={() => onUnpin('node', node.nodeId, node.label)}
                    className={ROW_ACTION_BUTTON}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              );
            })}

            {lease.seats.map((seat) => {
              const key = `seat:${seat.seatId}`;
              const isBusy = pendingKeys.has(key);
              const takeover = humanTakeovers.get(seat.seatId) ?? humanTakeovers.get(seat.nodeId);
              const stateLabel =
                seat.state === 'running' ? t('composer.mesh.seatRunning')
                  : seat.state === 'blocked' ? t('composer.mesh.seatBlocked')
                  : seat.state === 'failed' ? t('composer.mesh.seatFailed')
                  : seat.state === 'offline' ? t('composer.mesh.seatOffline')
                  : undefined;
              const stateDot =
                seat.state === 'running' ? 'bg-accent'
                  : seat.state === 'blocked' ? 'bg-amber-rule'
                  : seat.state === 'failed' || seat.state === 'offline' ? 'bg-danger'
                  : undefined;
              return (
                <div
                  key={key}
                  data-composer-mesh-item={key}
                  className={`flex items-center justify-between gap-2 px-3 py-1.5 text-[13px] ${isBusy ? 'opacity-60' : ''}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Icon name="agent" size={12} className="text-ink-faint" />
                      <span className="truncate font-normal text-ink">{seat.label}</span>
                      {stateDot !== undefined && stateLabel !== undefined ? (
                        <span
                          role="img"
                          aria-label={stateLabel}
                          title={stateLabel}
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateDot}`}
                        />
                      ) : null}
                      <TakeoverMark lease={takeover} />
                    </div>
                    <div className="mt-0.5 truncate pl-[18px] font-mono text-[11px] leading-4 text-ink-faint">
                      {stateLabel !== undefined ? `${seat.nodeId} · ${stateLabel}` : seat.nodeId}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-composer-mesh-unpin={key}
                    aria-label={t('composer.mesh.unpin', { name: seat.label })}
                    title={t('composer.mesh.unpin', { name: seat.label })}
                    disabled={isBusy}
                    onClick={() => onUnpin('seat', seat.seatId, seat.label)}
                    className={ROW_ACTION_BUTTON}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              );
            })}

            {lease.workspaceCopies.map((copy) => {
              const key = `workspace_copy:${copy.copyId}`;
              const label = formatCopyLabel(copy);
              const isBusy = pendingKeys.has(key);
              const takeover = humanTakeovers.get(copy.nodeId);
              return (
                <div
                  key={key}
                  data-composer-mesh-item={key}
                  className={`flex items-center justify-between gap-2 px-3 py-1.5 text-[13px] ${isBusy ? 'opacity-60' : ''}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Icon name="copy" size={12} className="text-ink-faint" />
                      <span className="truncate font-normal text-ink" title={copy.sourceRoot}>
                        {label}
                      </span>
                      {copy.dirty ? (
                        <span
                          role="img"
                          aria-label={t('composer.mesh.copyDirty')}
                          title={t('composer.mesh.copyDirty')}
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-rule"
                        />
                      ) : null}
                      <TakeoverMark lease={takeover} />
                    </div>
                    <div className="mt-0.5 truncate pl-[18px] font-mono text-[11px] leading-4 text-ink-faint">
                      {`${copy.nodeId} · ${copy.strategy}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-composer-mesh-unpin={key}
                    aria-label={t('composer.mesh.unpin', { name: label })}
                    title={t('composer.mesh.unpin', { name: label })}
                    disabled={isBusy}
                    onClick={() => onUnpin('workspace_copy', copy.copyId, label)}
                    className={ROW_ACTION_BUTTON}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {hasTunnels ? (
        <div data-composer-mesh-tunnels className="pb-1">
          <p className="px-3 pt-1.5 pb-1 text-[12px] font-normal text-ink-faint">
            {t('composer.mesh.tunnelsHeading')}
          </p>
          <div className="divide-y divide-hairline/40">
            {lease.portTunnels.map((tunnel) => {
              const endpoint = formatTunnelEndpoint(tunnel);
              const busyKey = `tunnel:${tunnel.tunnelId}`;
              const isBusy = pendingKeys.has(busyKey);
              const detail =
                tunnel.remoteHost !== '' && tunnel.remoteHost !== '127.0.0.1'
                  ? `${tunnel.nodeId} · ${tunnel.remoteHost}`
                  : tunnel.nodeId;
              return (
                <div
                  key={tunnel.tunnelId}
                  data-composer-mesh-tunnel={tunnel.tunnelId}
                  className={`flex items-center justify-between gap-2 px-3 py-1.5 text-[12px] ${isBusy ? 'opacity-60' : ''}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Icon name="arrowUpRight" size={12} className="text-ink-faint" />
                      <span className="truncate font-mono font-normal text-ink tabular-nums">
                        {endpoint}
                      </span>
                      {!tunnel.healthy ? (
                        <span
                          role="img"
                          aria-label={t('composer.mesh.tunnelUnhealthy')}
                          title={t('composer.mesh.tunnelUnhealthy')}
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
                        />
                      ) : null}
                    </div>
                    <div className="mt-0.5 truncate pl-[18px] font-mono text-[11px] leading-4 text-ink-faint">
                      {detail}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-composer-mesh-tunnel-close={tunnel.tunnelId}
                    aria-label={t('composer.mesh.closeTunnel', { endpoint })}
                    title={t('composer.mesh.closeTunnel', { endpoint })}
                    disabled={isBusy}
                    onClick={() => onCloseTunnel(tunnel)}
                    className={ROW_ACTION_BUTTON}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
