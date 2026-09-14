import type {
  PromptOverrides,
  PromptOverrideSource,
  PromptOverrideSurface,
  ResolvedPromptOverrides,
} from '@kiki/agent-profiles/promptOverrides';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export interface PromptTemplateReference {
  readonly kind: 'inline' | 'resource';
  readonly value: string;
}

export interface PromptFieldApplicability {
  readonly profiles?: readonly string[];
  readonly models?: readonly string[];
  readonly executors?: readonly string[];
  readonly consumers?: readonly string[];
  readonly delegationPositions?: readonly ('main' | 'sub' | 'independent')[];
}

export interface PromptFieldDefinition {
  readonly id: string;
  readonly owner: string;
  readonly defaultTemplate: PromptTemplateReference;
  readonly allowedVariables: readonly string[];
  readonly requiredPlaceholders: readonly string[];
  readonly allowEmpty: boolean;
  readonly readonly: boolean;
  readonly consumers: readonly string[];
  readonly appliesTo?: PromptFieldApplicability;
  readonly contractVersion: number;
}

export interface PromptFieldContext {
  readonly profileName?: string;
  readonly modelAlias?: string;
  readonly executor?: string;
  readonly consumer?: string;
  readonly delegationPosition?: 'main' | 'sub' | 'independent';
}

export type PromptFieldResolutionStatus =
  | 'effective'
  | 'shadowed'
  | 'inactive'
  | 'deferred'
  | 'unsupported';

export interface ResolvedPromptFieldOverride {
  readonly id: string;
  readonly value: string;
  readonly status: PromptFieldResolutionStatus;
  readonly sources: readonly PromptOverrideSource[];
}

export interface PromptOverrideScopeInput {
  readonly surface: PromptOverrideSurface;
  readonly overrides?: PromptOverrides | readonly PromptOverrides[];
  readonly sourcePath?: string;
}

export interface PromptOverrideResolutionInput {
  readonly global?: PromptOverrideScopeInput;
  readonly model?: PromptOverrideScopeInput;
  readonly profile?: PromptOverrideScopeInput;
  readonly profileModel?: PromptOverrideScopeInput;
  readonly context?: PromptFieldContext;
  readonly customVariables?: Readonly<Record<string, string>>;
}

export interface ResolvedPromptFieldOverrides {
  readonly values: Readonly<Record<string, string>>;
  readonly fields: readonly ResolvedPromptFieldOverride[];
}

export interface IPromptFieldRegistry {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<{ readonly ref?: string }>;
  list(): readonly PromptFieldDefinition[];
  get(id: string): PromptFieldDefinition | undefined;
  validate(
    overrides: ResolvedPromptOverrides,
    context?: PromptFieldContext,
    customVariables?: Readonly<Record<string, string>>,
  ): ResolvedPromptFieldOverrides;
  resolve(input: PromptOverrideResolutionInput): Promise<ResolvedPromptFieldOverrides>;
}

export const IPromptFieldRegistry: ServiceIdentifier<IPromptFieldRegistry> =
  createDecorator<IPromptFieldRegistry>('promptFieldRegistry');
