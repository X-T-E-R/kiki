import { createHash } from 'node:crypto';
import { wrapSystemReminder } from '#/agent/systemReminder/systemReminder';
import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';

const MAX_SHARED_TOOLSETS = 64;
const sharedCanonicalToolsets = new Map<string, readonly Tool[]>();

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function internCanonicalToolset(tools: readonly Tool[]): readonly Tool[] {
  const key = hashJson(tools.map((tool) => [tool.name, tool.description, tool.parameters, tool.deferred]));
  const existing = sharedCanonicalToolsets.get(key);
  if (existing !== undefined) {
    sharedCanonicalToolsets.delete(key);
    sharedCanonicalToolsets.set(key, existing);
    return existing;
  }
  const cloned = Object.freeze(structuredClone(tools).map((tool) => Object.freeze(tool)));
  if (sharedCanonicalToolsets.size >= MAX_SHARED_TOOLSETS) {
    const oldestKey = sharedCanonicalToolsets.keys().next().value;
    if (oldestKey !== undefined) sharedCanonicalToolsets.delete(oldestKey);
  }
  sharedCanonicalToolsets.set(key, cloned);
  return cloned;
}

export class PromptCacheWindow {
  private readonly turnTools = new Map<number, readonly Tool[]>();
  private toolset: { signatureHash: string; tools: readonly Tool[] } | undefined;
  private extension: { baseline: string; current: string } | undefined;
  private readonly extensionUpdates: { index: number; previousText: string; message: Message }[] = [];

  constructor(readonly key: string) {}

  toolsForTurn(turnId: number, tools: readonly Tool[], promptOverrides: string): readonly Tool[] {
    const frozen = this.turnTools.get(turnId);
    if (frozen !== undefined) return frozen;
    for (const id of this.turnTools.keys()) {
      if (id < turnId) this.turnTools.delete(id);
    }
    const signatureHash = hashJson([
      promptOverrides,
      tools.map((tool) => [tool.name, tool.parameters, tool.deferred]),
    ]);
    if (this.toolset?.signatureHash !== signatureHash) {
      this.toolset = { signatureHash, tools: internCanonicalToolset(tools) };
    }
    this.turnTools.set(turnId, this.toolset.tools);
    return this.toolset.tools;
  }

  projectExtensions(text: string, messages: readonly Message[]): { text: string; messages: Message[] } {
    if (this.extension === undefined) this.extension = { baseline: text, current: text };
    if (text !== this.extension.current) {
      const previousText = this.extension.current;
      this.extension.current = text;
      const index = messages.at(-1)?.partial === true ? messages.length - 1 : messages.length;
      const message: Message = {
        role: 'user',
        content: [{
          type: 'text',
          text: wrapSystemReminder(`Extension prompt sections updated; use this state instead of the previous extension prompt sections.\n\n${text || 'No extension prompt sections are active.'}`),
        }],
        toolCalls: [],
      };
      const last = this.extensionUpdates.at(-1);
      if (last !== undefined && last.index === index) {
        if (text === last.previousText) {
          this.extensionUpdates.pop();
        } else {
          last.message = message;
        }
      } else {
        this.extensionUpdates.push({ index, previousText, message });
      }
    }
    const projected: Message[] = [];
    let start = 0;
    for (const update of this.extensionUpdates) {
      const at = Math.min(Math.max(start, update.index), messages.length);
      projected.push(...messages.slice(start, at), update.message);
      start = at;
    }
    projected.push(...messages.slice(start));
    return { text: this.extension.baseline, messages: projected };
  }
}
