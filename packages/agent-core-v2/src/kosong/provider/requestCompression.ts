import { z } from 'zod';

import { Error2 } from '#/_base/errors/errors';
import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';
import type { RequestCompression } from '#/kosong/contract/requestCompression';
import type { ResponsesWebSocketConfig } from '#/kosong/contract/responsesTransport';

export const ProviderTargetsSchema = z.array(z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username === '' && url.password === '' && url.search === '' && url.hash === '';
}, 'Use an HTTP(S) API base URL without credentials, query, or fragment')).min(1);
const minBytes = z.number().int().nonnegative().safe().optional();

const requestCompressionObject = z.object({
  encoding: z.enum(['off', 'gzip', 'zstd']).optional(),
  targets: ProviderTargetsSchema.optional(),
  minBytes,
  dictionary: z.boolean().optional(),
}).strict();

export const RequestCompressionLayerSchema = requestCompressionObject.superRefine((value, ctx) => {
  const extra = value.targets !== undefined || value.minBytes !== undefined || value.dictionary !== undefined;
  if (value.encoding === 'off') {
    if (extra) {
      ctx.addIssue({ code: 'custom', message: 'encoding off cannot include other request_compression fields' });
    }
    return;
  }
  if (!extra && value.encoding === undefined) {
    ctx.addIssue({ code: 'custom', message: 'request_compression needs encoding, targets, min_bytes, or dictionary' });
  }
  if (value.encoding === 'gzip' && value.dictionary !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'dictionary applies only to encoding zstd', path: ['dictionary'] });
  }
});
export type RequestCompressionLayer = z.infer<typeof RequestCompressionLayerSchema>;

const responsesWebSocketObject = z.object({
  off: z.literal(true).optional(),
  targets: ProviderTargetsSchema.optional(),
}).strict();

export const ResponsesWebSocketLayerSchema = responsesWebSocketObject.superRefine((value, ctx) => {
  if (value.off === true) {
    if (value.targets !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'responses_web_socket off cannot include targets', path: ['targets'] });
    }
    return;
  }
  if (value.targets === undefined) {
    ctx.addIssue({ code: 'custom', message: 'responses_web_socket needs targets or off' });
  }
});
export type ResponsesWebSocketLayer = z.infer<typeof ResponsesWebSocketLayerSchema>;

export interface ProviderTransportDefaults {
  readonly requestCompression?: RequestCompressionLayer;
  readonly responsesWebSocket?: ResponsesWebSocketLayer;
}

/**
 * Field merge of the system table and one provider table.
 * Provider `encoding = "off"` suppresses the system table.
 * A set field replaces that field; an omitted field inherits.
 * `targets`, when set, replaces the whole array in order and is not concatenated.
 * `dictionary` is kept only for zstd. An omitted `dictionary` inherits a zstd system choice, including `false`.
 */
export function resolveRequestCompression(
  system: RequestCompressionLayer | undefined,
  provider: RequestCompressionLayer | undefined,
): RequestCompression | undefined {
  if (isCompressionOff(provider)) return { encoding: 'off' };
  if (provider === undefined) {
    if (system === undefined) return undefined;
    if (isCompressionOff(system)) return { encoding: 'off' };
    return finishCompression(system);
  }
  const base = system !== undefined && !isCompressionOff(system) ? system : undefined;
  return finishCompression({
    encoding: provider.encoding ?? base?.encoding,
    targets: provider.targets ?? base?.targets,
    minBytes: provider.minBytes ?? base?.minBytes,
    dictionary: provider.dictionary ?? (provider.encoding === 'gzip' ? undefined : base?.dictionary),
  });
}

/**
 * Whole-object override. An omitted provider layer inherits the system layer.
 * `{ off: true }` suppresses system targets. A provider `targets` array replaces the system array.
 * The returned array is a copy. `undefined` means ordinary HTTP.
 */
export function resolveResponsesWebSocket(
  system: ResponsesWebSocketLayer | undefined,
  provider: ResponsesWebSocketLayer | undefined,
): ResponsesWebSocketConfig | undefined {
  const chosen = provider ?? system;
  if (chosen === undefined || chosen.off === true) return undefined;
  if (chosen.targets === undefined) {
    throw new Error2(CONFIG_INVALID_ERROR_CODE, 'responses_web_socket needs targets');
  }
  return { targets: [...chosen.targets] };
}

function isCompressionOff(layer: RequestCompressionLayer | undefined): layer is { encoding: 'off' } {
  return layer !== undefined && layer.encoding === 'off';
}

