import type { DelegationPosition } from '#/agent/profile/delegationContext';
import type { CognitionConfig, CognitionContent } from '#/kosong/model/model';

export interface CognitionBinding {
  readonly position: DelegationPosition;
  readonly modelAlias: string;
  readonly revision: number;
  readonly contentRevision: string;
  readonly bindingRevision?: string;
  readonly config?: CognitionContent;
  readonly modelSettings?: Readonly<Record<string, unknown>>;
  readonly recipe?: { readonly installation_id: string; readonly resolved: import('#/state/state').DeepReadonly<import('@kiki/protocol').ResolvedRecipe>; readonly anchorSystem?: string };
  readonly anchor?: string;
  readonly slots?: { readonly overlay?: string; readonly steering?: string; readonly anchor?: string };
}

export function selectCognitionConfig(
  cognition: CognitionConfig | undefined,
  position: DelegationPosition,
): CognitionContent | undefined {
  if (cognition === undefined) return undefined;
  const branch = position === 'sub' ? undefined : cognition[position];
  if (branch === 'off') return undefined;
  if (typeof branch === 'object') return branch;
  const { overlay, steering, steeringOnTurn, steeringOnInput, steeringIntervalSteps, anchor, overlayMode, anchorSteps, anchorScope } = cognition;
  if ([overlay, steering, steeringOnTurn, steeringOnInput, steeringIntervalSteps, anchor, overlayMode, anchorSteps, anchorScope].every((value) => value === undefined)) return undefined;
  return { overlay, steering, steeringOnTurn, steeringOnInput, steeringIntervalSteps, anchor, overlayMode, anchorSteps, anchorScope };
}
