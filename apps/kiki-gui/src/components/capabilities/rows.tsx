/**
 * Row cards for the settings skills catalog and MCP status cards: one skill
 * card (name + two-line description + source badge + mono path) and one MCP
 * server row (status dot + transport/status/tool count + restart with the
 * settings page's feedback semantics). Formerly the /capabilities page rows.
 */

import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import type { McpServer, SkillDescriptor } from '@kiki/protocol';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { skillGroupId } from '../../lib/capabilities';
import { useConnection } from '../../state/connection';
import { FeedbackLine, type Feedback } from '../controls';
import { FilePathLink } from '../mediaPreview';
import { SkillPreviewButton } from './SkillPreviewButton';
import { SECONDARY_BUTTON } from '../ui';

const BADGE_CLASS =
  'shrink-0 rounded-full border border-hairline bg-panel px-1.5 py-px text-[9px] font-medium tracking-wide text-ink-faint uppercase';

export function SkillCard({ skill, sourceLabel }: { skill: SkillDescriptor; sourceLabel: string }) {
  const { t } = useI18n();
  const location = useLocation();
  return (
    <div className="rounded-lg border border-hairline bg-paper px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="min-w-0 truncate text-[13px] font-medium text-ink">{skill.name}</p>
        <span className={BADGE_CLASS}>{sourceLabel}</span>
        {skill.type ? (
          <span className="shrink-0 rounded bg-paper border border-hairline px-1.5 py-0.2 font-mono text-[9px] text-ink-soft">
            {skill.type}
          </span>
        ) : null}
        {skill.disable_model_invocation ? (
          <span className="shrink-0 rounded bg-amber-card border border-amber-rule/40 px-1.5 py-0.2 font-mono text-[9px] text-amber-ink">
            {t('agentPanel.disableModelInvocationBadge')}
          </span>
        ) : null}
        {skill.prompt_command ? (
          <span className="shrink-0 rounded bg-accent-soft px-1.5 py-0.2 font-mono text-[9px] text-accent">
            {t('agentPanel.promptCommandBadge')}
          </span>
        ) : null}
        {skillGroupId(skill.source) === 'plugin' ? (
          <Link
            to={{ pathname: '/settings/plugins', search: location.search }}
            className="shrink-0 text-[10px] font-medium text-accent hover:underline"
          >
            {t('st.plugins.manageLink')}
          </Link>
        ) : null}
      </div>
      {skill.argument_hint ? (
        <p className="mt-1 font-mono text-[10px] text-ink-soft bg-paper/60 rounded px-1.5 py-0.5 border border-hairline inline-block">
          {skill.argument_hint}
        </p>
      ) : null}
      {skill.description !== '' ? (
        <p className="mt-1 text-[11px] leading-snug text-ink-soft whitespace-pre-wrap">
          {skill.description}
        </p>
      ) : null}
      <div className="mt-1 truncate font-mono text-[10px] text-ink-faint">
        {skill.source === 'builtin' ? skill.path : <FilePathLink path={skill.path} />}
      </div>
      <SkillPreviewButton skill={skill} />
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
              {server.transport} · {t(`st.mcp.status.${server.status}`)} · {t('st.mcp.toolsCount', { count: server.tool_count })}
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
        <div className="mt-1.5 space-y-1 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-2">
          <p className="break-all font-mono text-[11px] leading-snug text-danger">
            {server.last_error}
          </p>
          <p className="text-[11px] text-ink-soft">{t('st.mcp.errorHint')}</p>
        </div>
      ) : null}
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
