/**
 * The settings side of a capability kind: one line saying what is there now
 * and a link to where it is managed. Settings keeps only server defaults;
 * installing, enabling and inspecting happen on the Capabilities page, so
 * this card reads the same queries and icons and never offers an action of
 * its own.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { Icon } from '../icons';
import { CapabilityIcon } from './CapabilityIcon';
import { useInstalledPlugins } from './usePlugins';

export type CapabilityLinkKind = 'plugins' | 'skills' | 'mcp';

/**
 * The one look of a "go to where this is managed" action: a paper-ink chip with
 * the same height, padding, hover and focus ring the rest of the settings
 * chrome uses. Exported so a settings leaf that offers the same move directly —
 * rather than through this component's summary line — is the same control, not
 * a second one that happens to sit near it.
 */
export const LINK_CLASS =
  'inline-flex min-h-8 items-center gap-1.5 rounded-md bg-ink/[0.06] px-3 text-[13px] font-medium text-ink transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.1] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink pointer-coarse:min-h-11';

export function CapabilityLink({ kind, workspaceId }: { readonly kind: CapabilityLinkKind; readonly workspaceId?: string }) {
  const { t, tp } = useI18n();
  const { client } = useConnection();
  const plugins = useInstalledPlugins();
  const mcp = useQuery({ queryKey: ['mcp-servers'], queryFn: () => client.listMcpServers(), staleTime: 15_000, enabled: kind === 'mcp' });
  const skills = useQuery({
    queryKey: ['workspace-skills', workspaceId ?? ''],
    queryFn: () => client.listWorkspaceSkills(workspaceId!),
    enabled: kind === 'skills' && workspaceId !== undefined && workspaceId !== '',
    staleTime: 60_000,
  });

  let summary: string;
  if (kind === 'plugins') {
    const list = plugins.data?.plugins ?? [];
    summary = plugins.isPending ? t('cap.loading') : list.length === 0 ? t('cap.plugins.noneInstalled')
      : tp('cap.link.plugins', list.length, { on: list.filter((plugin) => plugin.enabled).length });
  } else if (kind === 'mcp') {
    const list = mcp.data?.servers ?? [];
    const failing = list.filter((server) => server.status === 'error' || server.status === 'disconnected').length;
    summary = mcp.isPending ? t('cap.loading') : list.length === 0 ? t('cap.link.mcpNone')
      : failing > 0 ? tp('cap.link.mcpFailing', list.length, { failing }) : tp('cap.link.mcp', list.length);
  } else {
    const list = skills.data?.skills ?? [];
    summary = workspaceId === undefined || workspaceId === '' ? t('cap.noWorkspace')
      : skills.isPending ? t('cap.loading') : tp('cap.link.skills', list.length);
  }

  const target = kind === 'plugins' ? '/capabilities' : `/capabilities?tab=${kind}`;
  const icons = kind === 'plugins' ? (plugins.data?.plugins ?? []).slice(0, 5) : [];

  return (
    <div className="flex flex-wrap items-center justify-between gap-3" data-capability-link={kind}>
      <div className="flex min-w-0 items-center gap-3">
        {icons.length > 0 ? (
          <span className="flex shrink-0 -space-x-1.5" aria-hidden>
            {icons.map((plugin) => (
              <span key={plugin.id} className="rounded-[7px] ring-2 ring-paper"><CapabilityIcon icon={plugin.icon} size="sm" /></span>
            ))}
          </span>
        ) : null}
        <p className="min-w-0 text-[13px] leading-5 text-ink-soft">{summary}</p>
      </div>
      <Link to={target} className={LINK_CLASS} data-capability-link-open={kind}>
        {t(`cap.link.open.${kind}`)}
        <Icon name="arrowRight" size={14} />
      </Link>
    </div>
  );
}
