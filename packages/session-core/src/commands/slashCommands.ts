/**
 * Slash-command model for the composer.
 *
 * Two entry kinds, both honest about what backs them:
 *   - `skill` — a real catalog entry (`GET /sessions/{id}/skills` on a live
 *     session, `GET /workspaces/{id}/skills` on /new); submitting one calls
 *     `POST …/skills/{name}:activate` once a session exists.
 *   - `action` — a client-side shortcut that maps to a real GUI action
 *     (toggle plan mode, open the goal popover, a /btw side question,
 *     fork/undo/compact, /new).
 *
 * A draft that starts with `/` but matches no entry is still just text — the
 * server never sees an invented command. The composer intercepts such sends
 * (`classifySlashSubmission`) so a typo asks before shipping as prompt text.
 */

import type { SkillDescriptor } from '@kiki/protocol';

import { isAppRouteLink } from '../composer/threadRefs';

export type SlashActionId = 'plan' | 'goal' | 'new' | 'btw' | 'fork' | 'undo' | 'compact';

export interface SlashItem {
  kind: 'skill' | 'action';
  /** Command name without the leading slash (`review`, `plan`). */
  name: string;
  description: string;
  /** Skills only: `reference`-type skills are not user-activatable (40912). */
  disabled?: boolean;
  /** Skills only: the catalog descriptor, for badges and hints. */
  skill?: SkillDescriptor;
  /** Actions only: the shortcut id. */
  action?: SlashActionId;
}

interface SlashActionSpec {
  id: SlashActionId;
  name: string;
  description: string;
  /** Session actions make no sense on the /new draft page. */
  needsSession: boolean;
}

/** Client shortcuts — every one maps to a real, shipped GUI action. */
const SLASH_ACTIONS: readonly SlashActionSpec[] = [
  { id: 'plan', name: 'plan', description: 'Toggle plan mode for the next prompt', needsSession: false },
  { id: 'goal', name: 'goal', description: 'Set the goal objective', needsSession: false },
  { id: 'new', name: 'new', description: 'Start a new session', needsSession: false },
  { id: 'btw', name: 'btw', description: 'Ask a side question without interrupting this session', needsSession: true },
  { id: 'fork', name: 'fork', description: 'Fork this session into a copy', needsSession: true },
  { id: 'undo', name: 'undo', description: 'Undo the last turn', needsSession: true },
  { id: 'compact', name: 'compact', description: 'Compact older context into a summary', needsSession: true },
];

/** `reference`-type skills exist for the model, not for users (server 40912). */
export function isSkillActivatable(skill: SkillDescriptor): boolean {
  return skill.type !== 'reference';
}

export function buildSkillSlashItems(
  skills: readonly SkillDescriptor[],
  reservedNames: readonly string[],
): SlashItem[] {
  const reserved = new Set(reservedNames.map((name) => name.toLowerCase()));
  const occupied = new Set([...reserved, ...skills.map((skill) => skill.name.toLowerCase())]);
  return skills.map((skill) => {
    let name = skill.name;
    if (reserved.has(name.toLowerCase())) {
      do { name = `skill:${name}`; } while (occupied.has(name.toLowerCase()));
      occupied.add(name.toLowerCase());
    }
    return {
      kind: 'skill',
      name,
      description: skill.description,
      disabled: !isSkillActivatable(skill),
      skill,
    };
  });
}

export function buildSlashItems(
  skills: readonly SkillDescriptor[],
  options: { hasSession: boolean },
): SlashItem[] {
  const skillItems = buildSkillSlashItems(skills, SLASH_ACTIONS.map((spec) => spec.name));
  const actionItems: SlashItem[] = SLASH_ACTIONS.filter(
    (spec) => !spec.needsSession || options.hasSession,
  ).map((spec) => ({
    kind: 'action',
    name: spec.name,
    description: spec.description,
    action: spec.id,
  }));
  // Skills first (the point of the endpoint), shortcuts after.
  return [...skillItems, ...actionItems];
}

/**
 * The slash draft grammar: `/query` while the command name is being typed
 * (menu filters), then `/name args…` once a space separates them.
 * Returns null when the draft is not a slash draft at all.
 */
export function parseSlashDraft(text: string): { query: string; args: string } | null {
  if (!text.startsWith('/')) return null;
  const body = text.slice(1);
  const gap = body.search(/\s/);
  if (gap === -1) return { query: body, args: '' };
  return { query: body.slice(0, gap), args: body.slice(gap + 1).trim() };
}

export interface SlashTrigger {
  /** Slash token bounds in the full composer text (`end` is exclusive). */
  readonly start: number;
  readonly end: number;
  /** Token text between `/` and the caret. */
  readonly query: string;
  /** True for whitespace-delimited tokens away from message offset zero. */
  readonly inline: boolean;
}

/**
 * Find the slash token under the caret. Leading `/command` keeps the existing
 * command menu; a `/token` after whitespace (including a later line) is an
 * inline skill trigger. Paths/URLs are excluded because their token does not
 * begin with `/`, and a second slash invalidates the token.
 */
