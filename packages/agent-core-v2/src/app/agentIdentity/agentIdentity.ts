import { replaceUserAgentProduct } from '@kiki/oauth';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const DEFAULT_IDENTITY_SLUG = 'agent';
export const KIKI_USER_AGENT_PRODUCT = 'kiki-cli';
export const KIMI_CODE_USER_AGENT_PRODUCT = 'kimi-code-cli';

export interface AgentIdentitySnapshot {
  readonly displayName: string | undefined;
  readonly slug: string | undefined;
  readonly outboundUserAgent: string;
  readonly thirdPartyUserAgent: string | undefined;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly upstreamRequestHeaders: Readonly<Record<string, string>>;
}

export interface IAgentIdentity {
  readonly _serviceBrand: undefined;

  resolved(): Promise<AgentIdentitySnapshot>;
  current(): AgentIdentitySnapshot;
}

export const IAgentIdentity: ServiceIdentifier<IAgentIdentity> =
  createDecorator<IAgentIdentity>('agentIdentity');

export function normalizeIdentitySlug(raw: string): string {
  const folded = raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return folded.length > 0 ? folded : DEFAULT_IDENTITY_SLUG;
}

export interface AgentIdentityInput {
  readonly name?: string;
  readonly slug?: string;
  readonly advertiseAsKimiCode?: boolean;
  readonly hostDisplayName?: string;
  readonly hostRequestHeaders: Readonly<Record<string, string>>;
  readonly hostVersion?: string;
}

export function buildAgentIdentitySnapshot(input: AgentIdentityInput): AgentIdentitySnapshot {
  const name = declared(input.name);
  const rawSlug = declared(input.slug) ?? name;
  const slug = rawSlug === undefined ? undefined : normalizeIdentitySlug(rawSlug);
  const upstreamRequestHeaders: Record<string, string> = { ...input.hostRequestHeaders };
  const upstreamUserAgentKeys = userAgentKeys(upstreamRequestHeaders);
  if (upstreamUserAgentKeys.length === 0 && input.hostVersion !== undefined) {
    const product = input.advertiseAsKimiCode === true
      ? KIMI_CODE_USER_AGENT_PRODUCT
      : KIKI_USER_AGENT_PRODUCT;
    upstreamRequestHeaders['User-Agent'] = `${product}/${input.hostVersion}`;
    upstreamUserAgentKeys.push('User-Agent');
  } else if (input.advertiseAsKimiCode === true) {
    replaceUserAgentProducts(
      upstreamRequestHeaders,
      upstreamUserAgentKeys,
      KIMI_CODE_USER_AGENT_PRODUCT,
    );
  }
  const requestHeaders: Record<string, string> = { ...upstreamRequestHeaders };
  const requestUserAgentKeys = userAgentKeys(requestHeaders);
  if (slug !== undefined && input.advertiseAsKimiCode !== true) {
    replaceUserAgentProducts(requestHeaders, requestUserAgentKeys, slug);
  }
  const thirdPartyUserAgent =
    requestUserAgentKeys[0] === undefined ? undefined : requestHeaders[requestUserAgentKeys[0]];
  return {
    displayName: name ?? declared(input.hostDisplayName),
    slug,
    outboundUserAgent: thirdPartyUserAgent ?? slug ?? DEFAULT_IDENTITY_SLUG,
    thirdPartyUserAgent,
    requestHeaders,
    upstreamRequestHeaders,
  };
}

function userAgentKeys(headers: Readonly<Record<string, string>>): string[] {
  return Object.keys(headers).filter((key) => key.toLowerCase() === 'user-agent');
}

function replaceUserAgentProducts(
  headers: Record<string, string>,
  keys: readonly string[],
  product: string,
): void {
  for (const key of keys) {
    const value = headers[key];
    if (value !== undefined) headers[key] = replaceUserAgentProduct(value, product);
  }
}

function declared(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
