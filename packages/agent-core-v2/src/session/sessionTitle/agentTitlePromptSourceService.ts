import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import {
  promptMetadataTextFromContentParts,
  promptMetadataTextFromText,
} from '#/agent/prompt/promptMetadataText';
import type { ContentPart } from '#/kosong/contract/message';

import {
  IAgentTitlePromptSource,
  MAX_TITLE_RECENT_USER_PROMPTS,
  type TitleDigestExcerpt,
  type TitleTurnExcerpt,
} from './agentTitlePromptSource';

export class AgentTitlePromptSourceService implements IAgentTitlePromptSource {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
  ) {}

  async firstUserPrompts(limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];

    const result: string[] = [];
    for (const message of this.combinedMessages()) {
      if (!isNaturalLanguagePrompt(message)) continue;
      const text = promptMetadataTextFromUserMessage(message);
      if (text !== undefined) result.push(text);
      if (result.length >= limit) break;
    }
    return result;
  }

  async firstTurnExcerpt(): Promise<TitleTurnExcerpt> {
    const all = this.combinedMessages();
    const firstUserIndex = all.findIndex(isNaturalLanguagePrompt);
    if (firstUserIndex < 0) return {};
    const user = promptMetadataTextFromUserMessage(all[firstUserIndex]!);
    const span: ContextMessage[] = [];
    for (const message of all.slice(firstUserIndex + 1)) {
      if (isNaturalLanguagePrompt(message) || message.origin?.kind === 'compaction_summary') break;
      span.push(message);
    }
    return { user, assistant: finalAssistantText(span) };
  }

  async digestExcerpt(): Promise<TitleDigestExcerpt> {
    const all = this.combinedMessages();
    const users: string[] = [];
    let lastUserIndex = -1;
    let summaryIndex = -1;
    let summary: string | undefined;
    for (const [index, message] of all.entries()) {
      if (message.origin?.kind === 'compaction_summary') {
        summaryIndex = index;
        summary = promptMetadataTextFromContentParts(message.content);
      }
      if (!isNaturalLanguagePrompt(message)) continue;
      lastUserIndex = index;
      const text = promptMetadataTextFromUserMessage(message);
      if (text !== undefined) users.push(text);
    }
    return {
      firstUser: users[0],
      recentUsers: users.slice(1).slice(-MAX_TITLE_RECENT_USER_PROMPTS),
      summary,
      assistant: lastUserIndex >= 0 && lastUserIndex > summaryIndex
        ? finalAssistantText(all.slice(lastUserIndex + 1))
        : undefined,
    };
  }

  private combinedMessages(): ContextMessage[] {
    const queue = this.prompt.list();
    const candidates = [...this.context.get()];
    if (queue.active !== undefined) candidates.push(queue.active.message);
    if (queue.launching !== undefined) candidates.push(queue.launching.message);
    for (const item of queue.pending) candidates.push(item.message);
    const seen = new Set<string>();
    return candidates.filter(message => {
      if (!isNaturalLanguagePrompt(message) || message.id === undefined) return true;
      const key = JSON.stringify([message.id, message.providerMessageId]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

function isNaturalLanguagePrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  return origin === undefined || origin.kind === 'user';
}

function promptMetadataTextFromUserMessage(message: ContextMessage): string | undefined {
  const bundled = message.origin?.kind === 'user' ? (message.origin.skillActivations?.length ?? 0) : 0;
  return promptMetadataTextFromContentParts(
    bundled === 0 ? message.content : message.content.slice(bundled),
  );
}

function finalAssistantText(messages: readonly ContextMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    const text = assistantTextFromContentParts(message.content);
    if (text !== undefined) return text;
  }
  return undefined;
}

function assistantTextFromContentParts(parts: readonly ContentPart[]): string | undefined {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text.trim().length > 0) texts.push(part.text);
  }
  if (texts.length === 0) return undefined;
  return promptMetadataTextFromText(texts.join('\n'));
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTitlePromptSource,
  AgentTitlePromptSourceService,
  ScopeActivation.OnDemand,
  'sessionTitle',
);
