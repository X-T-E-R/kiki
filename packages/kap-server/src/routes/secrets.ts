import { IConfigService, IMcpRegistryService, INbSearchService, type Scope } from '@kiki/agent-core-v2';
import { ENV_MODEL_PROVIDER_KEY, type ProviderConfig } from '@kiki/agent-core-v2/kosong/provider/provider';
import { explainProviderEndpoint } from '@kiki/agent-core-v2/kosong/provider/providerDefinition';
import { revealSecretRequestSchema, revealedSecretSchema, type RevealedSecret, type SecretRef } from '@kiki/protocol';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';

interface SecretsRouteHost {
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: { id: string; body: unknown }, reply: { send(payload: unknown): void }) => Promise<void> | void,
  ): unknown;
}

/** Environment fallback the Jev reviewer reads when no key is saved in Kiki. */
export const REVIEWER_API_KEY_ENV = 'TYPESAFE_API_KEY';

class SecretNotFound extends Error {}

/**
 * The one route that returns a secret value. It sits behind the same bearer
 * authentication as every other `/api` route, takes the reference in the POST
 * body so nothing lands in URLs or access logs, and logs only the reference
 * kind. Bulk reads, events and logs keep returning redacted projections.
 * OAuth tokens are sign-in state and are not addressable here.
 */
export function registerSecretsRoutes(app: SecretsRouteHost, core: Scope): void {
  const revealRoute = defineRoute({
    method: 'POST',
    path: '/secrets:reveal',
    body: revealSecretRequestSchema,
    success: { data: revealedSecretSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Reveal one secret value on explicit request, with its source. Covers saved and environment-sourced provider keys, the reviewer key, MCP env/header values and nb-search credentials; OAuth tokens are never revealed.',
    tags: ['secrets'],
  }, async (req, reply) => {
    try {
      const revealed = await revealSecret(core, req.body.ref);
      requestLog(req)?.info({ kind: req.body.ref.kind, source: revealed.source }, 'secret revealed');
      reply.send(okEnvelope(revealed, req.id));
    } catch (error) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED,
        error instanceof SecretNotFound ? error.message : 'Secret could not be read; reload the settings and retry.', req.id));
    }
  });
  app.post(revealRoute.path, revealRoute.options, revealRoute.handler as Parameters<SecretsRouteHost['post']>[2]);
}

async function revealSecret(core: Scope, ref: SecretRef): Promise<RevealedSecret> {
  switch (ref.kind) {
    case 'provider_api_key': return revealProviderKey(core, ref.provider_id);
    case 'reviewer_api_key': return revealReviewerKey(core);
    case 'nb_search_credential': {
      const view = await core.accessor.get(INbSearchService).readManagedCredential(ref.instance_id, true);
      const source = view.source === 'managed' ? 'kiki' : view.source;
      return withValue({ source, env_name: view.env_name }, view.value);
    }
    case 'mcp_env':
    case 'mcp_header':
    case 'mcp_bearer_env': return revealMcp(core, ref);
  }
}

async function revealProviderKey(core: Scope, providerId: string): Promise<RevealedSecret> {
  const config = core.accessor.get(IConfigService);
  await config.ready;
  const providers = config.get<Record<string, ProviderConfig> | undefined>('providers') ?? {};
  if (!Object.hasOwn(providers, providerId)) throw new SecretNotFound(`Provider "${providerId}" is not configured.`);
  const provider = providers[providerId]!;
  if (providerId === ENV_MODEL_PROVIDER_KEY) {
    return withValue({ source: 'environment', env_name: 'KIKI_MODEL_API_KEY' }, provider.apiKey);
  }
  if (nonEmpty(provider.apiKey) !== undefined) return withValue({ source: 'kiki' }, provider.apiKey);
  if (provider.type === undefined) return { source: 'none' };
  const bag = explainProviderEndpoint(provider.type, provider.env ?? {});
  if (bag.apiKeyEnvName !== undefined) return withValue({ source: 'environment', env_name: bag.apiKeyEnvName }, bag.apiKey);
  const shell = explainProviderEndpoint(provider.type);
  return shell.apiKeyEnvName === undefined ? { source: 'none' } : withValue({ source: 'environment', env_name: shell.apiKeyEnvName }, shell.apiKey);
}

async function revealReviewerKey(core: Scope): Promise<RevealedSecret> {
  const config = core.accessor.get(IConfigService);
  await config.ready;
  const permission = config.get<{ reviewer?: { apiKey?: string } } | undefined>('permission');
  const saved = nonEmpty(permission?.reviewer?.apiKey);
  if (saved !== undefined) return withValue({ source: 'kiki' }, saved);
  const env = nonEmpty(process.env[REVIEWER_API_KEY_ENV]);
  return env === undefined ? { source: 'none' } : withValue({ source: 'environment', env_name: REVIEWER_API_KEY_ENV }, env);
}

async function revealMcp(core: Scope, ref: Extract<SecretRef, { kind: 'mcp_env' | 'mcp_header' | 'mcp_bearer_env' }>): Promise<RevealedSecret> {
  const entry = (await core.accessor.get(IMcpRegistryService).list({ cwd: ref.cwd }))
    .find((candidate) => candidate.name === ref.server && candidate.mutable);
  if (entry === undefined) throw new SecretNotFound(`MCP server "${ref.server}" is not a user-level entry.`);
  const config = entry.config;
  if (ref.kind === 'mcp_env') {
    if (config.transport !== 'stdio' || config.env === undefined || !Object.hasOwn(config.env, ref.key)) {
      throw new SecretNotFound(`MCP server "${ref.server}" has no environment value "${ref.key}".`);
    }
    return { source: 'kiki', value: config.env[ref.key] };
  }
  if (config.transport === 'stdio') throw new SecretNotFound(`MCP server "${ref.server}" does not use a remote transport.`);
  if (ref.kind === 'mcp_header') {
    const name = Object.keys(config.headers ?? {}).find((key) => key.toLowerCase() === ref.key.toLowerCase());
    if (name === undefined) throw new SecretNotFound(`MCP server "${ref.server}" has no header "${ref.key}".`);
    return { source: 'kiki', value: config.headers![name] };
  }
  const envName = config.bearerTokenEnvVar;
  if (envName === undefined) throw new SecretNotFound(`MCP server "${ref.server}" reads no bearer token from the environment.`);
  const value = nonEmpty(process.env[envName]);
  return value === undefined ? { source: 'none', env_name: envName } : { source: 'environment', env_name: envName, value };
}

function withValue(base: RevealedSecret, value: string | undefined): RevealedSecret {
  const present = nonEmpty(value);
  if (present === undefined) return { ...base, source: base.source === 'kiki' ? 'none' : base.source };
  return { ...base, value: present };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}
