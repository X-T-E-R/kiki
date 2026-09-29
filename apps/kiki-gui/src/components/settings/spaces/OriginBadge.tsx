import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { KikiConfigResponse } from '../../../lib/client';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { isInSubspace, originOf, spaceConfigApi, configOrigins } from '../../../lib/spaces';
import { useConnection } from '../../../state/connection';
import { parseKikiConfigResponse } from '../../../lib/client';

/**
 * §9.3 source mark for one setting, shown only inside an independent space.
 * From the main space: a quiet "From main space". Set here: an accent
 * "This space" chip with Restore inheritance, which deletes the key from the
 * space's own config.toml. Env-locked: the existing lock wording.
 */
export function OriginBadge({ config, domain, keyPath = [], label, onRestored }: {
  config: KikiConfigResponse | undefined;
  /** Snake-case config domain as the wire uses it (`default_model`, `subagent`). */
  domain: string;
  /** Leaf path inside the domain; empty for a scalar domain. */
  keyPath?: readonly string[];
  /** Setting name for the restore button's accessible label and the result line. */
  label: string;
  onRestored?: (config: KikiConfigResponse) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!isInSubspace()) return null;
  const origin = originOf(configOrigins(config), domain, keyPath.join('.'));
  if (origin === undefined || origin === 'default' || origin === 'memory') return null;

  if (origin === 'env') {
    return <span data-origin="env" className="text-[11.5px] text-ink-faint">{t('st.origin.env')}</span>;
  }
  if (origin === 'base') {
    return <span data-origin="base" className="text-[11.5px] text-ink-faint">{t('st.origin.inherited')}</span>;
  }
  const restore = () => {
    setBusy(true);
    setError(null);
    void spaceConfigApi(client).removeOverride({ domain, key_path: [...keyPath] })
      .then((raw) => {
        const next = parseKikiConfigResponse(raw);
        queryClient.setQueryData(['config'], next);
        onRestored?.(next);
      })
      .catch((cause: unknown) => { setError(errorText(locale, cause)); })
      .finally(() => { setBusy(false); });
  };
  return (
    <span data-origin="home" className="inline-flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 rounded-[4px] bg-accent-soft px-1.5 text-[11.5px] font-medium text-accent-ink">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />{t('st.origin.local')}
      </span>
      <button type="button" data-origin-restore={[domain, ...keyPath].join('.')} disabled={busy}
        aria-label={t('st.origin.restoreAria', { name: label })}
        onClick={restore}
        className="rounded px-1 text-[11.5px] text-ink-soft underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink disabled:opacity-50">
        {t('st.origin.restore')}
      </button>
      {error !== null ? <span role="alert" className="basis-full text-[11.5px] text-danger">{error}</span> : null}
    </span>
  );
}
