import { LocalizedError, translate, type Locale } from '@kiki/session-core/i18n';

import type { KikiClient, KikiConfigResponse } from './client';

export type OnboardingVoice = 'concise' | 'detailed';
type PromptClient = Pick<KikiClient, 'getConfig' | 'patchConfig'>;
export const REPLY_STYLE_FIELD = 'system.reply_style';
export const REPLY_STYLE_GUIDE = '${reply_style_guide}';
const VOICES = ['concise', 'detailed'] as const;
const LOCALES = ['en', 'zh'] as const;

export function onboardingReplyParagraph(locale: Locale, voice: OnboardingVoice): string {
  return `${REPLY_STYLE_GUIDE}\n\n${translate(locale, `onboarding.agreement.voice.${voice}.body`)}`;
}

export function readReplyParagraph(config: KikiConfigResponse): string {
  return config.prompt?.overrides?.fields?.[REPLY_STYLE_FIELD] ?? REPLY_STYLE_GUIDE;
}

export function onboardingVoiceFromParagraph(paragraph: string): OnboardingVoice | null {
  return VOICES.find((voice) => LOCALES.some((locale) => paragraph === onboardingReplyParagraph(locale, voice))) ?? null;
}

export async function saveOnboardingReplyParagraph(client: PromptClient, paragraph: string, isCurrent: () => boolean): Promise<KikiConfigResponse | undefined> {
  if (!paragraph.includes(REPLY_STYLE_GUIDE)) throw new LocalizedError({ key: 'onboarding.agreement.voice.guideRequired' });
  const baseline = await client.getConfig();
  if (!isCurrent()) return undefined;
  const prompt = baseline.prompt ?? {};
  return client.patchConfig({
    prompt: { ...prompt, overrides: { ...prompt.overrides, fields: { ...prompt.overrides?.fields, [REPLY_STYLE_FIELD]: paragraph } } },
    replace_domains: ['prompt'],
  });
}
