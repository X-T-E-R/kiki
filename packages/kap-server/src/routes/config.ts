import {
  ConfigChanged,
  ConfigTarget,
  IConfigService,
  IEventService,
  type Scope,
} from '@kiki/agent-core-v2';
import { REQUEST_IDENTITY_SECTION } from '@kiki/agent-core-v2/app/kosongConfig/configSection';
import {
  requestIdentityFromWire,
  requestIdentityToWire,
  type RequestIdentityPolicy,
} from '@kiki/agent-core-v2/kosong/requestIdentity/requestIdentityPolicy';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { configResponseSchema, patchConfigRequestSchema } from '../protocol/rest-config';
import type { ConfigResponse } from '../protocol/rest-config';

type ProviderResponse = ConfigResponse['providers'][string];

interface ConfigRouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

const configResponseWireSchema = configResponseSchema.passthrough();

export function registerConfigRoutes(app: ConfigRouteHost, core: Scope): void {
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/config',
      success: { data: configResponseSchema },
      description: 'Get the global Kimi configuration (secrets redacted)',
      tags: ['config'],
    },
    async (req, reply) => {
      const config = core.accessor.get(IConfigService);
      await config.ready;
      reply.send(okEnvelope(toConfigResponse(config.getAll()), req.id));
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<ConfigRouteHost['get']>[2]);

  const setRoute = defineRoute(
    {
      method: 'POST',
      path: '/config',
      body: patchConfigRequestSchema,
      success: { data: configResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
      },
      description: 'Update the global Kimi configuration (merge by default)',
      tags: ['config'],
    },
    async (req, reply) => {
      try {
        const config = core.accessor.get(IConfigService);
        await config.ready;
        const requestIdentity = req.body.request_identity;
        const camelPatch = convertKeysSnakeToCamel(req.body) as Record<string, unknown>;
        const replaceDomains = new Set(
          ((camelPatch['replaceDomains'] as string[] | undefined) ?? []).map(snakeToCamel),
        );
        delete camelPatch['replaceDomains'];
        delete camelPatch[REQUEST_IDENTITY_SECTION];
        if (camelPatch['yolo'] === true) {
          camelPatch['defaultPermissionMode'] = 'yolo';
        }
        delete camelPatch['yolo'];
        for (const domain of Object.keys(camelPatch)) {
          if (domain === 'prompt' && replaceDomains.has(domain)) {
            await config.replaceSections({ [domain]: camelPatch[domain] }, ConfigTarget.User);
          } else if (replaceDomains.has(domain)) {
            await config.replace(domain, null);
            await config.replace(domain, camelPatch[domain]);
          } else {
            await config.set(domain, camelPatch[domain]);
          }
        }
        if (requestIdentity !== undefined) {
          await config.replace(
            REQUEST_IDENTITY_SECTION,
            requestIdentity === null ? null : requestIdentityFromWire(requestIdentity),
            ConfigTarget.User,
          );
        }
        const response = toConfigResponse(config.getAll());
        const changedFields = Object.keys(req.body as Record<string, unknown>).filter(
          (field) => field !== 'replace_domains',
        );
        core.accessor.get(IEventService).publish(
          new ConfigChanged({ payload: { changedFields, config: response } }),
        );
        requestLog(req)?.info({ changedFields }, 'config updated');
        reply.send(okEnvelope(response, req.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        requestLog(req)?.error({ err: error }, 'config update failed');
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
      }
    },
  );
  app.post(setRoute.path, setRoute.options, setRoute.handler as Parameters<ConfigRouteHost['post']>[2]);
}

function toConfigResponse(resolved: Record<string, unknown>): ConfigResponse {
  const wire: Record<string, unknown> = {};
  for (const [domain, value] of Object.entries(resolved)) {
    if (domain === 'telemetry' || domain === 'services') {
      continue;
    } else if (domain === 'providers') {
      wire['providers'] = toProviderResponses(value);
    } else if (domain === REQUEST_IDENTITY_SECTION) {
      wire['request_identity'] = requestIdentityToWire(value as RequestIdentityPolicy);
    } else {
      wire[camelToSnake(domain)] = value;
    }
  }
  const defaultPermissionMode = resolved['defaultPermissionMode'];
  if (typeof defaultPermissionMode === 'string') {
    wire['yolo'] = defaultPermissionMode === 'yolo';
  }
  if (wire['providers'] === undefined) {
    wire['providers'] = {};
  }
  return configResponseWireSchema.parse(wire);
}

interface ProviderLike {
  readonly type?: unknown;
  readonly baseUrl?: unknown;
  readonly defaultModel?: unknown;
  readonly apiKey?: unknown;
  readonly oauth?: unknown;
}

function toProviderResponses(value: unknown): Record<string, ProviderResponse> {
  const result: Record<string, ProviderResponse> = {};
  if (!isPlainObject(value)) return result;
  for (const [id, raw] of Object.entries(value)) {
    const provider = raw as ProviderLike;
    result[id] = {
      type: typeof provider.type === 'string' ? provider.type : '',
      base_url: nonEmpty(provider.baseUrl),
      default_model: nonEmpty(provider.defaultModel),
      has_api_key: hasProviderCredential(provider),
    };
  }
  return result;
}

function hasProviderCredential(provider: ProviderLike): boolean {
  if (nonEmpty(provider.apiKey) !== undefined) return true;
  if (provider.oauth !== undefined) return true;
  return false;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAP_VALUED_CONFIG_KEYS = new Set(['providers', 'models', 'experimental', 'raw']);

function convertKeysSnakeToCamel(obj: unknown, preserveKeys = false): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => convertKeysSnakeToCamel(item));
  }
  if (isPlainObject(obj)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const targetKey = preserveKeys ? key : snakeToCamel(key);
      if (!preserveKeys && (key === 'nb_search' || key === 'prompt')) {
        result[targetKey] = value;
      } else {
        result[targetKey] = convertKeysSnakeToCamel(
          value,
          !preserveKeys && MAP_VALUED_CONFIG_KEYS.has(key),
        );
      }
    }
    return result;
  }
  return obj;
}

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function camelToSnake(str: string): string {
  return str.replaceAll(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}
