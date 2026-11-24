import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { ToolDisclosure } from '#/tool/toolContract';

export interface UserToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly disclosure?: ToolDisclosure;
  readonly inherit?: boolean;
}

export const ISessionDeclaredUserTools: ServiceIdentifier<readonly UserToolRegistration[]> =
  createDecorator<readonly UserToolRegistration[]>('sessionDeclaredUserTools');

export function sessionDeclaredUserToolsSeed(
  tools: readonly UserToolRegistration[],
): ScopeSeed {
  return [[ISessionDeclaredUserTools as ServiceIdentifier<unknown>, tools]];
}

export interface IAgentUserToolService {
  readonly _serviceBrand: undefined;

  list(): readonly UserToolRegistration[];
  inheritUserTools(parent: IAgentUserToolService): void;
  register(input: UserToolRegistration): void;
  unregister(name: string): void;
}

export const IAgentUserToolService = createDecorator<IAgentUserToolService>('agentUserToolService');
