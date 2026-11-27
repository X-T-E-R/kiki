import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type {
  ApprovalDecision,
  DeferredAppendTiming,
  MessageContent,
  PermissionMode,
  PromptSkillActivation,
  QuestionAnswer,
} from '@kiki/protocol';
import { SessionController, createViewState, type SessionViewState } from '@kiki/session-core/session';
import { sessionAttentionCursor } from '@kiki/session-core/sessions';

import type { KikiClient } from '../../lib/client';
import { commitPendingConversationOpen } from '../../lib/conversationOpen';
import { pushToast } from '../../lib/toasts';
import { useControllerRegistry } from '../../state/connection';

const NOOP_UNSUBSCRIBE = () => {};

export interface MobileSessionStreamResult {
  readonly controller: SessionController | null;
  readonly state: SessionViewState;
  readonly loadingOlder: boolean;
  readonly loadOlder: (signal?: AbortSignal) => Promise<boolean>;
  readonly retryLoad: () => Promise<void>;
  readonly sendPrompt: (input: {
    readonly text: string;
    readonly content?: readonly MessageContent[];
    readonly model?: string;
    readonly thinking?: string | null;
    readonly permissionMode?: PermissionMode;
    readonly planMode?: boolean;
    readonly timing?: DeferredAppendTiming;
    readonly personaGreetingReply?: boolean;
    readonly skills?: readonly PromptSkillActivation[];
    readonly now?: boolean;
  }) => Promise<boolean>;
  readonly abort: () => Promise<void>;
  readonly resolveApproval: (approvalId: string, decision: ApprovalDecision, reason?: string) => Promise<void>;
  readonly answerQuestion: (questionId: string, answers: Readonly<Record<string, QuestionAnswer>>) => Promise<void>;
  readonly dismissQuestion: (questionId: string) => Promise<void>;
  readonly regenerateMessage: (userMessageId: string) => Promise<void>;
  readonly resync: () => Promise<void>;
}

export function useMobileSessionStream(
  client: KikiClient,
  spaceKey: string,
  sessionId: string,
): MobileSessionStreamResult {
  const registry = useControllerRegistry();
  const [loadingOlder, setLoadingOlder] = useState(false);

  const createController = useCallback(
    () => new SessionController(client.sessions, client.sessionView(sessionId), sessionId),
    [client, sessionId],
  );
  const [controller, setController] = useState<SessionController | null>(null);
  const emptyState = useMemo(() => createViewState(sessionId), [sessionId]);

  useLayoutEffect(() => {
    const lease = registry.acquire(sessionId, client, createController, 'main');
    setController(lease.controller);
    return () => {
      lease.release();
    };
  }, [client, createController, registry, sessionId]);

  const subscribe = useCallback(
    (listener: () => void) => (controller === null ? NOOP_UNSUBSCRIBE : controller.subscribe(listener)),
    [controller],
  );
  const getSnapshot = useCallback(() => controller?.getState() ?? emptyState, [controller, emptyState]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!state.loaded || state.session === undefined) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    commitPendingConversationOpen(
      { spaceKey, kind: 'session', id: sessionId },
      sessionAttentionCursor(state.session),
    );
  }, [sessionId, spaceKey, state.loaded, state.session]);

  const loadOlder = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    if (controller === null || loadingOlder || !state.hasMoreHistory) return false;
    setLoadingOlder(true);
    try {
      const result = await controller.loadOlderHistory(undefined, signal);
      return result.changed;
    } finally {
      setLoadingOlder(false);
    }
  }, [controller, loadingOlder, state.hasMoreHistory]);

  const sendPrompt = useCallback(
    async (input: {
      readonly text: string;
      readonly content?: readonly MessageContent[];
      readonly model?: string;
      readonly thinking?: string | null;
      readonly permissionMode?: PermissionMode;
      readonly planMode?: boolean;
      readonly timing?: DeferredAppendTiming;
      readonly personaGreetingReply?: boolean;
      readonly skills?: readonly PromptSkillActivation[];
      readonly now?: boolean;
    }): Promise<boolean> => {
      if (controller === null) return false;
      const trimmed = input.text.trim();
      const hasMedia = input.content?.some((part) => part.type !== 'text') === true;
      if (trimmed === '' && !hasMedia) return false;
      try {
        if (input.now === true) {
          await controller.sendPromptNow({
            text: trimmed,
            ...(input.content !== undefined ? { content: [...input.content] } : {}),
          });
          return true;
        }
        await controller.sendPrompt({
          text: trimmed,
          ...(input.content !== undefined ? { content: [...input.content] } : {}),
          ...(input.model !== undefined && input.model !== '' ? { model: input.model } : {}),
          ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
          ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
          ...(input.planMode === true ? { planMode: true } : {}),
          ...(input.timing !== undefined ? { appendTiming: input.timing } : {}),
          ...(input.personaGreetingReply === true ? { personaGreetingReply: true } : {}),
          ...(input.skills !== undefined && input.skills.length > 0 ? { skills: [...input.skills] } : {}),
        });
        return true;
      } catch (error) {
        pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },
    [controller],
  );

  const abort = useCallback(async () => {
    if (controller === null) return;
    try {
      await controller.abortActive();
    } catch (error) {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }, [controller]);

  const resolveApproval = useCallback(
    async (approvalId: string, decision: ApprovalDecision, reason?: string) => {
      if (controller === null) return;
      const feedback = reason?.trim();
      try {
        await controller.resolveApproval(
          approvalId,
          decision,
          undefined,
          undefined,
          feedback !== undefined && feedback !== '' ? { feedback } : undefined,
        );
      } catch (error) {
        pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      }
    },
    [controller],
  );

  const answerQuestion = useCallback(
    async (questionId: string, answers: Readonly<Record<string, QuestionAnswer>>) => {
      if (controller === null) return;
      try {
        await controller.answerQuestion(questionId, { ...answers });
      } catch (error) {
        pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      }
    },
    [controller],
  );

  const dismissQuestion = useCallback(
    async (questionId: string) => {
      if (controller === null) return;
      try {
        await controller.dismissQuestion(questionId);
      } catch (error) {
        pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      }
    },
    [controller],
  );

  const retryLoad = useCallback(async () => {
    if (controller === null) return;
    try {
      if (state.loadError !== undefined) {
        await controller.retryOpen();
      } else if (state.resyncFailed && state.resyncError?.retryable !== false) {
        await controller.resync();
      }
    } catch (error) {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }, [controller, state.loadError, state.resyncError?.retryable, state.resyncFailed]);

  const regenerateMessage = useCallback(
    async (userMessageId: string) => {
      if (controller === null) return;
      try {
        await controller.regenerateMessage(userMessageId);
      } catch (error) {
        pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      }
    },
    [controller],
  );

  const resync = useCallback(async () => {
    if (controller === null) return;
    try {
      await controller.resync();
    } catch (error) {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }, [controller]);

  return {
    controller,
    state,
    loadingOlder,
    loadOlder,
    retryLoad,
    sendPrompt,
    abort,
    resolveApproval,
    answerQuestion,
    dismissQuestion,
    regenerateMessage,
    resync,
  };
}
