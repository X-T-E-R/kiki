import { memo, useEffect, useState } from 'react';
import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useOptionalConnection } from '../../state/connection';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { Hint } from '../controls';

export interface RawFileCollapseProps {
  readonly sourceFile?: string;
  readonly editable?: boolean;
  readonly writable?: boolean;
  readonly fallbackText?: string;
  readonly dataSection?: string;
  readonly onSave?: (text: string) => Promise<void>;
}

export const RawFileCollapse = memo(function RawFileCollapse({
  sourceFile,
  editable = false,
  writable = false,
  fallbackText,
  dataSection = 'raw',
  onSave,
}: RawFileCollapseProps) {
  const { t, locale } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;

  const [rawText, setRawText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // In read-only mode, load eagerly when sourceFile and client are present.
  useEffect(() => {
    if (editable || !sourceFile || !client) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .readHostFile(sourceFile)
      .then((text) => {
        if (!cancelled) setRawText(text);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editable, sourceFile, client]);

  // Read-only variant (ProfileDetailSections)
  if (!editable) {
    const displayedRaw = rawText ?? fallbackText;
    return (
      <details
        data-profile-section={dataSection}
        className="rounded-lg border border-hairline bg-paper/40 p-2.5"
      >
        <summary className="font-mono text-[10px] font-semibold uppercase text-ink-faint cursor-pointer select-none">
          {t('agentPanel.profileSection.raw')}
        </summary>
        <div className="mt-2">
          {loading ? (
            <p className="font-mono text-[10px] text-ink-faint animate-pulse">
              {t('st.namedAgents.rawLoading')}
            </p>
          ) : error ? (
            <p className="font-mono text-[10px] text-danger">{error}</p>
          ) : displayedRaw ? (
            <pre className="max-h-64 overflow-y-auto rounded-lg border border-hairline bg-paper/60 p-2.5 font-mono text-[10px] leading-snug text-ink-soft whitespace-pre-wrap">
              {displayedRaw}
            </pre>
          ) : (
            <p className="font-mono text-[10px] text-ink-faint italic">
              {t('st.namedAgents.builtin')}
            </p>
          )}
        </div>
      </details>
    );
  }

  // Editable variant (Settings AgentsSection)
  if (sourceFile === undefined) return null;

  const toggleOpen = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (client && rawText === null) {
      setLoading(true);
      setError(null);
      try {
        const text = await client.readHostFile(sourceFile);
        setRawText(text);
      } catch (err) {
        setOpen(false);
        setError(errorText(locale, err));
      } finally {
        setLoading(false);
      }
    }
  };

  const handleSave = async () => {
    if (!onSave || rawText === null) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(rawText);
    } catch (err) {
      setError(errorText(locale, err));
    } finally {
      setSaving(false);
    }
  };

  const toggleLabel = open
    ? t('st.namedAgents.hideRaw')
    : writable
      ? t('st.namedAgents.editRaw')
      : t('st.namedAgents.viewRaw');

  return (
    <div data-raw-file-collapse className="mt-3 border-t border-hairline pt-3">
      <button type="button" className={SECONDARY_BUTTON} onClick={() => void toggleOpen()}>
        {toggleLabel}
      </button>
      {error ? <p role="alert" className="mt-1 text-[11px] text-danger">{error}</p> : null}
      {open ? (
        <div className="mt-2 space-y-2">
          {loading ? (
            <Hint>{t('st.namedAgents.rawLoading')}</Hint>
          ) : (
            <textarea
              aria-label={t('st.namedAgents.sourceFile')}
              className={`${INPUT} min-h-64 font-mono text-[11px]`}
              value={rawText ?? ''}
              readOnly={!writable}
              onChange={(event) => {
                setRawText(event.target.value);
              }}
            />
          )}
          {writable && !loading ? (
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? t('common.saving') : t('st.namedAgents.saveRaw')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
