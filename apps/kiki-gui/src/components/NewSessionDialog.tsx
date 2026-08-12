/**
 * NewSessionDialog — the /new draft core as a centered modal (Ctrl+N or the
 * sidebar button from any route). Shares draft key "new" with the full page,
 * so closing the modal loses nothing; a successful send navigates to /s/:id
 * through the same `useNewSessionDraft.send` path and the modal closes.
 */

import { Dialog } from './Dialog';
import { NewSessionDraftPanel, useNewSessionDraft } from './NewSessionDraft';
import { useI18n } from '../i18n';

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const state = useNewSessionDraft({ onSent: onClose });

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={t('new.title')}
      overlayId="new-session-dialog"
      panelClassName="anim-enter flex max-h-[85vh] w-full max-w-[640px] flex-col overflow-y-auto rounded-2xl border border-hairline bg-panel p-5 shadow-[0_16px_48px_-16px_rgba(28,25,23,0.35)]"
    >
      <h2 className="mb-4 font-display text-[16px] font-semibold tracking-tight text-ink">
        {t('new.title')}
      </h2>
      <NewSessionDraftPanel state={state} autoFocus />
    </Dialog>
  );
}
