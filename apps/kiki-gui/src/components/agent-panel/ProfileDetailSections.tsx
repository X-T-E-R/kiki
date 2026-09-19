import { useState, useEffect } from 'react';
import type { AgentCapabilitiesQuery, AgentPanelProfile, NamedAgentProfile } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import {
  summarizeNamedAgentLease,
  summarizeNamedAgentModelProfile,
  type NamedAgentLeaseDetailLabel,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { loadAgentProfileCatalog, type AgentProfileCatalogMode } from '../../lib/agentProfileCatalog';
import { useOptionalConnection } from '../../state/connection';
import { FilePathLink } from '../mediaPreview';
import type { AgentIdentity } from './types';

export interface ProfileDetailSectionsProps {
  readonly profile?: AgentPanelProfile;
  readonly identity?: AgentIdentity;
  readonly query?: AgentCapabilitiesQuery;
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

/**
 * Where an effective model/effort value came from, as far as the panel can
 * prove it. The panel response does not carry a source for the owner profile,
 * so a locked value is the profile binding and an unlocked one is only
 * attributed when the bound definition declares exactly that value — anything
 * else stays "not reported" instead of claiming a source.
 */
function valueOrigin(
  effective: string | undefined,
  declared: string | undefined,
  locked: boolean,
): { readonly locked: boolean; readonly labelKey: I18nKey } {
  if (locked) return { locked: true, labelKey: 'diagnostics.source.profile' };
  return {
    locked: false,
    labelKey: declared !== undefined && declared === effective
      ? 'diagnostics.source.profile'
      : 'diagnostics.unknown',
  };
}

const LEASE_LABEL_MAP: Record<NamedAgentLeaseDetailLabel, I18nKey> = {
  description: 'st.namedAgents.description',
  whenToUse: 'st.namedAgents.whenToUse',
  contextBudget: 'st.namedAgents.contextBudget',
  maxCompletionTokens: 'st.namedAgents.maxCompletionTokens',
  serviceTier: 'st.namedAgents.serviceTier',
  delegationNotice: 'st.namedAgents.delegationNotice',
  promptMode: 'st.namedAgents.promptMode',
  allowedModels: 'st.namedAgents.allowedModels',
  deniedModels: 'st.namedAgents.deniedModels',
  allowedEfforts: 'st.namedAgents.allowedEfforts',
  tools: 'st.namedAgents.tools',
  disallowedTools: 'st.namedAgents.disallowedTools',
  subagents: 'st.namedAgents.subagentLease',
  prompt: 'st.namedAgents.prompt',
  requestParams: 'st.namedAgents.requestParams',
  modelProfile: 'st.namedAgents.modelProfile',
  leaseSource: 'st.namedAgents.leaseSource',
};

export function ProfileDetailSections({
  profile: propProfile,
  identity,
  query,
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

  const [rawText, setRawText] = useState<string | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);

  useEffect(() => {
    if (!sourceFile || !client) return;
    let cancelled = false;
    setRawLoading(true);
    setRawError(null);
    client
      .readHostFile(sourceFile)
      .then((text) => {
        if (!cancelled) setRawText(text);
      })
      .catch((err) => {
        if (!cancelled) setRawError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setRawLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceFile, client]);

  const rawFallback = identity?.configContentPreview;
  const displayedRaw = rawText ?? rawFallback;

  const source = profile?.source ?? identity?.source;
  const context = identity?.context ?? (query && 'session_id' in query ? 'live' : 'draft');
  const route = profile?.route;
  const definitionId = profile?.definition_id;
  const description = profile?.description ?? identity?.description ?? identity?.summary;
  const bound = definition.bound;
  const whenToUse = bound?.when_to_use;

  const effectiveModel = profile?.model ?? identity?.model;
  const pinnedModel = bound?.pinned_model_alias ?? profile?.locked_model;
  const isModelLocked = Boolean(profile?.locked_model);
  const modelOrigin = valueOrigin(effectiveModel, bound?.pinned_model_alias, isModelLocked);

  const effectiveEffort = profile?.thinking_effort ?? identity?.thinkingEffort;
  const pinnedEffort = bound?.thinking_effort ?? profile?.locked_effort;
  const isEffortLocked = Boolean(profile?.locked_effort);
  const effortOrigin = valueOrigin(effectiveEffort, bound?.thinking_effort, isEffortLocked);

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
            {source ? (
              <span className="rounded bg-accent-soft px-1.5 py-0.2 font-mono text-[9.5px] font-medium text-accent uppercase">
                {source}
              </span>
            ) : null}
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
              <dd className="text-ink">{source ?? t('agentPanel.unknown')}</dd>
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
      {definition.other ? (
        <details data-disk-definition className="rounded-lg border border-hairline bg-paper/40 p-2.5">
          <summary className="font-mono text-[10px] font-semibold uppercase text-ink-faint cursor-pointer select-none">
            {t('st.namedAgents.diskVersion')} · {definition.other.source_file ?? t('st.namedAgents.builtin')}
          </summary>
          <div className="mt-2 space-y-1 break-all font-mono text-[10.5px] text-ink-soft">
            {definition.other.description !== undefined ? (
              <p>
                <span className="text-ink-faint">{t('agentPanel.profileDescription')}: </span>
                {definition.other.description}
              </p>
            ) : null}
            {definition.other.when_to_use !== undefined ? (
              <p>
                <span className="text-ink-faint">{t('st.namedAgents.whenToUse')}: </span>
                {definition.other.when_to_use}
              </p>
            ) : null}
            {definition.other.pinned_model_alias !== undefined ? (
              <p>
                <span className="text-ink-faint">{t('st.namedAgents.modelPin')}: </span>
                {definition.other.pinned_model_alias}
              </p>
            ) : null}
            {definition.other.thinking_effort !== undefined ? (
              <p>
                <span className="text-ink-faint">{t('st.namedAgents.defaultModelThinkingEffort')}: </span>
                {definition.other.thinking_effort}
              </p>
            ) : null}
            {definition.other.service_tier !== undefined ? (
              <p>
                <span className="text-ink-faint">{t('st.namedAgents.serviceTier')}: </span>
                {definition.other.service_tier}
              </p>
            ) : null}
            {definition.other.context_budget !== undefined ? (
              <p>
                <span className="text-ink-faint">{t('st.namedAgents.contextBudget')}: </span>
                {definition.other.context_budget}
              </p>
            ) : null}
            {definition.other.max_completion_tokens !== undefined ? (
              <p>
                <span className="text-ink-faint">{t('st.namedAgents.maxCompletionTokens')}: </span>
                {definition.other.max_completion_tokens}
              </p>
            ) : null}
            {definition.other.tools !== undefined ? (
              <p>
                <span className="text-ink-faint">{t('st.namedAgents.tools')}: </span>
                {definition.other.tools.length === 0
                  ? t('st.tools.disabled')
                  : definition.other.tools.join(', ')}
              </p>
            ) : null}
            {definition.other.disallowed_tools !== undefined
              && definition.other.disallowed_tools.length > 0 ? (
                <p>
                  <span className="text-ink-faint">{t('st.namedAgents.disallowedTools')}: </span>
                  {definition.other.disallowed_tools.join(', ')}
                </p>
              ) : null}
            <p className="text-ink-faint">{t('st.namedAgents.diskVersionHint')}</p>
          </div>
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
              <p className="mt-0.5 text-ink leading-relaxed whitespace-pre-wrap">{description}</p>
            </div>
          ) : (
            <p className="text-ink-faint italic">{t('agentPanel.unrestricted')}</p>
          )}
          {whenToUse ? (
            <div className="rounded border-l-2 border-accent bg-accent/5 p-2 text-ink-soft text-[11px] leading-snug">
              <div className="font-medium text-accent text-[10px] uppercase mb-0.5">
                {t('st.namedAgents.whenToUse')}
              </div>
              <p className="italic">{whenToUse}</p>
            </div>
          ) : null}
        </div>
      </details>

      {/* 3. 模型与推理（三列：声明值 ← 生效值 ← 来源/锁定） */}
      <details open data-profile-section="model" className="rounded-lg border border-hairline bg-paper/40 p-2.5">
        <summary className="font-mono text-[10px] font-semibold uppercase text-ink-faint cursor-pointer select-none">
          {t('agentPanel.profileSection.model')}
        </summary>
        <div className="mt-2 space-y-2">
          <div className="rounded border border-hairline bg-paper/60 p-2 font-mono text-[10.5px]">
            <div className="grid grid-cols-3 gap-1 border-b border-hairline pb-1 text-[9.5px] font-semibold text-ink-faint uppercase">
              <div>{t('diagnostics.source.config')}</div>
              <div>{t('diagnostics.source.model')}</div>
              <div className="text-right">{t('diagnostics.source')}</div>
            </div>
            {/* Model row */}
            <div className="grid grid-cols-3 gap-1 py-1.5 border-b border-hairline items-center">
              <div className="text-ink truncate" title={pinnedModel ?? undefined}>
                {pinnedModel ?? '—'}
              </div>
              <div className="text-ink font-medium truncate" title={effectiveModel ?? undefined}>
                {effectiveModel ?? t('agentPanel.unknownModel')}
              </div>
              <div className="text-right">
                {modelOrigin.locked ? (
                  <span
                    className="rounded bg-amber-card px-1 py-0.2 text-[9px] text-amber-ink border border-amber-rule/30"
                    title={t('agentPanel.locked')}
                  >
                    🔒 {t('agentPanel.locked')}
                  </span>
                ) : (
                  <span data-value-origin="model" className="text-ink-faint text-[9.5px]">{t(modelOrigin.labelKey)}</span>
                )}
              </div>
            </div>
            {/* Effort row */}
            <div className="grid grid-cols-3 gap-1 py-1.5 border-b border-hairline items-center">
              <div className="text-ink truncate">{pinnedEffort ?? '—'}</div>
              <div className="text-ink font-medium truncate">
                {effectiveEffort ?? t('agentPanel.default')}
              </div>
              <div className="text-right">
                {effortOrigin.locked ? (
                  <span
                    className="rounded bg-amber-card px-1 py-0.2 text-[9px] text-amber-ink border border-amber-rule/30"
                    title={t('agentPanel.locked')}
                  >
                    🔒 {t('agentPanel.locked')}
                  </span>
                ) : (
                  <span data-value-origin="effort" className="text-ink-faint text-[9.5px]">{t(effortOrigin.labelKey)}</span>
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
                          {t(LEASE_LABEL_MAP[d.label])}: {d.value}
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
        <div className="mt-2 space-y-2 font-mono text-[10.5px]">
          <div>
            <div className="text-[10px] font-semibold uppercase text-ink-faint mb-1">
              {t('st.namedAgents.tools')}
            </div>
            {tools && tools.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {tools.map((name: string) => (
                  <span
                    key={name}
                    className="rounded bg-paper border border-hairline px-1.5 py-0.2 text-[9.5px] text-ink font-medium"
                  >
                    {name}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-ink-faint italic text-[10px]">{t('agentPanel.unrestricted')}</span>
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
          {spawnConstraints ? (
            <div className="space-y-1.5 rounded bg-paper/60 p-2 border border-hairline">
              <div className="text-[9.5px] font-semibold uppercase text-ink-faint">
                {t('st.namedAgents.spawnConstraints')}
              </div>
              {spawnConstraints.allowed_models && spawnConstraints.allowed_models.length > 0 ? (
                <div>
                  <span className="text-ink-faint text-[9.5px]">{t('st.namedAgents.allowedModels')}: </span>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {spawnConstraints.allowed_models.map((m: string) => (
                      <span key={m} className="rounded bg-paper border border-hairline px-1 text-[9px] text-ink">
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {spawnConstraints.deny_models && spawnConstraints.deny_models.length > 0 ? (
                <div>
                  <span className="text-danger text-[9.5px]">{t('st.namedAgents.deniedModels')}: </span>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {spawnConstraints.deny_models.map((m: string) => (
                      <span key={m} className="rounded bg-danger/10 border border-danger/20 px-1 text-[9px] text-danger">
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {spawnConstraints.allowed_efforts && spawnConstraints.allowed_efforts.length > 0 ? (
                <div>
                  <span className="text-ink-faint text-[9.5px]">{t('st.namedAgents.allowedEfforts')}: </span>
                  <span className="text-ink">{spawnConstraints.allowed_efforts.join(', ')}</span>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-ink-faint italic">{t('agentPanel.unrestricted')}</p>
          )}

          {/* Subagent leases */}
          {subagents && subagents.length > 0 ? (
            <div className="space-y-1 pt-1">
              <div className="text-[10px] font-semibold uppercase text-ink-faint">
                {t('agentPanel.subagents')} ({subagents.length})
              </div>
              <div className="space-y-1">
                {subagents.map((item, idx) => {
                  if (typeof item === 'string') {
                    return (
                      <span
                        key={item}
                        className="inline-block rounded bg-paper border border-hairline px-1.5 py-0.5 text-[9.5px] text-ink mr-1"
                      >
                        {item}
                      </span>
                    );
                  }
                  const summary = summarizeNamedAgentLease(item);
                  return (
                    <div
                      key={idx}
                      className="rounded border border-hairline bg-paper/60 p-2 font-mono text-[10px]"
                    >
                      <div className="font-medium text-ink flex items-center gap-1.5">
                        {summary.scoped ? (
                          <span className="rounded bg-accent-soft px-1 text-[8.5px] text-accent uppercase font-bold">
                            {t('st.namedAgents.scopedBadge')}
                          </span>
                        ) : null}
                        <span>{summary.headline}</span>
                      </div>
                      {summary.diagnostic ? (
                        <div className="text-danger text-[9px] mt-0.5">{summary.diagnostic}</div>
                      ) : null}
                      {summary.details.map((d, i) => (
                        <div key={i} className="text-ink-soft pl-2">
                          {t(LEASE_LABEL_MAP[d.label])}: {d.value}
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

      {/* 6. 原始文件 */}
      <details data-profile-section="raw" className="rounded-lg border border-hairline bg-paper/40 p-2.5">
        <summary className="font-mono text-[10px] font-semibold uppercase text-ink-faint cursor-pointer select-none">
          {t('agentPanel.profileSection.raw')}
        </summary>
        <div className="mt-2">
          {rawLoading ? (
            <p className="font-mono text-[10px] text-ink-faint animate-pulse">
              {t('st.namedAgents.rawLoading')}
            </p>
          ) : rawError ? (
            <p className="font-mono text-[10px] text-danger">{rawError}</p>
          ) : displayedRaw ? (
            <pre className="max-h-64 overflow-y-auto rounded-lg border border-hairline bg-paper/60 p-2.5 font-mono text-[10px] leading-snug text-ink-soft whitespace-pre-wrap">
              {displayedRaw}
            </pre>
          ) : (
            <p className="font-mono text-[10px] text-ink-faint italic">{t('st.namedAgents.builtin')}</p>
          )}
        </div>
      </details>
    </div>
  );
}
