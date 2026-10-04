import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { usageExportBucketDataSchema, usageExportQualitySchema, usageExportTokensSchema, type UsageExportBucketData, type UsageExportQuality, type UsageExportTokens } from '@kiki/protocol';
import type { IModelPricingService } from '../../pricing/modelPricingService';
import type { UsageExportSource } from '../usageAggregationService';

export const HALF_HOUR_MS = 1_800_000;
export const contributionSchema = z.object({
  start: z.number().int().nonnegative(), model_alias: z.string().max(8192), upstream_model_id: z.string().max(8192).nullable(),
  tokens: usageExportTokensSchema, quality: usageExportQualitySchema, cost: z.number().finite().nonnegative().nullable(), pricing_version: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type Contribution = z.infer<typeof contributionSchema>;
export interface SourceContribution {
  readonly key: string;
  readonly workspaceId: string;
  readonly kind: 'session' | 'ephemeral';
  readonly buckets: readonly Contribution[];
  readonly invalidRecords: number;
}
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function opaqueId(secret: string, value: string): string { return createHmac('sha256', secret).update(value).digest('hex'); }
const PUBLIC_MODEL_ROUTES = new Set(['axon', 'axon-message', 'axon-chat', 'kimi-code', 'anthropic', 'deepseek', 'z-ai', 'hub', 'stealth', 'st', 'minimax']);
const PUBLIC_MODEL_PATTERNS = [
    /^gpt-\d+(?:\.\d+)?(?:-(?:mini|nano|pro|chat|codex|luna|sol|astra|flash|preview|latest))*$/i,
    /^claude-(?:opus|sonnet|haiku)-\d+(?:[-.]\d+)*(?:-\d{8})?$/i,
    /^(?:deepseek|kimi|glm)-[a-z]?\d+(?:[.-]\d+)*(?:-(?:flash|thinking|chat|reasoner|preview|instruct|latest|luna))*$/i,
    /^kimi-k\d+(?:\.\d+)?(?:-(?:thinking|instruct|preview|latest))*$/i,
    /^gemini-\d+(?:\.\d+)?-(?:pro|flash)(?:-(?:preview|lite|latest|\d{2}-\d{2}))*$/i,
    /^MiniMax-M\d+(?:\.\d+)?(?:-(?:highspeed|preview))*$/i,
    /^Qwen\/Qwen\d+(?:\.\d+)?(?:-(?:Flash|Thinking|Instruct|Coder|Max|Turbo|Plus|\d+B))*$/i,
    /^qwen\d+(?:\.\d+)?(?:-(?:flash|thinking|instruct|coder|max|turbo|plus|\d+b))*$/i,
    /^grok-\d+(?:\.\d+)?(?:-(?:fast|reasoning|non-reasoning|beta|latest))*$/i,
];
export function normalizePublicModel(model: string): string | undefined {
  let id = model;
  for (;;) { const slash = id.indexOf('/'); if (slash <= 0 || !PUBLIC_MODEL_ROUTES.has(id.slice(0, slash))) break; id = id.slice(slash + 1); }
  return id.length <= 160 && PUBLIC_MODEL_PATTERNS.some((pattern) => pattern.test(id)) ? id : undefined;
}
export function emptyTokens(): UsageExportTokens { return { input_other: 0, input_cache_read: 0, input_cache_creation: 0, output: 0 }; }
export function emptyQuality(): UsageExportQuality { return { known_records: 0, missing_records: 0, legacy_zero_records: 0, invalid_records: 0, estimated_records: 0, mapping_unknown: false, price_unknown: false, complete: true }; }
function addTokenCounts(target: UsageExportTokens, inputOther: number, cacheRead: number, cacheCreation: number, output: number): void {
  const nextInput = target.input_other + inputOther; const nextRead = target.input_cache_read + cacheRead;
  const nextCreation = target.input_cache_creation + cacheCreation; const nextOutput = target.output + output;
  if (!Number.isSafeInteger(nextInput) || !Number.isSafeInteger(nextRead) || !Number.isSafeInteger(nextCreation) || !Number.isSafeInteger(nextOutput)) throw new Error('unsafe-token-sum');
  if (!Number.isSafeInteger(nextInput + nextRead + nextCreation + nextOutput)) throw new Error('unsafe-token-total');
  target.input_other = nextInput; target.input_cache_read = nextRead; target.input_cache_creation = nextCreation; target.output = nextOutput;
}
export function addTokens(target: UsageExportTokens, tokens: UsageExportTokens): void {
  addTokenCounts(target, tokens.input_other, tokens.input_cache_read, tokens.input_cache_creation, tokens.output);
}
export function addQuality(target: UsageExportQuality, quality: UsageExportQuality): void {
  for (const key of ['known_records', 'missing_records', 'legacy_zero_records', 'invalid_records', 'estimated_records'] as const) target[key] += quality[key];
  target.mapping_unknown ||= quality.mapping_unknown; target.price_unknown ||= quality.price_unknown; target.complete &&= quality.complete;
}
export function projectSource(source: UsageExportSource, pricing: IModelPricingService): SourceContribution {
  const buckets = new Map<string, Contribution>(); let invalidRecords = 0;
  for (const record of source.records) {
    if (!Number.isSafeInteger(record.time) || record.time < 0 || record.time > 8_640_000_000_000_000 || typeof record.model !== 'string' || record.model.length > 8192) { invalidRecords++; continue; }
    const start = Math.floor(record.time / HALF_HOUR_MS) * HALF_HOUR_MS;
    const alias = record.modelAlias ?? record.model;
    const upstream = record.upstreamModelId ?? null;
    const key = JSON.stringify([start, alias, upstream]);
    let bucket = buckets.get(key);
    const priceModel = upstream ?? normalizePublicModel(record.model) ?? record.model;
    if (bucket === undefined) {
      const price = pricing.resolve(priceModel);
      const pricingVersion = digest(price === undefined ? { unknown: true } : { model: price.catalogModel, prices: price.prices, currency: price.currency ?? 'USD' });
      bucket = { start, model_alias: alias, upstream_model_id: upstream, tokens: emptyTokens(), quality: emptyQuality(), cost: 0, pricing_version: pricingVersion }; buckets.set(key, bucket);
    }
    const input = record.usage?.inputOther; const read = record.usage?.inputCacheRead;
    const creation = record.usage?.inputCacheCreation; const output = record.usage?.output;
    if (record.invalid || !Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(read) || read < 0 || !Number.isSafeInteger(creation) || creation < 0 || !Number.isSafeInteger(output) || output < 0 || !Number.isSafeInteger(input + read + creation + output)) {
      bucket.quality.invalid_records++; bucket.quality.complete = false; bucket.quality.price_unknown = true; bucket.cost = null; invalidRecords++; continue;
    }
    addTokenCounts(bucket.tokens, input, read, creation, output);
    const legacy = record.usageKnown === undefined && input === 0 && read === 0 && creation === 0 && output === 0;
    if (record.usageKnown === false) bucket.quality.missing_records++;
    else if (legacy) bucket.quality.legacy_zero_records++;
    else bucket.quality.known_records++;
    const cost = record.usageKnown === false || legacy ? undefined : pricing.calculate(priceModel, record.usage);
    if (cost === undefined || !Number.isFinite(cost) || cost < 0) { bucket.cost = null; bucket.quality.price_unknown = true; }
    else if (bucket.cost !== null) bucket.cost += cost;
  }
  return { key: source.key, workspaceId: source.workspaceId, kind: source.kind, buckets: [...buckets.values()].map((v) => contributionSchema.parse(v)), invalidRecords };
}
export function publicBucket(contributions: readonly Contribution[], identitySecret: string): UsageExportBucketData {
  const first = contributions[0]; if (first === undefined) throw new Error('empty-contribution');
  const canonical = normalizePublicModel(first.upstream_model_id ?? first.model_alias);
  const model = canonical ?? `custom-${opaqueId(identitySecret, `model\0${first.upstream_model_id ?? first.model_alias}`).slice(0, 32)}`;
  const tokens = emptyTokens(); const quality = emptyQuality(); let cost: number | null = 0;
  const prices = new Set<string>();
  for (const contribution of contributions) {
    addTokens(tokens, contribution.tokens); addQuality(quality, contribution.quality); prices.add(contribution.pricing_version);
    if (contribution.cost === null) cost = null; else if (cost !== null) cost += contribution.cost;
  }
  quality.mapping_unknown = canonical === undefined;
  return usageExportBucketDataSchema.parse({ start_at: new Date(first.start).toISOString(), end_at: new Date(first.start + HALF_HOUR_MS).toISOString(), source: 'kiki', model, mapping_version: 'kiki-public-model-v1', tokens, quality, cost: { usd_estimated: cost, currency: 'USD', source: 'kiki-local-estimate', pricing_version: digest([...prices].sort()) } });
}
