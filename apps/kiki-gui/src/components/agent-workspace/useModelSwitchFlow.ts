/**
 * Shared model-switch flow for one agent (main or subagent):
 * - Opens the three-mode confirm dialog or switches immediately per remembered rules.
 * - Resolves target thinking effort against the model catalog (plus optional profile default).
 * - Submits or edits queued switch operations, updates remembered rules without clobbering
 *   other model_switch settings, and exposes timeline/queue notice actions.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  modelSwitchPreferencesToWire,
  readModelSwitchPreferences,
  rememberModelSwitchChoice,
  resolveCatalogModel,
  resolveModelSwitchPreferences,
  resolveSelectedEffort,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import type {
  KikiConfigPatch,
  KikiConfigResponse,
  ModelSwitchInput,
  ModelSwitchMode,
  ModelSwitchReceipt,
} from '../../lib/client';
import { pushToast } from '../../lib/toasts';
import type { ModelSwitchNoticeActions } from '../model-switch/ModelSwitchNotice';
import { resolveSwitchEffort } from '../model-switch/switchEffort';
import type { ModelSwitchesHandle } from '../model-switch/useModelSwitches';

export interface ModelSwitchCatalogItem {
  readonly id: string;
  readonly remote_id: string;
  readonly provider_id: string;
  readonly support_efforts?: readonly string[];
  readonly default_effort?: string;
}

export interface ModelSwitchFlowClient {
  switchAgentModel(sessionId: string, agentId: string, input: ModelSwitchInput): Promise<ModelSwitchReceipt>;
  updateAgentModelSwitch(
    sessionId: string,
    agentId: string,
    input: ModelSwitchInput,
    expectedRevision?: number,
  ): Promise<ModelSwitchReceipt>;
  cancelAgentModelSwitch(sessionId: string, agentId: string, operationId: string): Promise<ModelSwitchReceipt>;
  recoverAgentModelSwitch(
    sessionId: string,
    agentId: string,
    operationId: string,
    action: 'retry' | 'keep_original',
    mode?: ModelSwitchMode,
  ): Promise<ModelSwitchReceipt>;
  getConfig(): Promise<KikiConfigResponse>;
  patchConfig(body: KikiConfigPatch): Promise<KikiConfigResponse>;
}

export interface ModelSwitchDialogState {
  readonly fromModel: string;
  readonly toModel: string;
  readonly initialMode: ModelSwitchMode;
  readonly matchedRuleId?: string;
  readonly editingOperationId?: string;
  readonly editingRevision?: number;
}

export interface ModelSwitchSubmitChoice {
  readonly fromModel: string;
  readonly toModel: string;
  readonly mode: ModelSwitchMode;
  readonly remember: boolean;
  readonly effort?: string;
  readonly editingOperationId?: string;
  readonly editingRevision?: number;
}

export interface ModelSwitchDialogEffort {
  readonly efforts: readonly string[] | undefined;
  readonly defaultEffort: string | undefined;
  readonly effort: string | undefined;
  readonly adjustedFrom: string | undefined;
}

export interface UseModelSwitchFlowInput {
  readonly client: ModelSwitchFlowClient;
  readonly sessionId: string;
  readonly agentId: string;
  readonly catalogItems: readonly ModelSwitchCatalogItem[] | undefined;
  readonly currentModel: string | undefined;
  readonly carriedThinking: string | undefined;
  readonly switches: ModelSwitchesHandle;
  readonly rawConfigModelSwitch?: Parameters<typeof readModelSwitchPreferences>[0];
  readonly profileDefaultEffort?: (toModel: string) => string | undefined;
  readonly dialog?: ModelSwitchDialogState;
  readonly onChangeDialog?: (dialog: ModelSwitchDialogState | undefined) => void;
}

export interface UseModelSwitchFlowResult {
  readonly dialog: ModelSwitchDialogState | undefined;
  readonly setDialog: (dialog: ModelSwitchDialogState | undefined) => void;
  readonly dialogEffort: ModelSwitchDialogEffort | undefined;
  readonly submitting: boolean;
  readonly submit: (choice: ModelSwitchSubmitChoice) => Promise<void>;
  readonly open: (toModel: string, explicitMode?: ModelSwitchMode) => Promise<void>;
  readonly applyEffortSetting: (model: string, effort: string | undefined) => Promise<boolean>;
  readonly noticeActions: ModelSwitchNoticeActions;
}

export function useModelSwitchFlow({
  client,
  sessionId,
  agentId,
  catalogItems,
  currentModel,
  carriedThinking,
  switches: modelSwitches,
  rawConfigModelSwitch,
  profileDefaultEffort,
  dialog: controlledDialog,
  onChangeDialog,
}: UseModelSwitchFlowInput): UseModelSwitchFlowResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
    retry: false,
    enabled: rawConfigModelSwitch === undefined,
  });
  const effectiveModelSwitchConfig =
    rawConfigModelSwitch !== undefined ? rawConfigModelSwitch : configQuery.data?.model_switch;
  const modelSwitchPrefs = useMemo(
    () => readModelSwitchPreferences(effectiveModelSwitchConfig),
    [effectiveModelSwitchConfig],
  );

  const [internalDialog, setInternalDialog] = useState<ModelSwitchDialogState | undefined>(undefined);
  const dialog = onChangeDialog !== undefined ? controlledDialog : internalDialog;
  const setDialog = useCallback(
    (next: ModelSwitchDialogState | undefined) => {
      if (onChangeDialog !== undefined) {
        onChangeDialog(next);
      } else {
        setInternalDialog(next);
      }
    },
    [onChangeDialog],
  );

  const [submitting, setSubmitting] = useState(false);
  const [pendingOperationId, setPendingOperationId] = useState<string | undefined>(undefined);

  const resolveTargetSwitchEffort = useCallback(
    (toModel: string, carried: string | undefined): ModelSwitchDialogEffort => {
      if (catalogItems === undefined) {
        return { efforts: undefined, defaultEffort: undefined, effort: carried, adjustedFrom: undefined };
      }
      const targetCatalog = resolveCatalogModel(catalogItems, toModel);
      if (targetCatalog === undefined) {
        return { efforts: undefined, defaultEffort: undefined, effort: carried, adjustedFrom: undefined };
      }
      const targetEfforts = targetCatalog.support_efforts ?? [];
      const profileDefault = profileDefaultEffort?.(toModel);
      const defaultEffort = resolveSelectedEffort(targetEfforts, profileDefault, targetCatalog.default_effort);
      const resolved = resolveSwitchEffort({ targetEfforts, carried, targetDefault: defaultEffort });
      return {
        efforts: targetEfforts,
        defaultEffort,
        effort: resolved.effort,
        adjustedFrom: resolved.adjustedFrom,
      };
    },
    [catalogItems, profileDefaultEffort],
  );

  const dialogEffort = useMemo<ModelSwitchDialogEffort | undefined>(() => {
    if (dialog === undefined) return undefined;
    if (dialog.editingOperationId !== undefined) {
      const entry = modelSwitches.switches.find(
        (candidate) => candidate.input.operationId === dialog.editingOperationId,
      );
      const editedThinking =
        typeof entry?.input.thinking === 'string' && entry.input.thinking !== ''
          ? entry.input.thinking
          : undefined;
      return resolveTargetSwitchEffort(dialog.toModel, editedThinking);
    }
    return resolveTargetSwitchEffort(dialog.toModel, carriedThinking);
  }, [carriedThinking, dialog, modelSwitches.switches, resolveTargetSwitchEffort]);

  const submit = useCallback(
    async (choice: ModelSwitchSubmitChoice) => {
      setSubmitting(true);
      try {
        if (choice.editingOperationId !== undefined) {
          const existing = modelSwitches.switches.find(
            (entry) => entry.input.operationId === choice.editingOperationId,
          )?.input.thinking;
          const nextThinking =
            choice.effort !== undefined
              ? choice.effort
              : existing !== undefined && existing !== null
                ? null
                : existing;
          const receipt = await client.updateAgentModelSwitch(
            sessionId,
            agentId,
            {
              operationId: choice.editingOperationId,
              model: choice.toModel,
              mode: choice.mode,
              thinking: nextThinking,
              selectedFromModel: choice.fromModel,
            },
            choice.editingRevision,
          );
          if (receipt.state === 'failed') {
            throw new Error(receipt.error?.message ?? t('modelSwitch.listFailed'));
          }
        } else {
          const nextThinking =
            choice.effort !== undefined
              ? choice.effort
              : choice.toModel === choice.fromModel && carriedThinking !== undefined
                ? null
                : undefined;
          const receipt = await client.switchAgentModel(sessionId, agentId, {
            operationId: crypto.randomUUID(),
            model: choice.toModel,
            mode: choice.mode,
            thinking: nextThinking,
            selectedFromModel: choice.fromModel,
            intent: choice.mode === 'direct' ? 'setting' : undefined,
          });
          if (receipt.state === 'failed') {
            throw new Error(receipt.error?.message ?? t('modelSwitch.listFailed'));
          }
        }
        modelSwitches.refresh();
        setDialog(undefined);
      } catch (error) {
        pushToast({
          tone: 'error',
          text: t(
            choice.editingOperationId !== undefined
              ? 'modelSwitch.updateFailed'
              : 'modelSwitch.submitFailed',
            {
              detail: error instanceof Error ? error.message : String(error),
            },
          ),
        });
        return;
      } finally {
        setSubmitting(false);
      }

      if (!choice.remember) return;
      // The switch is already accepted: a preference write failure reports the
      // unsaved preference and never rolls back the switch. Only the rule table
      // is patched so default mode / ask flags edited elsewhere stay intact.
      try {
        const remembered = modelSwitchPreferencesToWire(
          rememberModelSwitchChoice(modelSwitchPrefs, choice.fromModel, choice.toModel, choice.mode),
        );
        const echoed = await client.patchConfig({ model_switch: { rules: remembered.rules } });
        queryClient.setQueryData(['config'], echoed);
      } catch (error) {
        pushToast({
          tone: 'error',
          text: t('modelSwitch.prefsSaveFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    },
    [agentId, carriedThinking, client, modelSwitchPrefs, modelSwitches, queryClient, sessionId, setDialog, t],
  );

  const open = useCallback(
    async (toModel: string, explicitMode?: ModelSwitchMode) => {
      const fromModel = currentModel;
      if (fromModel === undefined || (toModel === fromModel && explicitMode === undefined)) return;
      const resolved = resolveModelSwitchPreferences(modelSwitchPrefs, fromModel, toModel, explicitMode);
      if (resolved.confirm) {
        setDialog({
          fromModel,
          toModel,
          initialMode: resolved.mode,
          matchedRuleId: resolved.matchedRuleId,
        });
        return;
      }
      const { effort } = resolveTargetSwitchEffort(toModel, carriedThinking);
      await submit({ fromModel, toModel, mode: resolved.mode, remember: false, effort });
    },
    [carriedThinking, currentModel, modelSwitchPrefs, resolveTargetSwitchEffort, setDialog, submit],
  );

  const applyEffortSetting = useCallback(
    async (model: string, effort: string | undefined): Promise<boolean> => {
      try {
        const receipt = await client.switchAgentModel(sessionId, agentId, {
          operationId: crypto.randomUUID(),
          model,
          thinking: effort === '' ? null : effort ?? null,
          mode: 'direct',
          intent: 'setting',
        });
        if (receipt.state === 'failed') {
          throw new Error(receipt.error?.message ?? t('modelSwitch.listFailed'));
        }
        modelSwitches.refresh();
        return true;
      } catch (error) {
        pushToast({
          tone: 'error',
          text: t('subagent.effortChangeFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
        return false;
      }
    },
    [agentId, client, modelSwitches, sessionId, t],
  );

  const runModelSwitchAction = useCallback(
    (
      operationId: string,
      run: () => Promise<unknown>,
      failureKey: 'modelSwitch.cancelFailed' | 'modelSwitch.recoverFailed',
    ) => {
      setPendingOperationId(operationId);
      void run()
        .then(() => {
          modelSwitches.refresh();
        })
        .catch((error: unknown) => {
          pushToast({
            tone: 'error',
            text: t(failureKey, {
              detail: error instanceof Error ? error.message : String(error),
            }),
          });
        })
        .finally(() => {
          setPendingOperationId((current) => (current === operationId ? undefined : current));
        });
    },
    [modelSwitches, t],
  );

  const noticeActions = useMemo<ModelSwitchNoticeActions>(
    () => ({
      pendingOperationId,
      edit: (operationId) => {
        const entry = modelSwitches.switches.find(
          (candidate) => candidate.input.operationId === operationId,
        );
        if (entry === undefined || entry.receipt.state !== 'pending') return;
        const resolvedTo =
          catalogItems !== undefined
            ? resolveCatalogModel(catalogItems, entry.input.model)?.id
            : undefined;
        setDialog({
          fromModel: entry.receipt.fromModel,
          toModel: resolvedTo ?? entry.receipt.toModel,
          initialMode: entry.input.mode,
          editingOperationId: operationId,
          editingRevision: entry.revision,
        });
      },
      cancel: (operationId) => {
        runModelSwitchAction(
          operationId,
          () => client.cancelAgentModelSwitch(sessionId, agentId, operationId),
          'modelSwitch.cancelFailed',
        );
      },
      retry: (operationId) => {
        runModelSwitchAction(
          operationId,
          () => client.recoverAgentModelSwitch(sessionId, agentId, operationId, 'retry'),
          'modelSwitch.recoverFailed',
        );
      },
      retryAsFresh: (operationId) => {
        runModelSwitchAction(
          operationId,
          () => client.recoverAgentModelSwitch(sessionId, agentId, operationId, 'retry', 'fresh'),
          'modelSwitch.recoverFailed',
        );
      },
      keepOriginal: (operationId) => {
        runModelSwitchAction(
          operationId,
          () => client.recoverAgentModelSwitch(sessionId, agentId, operationId, 'keep_original'),
          'modelSwitch.recoverFailed',
        );
      },
    }),
    [agentId, catalogItems, client, modelSwitches.switches, pendingOperationId, runModelSwitchAction, sessionId, setDialog],
  );

  return {
    dialog,
    setDialog,
    dialogEffort,
    submitting,
    submit,
    open,
    applyEffortSetting,
    noticeActions,
  };
}
