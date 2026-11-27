import type { I18nKey } from '@kiki/session-core/i18n';

import { pushToast } from './toasts';

const UNCONFIGURED_MODEL_ERROR_RE =
  /model and thinking effort are required to bind profile|no default model configured/i;

export function isUnconfiguredModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return UNCONFIGURED_MODEL_ERROR_RE.test(message);
}

export function pushActionableModelOrErrorToast(
  error: unknown,
  t: (key: I18nKey) => string,
  onOpenProviderSettings?: () => void,
): void {
  const rawMessage = error instanceof Error ? error.message : String(error ?? '');
  if (UNCONFIGURED_MODEL_ERROR_RE.test(rawMessage)) {
    pushToast({
      tone: 'error',
      text: t('mobile.error.modelUnconfigured'),
      detail: rawMessage,
      ...(onOpenProviderSettings !== undefined
        ? {
            action: {
              label: t('mobile.error.configureModel'),
              run: onOpenProviderSettings,
            },
          }
        : {}),
    });
    return;
  }
  pushToast({ tone: 'error', text: rawMessage });
}
