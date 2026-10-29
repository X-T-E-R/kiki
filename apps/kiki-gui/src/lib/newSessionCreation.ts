import type { ComposerAttachment, ExecutionChoice } from '@kiki/session-core/composer';
import type { PermissionMode } from '@kiki/protocol';
import { readSettings } from '@kiki/session-core/settings';
import { spaceStorage, type SpaceStorage } from './spaceStorage';

export interface FirstSessionMessage {
  readonly initialPromptId: string;
  readonly initialPrompt?: string;
  readonly initialPresentation?: import('@kiki/transcript').TextPresentation;
  readonly initialAttachments?: readonly ComposerAttachment[];
  readonly initialSkill?: { readonly name: string; readonly args: string; readonly attachments: readonly ComposerAttachment[]; readonly userInput?: string };
  readonly model?: string;
  readonly thinking?: string;
  readonly permissionMode?: PermissionMode;
  readonly planMode?: boolean;
  readonly goalObjective?: string;
  readonly appendTiming?: import('@kiki/protocol').DeferredAppendTiming;
  readonly ephemeral?: boolean;
  readonly personaGreetingReply?: boolean;
  readonly execution?: ExecutionChoice;
}

export type FirstSessionSubmission = Omit<Parameters<import('@kiki/session-core/session').SessionController['sendPrompt']>[0], 'onPreservation' | 'onAcknowledged'>;

export interface FirstSessionMessageRecord {
  readonly message: FirstSessionMessage;
  readonly submission?: FirstSessionSubmission;
  readonly status: 'ready' | 'submitted';
}

export async function submitFirstSessionMessage<T>(input: {
  readonly record: FirstSessionMessageRecord;
  readonly save: (record: FirstSessionMessageRecord) => void;
  readonly read: (promptId: string) => Promise<T | undefined>;
  readonly submit: (submission: FirstSessionSubmission) => Promise<T>;
  readonly retryMissing?: boolean;
}): Promise<T> {
  const { record } = input;
  if (record.status === 'submitted') {
    const receipt = await input.read(record.message.initialPromptId);
    if (receipt !== undefined) return receipt;
    if (!input.retryMissing) throw new Error('The first message has no confirmed receipt yet. Check again before sending it again.');
  }
  if (record.submission === undefined) throw new Error('The first message payload is not prepared.');
  input.save({ ...record, status: 'submitted' });
  return input.submit(record.submission);
}

const key = (scopeId: string, sessionId: string) => `kiki.draft.new.message.${JSON.stringify([scopeId, sessionId])}`;

export function readFirstSessionMessage(scopeId: string, sessionId: string): FirstSessionMessageRecord | undefined {
  if (!readSettings().draftPersistence) return undefined;
  try {
    const value = JSON.parse(spaceStorage.getItem(key(scopeId, sessionId)) ?? 'null') as FirstSessionMessageRecord | null;
    if (value === null || typeof value !== 'object' || !value.message || typeof value.message.initialPromptId !== 'string'
      || (value.status !== 'ready' && value.status !== 'submitted')) return undefined;
    return value;
  } catch { return undefined; }
}

export function writeFirstSessionMessage(scopeId: string, sessionId: string, record: FirstSessionMessageRecord, storage: SpaceStorage = spaceStorage): void {
  if (!readSettings().draftPersistence) return;
  try { storage.setItem(key(scopeId, sessionId), JSON.stringify(record)); } catch { return; }
}

export function clearFirstSessionMessage(scopeId: string, sessionId: string, storage: SpaceStorage = spaceStorage): void {
  try { storage.removeItem(key(scopeId, sessionId)); } catch { return; }
}
