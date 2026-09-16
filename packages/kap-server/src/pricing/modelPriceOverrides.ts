import type { ModelTokenPrices } from './modelPricingService';

export interface LocalModelPriceOverride {
  readonly comment: string;
  readonly navigateTo?: string;
  readonly prices?: ModelTokenPrices;
}

/** Checked-in price overrides for internal routing aliases the LiteLLM catalog does not describe
 *  (`kimi-code/*`, backed by `managed:kimi-code`). Consulted before the catalog chain, so a local
 *  decision always wins; each entry either redirects to an existing catalog key (`navigateTo`) or
 *  carries explicit USD per-token prices (`prices`). Explicit prices exist only where an official
 *  page verified them — anything unverified is left out, so the cost report keeps flagging it as
 *  "no price" instead of inventing one. Official sources, retrieved 2026-08-19:
 *  https://www.kimi.com/zh-hans/resources/kimi-k3-pricing (`k3` / `k3-256k`) and
 *  https://www.kimi.com/zh-cn/resources/kimi-k2-7-code-pricing (the `kimi-for-coding` variants). */
export const LOCAL_MODEL_PRICE_OVERRIDES: Readonly<Record<string, LocalModelPriceOverride>> = {
  'kimi-code/k3': {
    comment: 'Kimi K3 (Open-Platform kimi-k3) — official USD list price.',
    prices: {
      inputCostPerToken: 3.0 / 1_000_000,
      outputCostPerToken: 15.0 / 1_000_000,
      cacheReadInputTokenCost: 0.3 / 1_000_000,
      cacheCreationInputTokenCost: 3.0 / 1_000_000,
    },
  },

  'kimi-code/k3-256k': {
    comment: 'k3-256k is the 256K-context variant of k3 (same per-token price).',
    prices: {
      inputCostPerToken: 3.0 / 1_000_000,
      outputCostPerToken: 15.0 / 1_000_000,
      cacheReadInputTokenCost: 0.3 / 1_000_000,
      cacheCreationInputTokenCost: 3.0 / 1_000_000,
    },
  },

  'kimi-code/kimi-for-coding': {
    comment:
      'managed kimi-for-coding == Open-Platform kimi-k2.7-code — reuse catalog USD price.',
    navigateTo: 'dashscope/kimi-k2.7-code',
  },

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