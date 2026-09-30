/**
 * The persona editor's face control: the avatar, "upload / change", and
 * "remove" once there is a picture. Picking a file opens the crop dialog;
 * what uploads is its 256 px square plus the chosen frame shape.
 */

import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { AvatarCropDialog, type AvatarCropResult } from './AvatarCropDialog';
import { PersonaAvatar, type PersonaAvatarData } from './PersonaAvatar';
import { invalidatePersonas } from './usePersonas';

export const AVATAR_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
/** Source pictures up to this size open in the crop dialog; what uploads is a 256 px PNG. */
export const AVATAR_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

/** A new persona has no directory yet, so the controls wait for its first save. */
export function PersonaAvatarControl({ persona, personaId }: { readonly persona: PersonaAvatarData; readonly personaId: string | undefined }) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const upload = useMutation({
    mutationFn: ({ file, shape }: AvatarCropResult) => client.putPersonaAvatar(personaId!, file, shape),
    onSuccess: () => {
      setPicked(null);
      pushToast({ tone: 'success', text: t('persona.avatarUploaded') });
      void invalidatePersonas(queryClient, personaId, { avatar: true });
    },
    onError: (error: unknown) => { pushToast({ tone: 'error', text: t('persona.actionFailed', { detail: errorText(locale, error) }) }); },
  });
  const remove = useMutation({
    mutationFn: () => client.deletePersonaAvatar(personaId!),
    onSuccess: () => {
      setConfirmRemove(false);
      pushToast({ tone: 'success', text: t('persona.avatarRemoved') });
      void invalidatePersonas(queryClient, personaId, { avatar: true });
    },
    onError: (error: unknown) => { pushToast({ tone: 'error', text: t('persona.actionFailed', { detail: errorText(locale, error) }) }); },
  });
  const pick = (file: File | undefined) => {
    if (file === undefined) return;
    if (!AVATAR_TYPES.includes(file.type)) { pushToast({ tone: 'error', text: t('persona.avatarType') }); return; }
    // The limit guards the source; the crop always uploads a small PNG.
    if (file.size > AVATAR_SOURCE_MAX_BYTES) { pushToast({ tone: 'error', text: t('persona.avatarTooLarge') }); return; }
    setPicked(file);
  };
  const hasImage = persona.avatarUrl !== undefined;
  const LINK = 'min-h-6 rounded px-1 text-[11.5px] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-60 pointer-coarse:min-h-11';
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <PersonaAvatar persona={persona} size={64} decorative />
      {personaId !== undefined ? (
        <>
          <input ref={inputRef} type="file" accept={AVATAR_TYPES.join(',')} className="sr-only" tabIndex={-1} aria-hidden onChange={(event) => { pick(event.target.files?.[0]); event.target.value = ''; }} />
          <button
            type="button"
            data-persona-avatar-upload
            disabled={upload.isPending || remove.isPending}
            title={t('persona.avatarHint')}
            onClick={() => { inputRef.current?.click(); }}
            className={`${LINK} text-ink-soft hover:text-ink`}
          >
            {t(hasImage ? 'persona.avatarChange' : 'persona.avatarUpload')}
          </button>
          {hasImage ? (
            <button
              type="button"
              data-persona-avatar-remove
              disabled={upload.isPending || remove.isPending}
              onClick={() => { setConfirmRemove(true); }}
              className={`${LINK} -mt-1 text-ink-faint hover:text-danger`}
            >
              {t('persona.avatarRemove')}
            </button>
          ) : null}
          {picked !== null ? (
            <AvatarCropDialog
              file={picked}
              name={persona.name}
              initialShape={persona.avatarShape ?? 'square'}
              busy={upload.isPending}
              onCancel={() => { setPicked(null); }}
              onSave={(result) => { upload.mutate(result); }}
            />
          ) : null}
          <ConfirmDialog
            open={confirmRemove}
            title={t('persona.avatarRemoveTitle', { name: persona.name })}
            body={t('persona.avatarRemoveBody')}
            confirmLabel={t('persona.avatarRemove')}
            busy={remove.isPending}
            overlayId="persona-avatar-remove"
            onConfirm={() => { remove.mutate(); }}
            onCancel={() => { setConfirmRemove(false); }}
          />
        </>
      ) : null}
    </div>
  );
}
