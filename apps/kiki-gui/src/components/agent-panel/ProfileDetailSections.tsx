import { useState, useEffect } from 'react';
import type { AgentCapabilitiesQuery, AgentPanelProfile, NamedAgentProfile, AgentCapabilityTarget } from '@kiki/protocol';
import {
  agentProfileValueOrigin,
  summarizeNamedAgentModelProfile,
  NAMED_AGENT_LEASE_DETAIL_LABEL_KEYS,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { loadAgentProfileCatalog, type AgentProfileCatalogMode } from '../../lib/agentProfileCatalog';
import { useOptionalConnection } from '../../state/connection';
import { FilePathLink } from '../mediaPreview';
import { DispatchPolicyBadges } from './AgentIdentitySection';
import { DiskDefinitionSummary } from './DiskDefinitionSummary';
import { RawFileCollapse } from './RawFileCollapse';
import { SourceBadge, sourceBadgeLabel } from './SourceBadge';
import { SubagentLeaseList } from './LeaseList';
import { ToolChipList } from './ToolChipList';
import type {
  AgentIdentity,
  AgentPanelProfileWithSources,
  AgentSkillCapability,
  AgentSubagentTarget,
  AgentToolCapability,
  DetailDrawerTarget,
} from './types';

export interface ProfileDetailSectionsProps {
  readonly profile?: AgentPanelProfile;
  readonly identity?: AgentIdentity;
  readonly query?: AgentCapabilitiesQuery;
  readonly subagentTargets?: readonly AgentSubagentTarget[];
  readonly toolCapabilities?: readonly AgentToolCapability[];
  readonly skills?: readonly AgentSkillCapability[];
  readonly dispatchTargets?: readonly AgentCapabilityTarget[];
  readonly onOpenTarget?: (target: DetailDrawerTarget) => void;
}

interface DefinitionLookup {
  /** The definition the shown profile is bound to, keyed by its own workspace
   *  scope and source file. */
  readonly bound?: NamedAgentProfile;
  /** A same-named definition from another source file. Never stands in for the
   *  bound one; rendered on its own, labelled by its file. */
  readonly other?: NamedAgentProfile;
}

function lookupDefinition(
  items: readonly NamedAgentProfile[],
  name: string | undefined,
  sourceFile: string | undefined,
): DefinitionLookup {
  if (name === undefined) return {};
  const sameName = items.filter((candidate) => candidate.name === name);
  const bound = sourceFile === undefined
    ? sameName.find((candidate) => candidate.source_file === undefined)
    : sameName.find((candidate) => candidate.source_file === sourceFile);
  if (bound !== undefined) return { bound };
  return sameName[0] === undefined ? {} : { other: sameName[0] };
}

export function ProfileDetailSections({
  profile: propProfile,
  identity,
  query,
  toolCapabilities,
  skills,
  dispatchTargets,
  onOpenTarget,
}: ProfileDetailSectionsProps) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;

  const profile = propProfile ?? identity?.rawProfile;
  const profileName = profile?.name ?? identity?.profile;
  const sourceFile = profile?.source_file ?? identity?.sourceFile;

  // The definition this profile is bound to is addressed by its own workspace
  // scope (when the query carries one) and by its source file — a same-named
  // profile from another workspace or directory must never stand in for it.
  const workspaceId = query !== undefined && 'workspace_id' in query ? query.workspace_id : undefined;
  const cwd = query !== undefined && 'cwd' in query ? query.cwd : undefined;

  const [catalogItems, setCatalogItems] = useState<readonly NamedAgentProfile[]>([]);

  useEffect(() => {
    if (!client || profileName === undefined) return;
    const mode: AgentProfileCatalogMode = workspaceId !== undefined
      ? { mode: 'workspace', workspaceId }
      : cwd !== undefined
        ? { mode: 'cwd', cwd }
        : { mode: 'global' };
    let cancelled = false;
    loadAgentProfileCatalog(client, mode)
      .then((result) => {
        if (!cancelled) setCatalogItems(result.items);
      })
      .catch(() => {
        if (!cancelled) setCatalogItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, profileName, workspaceId, cwd]);

  const definition = lookupDefinition(catalogItems, profileName, sourceFile);
  const bound = definition.bound;
  const other = definition.other;

  const rawFallback = identity?.configContentPreview;

  // New servers report the source directly. Older responses can still recover
  // it from the exact on-disk definition bound by source_file.
  const source = profile?.source ?? identity?.source ?? bound?.source;
  const context = identity?.context ?? (query && 'session_id' in query ? 'live' : 'draft');
  const route = profile?.route;
  const definitionId = profile?.definition_id;

  const description =
    profile?.description ??
    identity?.description ??
    identity?.summary ??
    bound?.description;
  const whenToUse = bound?.when_to_use;

  const effectiveModel = profile?.model ?? identity?.model;
  const pinnedModel = bound?.pinned_model_alias ?? profile?.locked_model;
  const isModelLocked = Boolean(profile?.locked_model);

  // Consume provenance fields defensively while older servers omit them.
  const profileSources = profile as AgentPanelProfileWithSources | undefined;
  const modelOrigin = agentProfileValueOrigin({
    reported: profileSources?.model_source,
    effective: effectiveModel,
    declared: bound?.pinned_model_alias,
    locked: isModelLocked,
  });

  const effectiveEffort = profile?.thinking_effort ?? identity?.thinkingEffort;
  const pinnedEffort = bound?.thinking_effort ?? profile?.locked_effort;
  const isEffortLocked = Boolean(profile?.locked_effort);
  const effortOrigin = agentProfileValueOrigin({
    reported: profileSources?.effort_source,
    effective: effectiveEffort,
    declared: bound?.thinking_effort,
    locked: isEffortLocked,
  });

  const serviceTier = profile?.service_tier ?? bound?.service_tier;
  const contextBudget = bound?.context_budget;
  const maxCompletionTokens = bound?.max_completion_tokens;
  const requestParams = bound?.request_params;

  const tools = profile?.tools ?? bound?.tools;
  const disallowedTools = profile?.disallowed_tools ?? bound?.disallowed_tools;
  const toolAllowPolicies = profile?.tool_allow_policies;
  const executionRestriction = profile?.execution_restriction;

  const spawnConstraints = profile?.spawn_constraints ?? bound?.spawn_constraints;
  const subagents = bound?.subagents;
  const profilePolicy = profile?.subagent_policy ?? bound?.subagent_policy;
  const hasDerivedConfiguration =
    spawnConstraints !== undefined ||
    (subagents !== undefined && subagents.length > 0) ||
    profilePolicy !== undefined ||
    (dispatchTargets !== undefined && dispatchTargets.length > 0);

  return (
    <div data-profile-detail className="space-y-3.5 text-[11.5px]">
      {/* 1. 身份与来源 */}
      <details open data-profile-section="identity" className="rounded-lg border border-hairline bg-paper/40 p-2.5">
        <summary className="font-mono text-[10px] font-semibold uppercase text-ink-faint cursor-pointer select-none">
          {t('agentPanel.profileSection.identity')}
        </summary>
        <div className="mt-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[14px] font-bold text-ink">{profileName}</span>
            <SourceBadge source={source} variant="accent" />
          </div>
          <dl className="grid grid-cols-1 gap-1.5 font-mono text-[10.5px] rounded bg-paper/60 p-2 border border-hairline">
            {identity?.id ? (
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-faint">{t('agentPanel.internalId')}</dt>
                <dd className="font-medium text-ink truncate select-all">{identity.id}</dd>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-ink-faint">{t('agentPanel.runtimeContext')}</dt>
              <dd className="text-ink">
                {context === 'live' ? t('agentPanel.liveContext') : t('agentPanel.draftContext')}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-ink-faint">{t('agentPanel.sourceLabel')}</dt>
              <dd className="text-ink">{source === undefined ? t('agentPanel.unknown') : sourceBadgeLabel(t, source)}</dd>
            </div>
            {route ? (
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-faint">{t('st.namedAgents.route')}</dt>
                <dd className="text-ink font-medium">{route}</dd>
              </div>
            ) : null}
            {definitionId ? (
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-faint">ID</dt>
                <dd className="text-ink truncate max-w-[200px]" title={definitionId}>
                  {definitionId}
                </dd>
              </div>
            ) : null}
            {sourceFile ? (
              <div className="flex flex-col gap-0.5 pt-1 border-t border-hairline">
                <dt className="text-ink-faint">{t('agentPanel.fileLabel')}</dt>
                <dd className="text-ink-soft break-all font-mono text-[10px]">
                  <FilePathLink path={sourceFile} />
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </details>

      {/* 1b. 磁盘上的同名定义：与上面这份绑定定义不是同一个文件时单列 */}
      {other ? (
        <details data-disk-definition className="rounded-lg border border-hairline bg-paper/40 p-2.5">
          <summary className="font-mono text-[10px] font-semibold uppercase text-ink-faint cursor-pointer select-none">
            {t('st.namedAgents.diskVersion')} · {other.source_file ?? t('st.namedAgents.builtin')}
          </summary>
          <DiskDefinitionSummary
            definition={other}
            className="mt-2 space-y-1 break-all font-mono text-[10.5px] text-ink-soft"
          />
          <p className="mt-1 font-mono text-[10px] text-ink-faint">{t('st.namedAgents.diskVersionHint')}</p>
        </details>
      ) : null}

      {/* 2. 意图与定位 */}
      <details open data-profile-section="intent" className="rounded-lg border border-hairline bg-paper/40 p-2.5">
        <summary className="font-mono text-[10px] font-semibold uppercase text-ink-faint cursor-pointer select-none">
          {t('agentPanel.profileSection.intent')}
        </summary>
        <div className="mt-2 space-y-2">
          {description ? (
            <div>
              <div className="text-[10px] font-medium text-ink-faint">
                {t('agentPanel.profileDescription')}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap leading-relaxed text-ink">{description}</p>
            </div>
          ) : !whenToUse ? (
            <p className="italic text-ink-faint">{t('agentPanel.unrestricted')}</p>
          ) : null}
          {whenToUse ? (
            <div className="rounded border-l-2 border-accent bg-accent/5 p-2 text-[11px] leading-snug text-ink-soft">
              <div className="mb-0.5 text-[10px] font-medium uppercase text-accent">
                {t('st.namedAgents.whenToUse')}
              </div>
              <p className="italic">{whenToUse}</p>
            </div>
          ) : null}
        </div>
      </details>

      {/* 3. 模型与推理（字段、声明值、生效值、来源/锁定） */}
      <details open data-profile-section="model" className="rounded-lg border border-hairline bg-paper/40 p-2.5">
        <summary className="font-mono text-[10px] font-semibold uppercase text-ink-faint cursor-pointer select-none">
          {t('agentPanel.profileSection.model')}
        </summary>
        <div className="mt-2 space-y-2">
          <div className="rounded border border-hairline bg-paper/60 p-2 font-mono text-[10.5px]">
            <div className="grid grid-cols-[minmax(3.5rem,0.7fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.9fr)] gap-1 border-b border-hairline pb-1 text-[9.5px] font-semibold uppercase text-ink-faint">
              <div>{t('agentPanel.value.field')}</div>
              <div>{t('agentPanel.value.declared')}</div>
              <div>{t('agentPanel.value.effective')}</div>
              <div className="text-right">{t('diagnostics.source')}</div>
            </div>
            <div
              data-profile-value="model"
              className="grid grid-cols-[minmax(3.5rem,0.7fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.9fr)] items-center gap-1 border-b border-hairline py-1.5"
            >
              <div className="text-ink-faint">{t('agentPanel.label.model')}</div>
              <div className="truncate text-ink" title={pinnedModel}>
                {pinnedModel ?? t('st.namedAgents.unspecified')}
              </div>
              <div className="truncate font-medium text-ink" title={effectiveModel}>
                {effectiveModel ?? t('agentPanel.unknownModel')}
              </div>
              <div className="text-right">
                {modelOrigin.locked ? (
                  <span
                    className="inline-block break-words rounded border border-amber-rule/30 bg-amber-card px-1 py-0.2 text-[9px] text-amber-ink"
                    title={t('agentPanel.locked')}
                  >
                    {t('agentPanel.locked')}
                  </span>
                ) : (
                  <span data-value-origin="model" className="break-words text-[9.5px] text-ink-faint">{t(modelOrigin.labelKey)}</span>
                )}
              </div>
            </div>
            <div
              data-profile-value="effort"
              className="grid grid-cols-[minmax(3.5rem,0.7fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.9fr)] items-center gap-1 border-b border-hairline py-1.5"
            >
              <div className="text-ink-faint">{t('agentPanel.label.effort')}</div>
              <div className="truncate text-ink" title={pinnedEffort}>
                {pinnedEffort ?? t('st.namedAgents.unspecified')}
              </div>
              <div className="truncate font-medium text-ink">
                {effectiveEffort ?? t('agentPanel.default')}
              </div>
              <div className="text-right">
                {effortOrigin.locked ? (
                  <span
                    className="inline-block break-words rounded border border-amber-rule/30 bg-amber-card px-1 py-0.2 text-[9px] text-amber-ink"
                    title={t('agentPanel.locked')}
                  >
                    {t('agentPanel.locked')}
                  </span>
                ) : (
                  <span data-value-origin="effort" className="break-words text-[9.5px] text-ink-faint">{t(effortOrigin.labelKey)}</span>
                )}
              </div>
            </div>
            {/* Service tier & limits */}
            {serviceTier ? (
              <div className="flex justify-between py-1 text-ink-soft">
                <span>{t('st.namedAgents.serviceTier')}</span>
                <span className="font-medium text-ink">{serviceTier}</span>
              </div>
            ) : null}
            {contextBudget ? (
              <div className="flex justify-between py-1 text-ink-soft">
                <span>{t('st.namedAgents.contextBudget')}</span>
                <span className="font-medium text-ink">{contextBudget}</span>
              </div>
            ) : null}
            {maxCompletionTokens ? (
              <div className="flex justify-between py-1 text-ink-soft">
                <span>{t('st.namedAgents.maxCompletionTokens')}</span>
                <span className="font-medium text-ink">{maxCompletionTokens}</span>
              </div>
            ) : null}
            {requestParams && Object.keys(requestParams).length > 0 ? (
              <div className="py-1 text-ink-soft">
                <span>{t('st.namedAgents.requestParams')}:</span>
                <pre className="mt-0.5 text-[9.5px] bg-paper p-1 rounded border border-hairline overflow-x-auto">
                  {JSON.stringify(requestParams, null, 2)}
                </pre>
              </div>
            ) : null}
          </div>

          {/* Model profiles list */}
          {bound?.model_profiles && bound.model_profiles.length > 0 ? (
            <div className="space-y-1 pt-1">
              <div className="text-[10px] font-semibold uppercase text-ink-faint">
                {t('st.namedAgents.modelProfile')}
              </div>
              <div className="space-y-1">
                {bound.model_profiles.map((mp) => {
                  const summary = summarizeNamedAgentModelProfile(mp);
                  return (
                    <div
                      key={mp.alias}
                      className="rounded border border-hairline bg-paper/60 p-2 font-mono text-[10px]"
                    >
                      <div className="font-medium text-ink">{summary.headline}</div>
                      {summary.details.map((d, i) => (
                        <div key={i} className="text-ink-soft pl-2">
                          {t(NAMED_AGENT_LEASE_DETAIL_LABEL_KEYS[d.label])}: {d.value}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </details>

      {/* 4. 工具与策略 */}
      <details open data-profile-section="tools" className="rounded-lg border border-hairline bg-paper/40 p-2.5">
        <summary className="font-mono text-[10px] font-semibold uppercase text-ink-faint cursor-pointer select-none">
          {t('agentPanel.profileSection.tools')}
        </summary>
        <div className="mt-2 space-y-2.5 font-mono text-[10.5px]">
          <div>
            <div className="text-[10px] font-semibold uppercase text-ink-faint mb-1">
              {t('st.namedAgents.tools')}
            </div>
            {tools === undefined ? (
              <span className="text-[10px] italic text-ink-faint">{t('agentPanel.unrestricted')}</span>
            ) : tools.length === 0 ? (
              <span className="text-[10px] text-danger">{t('agentPanel.noToolsAllowed')}</span>
            ) : (
              <ToolChipList
                variant="chips"
                items={tools.map((name) => {
                  const cap = toolCapabilities?.find((c) => c.name === name);
                  return {
                    key: name,
                    name,
                    state: cap?.state,
                    readOnly: cap?.readOnly,
                    unavailableReason: cap?.unavailableReason,
                    onOpen: onOpenTarget && cap ? () => onOpenTarget({ kind: 'tool', tool: cap }) : undefined,
                  };
                })}
              />
            )}
          </div>

          {disallowedTools && disallowedTools.length > 0 ? (
            <div>
              <div className="text-[10px] font-semibold uppercase text-danger mb-1">
                {t('st.namedAgents.disallowedTools')}
              </div>
              <div className="flex flex-wrap gap-1">
                {disallowedTools.map((name: string) => (
                  <span
                    key={name}
                    className="rounded bg-danger/10 border border-danger/20 px-1.5 py-0.2 text-[9.5px] text-danger font-medium"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {skills && skills.length > 0 ? (
            <div>
              <div className="text-[10px] font-semibold uppercase text-ink-faint mb-1">
                {t('agentPanel.skills')} ({skills.length})
              </div>
              <ToolChipList
                variant="chips"
                items={skills.map((skill) => ({
                  key: skill.id,
                  name: skill.name,
                  state: skill.state,
                  unavailableReason: skill.unavailableReason,
                  onOpen: onOpenTarget ? () => onOpenTarget({ kind: 'skill', skill }) : undefined,
                }))}
              />
            </div>
          ) : null}

          {toolAllowPolicies && toolAllowPolicies.length > 0 ? (
            <div>
              <div className="text-[10px] font-semibold uppercase text-ink-faint mb-1">
                {t('st.tools.title')} ({toolAllowPolicies.length})
              </div>
              <div className="space-y-1">
                {toolAllowPolicies.map((policy: readonly string[], idx: number) => (
                  <div key={idx} className="flex flex-wrap gap-1 bg-paper/50 p-1.5 rounded border border-hairline">
                    {policy.map((item: string) => (
                      <span key={item} className="rounded bg-paper px-1 text-[9px] text-ink-soft">
                        {item}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {executionRestriction === 'research-readonly' ? (
            <div className="rounded bg-accent-soft border border-accent/30 p-1.5 text-accent font-medium text-[10px]">
              {t('agentPanel.researchReadonly')}
            </div>
          ) : null}
        </div>
      </details>

      {/* 5. 派生能力 */}
      <details open data-profile-section="subagents" className="rounded-lg border border-hairline bg-paper/40 p-2.5">
        <summary className="font-mono text-[10px] font-semibold uppercase text-ink-faint cursor-pointer select-none">
          {t('agentPanel.profileSection.subagents')}
        </summary>
        <div className="mt-2 space-y-2 font-mono text-[10.5px]">
          <div className="flex items-center justify-between gap-2 border-b border-hairline pb-2">
            <span className="text-[10px] font-semibold uppercase text-ink-faint">
              {t('agentPanel.subagentPolicy')}
            </span>
            <DispatchPolicyBadges profilePolicy={profilePolicy} targets={dispatchTargets} />
          </div>

          {spawnConstraints ? (
            <div className="space-y-1.5 rounded border border-hairline bg-paper/60 p-2">
              <div className="text-[9.5px] font-semibold uppercase text-ink-faint">
                {t('st.namedAgents.spawnConstraints')}
              </div>
              {spawnConstraints.allowed_models && spawnConstraints.allowed_models.length > 0 ? (
                <div>
                  <span className="text-[9.5px] text-ink-faint">{t('st.namedAgents.allowedModels')}: </span>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {spawnConstraints.allowed_models.map((model: string) => (
                      <span key={model} className="rounded border border-hairline bg-paper px-1 text-[9px] text-ink">
                        {model}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {spawnConstraints.deny_models && spawnConstraints.deny_models.length > 0 ? (
                <div>
                  <span className="text-[9.5px] text-danger">{t('st.namedAgents.deniedModels')}: </span>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {spawnConstraints.deny_models.map((model: string) => (
                      <span key={model} className="rounded border border-danger/20 bg-danger/10 px-1 text-[9px] text-danger">
                        {model}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {spawnConstraints.allowed_efforts && spawnConstraints.allowed_efforts.length > 0 ? (
                <div>
                  <span className="text-[9.5px] text-ink-faint">{t('st.namedAgents.allowedEfforts')}: </span>
                  <span className="text-ink">{spawnConstraints.allowed_efforts.join(', ')}</span>
                </div>
              ) : null}
            </div>
          ) : !hasDerivedConfiguration ? (
            <p className="italic text-ink-faint">{t('agentPanel.unrestricted')}</p>
          ) : null}

          {subagents && subagents.length > 0 ? (
            <div className="space-y-1 pt-1">
              <div className="text-[10px] font-semibold uppercase text-ink-faint">
                {t('agentPanel.subagents')} ({subagents.length})
              </div>
              <SubagentLeaseList
                items={subagents}
                variant="cards"
                onOpen={
                  onOpenTarget
                    ? (name: string) => onOpenTarget({ kind: 'profile-draft', profile: name })
                    : undefined
                }
              />
            </div>
          ) : null}
        </div>
      </details>

      {/* 6. 原始文件 */}
      <RawFileCollapse
        sourceFile={sourceFile}
        fallbackText={rawFallback}
        dataSection="raw"
      />
    </div>
  );
}
