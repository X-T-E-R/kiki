import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { SendMessageReceipt } from './messageRouting';

export interface BotSummary {
  readonly personaId: string;
  readonly name: string;
  readonly title?: string;
  readonly homeSessionId?: string;
  readonly pinned: boolean;
  readonly hidden: boolean;
}

export interface BotState {
  readonly personaId: string;
  readonly homeSessionId?: string;
  readonly pinned: boolean;
  readonly hidden: boolean;
}

export interface BotUpdateInput {
  readonly pinned?: boolean;
  readonly hidden?: boolean;
}

export interface BotHandoffInput {
  readonly sourceSessionId: string;
  readonly sourcePersonaId?: string;
  readonly sourceName?: string;
  readonly target: string;
  readonly content: string;
  readonly replyTo?: string;
  readonly attachments?: readonly import('./messageRouting').MessageAttachmentReceipt[];
  readonly idempotencyKey: string;
}

export interface IBotService {
  readonly _serviceBrand: undefined;
  list(): Promise<readonly BotSummary[]>;
  resolve(nameOrId: string): Promise<BotSummary | undefined>;
  enable(personaId: string): Promise<BotSummary>;
  update(personaId: string, input: BotUpdateInput): Promise<BotState>;
  ensureHomeSession(personaId: string): Promise<BotSummary>;
  claimHomeSession(personaId: string, sessionId: string): Promise<import('#/app/persona/personaStore').PersonaState>;
  setHomeSession(personaId: string, sessionId: string): Promise<import('#/app/persona/personaStore').PersonaState>;
  sessionPersonaId(session: import('#/app/sessionIndex/sessionIndex').SessionSummary): Promise<string | undefined>;
  sessionBelongsToPersona(session: import('#/app/sessionIndex/sessionIndex').SessionSummary, personaId: string): Promise<boolean>;
  sendHandoff(input: BotHandoffInput): Promise<SendMessageReceipt>;
}

export const IBotService: ServiceIdentifier<IBotService> = createDecorator<IBotService>('botService');
