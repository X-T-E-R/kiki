/**
 * Row cards for the settings skills catalog and MCP status cards: one skill
 * card (name + two-line description + source badge + mono path) and one MCP
 * server row (status dot + transport/status/tool count + restart with the
 * settings page's feedback semantics). Formerly the /capabilities page rows.
 */

import { useState } from 'react';

import type { McpServer, SkillDescriptor } from '@moonshot-ai/protocol';

import { useI18n } from '../../i18n';
import { errorText } from '../../i18n/locale';
import { useConnection } from '../../state/connection';
import { FeedbackLine, type Feedback } from '../controls';
import { SECONDARY_BUTTON } from '../ui';

const BADGE_CLASS =
  'shrink-0 rounded-full border border-hairline bg-panel px-1.5 py-px text-[9px] font-medium tracking-wide text-ink-faint uppercase';

export function SkillCard({ skill, sourceLabel }: { skill: SkillDescriptor; sourceLabel: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-paper px-3 py-2">
      <div className="flex items-center gap-2">
        <p className="min-w-0 truncate text-[13px] font-medium text-ink">{skill.name}</p>
        <span className={BADGE_CLASS}>{sourceLabel}</span>
      </div>
      {skill.description !== '' ? (
        <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-soft">
          {skill.description}
        </p>
      ) : null}
      <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint" title={skill.path}>
        {skill.path}
      </p>
    </div>
  );
}

/** Status dot colors mirror the sidebar/connection pill semantics. */
function statusDotClass(status: McpServer['status']): string {
  switch (status) {
    case 'connected':
      return 'bg-success';
    case 'connecting':
      return 'status-dot-busy bg-amber-rule';
    case 'error':
      return 'bg-danger';
    case 'disconnected':
      return 'border border-hairline-strong bg-panel';
  }
}

export function McpServerRow({ server }: { server: McpServer }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [restarting, setRestarting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const restart = async () => {
    setRestarting(true);
    setFeedback(null);
    try {
      await client.restartMcpServer(server.id);
      setFeedback({ tone: 'success', text: t('st.mcp.restartRequested') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="rounded-lg border border-hairline bg-paper px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            title={server.status}
            className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(server.status)}`}
          />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-ink">{server.name}</p>
            <p className="truncate font-mono text-[10.5px] text-ink-faint">
              {server.transport} · {server.status} · {t('st.mcp.toolsCount', { count: server.tool_count })}
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={restarting}
          onClick={() => void restart()}
          className={SECONDARY_BUTTON}
        >
          {restarting ? t('st.mcp.restarting') : t('st.mcp.restart')}
        </button>
      </div>
      {server.last_error !== undefined && server.last_error !== '' ? (
        <p className="mt-1 truncate font-mono text-[10px] text-danger/80" title={server.last_error}>
          {server.last_error}
        </p>
      ) : null}
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
