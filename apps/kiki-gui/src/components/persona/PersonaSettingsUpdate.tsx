/**
 * PersonaSettingsUpdate — what this conversation is running versus what the
 * persona says now (D8), for the two places it is reachable from:
 *
 *   - the rail's folded chapter (`PersonaSettingsUpdate`), one word of state
 *     while closed;
 *   - the header menu's dialog (`PersonaSettingsDialog`), which is the same
 *     content with its title and state visible at once — the way in on a
 *     narrow screen, where the rail does not exist.
 *
 * Both carriers share one query, one mutation and one confirmation; only the
 * chrome around the content differs. A conversation freezes the persona copy it
 * was created with, so editing 林岚 never changes a conversation already
 * underway; this is the one place that states the difference and lets the user
 * close it on purpose.
 *
 *   - a conversation with no persona renders nothing and offers no entry;
 *   - a failed read is never drawn as "nothing here": it says so and carries
 *     the retry (the dialog keeps the chapter from folding in that case too);
 *   - every revision field is optional on the wire, so an absent one is drawn
 *     as absent rather than filled in;
 *   - the server applies only to an idle conversation and refuses otherwise
 *     (`applyPersonaSettings` throws REQUEST_INVALID — HTTP 40001 — while busy,
 *     and puts back the old binding if it went busy while preparing), so the
 *     line under the actions says exactly that instead of promising a later
 *     automatic apply;
 *   - `restoreDefaults` also drops this conversation's own overrides, so it is
 *     the one action behind a confirmation that names what goes;
 *   - a refused apply leaves the reading untouched and says why.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import type { SessionPersonaSettings } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { InspectorSection } from '../agent-panel/InspectorSection';
import { ConfirmDialog } from '../ConfirmDialog';
import { Dialog } from '../Dialog';
import { FeedbackLine, SavedTick } from '../controls';
import { Icon } from '../icons';
import { useSavedTick } from '../settings/useSavedTick';
import { PRIMARY_BUTTON } from '../ui';

export interface PersonaSettingsUpdateProps {
  readonly sessionId: string;
}

const STATE_KEY = {
  update: 'persona.binding.state.update',
  overrides: 'persona.binding.state.overrides',
  current: 'persona.binding.state.current',
} as const;

type PersonaState = keyof typeof STATE_KEY;

const settingsQueryKey = (sessionId: string) => ['sessions', sessionId, 'persona-settings'] as const;

/** Revision hashes are long; the first eight characters identify one in a row. */
function shortRevision(revision: string | undefined): string {
  return revision === undefined ? '—' : revision.slice(0, 8);
}

interface PersonaSettingsController {
  readonly status: 'loading' | 'error' | 'absent' | 'ready';
  readonly readError: unknown;
  readonly settings: SessionPersonaSettings | undefined;
  readonly state: PersonaState | undefined;
  readonly overrideLabels: readonly string[];
  readonly failure: string | null;
  readonly saved: boolean;
  readonly applying: boolean;
  readonly confirmRestore: boolean;
  readonly apply: (restoreDefaults: boolean) => void;
  readonly askRestore: () => void;
  readonly dismissRestore: () => void;
  readonly retry: () => void;
}

