export interface ProviderImagePolicy {
  readonly acceptedMimes: ReadonlySet<string>;
}

const BASELINE_IMAGE_POLICY: ProviderImagePolicy = {
  acceptedMimes: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
};

const KIMI_IMAGE_POLICY: ProviderImagePolicy = {
  acceptedMimes: new Set([
    ...BASELINE_IMAGE_POLICY.acceptedMimes,
    'image/bmp',
    'image/heic',
    'image/heif',
  ]),
};

export function providerImagePolicy(providerType?: string): ProviderImagePolicy {
  return providerType === 'kimi' ? KIMI_IMAGE_POLICY : BASELINE_IMAGE_POLICY;
}
