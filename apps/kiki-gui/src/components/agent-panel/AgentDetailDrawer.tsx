import { memo, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentCapabilityTarget } from '@kiki/protocol';
import { useI18n } from '../../i18n';
import { useOptionalConnection } from '../../state/connection';
import { Dialog } from '../Dialog';
import { FilePathLink } from '../mediaPreview';
import { SkillContentCollapse } from '../capabilities/SkillContentCollapse';
import { CapabilityStateBadge } from './CapabilityStateBadge';
import { ProfileDetailSections } from './ProfileDetailSections';
import { toolCategoryLabel } from './ToolChipList';
import {
  agentCapabilitiesErrorText,
  capabilityReasonText,
  mapPanelSkills,
  mapPanelSubagentTargets,
  mapPanelTools,
} from './mapCapabilities';
import type {
  AgentIdentity,
  AgentSkillCapability,
  AgentSubagentTarget,
  AgentToolCapability,
  DetailDrawerTarget,
} from './types';

export type { DetailDrawerTarget } from './types';

export interface AgentDetailDrawerProps {
  readonly target: DetailDrawerTarget | null;
  readonly onClose: () => void;
  readonly subagentTargets?: readonly AgentSubagentTarget[];
  readonly toolCapabilities?: readonly AgentToolCapability[];
  readonly skills?: readonly AgentSkillCapability[];
  readonly dispatchTargets?: readonly AgentCapabilityTarget[];
  readonly draftScope?: { readonly workspace_id?: string; readonly cwd?: string };
}

function ProfileDraftDetail({
  profile,
  scope,
  onOpenTarget,
}: {
  readonly profile: string;
  readonly scope?: { readonly workspace_id?: string; readonly cwd?: string };
  readonly onOpenTarget?: (target: DetailDrawerTarget) => void;
}) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const klient = connection?.klient;

  const query =
    scope?.workspace_id !== undefined
      ? { profile, workspace_id: scope.workspace_id }
      : scope?.cwd !== undefined
        ? { profile, cwd: scope.cwd }
        : undefined;

  const capabilities = useQuery({
    queryKey: ['agentCapabilities', 'draft', profile, query],
    queryFn: ({ signal }) => {
      if (!klient || !query) throw new Error('Client or scope unavailable');
      return klient.global.agentPanel.read(query, { signal });
    },
    enabled: klient !== undefined && query !== undefined,
    staleTime: 15_000,
    retry: false,
  });

  if (!query) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-danger text-[11px]">
        {t('agentPanel.profileDraftMissing', { profile })}
      </div>
    );
  }

  if (capabilities.isPending) {
    return (
      <p role="status" className="font-mono text-[11px] text-ink-soft animate-pulse">
        {t('diagnostics.loading')}
      </p>
    );
  }

  if (capabilities.isError) {
    return (
      <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-danger text-[11px] space-y-2">
        <p>{t('diagnostics.error')} · {agentCapabilitiesErrorText(capabilities.error, t)}</p>
        <button
          type="button"
          onClick={() => void capabilities.refetch()}
          className="underline font-mono cursor-pointer"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  const data = capabilities.data;
  if (!data || !data.profile) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-danger text-[11px]">
        {t('agentPanel.profileDraftMissing', { profile })}
      </div>
    );
  }

  return (
    <ProfileDetailSections
      profile={data.profile}
      query={query}
      subagentTargets={mapPanelSubagentTargets(data.targets)}
      dispatchTargets={data.targets}
      skills={mapPanelSkills(data.skills)}
      toolCapabilities={mapPanelTools(data.tools)}
      onOpenTarget={onOpenTarget}
    />
  );
}

