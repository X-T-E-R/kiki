import type { MobilePlatform } from '#/_base/node/resourceDefaults';

const IOS_DEFAULT_DISABLED_TOOLS: readonly string[] = ['Bash'];

export function platformDefaultDisabledTools(mobilePlatform: MobilePlatform | undefined): readonly string[] {
  if (mobilePlatform === 'ios') return IOS_DEFAULT_DISABLED_TOOLS;
  return [];
}

export function isPlatformDefaultDisabledTool(
  mobilePlatform: MobilePlatform | undefined,
  name: string,
): boolean {
  return platformDefaultDisabledTools(mobilePlatform).includes(name);
}
