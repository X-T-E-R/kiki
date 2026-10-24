import { useI18n } from '../../i18n';

/**
 * Re-export useI18n for channels slice without local dictionary override.
 * All keys are now provided canonically by packages/session-core/src/i18n/{en,zh}.ts.
 */
export function useChannelsI18n() {
  return useI18n();
}
