import { memo, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentCapabilityTarget } from '@kiki/protocol';
import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import { useOptionalConnection } from '../../state/connection';
import { Dialog } from '../Dialog';
import { FilePathLink } from '../mediaParts';
import { SkillPreviewButton } from '../capabilities/SkillPreviewButton';
import { CapabilityStateBadge } from './CapabilityStateBadge';
import { ProfileDetailSections, type ProfileDetailSectionsProps } from './ProfileDetailSections';
import { ToolDetailBody } from './ToolDetailBody';
import { toolCategoryLabel } from './ToolChipList';
import { capabilitySourceLabel, SOURCE_TONE_CLASS } from './sourceLabel';
import {
  agentCapabilitiesErrorText,
  capabilityReasonText,
  mapPanelSkills,
  mapPanelSubagentTargets,
  mapPanelTools,
} from './mapCapabilities';
import type {
  AgentSkillCapability,
  AgentSubagentTarget,
  AgentToolCapability,
  DetailDrawerTarget,
} from './types';

export type { DetailDrawerTarget } from './types';

/** The detail shell's backdrop: shared with any rail-hosted detail panel that
 * needs the same slide-over frame instead of the rail's own column. */
export const DETAIL_OVERLAY_CLASS = 'fixed inset-0 z-50 flex justify-end bg-shell/40 backdrop-blur-[2px]';
/** The detail shell's panel: a right-side sheet, 420px on wide viewports. */
export const DETAIL_PANEL_CLASS = 'anim-enter h-full w-full max-w-full sm:max-w-[420px] bg-panel border-l border-hairline shadow-2xl flex flex-col overflow-hidden outline-none font-sans text-ink';

export interface AgentDetailDrawerProps {
  readonly target: DetailDrawerTarget | null;
  readonly onClose: () => void;
  readonly subagentTargets?: readonly AgentSubagentTarget[];
  readonly toolCapabilities?: readonly AgentToolCapability[];
  readonly skills?: readonly AgentSkillCapability[];
  readonly dispatchTargets?: readonly AgentCapabilityTarget[];
  readonly draftScope?: { readonly workspace_id?: string; readonly cwd?: string };
  /** The dispatching profile; a private alias only resolves through it. */
  readonly callerProfile?: string;
}

function ProfileDraftDetail({
  profile,
  callerProfile,
  scope,
  onOpenTarget,
}: {
  readonly profile: string;
  readonly callerProfile?: string;
  readonly scope?: { readonly workspace_id?: string; readonly cwd?: string };
  readonly onOpenTarget?: (target: DetailDrawerTarget) => void;
}) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const klient = connection?.klient;

  const caller = callerProfile !== undefined && callerProfile !== '' && callerProfile !== profile
    ? { caller_profile: callerProfile }
    : {};
  const query =
    scope?.workspace_id !== undefined
      ? { profile, workspace_id: scope.workspace_id, ...caller }
      : scope?.cwd !== undefined
        ? { profile, cwd: scope.cwd, ...caller }
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
      <p role="status" className="font-mono text-[11px] text-ink-soft animate-pulse motion-reduce:animate-none">
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
      prompt={data.prompt}
      promptUnavailable={!data.available}
      subagentTargets={mapPanelSubagentTargets(data.targets)}
      dispatchTargets={data.targets}
      skills={mapPanelSkills(data.skills)}
      toolCapabilities={mapPanelTools(data.tools)}
      onOpenTarget={onOpenTarget}
    />
  );
}

function ProfileLiveDetail(props: ProfileDetailSectionsProps) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const klient = connection?.klient;
  const query = props.query;
  const result = useQuery({
    queryKey: ['agentCapabilities', query],
    queryFn: ({ signal }) => {
      if (klient === undefined || query === undefined) throw new Error('Client or agent unavailable');
      return klient.global.agentPanel.read(query, { signal });
    },
    enabled: klient !== undefined && query !== undefined,
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: false,
  });
  return <>
    {result.isError ? <p role="alert" className="text-[12px] text-danger">{agentCapabilitiesErrorText(result.error, t)} <button type="button" className="underline" onClick={() => void result.refetch()}>{t('common.retry')}</button></p> : null}
    <ProfileDetailSections {...props} profile={result.data?.profile ?? props.profile}
      prompt={result.data?.prompt} promptUnavailable={result.isError || result.data?.available === false}
      promptLoading={result.isFetching && result.data === undefined} />
  </>;
}