/** One reading, one write, one confirmation — shared by both carriers. */
function usePersonaSettings(sessionId: string): PersonaSettingsController {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, markSaved] = useSavedTick();
  const hasValidSession = Boolean(sessionId && sessionId.trim() !== '');

  const settingsQuery = useQuery({
    queryKey: settingsQueryKey(sessionId),
    queryFn: () => client.getPersonaSettings(sessionId),
    staleTime: 15_000,
    enabled: hasValidSession,
  });

  const applyMutation: UseMutationResult<SessionPersonaSettings, unknown, boolean> = useMutation({
    mutationFn: (restoreDefaults: boolean) => client.applyPersonaSettings(sessionId, restoreDefaults ? { restoreDefaults: true } : {}),
    onSuccess: (next, restoreDefaults) => {
      // The response is the new reading; nothing has to be re-fetched.
      queryClient.setQueryData<SessionPersonaSettings>(settingsQueryKey(sessionId), next);
      markSaved();
      setConfirmRestore(false);
      setFailure(null);
      pushToast({ tone: 'success', text: t(restoreDefaults ? 'persona.binding.restoredToast' : 'persona.binding.appliedToast') });
    },
    onError: (error: unknown, restoreDefaults) => {
      setConfirmRestore(false);
      setFailure(t(restoreDefaults ? 'persona.binding.restoreFailed' : 'persona.binding.applyFailed', { detail: errorText(locale, error) }));
    },
  });

  const settings = settingsQuery.data;
  const overrideLabels = settings === undefined ? [] : [
    settings.overrides?.profile === undefined ? undefined : t('persona.profile'),
    settings.overrides?.model === undefined ? undefined : t('persona.model'),
    settings.overrides?.thinking === undefined ? undefined : t('persona.effort'),
  ].filter((label) => label !== undefined);

  const state: PersonaState | undefined = settings === undefined
    ? undefined
    : settings.hasUpdate ? 'update' : overrideLabels.length > 0 ? 'overrides' : 'current';

  return {
    status: !hasValidSession ? 'absent' : settingsQuery.isPending ? 'loading' : settingsQuery.isError ? 'error' : settings?.personaId === undefined ? 'absent' : 'ready',
    readError: settingsQuery.error,
    settings,
    state,
    overrideLabels,
    failure,
    saved,
    applying: applyMutation.isPending,
    confirmRestore,
    apply: (restoreDefaults) => { setFailure(null); applyMutation.mutate(restoreDefaults); },
    askRestore: () => { setConfirmRestore(true); },
    dismissRestore: () => { setConfirmRestore(false); },
    retry: () => { void settingsQuery.refetch(); },
  };
}

/** The measured readings: where the copy came from, when someone wants it. */
function RevisionRows({ settings }: { readonly settings: SessionPersonaSettings }) {
  const { t } = useI18n();
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
      <dt className="text-ink-faint">{t('persona.binding.bound')}</dt>
      <dd className="truncate font-mono text-[11px] text-ink-soft" title={settings.boundRevision}>{shortRevision(settings.boundRevision)}</dd>
      <dt className="text-ink-faint">{t('persona.binding.latest')}</dt>
      <dd className="truncate font-mono text-[11px] text-ink-soft" title={settings.latestRevision}>{shortRevision(settings.latestRevision)}</dd>
    </dl>
  );
}

/**
 * What can be done about it, plus what went wrong if it was refused. No head
 * and no fold of its own: the carrier decides how the state is announced.
 */
function PersonaSettingsActions({ controller }: { readonly controller: PersonaSettingsController }) {
  const { t } = useI18n();
  const settings = controller.settings;
  if (settings === undefined) return null;
  // The conversation differs from the persona whenever either half is true, so
  // both actions live in one row that exists exactly while something differs —
  // and neither is offered when nothing does.
  const differs = settings.hasUpdate || controller.overrideLabels.length > 0;

  return (
    <div className="space-y-2">
      <RevisionRows settings={settings} />

      {differs ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {settings.hasUpdate ? (
              <button
                type="button"
                data-persona-binding-apply
                disabled={controller.applying}
                onClick={() => { controller.apply(false); }}
                className={PRIMARY_BUTTON}
              >
                {t('persona.binding.apply')}
              </button>
            ) : null}
            <button
              type="button"
              data-persona-binding-restore
              disabled={controller.applying}
              onClick={controller.askRestore}
              className="h-7 text-[12px] text-ink-soft underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:text-ink-faint"
            >
              {t('persona.binding.restore')}
            </button>
            <SavedTick show={controller.saved && !controller.applying} />
          </div>
          {settings.hasUpdate ? (
            <p data-persona-binding-idle-hint className="text-[12px] leading-relaxed text-ink-faint">{t('persona.binding.idleHint')}</p>
          ) : null}
        </div>
      ) : (
        <p data-persona-binding-current className="flex flex-wrap items-center gap-x-2 text-[13px] text-ink-soft">
          {t('persona.binding.current')}
          <SavedTick show={controller.saved && !controller.applying} />
        </p>
      )}

      {controller.overrideLabels.length > 0 ? (
        <p data-persona-binding-overrides className="text-[12px] leading-relaxed text-ink-faint">
          {t('persona.binding.overrides')} {controller.overrideLabels.join(' · ')}
        </p>
      ) : null}

      {controller.failure !== null ? (
        <div data-persona-binding-failure>
          <FeedbackLine feedback={{ tone: 'error', text: controller.failure }} />
        </div>
      ) : null}

      <ConfirmDialog
        open={controller.confirmRestore}
        title={t('persona.binding.restoreTitle')}
        consequences={[
          t('persona.binding.restoreConsequence'),
          ...(controller.overrideLabels.length > 0 ? [t('persona.binding.restoreOverrides', { fields: controller.overrideLabels.join(' · ') })] : []),
        ]}
        confirmLabel={t('persona.binding.restore')}
        busy={controller.applying}
        overlayId="persona-binding-restore"
        onCancel={controller.dismissRestore}
        onConfirm={() => { controller.apply(true); }}
      />
    </div>
  );
}

