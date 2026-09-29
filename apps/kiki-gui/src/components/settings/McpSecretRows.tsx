/**
 * Key/value secret rows for an MCP entry's environment (stdio) or HTTP
 * headers (remote). Listings arrive redacted, so a saved row starts from its
 * key alone; its value is revealed on request, and a row the user did not
 * touch is read back through the reveal route only when the entry is saved.
 */

import { useId } from 'react';

import { useI18n } from '../../i18n';
import { Hint } from '../controls';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { KEEP_SECRET, SecretField, type SecretDraft } from './SecretField';

export interface McpSecretRow {
  readonly key: string;
  /** Name the value is stored under; absent for a row added in this draft. */
  readonly storedKey?: string;
  readonly secret: SecretDraft;
  /** A value the listing already carried (older servers); never fetched again. */
  readonly known?: string;
}

export type McpSecretReveal = (storedKey: string) => Promise<string | undefined>;

export function mcpSecretRows(keys: readonly string[] | undefined, values?: Readonly<Record<string, string>>): McpSecretRow[] {
  const names = keys ?? Object.keys(values ?? {});
  return names.map((key) => ({ key, storedKey: key, secret: KEEP_SECRET, known: values?.[key] }));
}

/** Resolves every row to `KEY=value` lines; untouched saved rows are revealed first. */
export async function mcpSecretLines(rows: readonly McpSecretRow[], reveal: McpSecretReveal): Promise<string> {
  const lines = await Promise.all(rows.map(async (row) => {
    const value = row.secret.mode === 'set' ? row.secret.value
      : row.known ?? (row.storedKey === undefined ? '' : await reveal(row.storedKey));
    if (value === undefined) throw new Error('st.secret.revealError');
    return `${row.key}=${value}`;
  }));
  return lines.join('\n');
}

export function McpSecretRows({
  kind, rows, onChange, reveal, disabledKey, disabledHint,
}: {
  kind: 'env' | 'headers';
  rows: readonly McpSecretRow[];
  onChange: (rows: McpSecretRow[]) => void;
  reveal?: McpSecretReveal;
  /** A row whose key matches is shown but locked (an env reference overrides it). */
  disabledKey?: string;
  disabledHint?: string;
}) {
  const { t } = useI18n();
  const scope = useId();
  const update = (index: number, patch: Partial<McpSecretRow>) => {
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };
  const title = kind === 'env' ? t('st.mcp.env') : t('st.mcp.headers');
  return (
    <div className="space-y-2" role="group" aria-label={title} data-mcp-secret-rows={kind}>
      <p className="text-[11px] font-medium text-ink-soft">{title}</p>
      {kind === 'headers' ? <Hint>{t('st.mcp.headersHint')}</Hint> : null}
      {rows.map((row, index) => {
        const locked = disabledKey !== undefined && row.key.trim().toLowerCase() === disabledKey;
        const name = row.key.trim() === '' ? `${index + 1}` : row.key.trim();
        const valueLabel = t(kind === 'env' ? 'st.secret.envValueLabel' : 'st.secret.headerValueLabel', { name });
        const stored = row.storedKey !== undefined && (row.known !== undefined || reveal !== undefined);
        const rowReveal = row.known !== undefined ? async () => row.known
          : row.storedKey !== undefined && reveal !== undefined ? () => reveal(row.storedKey!) : undefined;
        return (
          <div key={index} data-mcp-secret-row={index}
            className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border border-hairline bg-panel p-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] sm:items-start">
            <label className="min-w-0 space-y-1 text-[11px] font-medium text-ink-soft" htmlFor={`${scope}-key-${index}`}>
              {kind === 'env' ? t('st.secret.envName') : t('st.secret.headerName')}
              <input id={`${scope}-key-${index}`} className={`${INPUT} font-mono`} value={row.key} disabled={locked}
                aria-label={`${kind === 'env' ? t('st.secret.envName') : t('st.mcp.headerName')} ${index + 1}`}
                spellCheck={false} autoComplete="off"
                onChange={(event) => { update(index, { key: event.target.value }); }} />
            </label>
            <div className="min-w-0 pt-[18px] max-sm:pt-0">
              <SecretField
                labelHidden
                label={valueLabel}
                source={stored ? 'kiki' : 'none'}
                draft={row.secret}
                reveal={stored ? rowReveal : undefined}
                clearable={false}
                disabled={locked}
                onChange={(secret) => { update(index, { secret }); }}
              />
            </div>
            <button type="button" className={`${SECONDARY_BUTTON} min-h-8 sm:mt-[18px] pointer-coarse:min-h-11`} disabled={locked}
              aria-label={kind === 'env' ? t('st.secret.removeRow', { name }) : `${t('st.mcp.removeHeader')} ${index + 1}`}
              onClick={() => { onChange(rows.filter((_, at) => at !== index)); }}>
              {t('st.secret.remove')}
            </button>
            {locked && disabledHint !== undefined ? <div className="sm:col-span-3"><Hint>{disabledHint}</Hint></div> : null}
          </div>
        );
      })}
      <button type="button" className={SECONDARY_BUTTON}
        onClick={() => { onChange([...rows, { key: '', secret: KEEP_SECRET }]); }}>
        {kind === 'env' ? t('st.secret.addEnv') : t('st.mcp.addHeader')}
      </button>
    </div>
  );
}

/**
 * The value behind a bearer-token env reference. It lives in the server
 * environment, so it is view-only here; replacing it means clearing the
 * reference and saving an Authorization header in Kiki instead.
 */
export function McpBearerValue({ label, envName, reveal }: {
  label: string;
  envName: string;
  reveal: () => Promise<string | undefined>;
}) {
  const { t } = useI18n();
  return (
    <div data-mcp-bearer-value>
      <SecretField label={label} source="environment" envName={envName} draft={KEEP_SECRET}
        onChange={() => undefined} reveal={reveal} clearable={false} hint={t('st.secret.bearerHint')}
        readOnlyValue />
    </div>
  );
}