export function parseSlashTrigger(text: string, cursor: number): SlashTrigger | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) return null;
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1] ?? '')) start -= 1;
  if (text[start] !== '/') return null;

  let end = cursor;
  while (end < text.length && !/\s/.test(text[end] ?? '')) end += 1;
  const token = text.slice(start + 1, end);
  const query = text.slice(start + 1, cursor);
  if (token.includes('/') || query.includes('/')) return null;
  return { start, end, query, inline: start > 0 };
}

/** Replace only the active slash token, preserving prose before and after it. */
export function completeSlashTrigger(
  text: string,
  trigger: Pick<SlashTrigger, 'start' | 'end'>,
  name: string,
): { text: string; cursor: number } {
  const before = text.slice(0, trigger.start);
  const after = text.slice(trigger.end);
  const separator = after === '' || !/^\s/.test(after) ? ' ' : '';
  const replacement = `/${name}${separator}`;
  return {
    text: before + replacement + after,
    cursor: before.length + replacement.length,
  };
}

/** Case-insensitive filter: prefix matches rank above substring matches. */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...items];
  const scored: { item: SlashItem; rank: number }[] = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    if (name.startsWith(q)) scored.push({ item, rank: 0 });
    else if (name.includes(q)) scored.push({ item, rank: 1 });
    else if (item.description.toLowerCase().includes(q)) scored.push({ item, rank: 2 });
  }
  return scored
    .toSorted((a, b) => a.rank - b.rank)
    .map((entry) => entry.item);
}

/**
 * Submit-time classification of a slash-looking draft: a runnable entry, an
 * unknown name (typo — currently degrades to plain prompt text), or a known
 * but disabled entry (`reference` skills are model-only). The composer uses
 * the two failure kinds to intercept the send and ask before a typo ships to
 * the model as prompt text.
 */
export type SlashSubmission =
  | { kind: 'resolved'; item: SlashItem; args: string }
  | { kind: 'unknown'; name: string; args: string }
  | { kind: 'disabled'; item: SlashItem; args: string };

export function classifySlashSubmission(
  items: readonly SlashItem[],
  text: string,
): SlashSubmission | null {
  const parsed = parseSlashDraft(text);
  if (parsed === null || parsed.query === '' || parsed.query.includes('/')) return null;
  // A pasted GUI route (`/s/<session>`, `/settings/…`) is a link, not a
  // command name: it goes out as prompt text without the typo guard.
  if (isAppRouteLink(`/${parsed.query}`)) return null;
  const name = parsed.query.toLowerCase();
  const item = items.find((candidate) => candidate.name.toLowerCase() === name);
  if (item === undefined) return { kind: 'unknown', name: parsed.query, args: parsed.args };
  if (item.disabled === true) return { kind: 'disabled', item, args: parsed.args };
  return { kind: 'resolved', item, args: parsed.args };
}

/** Exact command resolution for submit-time: `/name args…` → the item. */
export function resolveSlashCommand(
  items: readonly SlashItem[],
  text: string,
): { item: SlashItem; args: string } | null {
  const classified = classifySlashSubmission(items, text);
  return classified !== null && classified.kind === 'resolved'
    ? { item: classified.item, args: classified.args }
    : null;
}

export interface InlineSkillToken {
  readonly commandName: string;
  readonly start: number;
  readonly end: number;
}

export interface FindInlineSkillTokensOptions {
  /** Decide whether a syntactically valid token names a known skill. */
  readonly isKnownSkill: (commandName: string) => boolean;
  /** Include tokens with an empty command name (a bare trailing `/`). */
  readonly allowEmpty?: boolean;
  /** Also treat a `/` at the very start of the input as a token. */
  readonly includeLeading?: boolean;
}

const INLINE_WHITESPACE = /\s/;

/**
 * Scan whitespace-delimited `/token` spans in `text` (with no internal `/` and
 * excluding GUI route links like `/s/…`). The leading slash-command area at
 * offset 0 is skipped unless `includeLeading` is true.
 */
export function findInlineSkillTokens(
  text: string,
  options: FindInlineSkillTokensOptions,
): InlineSkillToken[] {
  const tokens: InlineSkillToken[] = [];

  let searchStart = 0;
  if (text.startsWith('/') && options.includeLeading !== true) {
    const firstWhitespace = text.search(INLINE_WHITESPACE);
    searchStart = firstWhitespace === -1 ? text.length : firstWhitespace + 1;
  }

  for (let i = searchStart; i < text.length; i++) {
    if (text[i] !== '/') continue;

    const isLeadingSlash = i === 0 && options.includeLeading === true;
    const charBefore = i > 0 ? text[i - 1] : undefined;
    if (!isLeadingSlash && (charBefore === undefined || !INLINE_WHITESPACE.test(charBefore))) continue;

    let end = i + 1;
    while (end < text.length && !INLINE_WHITESPACE.test(text[end] ?? '')) {
      end++;
    }

    const commandName = text.slice(i + 1, end);
    if (commandName.includes('/')) continue;
    if (commandName.length === 0 && options.allowEmpty !== true) continue;
    if (commandName.length > 0 && isAppRouteLink(`/${commandName}`)) continue;
    if (!options.isKnownSkill(commandName)) continue;

    tokens.push({ commandName, start: i, end });
  }

  return tokens;
}

