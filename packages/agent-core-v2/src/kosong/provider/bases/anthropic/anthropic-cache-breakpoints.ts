import { createHash } from 'node:crypto';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';

import { ChatProviderError } from '#/kosong/contract/errors';
import type { AnthropicProvenBreakpoint } from '#/kosong/contract/provider';

export const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

const CACHEABLE_BLOCK_TYPES = new Set([
  'text',
  'image',
  'document',
  'search_result',
  'tool_use',
  'tool_result',
  'server_tool_use',
  'web_search_tool_result',
]);

type CacheControlObject = {
  readonly type: string;
  readonly ttl?: string;
};

type CacheableContentBlock = ContentBlockParam & {
  cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' };
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCacheControl(value: unknown): CacheControlObject | undefined {
  if (!isPlainRecord(value)) return undefined;
  const cc = value['cache_control'];
  if (!isPlainRecord(cc) || typeof cc['type'] !== 'string') return undefined;
  return {
    type: cc['type'],
    ttl: typeof cc['ttl'] === 'string' ? cc['ttl'] : undefined,
  };
}

function normalizeTtl(cc: CacheControlObject): '1h' | '5m' {
  return cc.ttl === '1h' ? '1h' : '5m';
}

export function isCacheableAnthropicBlock(block: unknown): boolean {
  return isPlainRecord(block) && typeof block['type'] === 'string' && CACHEABLE_BLOCK_TYPES.has(block['type']);
}

export function anthropicBreakpointKey(messageIndex: number, blockIndex: number): string {
  return `${String(messageIndex)}:${String(blockIndex)}`;
}

export function digestAnthropicContentBlock(block: unknown): string {
  const hash = createHash('sha256');
  if (isPlainRecord(block)) {
    const { cache_control: _cc, ...rest } = block;
    void _cc;
    hash.update(JSON.stringify(rest));
  } else {
    hash.update(JSON.stringify(block));
  }
  return hash.digest('hex');
}

export interface AnthropicBreakpointSummary {
  readonly total: number;
  readonly serverFixedCount: number;
  readonly serverSawFiveMinute: boolean;
  readonly ttlOrderValid: boolean;
  readonly sawFiveMinute: boolean;
  readonly positions: readonly string[];
}

export function countAnthropicFixedBreakpoints(
  body: Readonly<Record<string, unknown>>,
): AnthropicBreakpointSummary {
  let total = 0;
  let serverFixedCount = 0;
  let serverSawFiveMinute = false;
  let sawFiveMinute = false;
  let ttlOrderValid = true;
  const positions: string[] = [];

  const recordControl = (cc: CacheControlObject | undefined, pos: string, isServerFixed: boolean): void => {
    if (cc === undefined) return;
    total += 1;
    if (isServerFixed) serverFixedCount += 1;
    positions.push(pos);
    const ttl = normalizeTtl(cc);
    if (ttl === '1h' && sawFiveMinute) {
      ttlOrderValid = false;
    } else if (ttl === '5m') {
      sawFiveMinute = true;
      if (isServerFixed) serverSawFiveMinute = true;
    }
  };

  const tools = body['tools'];
  if (Array.isArray(tools)) {
    for (let i = 0; i < tools.length; i += 1) {
      recordControl(readCacheControl(tools[i]), `tools[${String(i)}]`, true);
    }
  }

  const system = body['system'];
  if (Array.isArray(system)) {
    for (let i = 0; i < system.length; i += 1) {
      recordControl(readCacheControl(system[i]), `system[${String(i)}]`, true);
    }
  }

  recordControl(readCacheControl(body), 'top_level', false);

  return { total, serverFixedCount, serverSawFiveMinute, ttlOrderValid, sawFiveMinute, positions };
}

export function countAnthropicBodyBreakpoints(
  body: Readonly<Record<string, unknown>>,
  initialSawFiveMinute = false,
): AnthropicBreakpointSummary {
  let total = 0;
  let serverFixedCount = 0;
  let serverSawFiveMinute = initialSawFiveMinute;
  let sawFiveMinute = initialSawFiveMinute;
  let ttlOrderValid = true;
  const positions: string[] = [];

  const recordControl = (cc: CacheControlObject | undefined, pos: string, isServerFixed: boolean): void => {
    if (cc === undefined) return;
    total += 1;
    if (isServerFixed) serverFixedCount += 1;
    positions.push(pos);
    const ttl = normalizeTtl(cc);
    if (ttl === '1h' && sawFiveMinute) {
      ttlOrderValid = false;
    } else if (ttl === '5m') {
      sawFiveMinute = true;
      if (isServerFixed) serverSawFiveMinute = true;
    }
  };

  const tools = body['tools'];
  if (Array.isArray(tools)) {
    for (let i = 0; i < tools.length; i += 1) {
      recordControl(readCacheControl(tools[i]), `tools[${String(i)}]`, true);
    }
  }

  const system = body['system'];
  if (Array.isArray(system)) {
    for (let i = 0; i < system.length; i += 1) {
      recordControl(readCacheControl(system[i]), `system[${String(i)}]`, true);
    }
  }

  const messages = body['messages'];
  if (Array.isArray(messages)) {
    for (let m = 0; m < messages.length; m += 1) {
      const msg = messages[m];
      if (!isPlainRecord(msg) || !Array.isArray(msg['content'])) continue;
      const content = msg['content'] as readonly unknown[];
      for (let b = 0; b < content.length; b += 1) {
        recordControl(readCacheControl(content[b]), `messages[${String(m)}].content[${String(b)}]`, false);
      }
    }
  }

  recordControl(readCacheControl(body), 'top_level', false);

  return { total, serverFixedCount, serverSawFiveMinute, ttlOrderValid, sawFiveMinute, positions };
}

export interface PlannedAnthropicBreakpoints {
  readonly allowedKeys: ReadonlySet<string>;
  readonly applied: readonly AnthropicProvenBreakpoint[];
  readonly fixedCount: number;
  readonly serverFixedCount: number;
  readonly serverSawFiveMinute: boolean;
}

export function stripMessageCacheControls(messages: readonly MessageParam[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isPlainRecord(block) && 'cache_control' in block) {
        delete block['cache_control'];
      }
    }
  }
}

