import { memo } from 'react';
import { useI18n } from '../../i18n';
import { Dialog } from '../Dialog';
import { FilePathLink } from '../mediaPreview';
import { SkillContentCollapse } from '../capabilities/SkillContentCollapse';
import { ProfileDetailSections } from './ProfileDetailSections';
import type {
  AgentIdentity,
  AgentToolCapability,
  AgentSkillCapability,
  AgentSubagentTarget,
  CapabilityState,
} from './types';

export type DetailDrawerTarget =
  | { readonly kind: 'profile'; readonly identity: AgentIdentity }
  | { readonly kind: 'tool'; readonly tool: AgentToolCapability }
  | { readonly kind: 'skill'; readonly skill: AgentSkillCapability }
  | { readonly kind: 'subagent'; readonly target: AgentSubagentTarget };

export interface AgentDetailDrawerProps {
  readonly target: DetailDrawerTarget | null;
  readonly onClose: () => void;
}

function stateBadgeClass(state: CapabilityState): string {
  switch (state) {
    case 'enabled':
      return 'bg-success/15 text-success border border-success/30';
    case 'approval-required':
      return 'bg-amber-card text-amber-ink border border-amber-rule/40';
    case 'disabled':
      return 'bg-paper text-ink-faint border border-hairline';
    case 'disconnected':
      return 'bg-danger/10 text-danger border border-danger/30';
    case 'unknown':
    default:
      return 'bg-paper text-ink-faint border border-hairline';
  }
}