/**
 * True when `text` contains at least one syntactically valid inline `/token`
 * candidate away from offset 0 (used to hold submission while the skill catalog
 * is still loading on a cold start).
 */
export function hasInlineSlashCandidate(text: string): boolean {
  return findInlineSkillTokens(text, { isKnownSkill: () => true }).length > 0;
}

export interface InlineSkillActivationMatch {
  readonly item: SlashItem;
  readonly skillName: string;
  readonly commandName: string;
  readonly start: number;
  readonly end: number;
}

export interface ExtractSlashSkillActivationsOptions {
  readonly includeLeading?: boolean;
  /** Exclude a token still actively being typed at `activeCursor`. */
  readonly activeCursor?: number;
}

function buildActivatableSkillLookup(items: readonly SlashItem[]): Map<string, SlashItem> {
  const map = new Map<string, SlashItem>();
  for (const item of items) {
    if (item.kind !== 'skill' || item.disabled === true) continue;
    const key = item.name.toLowerCase();
    if (!map.has(key)) map.set(key, item);
    if (item.skill !== undefined) {
      const rawKey = item.skill.name.toLowerCase();
      if (!map.has(`skill:${rawKey}`)) map.set(`skill:${rawKey}`, item);
    }
  }
  return map;
}

function resolveInlineSlashSkillItem(
  lookup: ReadonlyMap<string, SlashItem>,
  commandName: string,
  isLeading: boolean,
): SlashItem | undefined {
  const lower = commandName.toLowerCase();
  const direct = lookup.get(lower);
  if (direct !== undefined) return direct;
  // At offset 0, bare reserved action names (`/plan`, `/new`) belong to client
  // shortcuts unless prefixed with `/skill:`. Inline tokens have no client
  // shortcut ambiguity, so `/plan` inline can fall back to `skill:plan`.
  return isLeading ? undefined : lookup.get(`skill:${lower}`);
}

/**
 * Resolve every activatable skill `/token` in `text` against `buildSlashItems`
 * entries. Returns all matched token occurrences in document order alongside
 * deduplicated activations in first-occurrence order.
 */
export function extractSlashSkillTokens(
  items: readonly SlashItem[],
  text: string,
  options?: ExtractSlashSkillActivationsOptions,
): {
  readonly occurrences: readonly InlineSkillActivationMatch[];
  readonly activations: readonly InlineSkillActivationMatch[];
} {
  const lookup = buildActivatableSkillLookup(items);
  if (lookup.size === 0) return { occurrences: [], activations: [] };
  const rawTokens = findInlineSkillTokens(text, {
    includeLeading: options?.includeLeading,
    isKnownSkill: (commandName) => {
      const lower = commandName.toLowerCase();
      return lookup.has(lower) || lookup.has(`skill:${lower}`);
    },
  });
  const occurrences: InlineSkillActivationMatch[] = [];
  const activations: InlineSkillActivationMatch[] = [];
  const seen = new Set<string>();
  for (const token of rawTokens) {
    if (
      options?.activeCursor !== undefined &&
      options.activeCursor >= token.start &&
      options.activeCursor <= token.end
    ) {
      continue;
    }
    const item = resolveInlineSlashSkillItem(lookup, token.commandName, token.start === 0);
    if (item === undefined) continue;
    const skillName = item.skill?.name ?? item.name;
    const match: InlineSkillActivationMatch = {
      item,
      skillName,
      commandName: token.commandName,
      start: token.start,
      end: token.end,
    };
    occurrences.push(match);
    const dedupeKey = skillName.toLowerCase();
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      activations.push(match);
    }
  }
  return { occurrences, activations };
}

/** Remove one `/skill` token span from `text`, collapsing one adjacent space cleanly. */
export function removeSkillToken(
  text: string,
  token: { readonly start: number; readonly end: number },
): { text: string; cursor: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  if (before === '') {
    const trimmedAfter = after.replace(/^[ \t]+/, '');
    return { text: trimmedAfter, cursor: 0 };
  }
  if (/[ \t]$/.test(before) && /^[ \t]/.test(after)) {
    return { text: before + after.replace(/^[ \t]+/, ''), cursor: before.length };
  }
  if (after === '' && /[ \t]$/.test(before)) {
    const trimmedBefore = before.replace(/[ \t]+$/, '');
    return { text: trimmedBefore, cursor: trimmedBefore.length };
  }
  return { text: before + after, cursor: before.length };
}
