/**
 * Owner-scoped resolution of the `[image]` config limits for host-side
 * ingestion (clipboard paste, ACP attachments) — the points where a host
 * shrinks an image before it enters a prompt.
 *
 * One instance per harness: the host pushes its config on load and reload via
 * {@link ImageLimits.setConfig}, and consumers resolve through the instance
 * they were handed. Nothing lives in module state, so two harnesses in one
 * process each compress with their own `[image]` settings.
 *
 * Resolution precedence per value: env var > owning config > built-in default.
 * Env stays process-level on purpose — it is the operator's override for
 * everything in the process.
 */

import { MAX_IMAGE_EDGE_PX, READ_IMAGE_BYTE_BUDGET } from '@kiki/agent-core-v2';

import type { ImageConfig } from '#/config';

export const MAX_IMAGE_EDGE_ENV = 'KIMI_IMAGE_MAX_EDGE_PX';
export const READ_IMAGE_BYTE_BUDGET_ENV = 'KIMI_IMAGE_READ_BYTE_BUDGET';

function positiveIntFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export class ImageLimits {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private config: ImageConfig | undefined = undefined,
  ) {}

  /**
   * Push (or clear, with `undefined`) the owning config. Called by the config
   * owner on load and reload, so limits hot-reload per owner.
   */
  setConfig(config: ImageConfig | undefined): void {
    this.config = config;
  }

  /** Longest-edge ceiling (px) for compressing images for the model. */
  maxEdgePx(): number {
    return (
      positiveIntFromEnv(this.env, MAX_IMAGE_EDGE_ENV) ??
      this.config?.maxEdgePx ??
      MAX_IMAGE_EDGE_PX
    );
  }

  /** Raw-byte budget for model-initiated image reads. */
  readByteBudget(): number {
    return (
      positiveIntFromEnv(this.env, READ_IMAGE_BYTE_BUDGET_ENV) ??
      this.config?.readByteBudget ??
      READ_IMAGE_BYTE_BUDGET
    );
  }
}
