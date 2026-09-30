import { useI18n } from '../../i18n';

/**
 * A miniature of the three surfaces every appearance choice lands on — a
 * sidebar, a conversation, the composer — built from the same tokens and
 * classes the real ones read (`.kiki-prose`, `--kiki-sheet-radius`, the
 * surface ladder, `--spacing`), so it moves with every control on the page.
 * Static and inert: nothing in it is focusable.
 */
export function AppearancePreview() {
  const { t } = useI18n();
  return (
    <figure
      aria-label={t('st.appearance.previewAria')}
      data-appearance-preview
      // One scene, not a frame around a card: the window ground (canvas) is the
      // only container on wide screens, and on a phone — where the miniature
      // has no sidebar to show — the sheet stands on the page by itself.
      className="pointer-events-none flex select-none overflow-hidden rounded-[var(--kiki-sheet-radius)] sm:bg-canvas sm:p-2"
    >
      <div aria-hidden className="hidden w-[168px] shrink-0 flex-col gap-0.5 py-1 pr-2 sm:flex">
        <p className="px-2 pb-0.5 text-[12px] font-medium text-ink-soft">{t('sidebar.groupToday')}</p>
        <div className="flex items-start gap-2 rounded-lg bg-paper px-2 py-1.5 shadow-[var(--kiki-sheet-shadow)]">
          <span className="mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full bg-accent" />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium text-ink">{t('st.appearance.preview.session')}</span>
            <span className="block truncate text-[12px] leading-4 text-accent-ink">{t('st.appearance.preview.waiting')}</span>
          </span>
        </div>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="h-[7px] w-[7px] shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-soft">{t('st.appearance.preview.otherSession')}</span>
          <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">{t('st.appearance.preview.time')}</span>
        </div>
      </div>
      <div aria-hidden className="flex min-w-0 flex-1 flex-col gap-3 rounded-[var(--kiki-sheet-radius)] bg-paper px-4 pb-3 pt-4 shadow-[var(--kiki-sheet-shadow)]">
        <div className="ml-auto max-w-[80%] rounded-xl bg-bubble-user px-3 py-1.5 text-[13px] text-ink">
          {t('st.appearance.preview.user')}
        </div>
        <div className="kiki-prose max-w-[52ch] !text-[15px] leading-relaxed">
          <p className="m-0">
            {t('st.appearance.preview.reply')}{' '}
            <code className="rounded bg-ink/[0.05] px-1 font-mono text-[12px] text-ink-soft">pnpm check</code>
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-[var(--kiki-sheet-radius)] bg-panel px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-faint">{t('st.appearance.preview.composer')}</span>
          <span className="flex h-7 items-center rounded-md bg-accent px-3 text-[12px] font-semibold text-on-accent">
            {t('st.appearance.preview.send')}
          </span>
        </div>
      </div>
    </figure>
  );
}