export const AgentDetailDrawer = memo(function AgentDetailDrawer({
  target,
  onClose,
  subagentTargets,
  toolCapabilities,
  skills,
  dispatchTargets,
  draftScope,
  callerProfile,
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
      overlayClassName={DETAIL_OVERLAY_CLASS}
      panelClassName={DETAIL_PANEL_CLASS}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3 bg-paper/40 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {navStack.length > 0 ? (
            <button
              type="button"
              onClick={popTarget}
              className="rounded border border-hairline px-1.5 py-0.5 text-[11px] font-mono text-ink-soft hover:text-ink hover:bg-paper cursor-pointer transition-colors"
              title={t('agentPanel.detailBack')}
            >
              <span className="inline-flex items-center gap-1"><Icon name="arrowLeft" size={12} />{t('agentPanel.detailBack')}</span>
            </button>
          ) : null}
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            {title}
          </span>
          {categoryLabel ? (
            <span className="rounded bg-paper border border-hairline px-1.5 py-px font-mono text-[11px] text-ink-soft truncate">
              {categoryLabel}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          data-autofocus
          onClick={onClose}
          aria-label={t('agentPanel.detailClose')}
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink transition-colors cursor-pointer"
        >
          <Icon name="close" />
        </button>
      </div>

      {/* Body content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-[12px] leading-relaxed">
        {currentTarget.kind === 'profile' && (
          <ProfileLiveDetail
            identity={currentTarget.identity}
            query={currentTarget.identity.sessionId === undefined ? undefined : { session_id: currentTarget.identity.sessionId, agent_id: currentTarget.identity.id }}
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
            callerProfile={currentTarget.callerProfile ?? callerProfile}
            scope={draftScope}
            onOpenTarget={pushTarget}
          />
        )}

        {currentTarget.kind === 'tool' && <ToolDetailBody tool={currentTarget.tool} />}

        {currentTarget.kind === 'skill' && (
          <div data-skill-detail className="space-y-3">
            {/* Title & Badges */}
            <div className="border-b border-hairline pb-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-[15px] font-semibold text-ink">
                  {currentTarget.skill.name}
                </h3>
                <CapabilityStateBadge state={currentTarget.skill.state} />
              </div>
              <SourceLine {...currentTarget.skill} />
            </div>

            {/* Notices */}
            {skillReason !== undefined && (
              <div className="rounded-lg border border-danger/30 bg-danger/5 p-2 text-[11px] text-danger">
                {skillReason}
              </div>
            )}

            {/* Description */}
            {currentTarget.skill.description ? (
              <div className="space-y-1">
                <div className="font-mono text-[11px] font-semibold uppercase text-ink-faint">
                  {t('agentPanel.profileDescription')}
                </div>
                <p className="text-ink leading-relaxed">{currentTarget.skill.description}</p>
              </div>
            ) : null}

            {/* Path & Hints */}
            <dl className="grid grid-cols-1 gap-2 font-mono text-[11px] bg-paper/50 rounded-lg p-2 border border-hairline">
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
                  <dd className="font-medium text-accent-ink">{t('agentPanel.promptCommandBadge')}</dd>
                </div>
              ) : null}
              {currentTarget.skill.path ? (
                <div className="flex flex-col gap-0.5 pt-1 border-t border-hairline">
                  <dt className="text-ink-faint">{t(currentTarget.skill.source === 'builtin' ? 'cap.source.builtin' : 'agentPanel.fileLabel')}</dt>
                  <dd className="text-ink-soft break-all text-[11px]">
                    {currentTarget.skill.source === 'builtin'
                      ? currentTarget.skill.path
                      : <FilePathLink path={currentTarget.skill.path} />}
                  </dd>
                </div>
              ) : null}
              {currentTarget.skill.argumentHint ? (
                <div className="flex flex-col gap-0.5 pt-1 border-t border-hairline">
                  <dt className="text-ink-faint">{t('agentPanel.argumentHint')}</dt>
                  <dd className="text-ink-soft break-all text-[11px]">{currentTarget.skill.argumentHint}</dd>
                </div>
              ) : null}
            </dl>

            {currentTarget.skill.path ? (
              <SkillPreviewButton skill={{
                name: currentTarget.skill.name,
                source: currentTarget.skill.source,
                path: currentTarget.skill.path,
              }} onOpen={onClose} />
            ) : null}
          </div>
        )}

        {currentTarget.kind === 'subagent' && (
          <div data-subagent-detail className="space-y-3">
            {/* Title & Status */}
            <div className="border-b border-hairline pb-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-[15px] font-semibold text-ink">
                  {currentTarget.target.profile}
                  {currentTarget.target.route ? ` / ${currentTarget.target.route}` : ''}
                </h3>
                <span
                  className={`rounded px-1.5 py-px font-mono text-[11px] font-medium uppercase ${
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
              <div className="mt-1 font-mono text-[11px] text-ink-faint">
                {t('agentPanel.executor', { value: currentTarget.target.executor })}
              </div>
              <SourceLine {...currentTarget.target} />
            </div>

            {/* Admission Notices */}
            {currentTarget.target.launchAllowed !== false && currentTarget.target.defaultsAvailable ? (
              <div className="rounded-lg border border-success/30 bg-success/5 p-2 text-[11px] text-success">
                {t('agentPanel.launchAllowedNotice')}
              </div>
            ) : (
              <div className="rounded-lg border border-danger/30 bg-danger/5 p-2 text-[11px] text-danger space-y-1">
                <p className="font-medium">{t('agentPanel.launchBlockedNotice')}</p>
                {launchReason !== undefined ? (
                  <p className="text-[11px]">{launchReason}</p>
                ) : null}
              </div>
            )}

            {currentTarget.target.executionRestriction === 'research-readonly' && (
              <div className="rounded-lg border border-hairline bg-paper/60 p-2 text-[11px] text-ink font-mono">
                {t('agentPanel.researchReadonly')}
              </div>
            )}

            {/* Metadata Fields */}
            <dl className="grid grid-cols-1 gap-2 rounded-lg border border-hairline bg-paper/50 p-2 font-mono text-[11px]">
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
              onClick={() => pushTarget({
                kind: 'profile-draft',
                profile: currentTarget.target.profile,
                callerProfile: currentTarget.target.callerProfile ?? callerProfile,
              })}
              className="inline-flex items-center gap-1 font-mono text-[11px] text-accent-ink transition-colors hover:underline"
            >
              <span>{t('agentPanel.profileDetail')}</span>
              <Icon name="arrowRight" size={12} />
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
});

/** Origin chip plus the root or file it was found under. */
function SourceLine(input: {
  readonly source?: string;
  readonly sourceKind?: string;
  readonly sourceRoot?: string;
  readonly sourceFile?: string;
  readonly scope?: 'workspace' | 'global';
}) {
  const { t } = useI18n();
  const label = capabilitySourceLabel(t, input);
  if (label === undefined) return null;
  const where = input.sourceRoot ?? input.sourceFile;
  return (
    <div data-capability-source-line={label.tone} className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px]">
      <span className={`shrink-0 rounded px-1.5 py-px leading-4 ${SOURCE_TONE_CLASS[label.tone]}`}>{label.text}</span>
      {where !== undefined && where !== '' ? (
        <span className="min-w-0 truncate font-mono text-ink-faint" title={where}>{where}</span>
      ) : null}
    </div>
  );
}
