import { adhocEndpointModelId, type BoundEndpoint } from '@kiki/protocol';
import { sanitizeProviderError } from '@kiki/oauth';
import type { Model } from '#/kosong/model/catalog';
import { ModelRequesterImpl } from '#/kosong/model/modelRequesterImpl';
import type { ModelRequester, ModelRequestParams } from '#/kosong/model/modelRequester';
import type { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import type { RequestAdmissionPort } from '#/kosong/model/requestAdmission';
import { resolveImagePolicy } from '#/kosong/provider/providerImagePolicy';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { credentialUnavailable, type IAdhocEndpointVault } from './adhocEndpointVault';

export function materializeAdhocModel(endpoint: BoundEndpoint, vault?: IAdhocEndpointVault): Model {
  const capabilities = endpoint.capabilities;
  return {
    id: adhocEndpointModelId(endpoint), name: endpoint.model, aliases: [],
    protocol: endpoint.provider_type, providerType: endpoint.provider_type,
    providerName: `adhoc:${endpoint.provider_type}@${endpoint.base_url}`,
    baseUrl: endpoint.base_url, headers: {},
    capabilities: {
      image_in: capabilities.includes('image_in'), video_in: capabilities.includes('video_in'),
      audio_in: capabilities.includes('audio_in'), thinking: capabilities.includes('thinking'),
      tool_use: capabilities.includes('tool_use'), max_context_tokens: endpoint.max_context_size,
    },
    maxContextSize: endpoint.max_context_size, maxCompletionTokens: endpoint.max_completion_tokens,
    requestParams: endpoint.request_params, supportEfforts: endpoint.support_efforts,
    defaultEffort: capabilities.includes('thinking') ? 'medium' : 'off', alwaysThinking: false,
    imagePolicy: resolveImagePolicy(endpoint.provider_type, undefined, undefined),
    providerOptions: { supportEfforts: endpoint.support_efforts },
    authProvider: {
      canRefresh: false,
      getAuth: async () => {
        const credential = endpoint.credential;
        const apiKey = credential.kind === 'env' ? process.env[credential.env] : vault?.read(credential.secretRef);
        if (!apiKey?.trim()) throw credentialUnavailable();
        return { apiKey };
      },
    },
  };
}

export function materializeAdhocRequester(endpoint: BoundEndpoint, vault: IAdhocEndpointVault,
  protocols: IProtocolAdapterRegistry, admission: RequestAdmissionPort): ModelRequester {
  const model = materializeAdhocModel(endpoint, vault);
  const inner = new ModelRequesterImpl(model, protocols, admission);
  return {
    model,
    async *request(input, signal, params) {
      const clean: ModelRequestParams & { attribution: typeof params.attribution } = {
        ...params, headers: undefined, requestIdentity: undefined, cacheKey: undefined,
        responsesTransport: undefined, resolveResponsesTransport: undefined, rawResponseObserver: undefined,
      };
      try { yield* inner.request(input, signal, clean); }
      catch (error) {
        if (signal?.aborted) throw error;
        const credential = endpoint.credential;
        const apiKey = credential.kind === 'env' ? process.env[credential.env] : vault.read(credential.secretRef);
        throw new Error2(isError2(error) ? error.code : ErrorCodes.PROVIDER_API_ERROR,
          vault.redact(sanitizeProviderError(error, { apiKey, baseUrl: endpoint.base_url })),
          { details: isError2(error) && error.details?.['reason'] === 'credential_unavailable' ? { reason: 'credential_unavailable', retry: false } : undefined });
      }
    },
    uploadImage: (input, options) => inner.uploadImage(input, { ...options, headers: undefined }),
    uploadVideo: (input, options) => inner.uploadVideo(input, options),
    supportsVideoUpload: () => inner.supportsVideoUpload?.() ?? false,
  };
}