export const AgentDetailDrawer = memo(function AgentDetailDrawer({
  target,
  onClose,
}: AgentDetailDrawerProps) {
  const { t } = useI18n();

  if (!target) return null;

  const stateLabels: Readonly<Record<CapabilityState, string>> = {
    enabled: t('agentPanel.capability.enabled'),
    'approval-required': t('agentPanel.capability.approvalRequired'),
    disabled: t('agentPanel.capability.disabled'),
    disconnected: t('agentPanel.capability.disconnected'),
    unknown: t('agentPanel.capability.unknown'),
  };

  let title = t('agentPanel.detailTitle');
  let categoryLabel = '';

  if (target.kind === 'profile') {
    title = t('agentPanel.profileDetail');
    categoryLabel = target.identity.profile;
  } else if (target.kind === 'tool') {
    title = t('agentPanel.toolDetail');
    categoryLabel = target.tool.category || t('agentPanel.generalCategory');
  } else if (target.kind === 'skill') {
    title = t('agentPanel.skillDetail');
    categoryLabel =
      target.skill.scope === 'workspace'
        ? t('agentPanel.scopeWorkspace')
        : t('agentPanel.scopeGlobal');
  } else if (target.kind === 'subagent') {
    title = t('agentPanel.subagentDetail');
    categoryLabel = target.target.executor;
  }

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={title}
      overlayId="agent-panel-detail-drawer"
      overlayClassName="fixed inset-0 z-50 flex justify-end bg-shell/40 backdrop-blur-[2px]"
      panelClassName="anim-enter h-full w-full max-w-full sm:max-w-[420px] bg-panel border-l border-hairline shadow-2xl flex flex-col overflow-hidden outline-none font-sans text-ink"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3 bg-paper/40 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            {title}
          </span>
          {categoryLabel ? (
            <span className="rounded bg-paper border border-hairline px-1.5 py-0.2 font-mono text-[10px] text-ink-soft truncate">
              {categoryLabel}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          data-autofocus
          onClick={onClose}
          aria-label={t('agentPanel.detailClose')}
          className="rounded-md border border-hairline px-2 py-0.5 text-[12px] font-mono text-ink-soft hover:bg-paper hover:text-ink transition-colors cursor-pointer"
        >
          ×
        </button>
      </div>

      {/* Body content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-[12px] leading-relaxed">
        {target.kind === 'profile' && (
          <ProfileDetailSections identity={target.identity} />
        )}

        {target.kind === 'tool' && (
          <div data-tool-detail className="space-y-3.5">
            {/* Title & Badges */}
            <div className="border-b border-hairline pb-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-[15px] font-semibold text-ink">
                  {target.tool.name}
                </h3>
                <div className="flex items-center gap-1.5 shrink-0">
                  {target.tool.readOnly ? (
                    <span className="rounded bg-accent-soft px-1.5 py-0.2 text-[9.5px] font-mono text-accent">
                      {t('agentPanel.readOnly')}
                    </span>
                  ) : null}
                  <span
                    className={`rounded px-1.5 py-0.2 font-mono text-[9.5px] ${stateBadgeClass(
                      target.tool.state,
                    )}`}
                  >
                    {stateLabels[target.tool.state]}
                  </span>
                </div>
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-ink-faint">
                {target.tool.category || t('agentPanel.generalCategory')}
              </div>
            </div>

            {/* Notices / Human Explanation */}
            {target.tool.state === 'approval-required' && (
              <div className="rounded-lg border border-amber-rule/40 bg-amber-card/50 p-2.5 text-[11px] text-amber-ink">
                {t('agentPanel.approvalNotice')}
              </div>
            )}
            {target.tool.unavailableReason && (
              <div className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-[11px] text-danger">
                {t('agentPanel.unavailableReason', { reason: target.tool.unavailableReason })}
              </div>
            )}
            {target.tool.readOnly && (
              <div className="rounded-lg border border-hairline bg-paper/60 p-2 text-[11px] text-ink-soft">
                {t('agentPanel.readOnlyNotice')}
              </div>
            )}

            {/* Description */}
            {target.tool.description ? (
              <div className="space-y-1">
                <div className="font-mono text-[10px] font-semibold uppercase text-ink-faint">
                  {t('agentPanel.profileDescription')}
                </div>
                <p className="text-ink leading-relaxed">{target.tool.description}</p>
              </div>
            ) : null}

            {/* Parameters Schema */}
            <details open className="space-y-1">
              <summary className="font-mono text-[10px] font-semibold uppercase text-ink-faint cursor-pointer select-none">
                {t('agentPanel.parametersSchema')}
              </summary>
              <pre className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-hairline bg-paper/60 p-2.5 font-mono text-[10px] leading-snug text-ink-soft whitespace-pre-wrap">
                {target.tool.parametersSchema ??
                  target.tool.parametersSummary ??
                  t('agentPanel.noParameters')}
              </pre>
            </details>
          </div>
        )}

        {target.kind === 'skill' && (
          <div data-skill-detail className="space-y-3.5">
            {/* Title & Badges */}
            <div className="border-b border-hairline pb-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-[15px] font-semibold text-ink flex items-center gap-1.5">
                  <span>{target.skill.scope === 'workspace' ? '⚡' : '🌐'}</span>
                  <span>{target.skill.name}</span>
                </h3>
                <span
                  className={`rounded px-1.5 py-0.2 font-mono text-[9.5px] ${stateBadgeClass(
                    target.skill.state,
                  )}`}
                >
                  {stateLabels[target.skill.state]}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-ink-faint">
                {target.skill.scope === 'workspace'
                  ? t('agentPanel.scopeWorkspace')
                  : t('agentPanel.scopeGlobal')}
              </div>
            </div>

            {/* Notices */}
            {target.skill.unavailableReason && (
              <div className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-[11px] text-danger">
                {target.skill.unavailableReason}
              </div>
            )}

            {/* Description */}
            {target.skill.description ? (
              <div className="space-y-1">
                <div className="font-mono text-[10px] font-semibold uppercase text-ink-faint">
                  {t('agentPanel.profileDescription')}
                </div>
                <p className="text-ink leading-relaxed">{target.skill.description}</p>
              </div>
            ) : null}

            {/* Path & Hints */}
            <dl className="grid grid-cols-1 gap-2 font-mono text-[10.5px] bg-paper/50 rounded-lg p-2.5 border border-hairline">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-faint">{t('agentPanel.scope')}</dt>
                <dd className="text-ink">
                  {target.skill.scope === 'workspace'
                    ? t('agentPanel.scopeWorkspace')
                    : t('agentPanel.scopeGlobal')}
                </dd>
              </div>
              {target.skill.type ? (
                <div className="flex items-baseline justify-between gap-2 pt-1 border-t border-hairline">
                  <dt className="text-ink-faint">{t('agentPanel.skillTypeLabel')}</dt>
                  <dd className="text-ink">{target.skill.type}</dd>
                </div>
              ) : null}
              {target.skill.disableModelInvocation ? (
                <div className="flex items-baseline justify-between gap-2 pt-1 border-t border-hairline">
                  <dt className="text-ink-faint">{t('agentPanel.disableModelInvocationBadge')}</dt>
                  <dd className="text-amber-ink font-semibold">{t('agentPanel.disableModelInvocationBadge')}</dd>
                </div>
              ) : null}
              {target.skill.promptCommand ? (
                <div className="flex items-baseline justify-between gap-2 pt-1 border-t border-hairline">
                  <dt className="text-ink-faint">{t('agentPanel.promptCommandBadge')}</dt>
                  <dd className="text-accent font-semibold">{t('agentPanel.promptCommandBadge')}</dd>
                </div>
              ) : null}
              {target.skill.path ? (
                <div className="flex flex-col gap-0.5 pt-1 border-t border-hairline">
                  <dt className="text-ink-faint">{t('agentPanel.fileLabel')}</dt>
                  <dd className="text-ink-soft break-all text-[10px]">
                    <FilePathLink path={target.skill.path} />
                  </dd>
                </div>
              ) : null}
              {target.skill.argumentHint ? (
                <div className="flex flex-col gap-0.5 pt-1 border-t border-hairline">
                  <dt className="text-ink-faint">{t('agentPanel.argumentHint')}</dt>
                  <dd className="text-ink-soft break-all text-[10px]">{target.skill.argumentHint}</dd>
                </div>
              ) : null}
            </dl>

            {target.skill.path ? (
              <SkillContentCollapse path={target.skill.path} />
            ) : null}
          </div>
        )}

        {target.kind === 'subagent' && (
          <div data-subagent-detail className="space-y-3.5">
            {/* Title & Status */}
            <div className="border-b border-hairline pb-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-[15px] font-semibold text-ink">
                  {target.target.profile}
                  {target.target.route ? ` / ${target.target.route}` : ''}
                </h3>
                <span
                  className={`rounded px-1.5 py-0.2 font-mono text-[9.5px] font-medium uppercase ${
                    target.target.launchAllowed !== false && target.target.defaultsAvailable
                      ? 'bg-success/15 text-success border border-success/30'
                      : 'bg-danger/10 text-danger border border-danger/30'
                  }`}
                >
                  {target.target.launchAllowed !== false && target.target.defaultsAvailable
                    ? t('agentPanel.allowed')
                    : t('agentPanel.blocked')}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-ink-faint">
                {t('agentPanel.executor', { value: target.target.executor })}
              </div>
            </div>

            {/* Admission Notices */}
            {target.target.launchAllowed !== false && target.target.defaultsAvailable ? (
              <div className="rounded-lg border border-success/30 bg-success/5 p-2.5 text-[11px] text-success">
                {t('agentPanel.launchAllowedNotice')}
              </div>
            ) : (
              <div className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-[11px] text-danger space-y-1">
                <p className="font-medium">{t('agentPanel.launchBlockedNotice')}</p>
                {target.target.launchUnavailableReason && (
                  <p className="text-[10.5px] opacity-90">{target.target.launchUnavailableReason}</p>
                )}
              </div>
            )}

            {target.target.executionRestriction === 'research-readonly' && (
              <div className="rounded-lg border border-hairline bg-paper/60 p-2 text-[11px] text-accent font-mono">
                {t('agentPanel.researchReadonly')}
              </div>
            )}

            {/* Metadata Fields */}
            <dl className="grid grid-cols-1 gap-2 font-mono text-[11px] bg-paper/50 rounded-lg p-2.5 border border-hairline">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-faint">{t('agentPanel.label.executor')}</dt>
                <dd className="font-medium text-ink">{target.target.executor}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-faint">{t('agentPanel.label.model')}</dt>
                <dd className="text-ink">{target.target.modelAlias ?? t('agentPanel.default')}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-faint">{t('agentPanel.label.effort')}</dt>
                <dd className="text-ink">{target.target.thinkingEffort ?? t('agentPanel.default')}</dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </Dialog>
  );
});