function finishCompression(layer: {
  readonly encoding?: 'off' | 'gzip' | 'zstd';
  readonly targets?: readonly string[];
  readonly minBytes?: number;
  readonly dictionary?: boolean;
}): RequestCompression {
  if (layer.encoding === undefined || layer.encoding === 'off' || layer.targets === undefined) {
    throw new Error2(CONFIG_INVALID_ERROR_CODE, 'request_compression needs encoding and targets');
  }
  const targets = [...layer.targets];
  if (layer.encoding === 'gzip') {
    if (layer.dictionary !== undefined) {
      throw new Error2(CONFIG_INVALID_ERROR_CODE, 'request_compression dictionary requires encoding zstd');
    }
    return layer.minBytes === undefined ? { encoding: 'gzip', targets } : { encoding: 'gzip', targets, minBytes: layer.minBytes };
  }
  const resolved = layer.minBytes === undefined
    ? { encoding: 'zstd' as const, targets }
    : { encoding: 'zstd' as const, targets, minBytes: layer.minBytes };
  return layer.dictionary === undefined ? resolved : { ...resolved, dictionary: layer.dictionary };
}

function schemaIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ');
}

/**
 * A present system table must already be a complete effective value or explicit off.
 * A provider overlay stays on {@link RequestCompressionLayerSchema} and may name one field.
 */
export const RequestCompressionSystemSchema = requestCompressionObject.superRefine((value) => {
  const parsed = RequestCompressionLayerSchema.safeParse(value);
  if (!parsed.success) throw new Error2(CONFIG_INVALID_ERROR_CODE, schemaIssues(parsed.error));
  resolveRequestCompression(parsed.data, undefined);
});

/** A present system table must name targets or explicit off. */
export const ResponsesWebSocketSystemSchema = responsesWebSocketObject.superRefine((value) => {
  const parsed = ResponsesWebSocketLayerSchema.safeParse(value);
  if (!parsed.success) throw new Error2(CONFIG_INVALID_ERROR_CODE, schemaIssues(parsed.error));
  resolveResponsesWebSocket(parsed.data, undefined);
});

export const RequestCompressionWireSchema = z.object({
  encoding: z.enum(['off', 'gzip', 'zstd']).optional(),
  targets: ProviderTargetsSchema.optional(),
  min_bytes: minBytes,
  dictionary: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  const parsed = RequestCompressionLayerSchema.safeParse(requestCompressionFromWire(value));
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  }
});
export type RequestCompressionWire = z.infer<typeof RequestCompressionWireSchema>;

export const ResponsesWebSocketWireSchema = z.object({
  off: z.literal(true).optional(),
  targets: ProviderTargetsSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const parsed = ResponsesWebSocketLayerSchema.safeParse(responsesWebSocketFromWire(value));
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  }
});
export type ResponsesWebSocketWire = z.infer<typeof ResponsesWebSocketWireSchema>;

export function requestCompressionFromWire(wire: {
  readonly encoding?: 'off' | 'gzip' | 'zstd';
  readonly targets?: readonly string[];
  readonly min_bytes?: number;
  readonly dictionary?: boolean;
}): RequestCompressionLayer {
  const layer: RequestCompressionLayer = {};
  if (wire.encoding !== undefined) layer.encoding = wire.encoding;
  if (wire.targets !== undefined) layer.targets = [...wire.targets];
  if (wire.min_bytes !== undefined) layer.minBytes = wire.min_bytes;
  if (wire.dictionary !== undefined) layer.dictionary = wire.dictionary;
  return layer;
}

export function requestCompressionToWire(
  layer: RequestCompressionLayer | undefined,
): RequestCompressionWire | undefined {
  if (layer === undefined) return undefined;
  const wire: RequestCompressionWire = {};
  if (layer.encoding !== undefined) wire.encoding = layer.encoding;
  if (layer.targets !== undefined) wire.targets = [...layer.targets];
  if (layer.minBytes !== undefined) wire.min_bytes = layer.minBytes;
  if (layer.dictionary !== undefined) wire.dictionary = layer.dictionary;
  return wire;
}

export function responsesWebSocketFromWire(wire: {
  readonly off?: true;
  readonly targets?: readonly string[];
}): ResponsesWebSocketLayer {
  const layer: ResponsesWebSocketLayer = {};
  if (wire.off !== undefined) layer.off = wire.off;
  if (wire.targets !== undefined) layer.targets = [...wire.targets];
  return layer;
}

export function responsesWebSocketToWire(
  layer: ResponsesWebSocketLayer | undefined,
): ResponsesWebSocketWire | undefined {
  if (layer === undefined) return undefined;
  const wire: ResponsesWebSocketWire = {};
  if (layer.off !== undefined) wire.off = layer.off;
  if (layer.targets !== undefined) wire.targets = [...layer.targets];
  return wire;
}
