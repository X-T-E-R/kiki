import type { AgentCapabilityTarget } from '@kiki/protocol';
import { useI18n } from '../../i18n';

export function dispatchPolicyClass(policy: AgentCapabilityTarget['dispatch_policy']): string {
  return policy === 'fixed' ? 'bg-amber-card text-amber-ink' : 'bg-panel text-ink-faint';
}

function recommendationClass(status: AgentCapabilityTarget['recommendation_status']): string {
  switch (status) {
    case 'preferred': return 'bg-success/10 text-success';
    case 'allowed_nonpreferred': return 'bg-amber-card text-amber-ink';
    case 'blocked': return 'bg-danger/10 text-danger';
    case 'unconfigured': return 'bg-panel text-ink-soft';
    default: return 'bg-panel text-ink-faint';
  }
}

export function DispatchPolicyBadges({ profilePolicy, targets, className = '' }: {
  readonly profilePolicy?: AgentCapabilityTarget['dispatch_policy'];
  readonly targets?: readonly AgentCapabilityTarget[];
  readonly className?: string;
}) {
  const { t } = useI18n();
  const recommendationStates = targets === undefined || targets.length === 0 ? [undefined] : targets;
  const isRecommendationUnreported = (target: AgentCapabilityTarget | undefined) => target === undefined || (
    target.recommendation_status === undefined && target.advisory_deviation === undefined
  );
  const hasUnreportedRecommendation = recommendationStates.some(isRecommendationUnreported);
  const reportedRecommendations = recommendationStates.filter(
    (target): target is AgentCapabilityTarget => !isRecommendationUnreported(target),
  );
  const policies = profilePolicy === undefined
    ? [...new Set(recommendationStates.map((target) => target?.dispatch_policy))]
    : [profilePolicy];
  const recommendations = new Map<string, { status: AgentCapabilityTarget['recommendation_status']; deviation: boolean | undefined }>();
  for (const target of reportedRecommendations) {
    recommendations.set(`${target.recommendation_status ?? 'unknown'}:${String(target.advisory_deviation)}`,
      { status: target.recommendation_status, deviation: target.advisory_deviation });
  }
  return (
    <div data-dispatch-policy-badges className={`flex flex-wrap items-center gap-1 ${className}`}>
      {policies.map((policy) => (
        <span key={policy ?? 'unknown'} data-dispatch-policy={policy ?? 'unknown'} className={`rounded-sm px-1.5 py-px text-[11.5px] ${dispatchPolicyClass(policy)}`}>
          {policy === undefined ? t('diagnostics.unknown') : t(`diagnostics.policy.${policy}`)}
        </span>
      ))}
      {[...recommendations.values()].map(({ status, deviation }) => {
        const label = status === undefined ? t('diagnostics.unknown') : status === 'unconfigured' ? t('diagnostics.unconfigured') : status === 'preferred' ? t('diagnostics.preferred') : status === 'allowed_nonpreferred' ? t('diagnostics.allowedNonpreferred') : t('diagnostics.blocked');
        return (
          <span key={`${status ?? 'unknown'}:${String(deviation)}`} data-recommendation-status={status ?? 'unknown'} data-advisory-deviation={deviation === undefined ? 'unknown' : String(deviation)} className={`rounded-sm px-1.5 py-px text-[11.5px] ${recommendationClass(status)}`}>
            {label}
          </span>
        );
      })}
      {hasUnreportedRecommendation ? (
        <span data-recommendation-status="unknown" data-advisory-deviation="unknown" className={`rounded-sm px-1.5 py-px text-[11.5px] ${recommendationClass(undefined)}`}>
          {t('diagnostics.unknown')}
        </span>
      ) : null}
    </div>
  );
}
