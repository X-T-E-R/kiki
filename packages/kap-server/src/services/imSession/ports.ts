import type { ImBusyDelivery, ImProviderKind } from '@kiki/protocol';
import type { MessageContent } from '@kiki/protocol';

import type { ImAdapterFactory, ImInboundIdentity } from './adapter';

export interface ImCredentialInstance {
  readonly id: string;
  readonly providerId: string;
  readonly label?: string;
  readonly configured: boolean;
}

export interface ImVisibleMedia {
  readonly kind: 'image' | 'file' | 'audio';
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface ImVisibleReply {
  readonly text: string;
  readonly done: boolean;
  readonly media: readonly ImVisibleMedia[];
}

export interface ImPendingApproval {
  readonly id: string;
  readonly expiresAt: number;
  readonly toolName: string;
  readonly action: string;
  readonly ssh?: 'login' | 'host_key';
}

export interface ImPendingQuestion {
  readonly id: string;
  readonly questionIndex: number;
  readonly expiresAt: number;
  readonly questionKey: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly multi: boolean;
  readonly allowOther: boolean;
}

export interface ImSubmitResult {
  readonly duplicate: boolean;
  readonly promptId: string;
  readonly turnId?: number;
  readonly deliveryState: 'queued' | 'steered' | 'pending';
}

export interface ImQuestionAnswer {
  readonly kind: 'single' | 'multi' | 'other' | 'multi_with_other';
  readonly questionKey?: string;
  readonly questionIndex?: number;
  readonly optionIds?: readonly string[];
  readonly text?: string;
  readonly method: 'number_key';
}

export type ImAnswerResult =
  | 'answered'
  | 'expired'
  | 'resolved'
  | { readonly result: 'answered' | 'partial'; readonly answers: Record<string, string | true> };

export interface WechatQrLoginPort {
  start(): Promise<{ readonly login_id: string; readonly image: string }>;
  poll(id: string, verifyCode?: string): Promise<{ readonly status: string; readonly provider_instance_id?: string; readonly account_id?: string }>;
  cancel(id: string): Promise<void>;
}

export interface ImSessionPorts {
  readonly history?: import('./history').ImHistoryDocuments;
  readonly notifications?: {
    channels(sessionId: string): readonly import('@kiki/agent-core-v2/app/bot/messageRouting').UserMessageChannel[];
  };
  readonly credentials: {
    list(): readonly ImCredentialInstance[];
    read(instanceId: string): string | undefined;
    write(instanceId: string, value: string): Promise<void>;
    check(instanceId: string): Promise<{ ok: boolean; accountId?: string; conflict?: 'webhook'; detail?: string }>;
    create?(input: { providerKind: ImProviderKind; credential: string }): Promise<{ instanceId: string; label?: string }>;
  };
  readonly sessions: {
    listPersonas(): Promise<readonly { id: string; name: string; homeSessionId?: string }[]>;
    listSessions(): Promise<readonly { id: string; title: string; personaId?: string }[]>;
    owns(sessionId: string): Promise<boolean>;
    ensureHome(personaId: string): Promise<{ homeSessionId?: string }>;
    setHome?(personaId: string, sessionId: string): Promise<void>;
    activity(sessionId: string): Promise<{ busy: boolean; pending: 'none' | 'approval' | 'question'; queueLength: number; activePromptId?: string; activeTurnId?: number }>;
    submit(input: { sessionId: string; promptId: string; content: readonly MessageContent[]; delivery: ImBusyDelivery; im?: import('@kiki/protocol').ImMessageMetadata }): Promise<ImSubmitResult>;
    steer(sessionId: string, promptId: string): Promise<'steered' | 'queued' | 'started'>;
    abort(sessionId: string, promptId?: string, turnId?: number): Promise<boolean>;
    saveMedia(input: { sessionId: string; kind: 'image' | 'file' | 'audio' | 'video'; name: string; mediaType: string; bytes: Uint8Array; text?: string }): Promise<readonly MessageContent[]>;
    historyMedia?(sessionId: string, content: readonly MessageContent[]): Promise<readonly MessageContent[]>;
    readAttachment?(input: { sessionId: string; blobId: string }): Promise<{ bytes: Uint8Array; name: string; mediaType?: string } | undefined>;
    readVisible(sessionId: string, promptId: string, turnId?: number): Promise<ImVisibleReply>;
    listInteractions(sessionId: string, signal?: AbortSignal): Promise<{ approvals: readonly ImPendingApproval[]; questions: readonly ImPendingQuestion[] }>;
    decideApproval(input: { sessionId: string; interactionId: string; decision: 'approved' | 'rejected' }): Promise<'decided' | 'expired' | 'resolved'>;
    decideHostKey(input: { sessionId: string; interactionId: string; decision: 'approved' | 'rejected' }): Promise<'decided' | 'expired' | 'resolved'>;
    answerQuestion(input: { sessionId: string; interactionId: string; response: ImQuestionAnswer; previous?: Record<string, string | true> }): Promise<ImAnswerResult>;
  };
  readonly logger: { info(fields: Record<string, string | number | boolean>, message: string): void };
  load(): Promise<string | undefined>;
  save(value: string): Promise<void>;
}

export interface ImSessionBridgeOptions {
  readonly ports: ImSessionPorts;
  readonly factories: readonly ImAdapterFactory[];
  readonly locale?: 'en' | 'zh' | (() => 'en' | 'zh');
  readonly editIntervalMs?: number;
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
  readonly wechatLogin?: WechatQrLoginPort;
}

export type { ImInboundIdentity };
