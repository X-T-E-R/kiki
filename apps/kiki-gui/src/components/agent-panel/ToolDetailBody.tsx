/**
 * One tool's full detail: name and state, the notices that explain its state,
 * its description and its parameter schema. The detail drawer renders it for
 * `kind: 'tool'` and a capability group renders the same body in place, so a
 * tool reads the same wherever it is opened from.
 */

import { useI18n } from '../../i18n';
import { CapabilityStateBadge } from './CapabilityStateBadge';
import { capabilityReasonText } from './mapCapabilities';
import { toolCategoryLabel } from './ToolChipList';
import type { AgentToolCapability } from './types';

/**
 * One tool's full detail: name and state, the notices that explain its state,
 * its description and its parameter schema. The drawer renders it for
 * `kind: 'tool'`; a group panel reuses the same body so a tool reads the same
 * wherever it is opened from.
 */
export function ToolDetailBody({ tool }: { readonly tool: AgentToolCapability }) {
  const { t } = useI18n();
  const reason = capabilityReasonText(t, tool.unavailableReasonCode, tool.unavailableReason);
  return (
    <div data-tool-detail className="space-y-3">
      {/* Title & Badges */}
      <div className="border-b border-hairline pb-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-mono text-[15px] font-semibold text-ink">
            {tool.name}
          </h3>
          <div className="flex items-center gap-1.5 shrink-0">
            {tool.readOnly ? (
              <span className="px-0.5 text-[11px] font-mono font-medium text-accent-ink">
                {t('agentPanel.readOnly')}
              </span>
            ) : null}
            <CapabilityStateBadge state={tool.state} />
          </div>
        </div>
        <div className="mt-1 font-mono text-[11px] text-ink-faint">
          {toolCategoryLabel(t, tool.category || t('agentPanel.generalCategory'))}
        </div>
      </div>

      {/* Notices / Human Explanation */}
      {tool.state === 'approval-required' && (
        <div className="rounded-lg border border-amber-rule/40 bg-amber-card/50 p-2 text-[11px] text-amber-ink">
          {t('agentPanel.approvalNotice')}
        </div>
      )}
      {reason !== undefined && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-2 text-[11px] text-danger">
          {t('agentPanel.unavailableReason', { reason })}
        </div>
      )}
      {tool.readOnly && (
        <div className="rounded-lg border border-hairline bg-paper/60 p-2 text-[11px] text-ink-soft">
          {t('agentPanel.readOnlyNotice')}
        </div>
      )}

      {/* Description */}
      {tool.description ? (
        <div className="space-y-1">
          <div className="font-mono text-[11px] font-semibold uppercase text-ink-faint">
            {t('agentPanel.profileDescription')}
          </div>
          <p className="text-ink leading-relaxed">{tool.description}</p>
        </div>
      ) : null}

      {/* Parameters Schema */}
      <details open className="space-y-1">
        <summary className="font-mono text-[11px] font-semibold uppercase text-ink-faint cursor-pointer select-none">
          {t('agentPanel.parametersSchema')}
        </summary>
        <pre className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-hairline bg-paper/60 p-2 font-mono text-[11px] leading-snug text-ink-soft whitespace-pre-wrap">
          {tool.parametersSchema ??
            tool.parametersSummary ??
            t('agentPanel.noParameters')}
        </pre>
      </details>
    </div>
  );
}
