import type { KikiConfigResponse } from '../../lib/client';

export function mergeConfigEcho(
  baseline: KikiConfigResponse | undefined,
  echoed: KikiConfigResponse,
): KikiConfigResponse {
  if (baseline === undefined) return echoed;
  return {
    ...baseline,
    ...echoed,
    default_permission_mode: echoed.default_permission_mode ?? baseline.default_permission_mode,
    default_plan_mode: echoed.default_plan_mode ?? baseline.default_plan_mode,
    plan: echoed.plan === undefined
      ? baseline.plan
      : baseline.plan === undefined
        ? echoed.plan
        : { ...baseline.plan, ...echoed.plan },
  };
}
