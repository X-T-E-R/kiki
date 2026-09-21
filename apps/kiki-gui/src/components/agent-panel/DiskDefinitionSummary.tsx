import { memo } from 'react';
import type { NamedAgentProfile } from '@kiki/protocol';
import {
  NAMED_AGENT_LEASE_DETAIL_LABEL_KEYS,
  summarizeNamedAgentModelProfile,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';

export interface DiskDefinitionSummaryProps {
  readonly definition: NamedAgentProfile;
  readonly className?: string;
  readonly showDescription?: boolean;
  readonly showTools?: boolean;
  readonly showModelProfiles?: boolean;
  readonly showSpawnConstraints?: boolean;
  readonly budgetFallbackLabel?: string;
}

export const DiskDefinitionSummary = memo(function DiskDefinitionSummary({
  definition,
  className = 'space-y-1 break-all font-mono text-[10.5px] text-ink-soft',
  showDescription = true,
  showTools = true,
  showModelProfiles = false,
  showSpawnConstraints = false,
  budgetFallbackLabel,
}: DiskDefinitionSummaryProps) {
  const { t } = useI18n();

  const constraints = definition.spawn_constraints;
  const spawnSummary =
    constraints === undefined
      ? ''
      : [
          constraints.allowed_models === undefined
            ? null
            : `${t('st.namedAgents.allowedModels')} ${constraints.allowed_models.join(', ')}`,
          constraints.deny_models === undefined
            ? null
            : `${t('st.namedAgents.deniedModels')} ${constraints.deny_models.join(', ')}`,
          constraints.allowed_efforts === undefined
            ? null
            : `${t('st.namedAgents.allowedEfforts')} ${constraints.allowed_efforts.join(', ')}`,
          constraints.disallowed_tools === undefined
            ? null
            : `${t('st.namedAgents.disallowedTools')} ${constraints.disallowed_tools.join(', ')}`,
        ]
          .filter((segment): segment is string => segment !== null)
          .join(' · ');

  const contextBudget =
    definition.context_budget !== undefined && definition.context_budget > 0
      ? definition.context_budget
      : undefined;
  const maxCompletionTokens =
    definition.max_completion_tokens !== undefined && definition.max_completion_tokens > 0
      ? definition.max_completion_tokens
      : undefined;
  const hasProfileBudget =
    contextBudget !== undefined ||
    maxCompletionTokens !== undefined ||
    (definition.request_params !== undefined && Object.keys(definition.request_params).length > 0);

  return (
    <div className={className}>
      {showDescription && definition.description !== undefined ? (
        <p>
          <span className="text-ink-faint">{t('agentPanel.profileDescription')}: </span>
          {definition.description}
        </p>
      ) : null}

      {definition.when_to_use !== undefined ? (
        <p>
          <span className="text-ink-faint">{t('st.namedAgents.whenToUse')}: </span>
          {definition.when_to_use}
        </p>
      ) : null}

      {definition.pinned_model_alias !== undefined ? (
        <p>
          <span className="text-ink-faint">{t('st.namedAgents.modelPin')}: </span>
          {definition.pinned_model_alias}
        </p>
      ) : null}

      {definition.thinking_effort !== undefined ? (
        <p>
          <span className="text-ink-faint">{t('st.namedAgents.defaultModelThinkingEffort')}: </span>
          {definition.thinking_effort}
        </p>
      ) : null}

      {definition.service_tier !== undefined ? (
        <p>
          <span className="text-ink-faint">{t('st.namedAgents.serviceTier')}: </span>
          {definition.service_tier}
        </p>
      ) : null}

      {budgetFallbackLabel !== undefined ? (
        hasProfileBudget ? (
          <>
            <p>
              <span className="text-ink-faint">{t('st.namedAgents.contextBudget')}: </span>
              {contextBudget ?? budgetFallbackLabel}
            </p>
            <p>
              <span className="text-ink-faint">{t('st.namedAgents.maxCompletionTokens')}: </span>
              {maxCompletionTokens ?? budgetFallbackLabel}
            </p>
            <p>
              <span className="text-ink-faint">{t('st.namedAgents.requestParams')}: </span>
              {definition.request_params === undefined || Object.keys(definition.request_params).length === 0
                ? budgetFallbackLabel
                : JSON.stringify(definition.request_params)}
            </p>
          </>
        ) : null
      ) : (
        <>
          {contextBudget !== undefined ? (
            <p>
              <span className="text-ink-faint">{t('st.namedAgents.contextBudget')}: </span>
              {contextBudget}
            </p>
          ) : null}
          {maxCompletionTokens !== undefined ? (
            <p>
              <span className="text-ink-faint">{t('st.namedAgents.maxCompletionTokens')}: </span>
              {maxCompletionTokens}
            </p>
          ) : null}
          {definition.request_params !== undefined && Object.keys(definition.request_params).length > 0 ? (
            <p>
              <span className="text-ink-faint">{t('st.namedAgents.requestParams')}: </span>
              {JSON.stringify(definition.request_params)}
            </p>
          ) : null}
        </>
      )}

      {showTools && definition.tools !== undefined ? (
        <p>
          <span className="text-ink-faint">{t('st.namedAgents.tools')}: </span>
          {definition.tools.length === 0 ? t('st.tools.disabled') : definition.tools.join(', ')}
        </p>
      ) : null}

      {showTools && definition.disallowed_tools !== undefined && definition.disallowed_tools.length > 0 ? (
        <p>
          <span className="text-ink-faint">{t('st.namedAgents.disallowedTools')}: </span>
          {definition.disallowed_tools.join(', ')}
        </p>
      ) : null}

      {showSpawnConstraints && spawnSummary !== '' ? (
        <p>
          <span className="text-ink-faint">{t('st.namedAgents.spawnConstraints')}: </span>
          {spawnSummary}
        </p>
      ) : null}

      {showModelProfiles && definition.model_profiles && definition.model_profiles.length > 0 ? (
        <div className="space-y-1">
          {definition.model_profiles.map((entry) => {
            const modelProfile = summarizeNamedAgentModelProfile(entry);
            return (
              <div key={entry.alias} className="space-y-1">
                <p>
                  <span className="text-ink-faint">{t('st.namedAgents.modelProfile')}: </span>
                  {modelProfile.headline}
                </p>
                {modelProfile.details.map((detail, detailIndex) => (
                  <p key={`${detail.label}:${detailIndex}`} className="pl-3">
                    <span className="text-ink-faint">{t(NAMED_AGENT_LEASE_DETAIL_LABEL_KEYS[detail.label])}: </span>
                    {detail.value}
                  </p>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});
