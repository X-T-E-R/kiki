import { collection, type CollectionView } from '#/_base/di/collection';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type {
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import type { PermissionPolicy, PermissionPolicyResult } from './types';

export const PermissionPolicyAllowlistContribution =
  collection<ServiceIdentifier<PermissionPolicy>>('permission-policy-allowlist');

export type PermissionPolicyAllowlistView = CollectionView<ServiceIdentifier<PermissionPolicy>>;

export interface PermissionPolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export interface IAgentPermissionPolicyService {
  readonly _serviceBrand: undefined;

  evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyEvaluation | undefined>;
}

export const IAgentPermissionPolicyService =
  createDecorator<IAgentPermissionPolicyService>('agentPermissionPolicyService');