export const AgentDetailDrawer = memo(function AgentDetailDrawer({
  target,
  onClose,
  subagentTargets,
  toolCapabilities,
  skills,
  dispatchTargets,
  draftScope,
}: AgentDetailDrawerProps) {
  const { t } = useI18n();

  // Navigation stack to support in-drawer jumps (e.g. subagent chip -> target profile)
  const [navStack, setNavStack] = useState<readonly DetailDrawerTarget[]>([]);

  useEffect(() => {
    setNavStack([]);
  }, [target]);

  if (!target) return null;

  const currentTarget = navStack.length > 0 ? navStack[navStack.length - 1]! : target;
  const pushTarget = (next: DetailDrawerTarget) => {
    setNavStack((prev) => [...prev, next]);
  };
  const popTarget = () => {
    setNavStack((prev) => prev.slice(0, -1));
  };

  let title = t('agentPanel.detailTitle');
  let categoryLabel = '';

  if (currentTarget.kind === 'profile') {
    title = t('agentPanel.profileDetail');
    categoryLabel = currentTarget.identity.profile;
  } else if (currentTarget.kind === 'profile-draft') {
    title = t('agentPanel.profileDetail');
    categoryLabel = currentTarget.profile;
  } else if (currentTarget.kind === 'tool') {
    title = t('agentPanel.toolDetail');
    categoryLabel = toolCategoryLabel(t, currentTarget.tool.category || t('agentPanel.generalCategory'));
  } else if (currentTarget.kind === 'skill') {
    title = t('agentPanel.skillDetail');
    categoryLabel =
      currentTarget.skill.scope === 'workspace'
        ? t('agentPanel.scopeWorkspace')
        : t('agentPanel.scopeGlobal');
  } else if (currentTarget.kind === 'subagent') {
    title = t('agentPanel.subagentDetail');
    categoryLabel = currentTarget.target.executor;
  }

  const toolReason = currentTarget.kind === 'tool'
    ? capabilityReasonText(t, currentTarget.tool.unavailableReasonCode, currentTarget.tool.unavailableReason)
    : undefined;
  const skillReason = currentTarget.kind === 'skill'
    ? capabilityReasonText(t, currentTarget.skill.unavailableReasonCode, currentTarget.skill.unavailableReason)
    : undefined;
  const launchReason = currentTarget.kind === 'subagent'
    ? capabilityReasonText(t, currentTarget.target.launchUnavailableReasonCode, currentTarget.target.launchUnavailableReason)
    : undefined;

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
          {navStack.length > 0 ? (
            <button
              type="button"
              onClick={popTarget}
              className="rounded border border-hairline px-1.5 py-0.5 text-[10px] font-mono text-ink-soft hover:text-ink hover:bg-paper cursor-pointer transition-colors"
              title={t('agentPanel.detailBack')}
            >
              ← {t('agentPanel.detailBack')}
            </button>
          ) : null}
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
        {currentTarget.kind === 'profile' && (
          <ProfileDetailSections
            identity={currentTarget.identity}
            subagentTargets={subagentTargets}
            toolCapabilities={toolCapabilities}
            skills={skills}
            dispatchTargets={dispatchTargets}
            onOpenTarget={pushTarget}
          />
        )}

        {currentTarget.kind === 'profile-draft' && (
          <ProfileDraftDetail
            profile={currentTarget.profile}
            scope={draftScope}
            onOpenTarget={pushTarget}
          />
        )}

        {currentTarget.kind === 'tool' && (
          <div data-tool-detail className="space-y-3.5">
            {/* Title & Badges */}
            <div className="border-b border-hairline pb-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-[15px] font-semibold text-ink">
                  {currentTarget.tool.name}
                </h3>
                <div className="flex items-center gap-1.5 shrink-0">
                  {currentTarget.tool.readOnly ? (
                    <span className="rounded bg-accent-soft px-1.5 py-0.2 text-[9.5px] font-mono text-accent">
                      {t('agentPanel.readOnly')}
                    </span>
                  ) : null}
                  <CapabilityStateBadge state={currentTarget.tool.state} />
                </div>
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-ink-faint">
                {toolCategoryLabel(t, currentTarget.tool.category || t('agentPanel.generalCategory'))}
              </div>
            </div>

            {/* Notices / Human Explanation */}
            {currentTarget.tool.state === 'approval-required' && (
              <div className="rounded-lg border border-amber-rule/40 bg-amber-card/50 p-2.5 text-[11px] text-amber-ink">
                {t('agentPanel.approvalNotice')}
              </div>
            )}
            {toolReason !== undefined && (
              <div className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-[11px] text-danger">
                {t('agentPanel.unavailableReason', { reason: toolReason })}
              </div>
            )}
            {currentTarget.tool.readOnly && (
              <div className="rounded-lg border border-hairline bg-paper/60 p-2 text-[11px] text-ink-soft">
                {t('agentPanel.readOnlyNotice')}
              </div>
            )}

            {/* Description */}
            {currentTarget.tool.description ? (
              <div className="space-y-1">
                <div className="font-mono text-[10px] font-semibold uppercase text-ink-faint">
                  {t('agentPanel.profileDescription')}
                </div>
                <p className="text-ink leading-relaxed">{currentTarget.tool.description}</p>
              </div>
            ) : null}

            {/* Parameters Schema */}
            <details open className="space-y-1">
              <summary className="font-mono text-[10px] font-semibold uppercase text-ink-faint cursor-pointer select-none">
                {t('agentPanel.parametersSchema')}
              </summary>
              <pre className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-hairline bg-paper/60 p-2.5 font-mono text-[10px] leading-snug text-ink-soft whitespace-pre-wrap">
                {currentTarget.tool.parametersSchema ??
                  currentTarget.tool.parametersSummary ??
                  t('agentPanel.noParameters')}
              </pre>
            </details>
          </div>
        )}

        {currentTarget.kind === 'skill' && (
          <div data-skill-detail className="space-y-3.5">
            {/* Title & Badges */}
            <div className="border-b border-hairline pb-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-[15px] font-semibold text-ink">
                  {currentTarget.skill.name}
                </h3>
                <CapabilityStateBadge state={currentTarget.skill.state} />
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-ink-faint">
                {currentTarget.skill.scope === 'workspace'
                  ? t('agentPanel.scopeWorkspace')
                  : t('agentPanel.scopeGlobal')}
              </div>
            </div>

            {/* Notices */}
            {skillReason !== undefined && (
              <div className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-[11px] text-danger">
                {skillReason}
              </div>
            )}

            {/* Description */}
            {currentTarget.skill.description ? (
              <div className="space-y-1">
                <div className="font-mono text-[10px] font-semibold uppercase text-ink-faint">
                  {t('agentPanel.profileDescription')}
                </div>
                <p className="text-ink leading-relaxed">{currentTarget.skill.description}</p>
              </div>
            ) : null}

            {/* Path & Hints */}
            <dl className="grid grid-cols-1 gap-2 font-mono text-[10.5px] bg-paper/50 rounded-lg p-2.5 border border-hairline">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-faint">{t('agentPanel.scope')}</dt>
                <dd className="text-ink">
                  {currentTarget.skill.scope === 'workspace'
                    ? t('agentPanel.scopeWorkspace')
                    : t('agentPanel.scopeGlobal')}
                </dd>
              </div>
              {currentTarget.skill.type ? (
                <div className="flex items-baseline justify-between gap-2 pt-1 border-t border-hairline">
                  <dt className="text-ink-faint">{t('agentPanel.skillTypeLabel')}</dt>
                  <dd className="text-ink">{currentTarget.skill.type}</dd>
                </div>
              ) : null}
              {currentTarget.skill.disableModelInvocation ? (
                <div className="flex items-baseline justify-between gap-2 pt-1 border-t border-hairline">
                  <dt className="text-ink-faint">{t('agentPanel.disableModelInvocationBadge')}</dt>
                  <dd className="text-amber-ink font-semibold">{t('agentPanel.disableModelInvocationBadge')}</dd>
                </div>
              ) : null}
              {currentTarget.skill.promptCommand ? (
                <div className="flex items-baseline justify-between gap-2 pt-1 border-t border-hairline">
                  <dt className="text-ink-faint">{t('agentPanel.promptCommandBadge')}</dt>
                  <dd className="text-accent font-semibold">{t('agentPanel.promptCommandBadge')}</dd>
                </div>
              ) : null}
              {currentTarget.skill.path ? (
                <div className="flex flex-col gap-0.5 pt-1 border-t border-hairline">
                  <dt className="text-ink-faint">{t('agentPanel.fileLabel')}</dt>
                  <dd className="text-ink-soft break-all text-[10px]">
                    <FilePathLink path={currentTarget.skill.path} />
                  </dd>
                </div>
              ) : null}
              {currentTarget.skill.argumentHint ? (
                <div className="flex flex-col gap-0.5 pt-1 border-t border-hairline">
                  <dt className="text-ink-faint">{t('agentPanel.argumentHint')}</dt>
                  <dd className="text-ink-soft break-all text-[10px]">{currentTarget.skill.argumentHint}</dd>
                </div>
              ) : null}
            </dl>

            {currentTarget.skill.path ? (
              <SkillContentCollapse path={currentTarget.skill.path} />
            ) : null}
          </div>
        )}

        {currentTarget.kind === 'subagent' && (
          <div data-subagent-detail className="space-y-3.5">
            {/* Title & Status */}
            <div className="border-b border-hairline pb-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-[15px] font-semibold text-ink">
                  {currentTarget.target.profile}
                  {currentTarget.target.route ? ` / ${currentTarget.target.route}` : ''}
                </h3>
                <span
                  className={`rounded px-1.5 py-0.2 font-mono text-[9.5px] font-medium uppercase ${
                    currentTarget.target.launchAllowed !== false && currentTarget.target.defaultsAvailable
                      ? 'bg-success/15 text-success border border-success/30'
                      : 'bg-danger/10 text-danger border border-danger/30'
                  }`}
                >
                  {currentTarget.target.launchAllowed !== false && currentTarget.target.defaultsAvailable
                    ? t('agentPanel.allowed')
                    : t('agentPanel.blocked')}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-ink-faint">
                {t('agentPanel.executor', { value: currentTarget.target.executor })}
              </div>
            </div>

            {/* Admission Notices */}
            {currentTarget.target.launchAllowed !== false && currentTarget.target.defaultsAvailable ? (
              <div className="rounded-lg border border-success/30 bg-success/5 p-2.5 text-[11px] text-success">
                {t('agentPanel.launchAllowedNotice')}
              </div>
            ) : (
              <div className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-[11px] text-danger space-y-1">
                <p className="font-medium">{t('agentPanel.launchBlockedNotice')}</p>
                {launchReason !== undefined ? (
                  <p className="text-[10.5px] opacity-90">{launchReason}</p>
                ) : null}
              </div>
            )}

            {currentTarget.target.executionRestriction === 'research-readonly' && (
              <div className="rounded-lg border border-hairline bg-paper/60 p-2 text-[11px] text-accent font-mono">
                {t('agentPanel.researchReadonly')}
              </div>
            )}

            {/* Metadata Fields */}
            <dl className="grid grid-cols-1 gap-2 rounded-lg border border-hairline bg-paper/50 p-2.5 font-mono text-[11px]">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-faint">{t('agentPanel.label.executor')}</dt>
                <dd className="font-medium text-ink">{currentTarget.target.executor}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-faint">{t('agentPanel.label.model')}</dt>
                <dd className="text-ink">{currentTarget.target.modelAlias ?? t('agentPanel.default')}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-faint">{t('agentPanel.label.effort')}</dt>
                <dd className="text-ink">{currentTarget.target.thinkingEffort ?? t('agentPanel.default')}</dd>
              </div>
            </dl>

            <button
              type="button"
              onClick={() => pushTarget({ kind: 'profile-draft', profile: currentTarget.target.profile })}
              className="inline-flex items-center gap-1 font-mono text-[11px] text-accent transition-colors hover:text-accent-deep hover:underline"
            >
              <span>{t('agentPanel.profileDetail')}</span>
              <span aria-hidden>→</span>
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
});
