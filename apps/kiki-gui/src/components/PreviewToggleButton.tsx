import { useI18n } from '../i18n';
import { useMediaPreview } from './mediaPreviewContext';

/** Header toggle for the preview workspace; hides itself with no open tabs. */
export function PreviewToggleButton({ className }: { className?: string }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  if (preview === null || preview.previewTabCount === 0) return null;
  return (
    <button
      type="button"
      onClick={preview.togglePreviewPanel}
      title={t('preview.toggleAria')}
      aria-label={t('preview.toggleAria')}
      aria-expanded={preview.previewPanelOpen}
      data-preview-toggle
      className={`flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12.5px] transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-8 ${
        preview.previewPanelOpen
          ? 'bg-canvas text-ink'
          : 'text-ink-faint hover:bg-canvas hover:text-ink'
      } ${className ?? ''}`}
    >
      <svg aria-hidden viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" className="h-[14px] w-[14px] shrink-0">
        <path d="M4.5 2.5h4.8l2.7 2.7v7.3a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
        <path d="M9 2.5v3h3" />
      </svg>
      {t('preview.toggle')}
    </button>
  );
}
