import { adhocEndpointModelId, mergeEndpointInputs, type AdhocEndpointInput, type BoundEndpoint } from '@kiki/protocol';
import { readProfileEndpointSecret } from '@kiki/agent-profiles/endpointCredential';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { IConfigService } from '#/app/config/config';
import { assertSubagentModelNotDenied } from '#/session/subagent/configSection';
import { assertRoleBindingConstraints, type SubagentRoleModelConstraints } from '#/session/subagent/modelConstraints';
import type { IAdhocEndpointVault } from './adhocEndpointVault';
import { Error2, ErrorCodes } from '#/errors';

export function resolveEndpointBinding(profile: AgentProfile, override: AdhocEndpointInput | undefined,
  explicitCatalogModel: string | undefined, vault: IAdhocEndpointVault, secretRef?: string): BoundEndpoint | undefined {
  if (explicitCatalogModel !== undefined && override === undefined) return undefined;
  if (explicitCatalogModel !== undefined && override !== undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'model_alias cannot be combined with endpoint overrides; use endpoint.model for the upstream model ID.');
  const input = mergeEndpointInputs(profile.endpoint, override);
  if (input === undefined) return undefined;
  if (profile.executor !== undefined && profile.executor !== 'native') throw new Error2(ErrorCodes.REQUEST_INVALID, 'Ad-hoc endpoints require the native executor.');
  const inherited = profile.endpoint;
  const ownAuth = override?.api_key !== undefined || override?.api_key_env !== undefined;
  const literal = !ownAuth && inherited !== undefined && input.api_key === '[REDACTED]' ? readProfileEndpointSecret(inherited) : undefined;
  return vault.bind(input, literal === undefined ? secretRef : vault.store(literal));
}

export function endpointThinking(endpoint: BoundEndpoint, explicit?: string | null, profileDefault?: string): string {
  if (!endpoint.capabilities.includes('thinking')) return 'off';
  const effort = explicit ?? profileDefault ?? 'medium';
  if (!endpoint.support_efforts?.some((supported) => supported === effort)) throw new Error2(ErrorCodes.REQUEST_INVALID, `Unsupported endpoint thinking effort "${effort}".`);
  return effort;
}

export function assertEndpointConstraints(endpoint: BoundEndpoint, effort: string, config: IConfigService,
  layers: readonly ((SubagentRoleModelConstraints & { readonly name?: string; readonly modelAlias?: string }) | undefined)[]): void {
  const model = adhocEndpointModelId(endpoint);
  for (const constraints of layers) {
    if (constraints === undefined) continue;
    if ('restrictModelsToMenu' in constraints && constraints.restrictModelsToMenu === true) throw new Error2(ErrorCodes.PROFILE_CONSTRAINT_VIOLATION, 'Ad-hoc endpoints are unavailable when restrict_models_to_menu is enabled.');
    if (constraints.modelAlias !== undefined && constraints.modelAlias !== 'inherit' && constraints.name === undefined && constraints.modelAlias !== model) throw new Error2(ErrorCodes.PROFILE_CONSTRAINT_VIOLATION, 'The caller model pin does not permit this endpoint.');
    if (constraints.denyModels?.includes(endpoint.model)) throw new Error2(ErrorCodes.PROFILE_CONSTRAINT_VIOLATION, `The upstream model "${endpoint.model}" is denied.`);
    assertRoleBindingConstraints({ model, thinking: effort, constraints, ruleSource: 'endpoint', modelValueSource: 'dispatch-explicit' });
  }
  assertSubagentModelNotDenied(config, model);
  assertSubagentModelNotDenied(config, endpoint.model);
}
