import { useState } from 'react';

import type { SpaceRecord } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../../Dialog';
import { SpaceCreateForm } from './SpaceFormPanel';

/**
 * §9.2 as one page: name and color, location, then what the space takes from
 * the main space. The "copy once" column of the wireframe is not offered: the
 * create contract only knows inherit or not.
 */
export function CreateSpaceDialog({ client, mainPath, canOpen, onClose, onCreated }: {
  client?: KikiClient;
  mainPath: string;
  /** Desktop only: the primary action also opens the new space. */
  canOpen: boolean;
  onClose: () => void;
  onCreated: (record: SpaceRecord, open: boolean, existing: boolean) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      onClose={() => { if (!busy) onClose(); }}
      ariaLabel={t('st.spaces.createTitle')}
      overlayId="space-create-dialog"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} max-h-[calc(100dvh-2rem)] overflow-y-auto`}
    >
      <SpaceCreateForm
        client={client}
        mainPath={mainPath}
        canOpen={canOpen}
        layout="dialog"
        title={t('st.spaces.createTitle')}
        onBusyChange={setBusy}
        onClose={onClose}
        onDone={onCreated}
      />
    </Dialog>
  );
}
