/**
 * Checked-in local model price overrides for internal routing aliases.
 *
 * The LiteLLM catalog (`vendor/litellm/model_prices_and_context_window.json`,
 * refreshed from MODEL_PRICE_URLS) is the source of truth for public provider
 * pricing, but it does not describe every internal alias this repo serves.
 * `kimi-code/*` is one such internal alias prefix: the underlying provider is
 * `managed:kimi-code` (see `packages/oauth`), while the LiteLLM catalog only
 * lists third-party resales of Moonshot models (e.g. `azure_ai/FW-Kimi-K3`).
 *
 * Each entry does exactly one of two things, both consulted *before* the
 * LiteLLM chain so a local decision always wins and can never regress the
 * existing `axon-message/*` gateway-prefix / date-pin behaviour:
 *
 *  1. `navigateTo` — map a request alias onto a catalog key whose prices
 *     already exist and should be reused verbatim.
 *  2. `prices` — hold explicit USD per-token prices for an alias whose model
 *     has no catalog entry yet.
 *
 * Every explicit `prices` entry documents its official source and retrieval
 * date below. An alias is only ever assigned explicit prices when they could be
 * verified against an official Moonshot/Kimi page; anything without a verified
 * price is deliberately left out so the cost report keeps flagging it as "no
 * price" instead of inventing one.
 *
 * Retrieval date for all official pages: 2026-08-19.
 */
import type { ModelTokenPrices } from './modelPricingService';

export interface LocalModelPriceOverride {
  readonly comment: string;
  readonly navigateTo?: string;
  readonly prices?: ModelTokenPrices;
}

export const LOCAL_MODEL_PRICE_OVERRIDES: Readonly<Record<string, LocalModelPriceOverride>> = {
  // managed kimi-code `k3` == Open-Platform `kimi-k3`. LiteLLM has no
  // `kimi-k3` key yet (only Azure's marked-up `azure_ai/FW-Kimi-K3`), so the
  // official USD list price is carried here.
  // Source: https://www.kimi.com/zh-hans/resources/kimi-k3-pricing
  //   input cache-miss $3.00 / 1M, cache-hit $0.30 / 1M, output $15.00 / 1M.
  //   `cache_creation_input_token_cost` is billed as a cache-miss (full input
  //   price) — Kimi K3 does not announce a separate cache-write price.
  'kimi-code/k3': {
    comment: 'Kimi K3 (Open-Platform kimi-k3) — official USD list price.',
    prices: {
      inputCostPerToken: 3.0 / 1_000_000,
      outputCostPerToken: 15.0 / 1_000_000,
      cacheReadInputTokenCost: 0.3 / 1_000_000,
      cacheCreationInputTokenCost: 3.0 / 1_000_000,
    },
  },

  // `k3-256k` is the 256K-context variant of the same K3 model — identical
  // unit price, just a shorter context window.
  'kimi-code/k3-256k': {
    comment: 'k3-256k is the 256K-context variant of k3 (same per-token price).',
    prices: {
      inputCostPerToken: 3.0 / 1_000_000,
      outputCostPerToken: 15.0 / 1_000_000,
      cacheReadInputTokenCost: 0.3 / 1_000_000,
      cacheCreationInputTokenCost: 3.0 / 1_000_000,
    },
  },

  // managed kimi-code `kimi-for-coding` is the K2.7-code coding series. Reuse
  // the catalog's USD price for the Open-Platform `kimi-k2.7-code` rather than
  // duplicating a figure (the dashscope entry is the plain non-marked-up USD
  // equivalent of the official ¥6.50 / ¥27 / ¥1.30 list).
  // Source: https://www.kimi.com/zh-cn/resources/kimi-k2-7-code-pricing
  'kimi-code/kimi-for-coding': {
    comment:
      'managed kimi-for-coding == Open-Platform kimi-k2.7-code — reuse catalog USD price.',
    navigateTo: 'dashscope/kimi-k2.7-code',
  },

  // `kimi-for-coding-highspeed` is the high-speed K2.7-code variant. It has no
  // catalog key, and reusing the standard price would understate cost by 2×.
  // The official page lists the high-speed tier at exactly 2× the standard in
  // every bucket, so the catalog's own USD figure is doubled.
  // Source: https://www.kimi.com/zh-cn/resources/kimi-k2-7-code-pricing
  //   (¥13.00 in / ¥2.60 cache-hit / ¥54.00 out vs ¥6.50 / ¥1.30 / ¥27.00).
  'kimi-code/kimi-for-coding-highspeed': {
    comment:
      'managed kimi-for-coding-highspeed == kimi-k2.7-code-highspeed; 2× the standard catalog USD.',
    prices: {
      inputCostPerToken: 1.9e-6,
      outputCostPerToken: 8e-6,
      cacheReadInputTokenCost: 0.38e-6,
      cacheCreationInputTokenCost: 1.9e-6,
    },
  },
};