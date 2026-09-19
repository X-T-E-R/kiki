export const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/tiff',
  'image/x-icon',
] as const;

export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];
export type ImageConversionMode = 'off' | 'auto' | 'png' | 'jpeg';

export interface ImagePolicyConfig {
  acceptedTypes?: ImageMime[];
  convertUnsupported?: ImageConversionMode;
}

export interface ResolvedImagePolicy {
  readonly acceptedTypes: ReadonlySet<ImageMime>;
  readonly convertUnsupported: ImageConversionMode;
}

export interface ProviderImagePolicy {
  readonly acceptedMimes: ReadonlySet<ImageMime>;
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

export function resolveImagePolicy(
  providerType: string | undefined,
  provider: ImagePolicyConfig | undefined,
  model: ImagePolicyConfig | undefined,
): ResolvedImagePolicy {
  const acceptedTypes = new Set(
    model?.acceptedTypes ?? provider?.acceptedTypes ?? providerImagePolicy(providerType).acceptedMimes,
  );
  const convertUnsupported =
    model?.convertUnsupported ?? provider?.convertUnsupported ?? 'off';
  const target =
    convertUnsupported === 'png'
      ? 'image/png'
      : convertUnsupported === 'jpeg'
        ? 'image/jpeg'
        : undefined;
  if (target !== undefined && !acceptedTypes.has(target)) {
    throw new Error(`images.convert_unsupported=${convertUnsupported} requires ${target} in images.accepted_types`);
  }
  if (
    convertUnsupported === 'auto' &&
    !acceptedTypes.has('image/png') &&
    !acceptedTypes.has('image/jpeg')
  ) {
    throw new Error('images.convert_unsupported=auto requires image/png or image/jpeg in images.accepted_types');
  }
  return { acceptedTypes, convertUnsupported };
}
