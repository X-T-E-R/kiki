import { useCallback, useRef, useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import type { Feedback } from '../controls';
import { useSavedTick } from './useSavedTick';

/**
 * State for an instant-apply control: one write in flight at a time, the
 * transient ✓ Saved on success, and an error line on failure. Pair with
 * `SaveStatus` beside the control and `FeedbackLine` for `error`.
 *
 *   const save = useInstantSave();
 *   onChange={(next) => save.run(() => client.patchConfig({ ... }))}
 *   <SaveStatus saving={save.saving} saved={save.saved} />
 *   <FeedbackLine feedback={save.error} />
 */
export interface InstantSave {
  readonly saving: boolean;
  readonly saved: boolean;
  readonly error: Feedback;
  /** Runs the write; resolves true on success. A failure never throws. */
  run: (write: () => Promise<unknown>) => Promise<boolean>;
  clearError: () => void;
}

export function useInstantSave(): InstantSave {
  const { locale } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Feedback>(null);
  const [saved, ping, clearSaved] = useSavedTick();
  const inFlight = useRef(0);

  const run = useCallback(async (write: () => Promise<unknown>) => {
    const ticket = ++inFlight.current;
    clearSaved();
    setSaving(true);
    setError(null);
    try {
      await write();
      if (ticket === inFlight.current) ping();
      return true;
    } catch (cause) {
      if (ticket === inFlight.current) {
        clearSaved();
        setError({ tone: 'error', text: errorText(locale, cause) });
      }
      return false;
    } finally {
      if (ticket === inFlight.current) setSaving(false);
    }
  }, [clearSaved, locale, ping]);

  const clearError = useCallback(() => { setError(null); }, []);
  return { saving, saved, error, run, clearError };
}