/** The failed read, as the short reason plus the way back. */
function PersonaSettingsError({ controller }: { readonly controller: PersonaSettingsController }) {
  const { t, locale } = useI18n();
  return (
    <div data-persona-binding-error className="space-y-1">
      <FeedbackLine feedback={{ tone: 'error', text: errorText(locale, controller.readError) }} />
      <button type="button" data-persona-binding-retry onClick={controller.retry} className="text-[12px] text-ink-faint underline underline-offset-2 hover:text-ink">
        {t('common.retry')}
      </button>
    </div>
  );
}

/**
 * The rail's chapter: folded it says only which of the three situations this
 * conversation is in; everything else is one click away.
 */
export function PersonaSettingsUpdate({ sessionId }: PersonaSettingsUpdateProps) {
  const { t } = useI18n();
  const controller = usePersonaSettings(sessionId);

  // Nothing is claimed before the reading arrives: a chapter that appears with
  // the wrong state and then corrects itself is worse than one that waits.
  if (controller.status === 'loading') return null;

  if (controller.status === 'error') {
    return (
      <InspectorSection title={t('persona.binding.section')} collapsible={false} data-persona-binding-error data-persona-binding-state="failed">
        <PersonaSettingsError controller={controller} />
      </InspectorSection>
    );
  }
  // No persona on this conversation: there is no version to compare.
  if (controller.status === 'absent' || controller.settings === undefined) return null;

  return (
    <InspectorSection
      title={t('persona.binding.section')}
      summary={t(STATE_KEY[controller.state ?? 'current'])}
      defaultOpen={false}
      data-persona-binding={controller.settings.personaId}
      data-persona-binding-state={controller.state}
    >
      <PersonaSettingsActions controller={controller} />
    </InspectorSection>
  );
}

/**
 * The header menu's carrier: the same content, with the title and the state
 * both visible and nothing folded. Also the narrow-screen way in, since the
 * rail (and its chapter) does not exist there.
 */
export function PersonaSettingsDialog({ sessionId, onClose }: PersonaSettingsUpdateProps & { readonly onClose: () => void }) {
  const { t } = useI18n();
  const controller = usePersonaSettings(sessionId);
  const state = controller.state;

  // The menu entry only exists for a conversation with a persona; if that ever
  // changes while the drawer is open, the drawer closes its own content too.
  if (controller.status === 'absent') return null;

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={t('persona.binding.menu')}
      overlayId="persona-settings"
      overlayClassName="fixed inset-0 z-50 flex justify-end bg-shell/40 backdrop-blur-[2px]"
      panelClassName="anim-enter flex h-full w-full max-w-full flex-col overflow-hidden bg-panel text-ink outline-none shadow-2xl min-[768px]:max-w-[440px]"
    >
      <div
        data-persona-settings-dialog={controller.settings?.personaId ?? 'none'}
        data-persona-binding-state={state}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-4">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-[14px] font-medium">{t('persona.binding.menu')}</h2>
            {state === undefined ? null : (
              <span data-persona-binding-state-word className="text-[12px] text-ink-faint">{t(STATE_KEY[state])}</span>
            )}
          </div>
          <button
            type="button"
            data-autofocus
            data-persona-settings-close
            aria-label={t('agentPanel.detailClose')}
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-ink-soft hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          {controller.status === 'loading' ? (
            <p role="status" data-persona-binding-loading className="text-[13px] text-ink-faint">{t('persona.binding.loading')}</p>
          ) : controller.status === 'error' ? (
            <PersonaSettingsError controller={controller} />
          ) : (
            <PersonaSettingsActions controller={controller} />
          )}
        </div>
      </div>
    </Dialog>
  );
}
