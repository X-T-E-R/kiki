import type { AdhocEndpointInput } from '@kiki/protocol';

const REDACTED_ENDPOINT_SECRET = '[REDACTED]';
const endpointSecrets = new WeakMap<object, string>();

export function redactProfileEndpoint(endpoint: AdhocEndpointInput): AdhocEndpointInput {
  if (endpoint['api_key'] === REDACTED_ENDPOINT_SECRET && endpointSecrets.has(endpoint as object)) return endpoint;

  const sanitized: Record<string, unknown> = { ...endpoint };
  if (endpoint['capabilities'] !== undefined) sanitized['capabilities'] = [...endpoint['capabilities']];
  if (endpoint['support_efforts'] !== undefined) sanitized['support_efforts'] = [...endpoint['support_efforts']];
  if (endpoint['request_params'] !== undefined) sanitized['request_params'] = { ...endpoint['request_params'] };
  if (endpoint['api_key'] !== undefined) {
    endpointSecrets.set(sanitized, endpoint['api_key']);
    sanitized['api_key'] = REDACTED_ENDPOINT_SECRET;
  }
  return sanitized as AdhocEndpointInput;
}

export function readProfileEndpointSecret(endpoint: AdhocEndpointInput): string | undefined {
  return endpointSecrets.get(endpoint as object);
}
