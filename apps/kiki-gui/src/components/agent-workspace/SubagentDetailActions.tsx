/**
 * SubagentDetailActions — the action cluster on a subagent detail header:
 * message the agent, switch its model, terminate its run.
 *
 * Purely controlled: the parent workspace owns the client calls and passes
 * them in as async callbacks, so the component renders in static markup tests
 * without a connection provider. Failures surface as toasts here; the message
 * dialog additionally keeps an inline error so the draft is not lost.
 */

import { useEffect, useState } from 'react';

import type { ModelCatalogItem } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { pushToast } from '../../lib/toasts';
import { ConfirmDialog } from '../ConfirmDialog';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from '../ui';

export interface SubagentDetailActionsProps {
  /** Stable id — scopes the uiBusy overlay registration. */
  readonly agentId: string;
  /** Display name, used in dialog titles and toasts. */
  readonly name: string;
  /** Live agents accept messages and model changes; dead ones report agent.not_found. */
  readonly live: boolean;
  /** A running task exists for this agent, so terminate can land. */
  readonly canTerminate: boolean;
  readonly currentModel?: string;
  readonly models: readonly ModelCatalogItem[];
  readonly onSendMessage: (text: string) => Promise<void>;
  readonly onTerminate: () => Promise<void>;
  readonly onChangeModel: (model: string) => Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SubagentDetailActions({
  agentId,
  name,
  live,
  canTerminate,
  currentModel,
  models,
  onSendMessage,
  onTerminate,
  onChangeModel,
}: SubagentDetailActionsProps) {
  const { t } = useI18n();
  const [messageOpen, setMessageOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | undefined>(undefined);
  const [confirmTerminate, setConfirmTerminate] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [selectedModel, setSelectedModel] = useState(currentModel ?? '');
  const [modelBusy, setModelBusy] = useState(false);

  useEffect(() => {
    setSelectedModel(currentModel ?? '');
  }, [currentModel]);

  const sendMessage = async () => {
    const text = draft.trim();
    if (text === '' || sending) return;
    setSending(true);
    setSendError(undefined);
    try {
      await onSendMessage(text);
      pushToast({ tone: 'success', text: t('subagent.messageSent', { name }) });
      setMessageOpen(false);
      setDraft('');
    } catch (error) {
      const detail = errorText(error);
      setSendError(detail);
      pushToast({ tone: 'error', text: t('subagent.messageFailed', { detail }) });
    } finally {
      setSending(false);
    }
  };

  const terminate = async () => {
    setTerminating(true);
    try {
      await onTerminate();
      setConfirmTerminate(false);
    } catch (error) {
      pushToast({
        tone: 'error',
        text: t('subagent.terminateFailed', { detail: errorText(error) }),
      });
    } finally {
      setTerminating(false);
    }
  };

  const changeModel = async (model: string) => {
    if (model === '' || model === currentModel || modelBusy) return;
    setModelBusy(true);
    try {
      await onChangeModel(model);
      pushToast({ tone: 'success', text: t('subagent.modelChanged', { model }) });
    } catch (error) {
      pushToast({
        tone: 'error',
        text: t('subagent.modelChangeFailed', { detail: errorText(error) }),
      });
      setSelectedModel(currentModel ?? '');
    } finally {
      setModelBusy(false);
    }
  };

  return (
    <div data-subagent-actions className="flex shrink-0 items-center gap-1.5">
      {live && models.length > 0 ? (
        <select
          aria-label={t('subagent.changeModel')}
          data-subagent-model-select
          value={selectedModel}
          disabled={modelBusy}
          onChange={(event) => { void changeModel(event.target.value); }}
          className={`${SMALL_INPUT} max-w-44`}
        >
          {selectedModel === '' ? (
            <option value="" disabled>
              {t('subagent.changeModel')}
            </option>
          ) : null}
          {models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.display_name ?? item.id}
            </option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        data-subagent-message
        disabled={!live}
        onClick={() => { setMessageOpen(true); }}
        className={`${SECONDARY_BUTTON} px-2 py-1 text-[11.5px]`}
      >
        {t('subagent.message')}
      </button>
      {canTerminate ? (
        <button
          type="button"
          data-subagent-terminate
          onClick={() => { setConfirmTerminate(true); }}
          className={`${DANGER_GHOST_BUTTON} px-2 py-1 text-[11.5px]`}
        >
          {t('subagent.terminate')}
        </button>
      ) : null}

      {messageOpen ? (
        <Dialog
          onClose={() => { if (!sending) setMessageOpen(false); }}
          ariaLabel={t('subagent.messageTitle', { name })}
          overlayId={`subagent-message-${agentId}`}
          panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.sm}`}
        >
          <h3 className="font-display text-[17px] font-semibold text-ink">
            {t('subagent.messageTitle', { name })}
          </h3>
          <textarea
            data-autofocus
            data-subagent-message-input
            rows={4}
            value={draft}
            placeholder={t('subagent.messagePlaceholder')}
            disabled={sending}
            onChange={(event) => { setDraft(event.target.value); }}
            className={`${INPUT} mt-3 resize-y`}
          />
          {sendError !== undefined ? (
            <p className="mt-2 text-[12px] text-danger">{sendError}</p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2.5">
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={sending}
              onClick={() => { setMessageOpen(false); }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              data-subagent-message-send
              className={PRIMARY_BUTTON}
              disabled={sending || draft.trim() === ''}
              onClick={() => { void sendMessage(); }}
            >
              {t('subagent.send')}
            </button>
          </div>
        </Dialog>
      ) : null}

      <ConfirmDialog
        open={confirmTerminate}
        title={t('subagent.terminateTitle', { name })}
        body={t('subagent.terminateBody')}
        confirmLabel={t('subagent.terminate')}
        tone="danger"
        busy={terminating}
        overlayId={`confirm-terminate-subagent-${agentId}`}
        onConfirm={() => { void terminate(); }}
        onCancel={() => { setConfirmTerminate(false); }}
      />
    </div>
  );
}
