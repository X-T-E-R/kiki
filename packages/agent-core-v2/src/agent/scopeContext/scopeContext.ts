import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentScopeContext {
  readonly _serviceBrand: undefined;

  readonly agentId: string;
  readonly parentAgentId?: string;
  scope(subKey?: string): string;
}

export const IAgentScopeContext: ServiceIdentifier<IAgentScopeContext> =
  createDecorator<IAgentScopeContext>('agentScopeContext');

export function makeAgentScopeContext(input: {
  readonly agentId: string;
  readonly agentScope: string;
  readonly parentAgentId?: string;
}): IAgentScopeContext {
  const { agentScope } = input;
  return {
    _serviceBrand: undefined,
    agentId: input.agentId,
    parentAgentId: input.parentAgentId,
    scope: (subKey?: string): string => {
      if (subKey === undefined || subKey === '') return agentScope;
      if (agentScope === '') return subKey;
      return `${agentScope}/${subKey}`;
    },
  };
}
