import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';

import type { ApprovalDecision, DeferredAppendTiming, QuestionAnswer } from '@kiki/protocol';
import { SessionController, type SessionViewState } from '@kiki/session-core/session';
import { sessionAttentionCursor } from '@kiki/session-core/sessions';

import type { KikiClient } from '../../lib/client';
import { commitPendingConversationOpen } from '../../lib/conversationOpen';
import { pushToast } from '../../lib/toasts';
import { useControllerRegistry } from '../../state/connection';

export interface MobileSessionStreamResult {
  readonly state: SessionViewState;
  readonly loadingOlder: boolean;
  readonly loadOlder: () => Promise<void>;
  readonly retryLoad: () => Promise<void>;
  readonly sendPrompt: (input: {
    readonly text: string;
    readonly model?: string;
    readonly planMode?: boolean;
    readonly timing?: DeferredAppendTiming;
    readonly personaGreetingReply?: boolean;
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
  const [controller, setController] = useState<SessionController>(createController);

  useLayoutEffect(() => {
    const lease = registry.acquire(sessionId, client, createController, 'main');
    setController(lease.controller);
    return () => {
      lease.release();
    };
  }, [client, createController, registry, sessionId]);

  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!state.loaded || state.session === undefined) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    commitPendingConversationOpen(
      { spaceKey, kind: 'session', id: sessionId },
      sessionAttentionCursor(state.session),
    );
  }, [sessionId, spaceKey, state.loaded, state.session]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !state.hasMoreHistory) return;
    setLoadingOlder(true);
    try {
      await controller.loadOlderHistory();
    } finally {
      setLoadingOlder(false);
    }
  }, [controller, loadingOlder, state.hasMoreHistory]);

  const sendPrompt = useCallback(
    async (input: {
      readonly text: string;
      readonly model?: string;
      readonly planMode?: boolean;
      readonly timing?: DeferredAppendTiming;
      readonly personaGreetingReply?: boolean;
    }): Promise<boolean> => {
      const trimmed = input.text.trim();
      if (trimmed === '') return false;
      try {
        await controller.sendPrompt({
          text: trimmed,
          ...(input.model !== undefined && input.model !== '' ? { model: input.model } : {}),
          ...(input.planMode === true ? { planMode: true } : {}),
          ...(input.timing !== undefined ? { appendTiming: input.timing } : {}),
          ...(input.personaGreetingReply === true ? { personaGreetingReply: true } : {}),
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
    try {
      await controller.abortActive();
    } catch (error) {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }, [controller]);

  const resolveApproval = useCallback(
    async (approvalId: string, decision: ApprovalDecision, reason?: string) => {
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
      try {
        await controller.dismissQuestion(questionId);
      } catch (error) {
        pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      }
    },
    [controller],
  );

  const retryLoad = useCallback(async () => {
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
      try {
        await controller.regenerateMessage(userMessageId);
      } catch (error) {
        pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      }
    },
    [controller],
  );

  const resync = useCallback(async () => {
    try {
      await controller.resync();
    } catch (error) {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }, [controller]);

  return {
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
