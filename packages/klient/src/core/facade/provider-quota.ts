import type { ProviderQuotaSnapshot } from '@kiki/protocol';

export interface ProviderQuotaFacade {
  /** Local metadata and cached snapshots only; never starts remote quota requests. */
  snapshot(): Promise<ProviderQuotaSnapshot>;
  /** Explicitly query one connected source. An off source stays off. */
  refresh(sourceId: string): Promise<ProviderQuotaSnapshot>;
  /** Changes quota collection only; enabling does not query or log in. */
  setEnabled(sourceId: string, enabled: boolean): Promise<ProviderQuotaSnapshot>;
}
