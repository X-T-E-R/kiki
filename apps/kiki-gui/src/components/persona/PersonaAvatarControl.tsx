/**
 * The persona editor's face control: a single 64px avatar trigger with a
 * subtle edit mark, opening the file picker directly when no picture is set
 * and a named keyboard/touch action menu (Change / Remove) once one exists.
 * Picking a file opens the crop dialog; what uploads is its 256 px square
 * plus the chosen frame shape.
 */

import { useEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { pushToast } from '../../lib/toasts';
import { floatingSurfaceZIndex, registerOverlay } from '../../lib/uiBusy';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { Icon } from '../icons';
import { POPOVER_SURFACE_CLASS } from '../SearchableSelect';
import { AvatarCropDialog, type AvatarCropResult } from './AvatarCropDialog';
import { PersonaAvatar, type PersonaAvatarData } from './PersonaAvatar';
import { invalidatePersonas } from './usePersonas';

export const AVATAR_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
/** Source pictures up to this size open in the crop dialog; what uploads is a 256 px PNG. */
export const AVATAR_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Supports immediate upload for saved personas (`personaId !== undefined`) and
 * local crop staging during new-persona creation when `onStageAvatar` is given.
 */
export function PersonaAvatarControl({
  persona,
  personaId,
  stagedAvatar,
  onStageAvatar,
}: {
  readonly persona: PersonaAvatarData;
  readonly personaId: string | undefined;
  readonly stagedAvatar?: AvatarCropResult | null;
  readonly onStageAvatar?: (next: AvatarCropResult | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [stagedUrl, setStagedUrl] = useState<string | undefined>(undefined);
  const staging = personaId === undefined && onStageAvatar !== undefined;

  useEffect(() => {
    if (!staging || stagedAvatar === undefined || stagedAvatar === null) {
      setStagedUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(stagedAvatar.file);
    setStagedUrl(url);
    return () => { URL.revokeObjectURL(url); };
  }, [staging, stagedAvatar]);

  const previewPersona: PersonaAvatarData = staging && stagedUrl !== undefined && stagedAvatar !== undefined && stagedAvatar !== null
    ? { ...persona, avatarUrl: stagedUrl, avatarShape: stagedAvatar.shape }
    : persona;
  const canEdit = personaId !== undefined || staging;
  const hasImage = previewPersona.avatarUrl !== undefined;

  useEffect(() => {
    if (!hasImage && menuOpen) setMenuOpen(false);
  }, [hasImage, menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const unregister = registerOverlay('persona-avatar-menu');
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      unregister();
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen]);

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

  const busy = upload.isPending || remove.isPending;
  const triggerClass = 'group/avatar relative flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-60';
  const badgeClass = 'pointer-events-none absolute -right-1 -bottom-1 flex h-6 w-6 items-center justify-center rounded-full bg-panel text-ink-soft shadow-sm ring-1 ring-hairline transition-colors duration-[var(--kiki-motion-quick)] group-hover/avatar:text-ink group-focus-visible/avatar:text-ink';
  const menuItemClass = 'flex w-full items-center rounded-md px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-ink/[0.05] focus-visible:bg-ink/[0.05] focus-visible:outline-none disabled:opacity-50 pointer-coarse:min-h-11';

  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center">
      {canEdit ? (
        <>
          <input
            ref={inputRef}
            type="file"
            accept={AVATAR_TYPES.join(',')}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => { pick(event.target.files?.[0]); event.target.value = ''; }}
          />
          {hasImage ? (
            <button
              ref={triggerRef}
              type="button"
              data-persona-avatar-trigger
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t('persona.avatarActionsAria', { name: persona.name })}
              title={t('persona.avatarActionsAria', { name: persona.name })}
              disabled={busy}
              onClick={() => { setMenuOpen((open) => !open); }}
              className={triggerClass}
            >
              <PersonaAvatar persona={previewPersona} size={64} decorative />
              <span aria-hidden className={badgeClass}>
                <Icon name="edit" size={12} />
              </span>
            </button>
          ) : (
            <button
              ref={triggerRef}
              type="button"
              data-persona-avatar-upload
              aria-label={t('persona.avatarUpload')}
              title={t('persona.avatarHint')}
              disabled={busy}
              onClick={() => { inputRef.current?.click(); }}
              className={triggerClass}
            >
              <PersonaAvatar persona={previewPersona} size={64} decorative />
              <span aria-hidden className={badgeClass}>
                <Icon name="edit" size={12} />
              </span>
            </button>
          )}
          {hasImage && menuOpen ? (
            <Popover.Root
              open
              modal={false}
              onOpenChange={(nextOpen, eventDetails) => {
                if (nextOpen) return;
                if (eventDetails.reason === 'escape-key') {
                  setMenuOpen(false);
                  triggerRef.current?.focus();
                  return;
                }
                eventDetails.cancel();
              }}
            >
              <Popover.Portal>
                <Popover.Positioner
                  anchor={triggerRef}
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  collisionPadding={8}
                  positionMethod="fixed"
                  style={{ zIndex: floatingSurfaceZIndex(triggerRef.current) }}
                >
                  <Popover.Popup
                    ref={(node) => {
                      menuRef.current = node;
                      if (node !== null && !node.contains(document.activeElement)) {
                        node.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
                      }
                    }}
                    role="menu"
                    data-persona-avatar-menu
                    aria-label={t('persona.avatarMenuAria', { name: persona.name })}
                    initialFocus={false}
                    finalFocus={false}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
                      const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
                      if (items.length === 0) return;
                      event.preventDefault();
                      const index = items.indexOf(document.activeElement as HTMLButtonElement);
                      const next = event.key === 'Home' ? 0
                        : event.key === 'End' ? items.length - 1
                        : event.key === 'ArrowDown' ? (index + 1) % items.length
                        : (index - 1 + items.length) % items.length;
                      items[next]?.focus();
                    }}
                    className={`anim-enter w-44 p-1 outline-none ${POPOVER_SURFACE_CLASS}`}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      data-persona-avatar-upload
                      disabled={busy}
                      title={t('persona.avatarHint')}
                      onClick={() => {
                        setMenuOpen(false);
                        inputRef.current?.click();
                      }}
                      className={`${menuItemClass} text-ink`}
                    >
                      {t('persona.avatarChange')}
                    </button>
                    <div role="separator" className="my-1 h-px bg-hairline" />
                    <button
                      type="button"
                      role="menuitem"
                      data-persona-avatar-remove
                      disabled={busy}
                      onClick={() => {
                        setMenuOpen(false);
                        if (staging) { onStageAvatar(null); return; }
                        setConfirmRemove(true);
                      }}
                      className={`${menuItemClass} text-danger`}
                    >
                      {t('persona.avatarRemove')}
                    </button>
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          ) : null}
          {picked !== null ? (
            <AvatarCropDialog
              file={picked}
              name={persona.name}
              initialShape={previewPersona.avatarShape ?? 'square'}
              busy={!staging && upload.isPending}
              onCancel={() => { setPicked(null); }}
              onSave={(result) => {
                if (staging) {
                  onStageAvatar(result);
                  setPicked(null);
                  return;
                }
                upload.mutate(result);
              }}
            />
          ) : null}
          {!staging ? (
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
          ) : null}
        </>
      ) : (
        <PersonaAvatar persona={previewPersona} size={64} decorative />
      )}
    </div>
  );
}
