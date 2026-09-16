import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useOptionalConnection } from '../../state/connection';
import { Markdown } from '../Markdown';

export function SkillContentCollapse({ path }: { path: string }) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (content !== null) return;
    if (!client) {
      setError(t('diagnostics.unavailable'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const text = await client.readHostFile(path);
      setContent(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-2 pt-2 border-t border-hairline" data-skill-content-collapse>
      <button
        type="button"
        onClick={() => { void toggle(); }}
        className="text-[11px] font-medium text-accent hover:underline cursor-pointer flex items-center gap-1 transition-colors"
      >
        <span aria-hidden className="text-[9px]">{open ? '▾' : '▸'}</span>
        <span>{open ? t('agentPanel.hideSkillMd') : t('agentPanel.viewSkillMd')}</span>
      </button>
      {open ? (
        <div className="mt-2">
          {loading ? (
            <p className="font-mono text-[10.5px] text-ink-faint animate-pulse">
              {t('agentPanel.loadingSkillMd')}
            </p>
          ) : error ? (
            <p className="font-mono text-[10.5px] text-danger">{error}</p>
          ) : content !== null ? (
            <div className="max-h-72 overflow-y-auto rounded-lg border border-hairline bg-paper/80 p-2.5 text-[11px] text-ink leading-relaxed">
              <Markdown text={content} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
