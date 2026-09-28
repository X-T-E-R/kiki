import type { AutoCompactWrite } from '@kiki/protocol';

import type { SlashCommandHost } from './dispatch';

const USAGE = 'Usage: /autocompact [<tokens>|<k>|<m>|<percent>%|default] [--save model|profile|global]';

export function parseAutoCompactArgs(args: string, usableTokens: number): AutoCompactWrite | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  const save = words[1] === '--save' && words.length === 3 &&
    (words[2] === 'model' || words[2] === 'profile' || words[2] === 'global')
    ? words[2] : undefined;
  if (words.length !== 1 && (words.length !== 3 || save === undefined)) throw new Error(USAGE);
  if (words[0]?.toLowerCase() === 'default') {
    if (save !== undefined) throw new Error('Resetting to default cannot be combined with --save.');
    return { tokens: null };
  }
  const match = /^(\d+(?:\.\d+)?)(k|m|%)?$/i.exec(words[0] ?? '');
  if (match === null) throw new Error(USAGE);
  const amount = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  if (suffix === undefined && !Number.isSafeInteger(amount)) throw new Error('An absolute token count must be an integer.');
  if (suffix === '%' && (amount > 100 || usableTokens <= 0)) throw new Error('A percentage must be between 0 and 100 and the model must have a usable context window.');
  const tokens = Math.round(amount * (suffix === '%' ? usableTokens / 100 : suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1));
  if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new Error('Automatic compaction requires a positive absolute token count.');
  return { tokens, ...(save === undefined ? {} : { save }) };
}

export async function handleAutoCompactCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError('No active session');
    return;
  }
  const current = await session.getAutoCompact();
  const input = parseAutoCompactArgs(args, current.effectiveMaxContextTokens);
  if (input === undefined) {
    host.showNotice('Automatic compaction', `${current.tokens.toLocaleString()} tokens (${current.source}); usable ${current.effectiveMaxContextTokens.toLocaleString()}, reserved ${current.reservedContextTokens.toLocaleString()}`);
    return;
  }
  const result = await session.setAutoCompact(input);
  const saved = result.savedAs === undefined ? '' : `; saved ${input.save}: ${String(result.savedAs)}`;
  host.showNotice('Automatic compaction', `${result.effective.tokens.toLocaleString()} tokens (${result.effective.source})${saved}`);
}