export function planAndApplyAnthropicMessageBreakpoints(
  body: Readonly<Record<string, unknown>>,
  messages: MessageParam[],
  provenBreakpoints?: readonly AnthropicProvenBreakpoint[],
): PlannedAnthropicBreakpoints {
  const fixed = countAnthropicFixedBreakpoints(body);
  if (fixed.total > ANTHROPIC_MAX_CACHE_BREAKPOINTS) {
    throw new ChatProviderError(
      `Anthropic cache_control breakpoints (${String(fixed.total)}) exceed the hard limit of ${String(ANTHROPIC_MAX_CACHE_BREAKPOINTS)}.`,
    );
  }
  if (!fixed.ttlOrderValid) {
    throw new ChatProviderError(
      'Anthropic cache_control TTL order is invalid: 1h breakpoints must precede 5m breakpoints.',
    );
  }

  stripMessageCacheControls(messages);

  const topLevel = readCacheControl(body);
  const topLevelRequiresOneHour = topLevel !== undefined && normalizeTtl(topLevel) === '1h';
  let remainingSlots = ANTHROPIC_MAX_CACHE_BREAKPOINTS - fixed.total;
  let sawFiveMinute = false;
  const tools = body['tools'];
  if (Array.isArray(tools)) {
    for (const item of tools) {
      const cc = readCacheControl(item);
      if (cc !== undefined && normalizeTtl(cc) === '5m') sawFiveMinute = true;
    }
  }
  const system = body['system'];
  if (Array.isArray(system)) {
    for (const item of system) {
      const cc = readCacheControl(item);
      if (cc !== undefined && normalizeTtl(cc) === '5m') sawFiveMinute = true;
    }
  }
  const allowedKeys = new Set<string>();
  const applied: AnthropicProvenBreakpoint[] = [];

  if (provenBreakpoints !== undefined && provenBreakpoints.length > 0) {
    for (const bp of provenBreakpoints) {
      if (remainingSlots <= 0) break;
      const msg = messages[bp.messageIndex];
      if (msg === undefined || msg.role !== bp.role || !Array.isArray(msg.content)) continue;
      const block = msg.content[bp.blockIndex] as CacheableContentBlock | undefined;
      if (block === undefined || !isCacheableAnthropicBlock(block)) continue;
      const digest = digestAnthropicContentBlock(block);
      if (digest !== bp.blockDigest) continue;
      const key = anthropicBreakpointKey(bp.messageIndex, bp.blockIndex);
      if (allowedKeys.has(key)) continue;
      const ttl: '1h' | '5m' = (bp.ttl === '1h' || topLevelRequiresOneHour) && !sawFiveMinute ? '1h' : '5m';
      block.cache_control = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
      if (ttl === '5m') sawFiveMinute = true;
      allowedKeys.add(key);
      applied.push({
        messageIndex: bp.messageIndex,
        blockIndex: bp.blockIndex,
        role: bp.role,
        blockDigest: digest,
        ttl,
      });
      remainingSlots -= 1;
    }
  }

  if (remainingSlots >= 1 && messages.length > 0) {
    const lastMessageIndex = messages.length - 1;
    const lastMessage = messages[lastMessageIndex];
    if (lastMessage !== undefined && Array.isArray(lastMessage.content) && lastMessage.content.length > 0) {
      const lastBlockIndex = lastMessage.content.length - 1;
      const lastBlock = lastMessage.content[lastBlockIndex] as CacheableContentBlock | undefined;
      const key = anthropicBreakpointKey(lastMessageIndex, lastBlockIndex);
      if (lastBlock !== undefined && !allowedKeys.has(key) && isCacheableAnthropicBlock(lastBlock)) {
        const ttl: '1h' | '5m' = topLevelRequiresOneHour && !sawFiveMinute ? '1h' : '5m';
        lastBlock.cache_control = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
        allowedKeys.add(key);
        applied.push({
          messageIndex: lastMessageIndex,
          blockIndex: lastBlockIndex,
          role: lastMessage.role,
          blockDigest: digestAnthropicContentBlock(lastBlock),
          ttl,
        });
      }
    }
  }

  return {
    allowedKeys,
    applied,
    fixedCount: fixed.total,
    serverFixedCount: fixed.serverFixedCount,
    serverSawFiveMinute: fixed.serverSawFiveMinute,
  };
}

export function assertAnthropicBreakpointsValid(
  body: Readonly<Record<string, unknown>>,
  extraServerFixedCount = 0,
  extraServerSawFiveMinute = false,
): void {
  const summary = countAnthropicBodyBreakpoints(body, extraServerSawFiveMinute);
  const total = summary.total + extraServerFixedCount;
  if (total > ANTHROPIC_MAX_CACHE_BREAKPOINTS) {
    throw new ChatProviderError(
      `Anthropic cache_control breakpoints (${String(total)}) exceed the hard limit of ${String(ANTHROPIC_MAX_CACHE_BREAKPOINTS)}.`,
    );
  }
  if (!summary.ttlOrderValid) {
    throw new ChatProviderError(
      'Anthropic cache_control TTL order is invalid: 1h breakpoints must precede 5m breakpoints.',
    );
  }
}
