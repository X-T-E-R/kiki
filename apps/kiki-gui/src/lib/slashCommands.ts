/**
 * Slash-command model for the composer.
 *
 * Two entry kinds, both honest about what backs them:
 *   - `skill` — a real entry from `GET /sessions/{id}/skills`; submitting one
 *     calls `POST …/skills/{name}:activate` (never an invented text command).
 *   - `action` — a client-side shortcut that maps to a real GUI action
 *     (toggle plan mode, open the goal popover, fork/undo/compact, /new).
 *
 * A draft that starts with `/` but matches no entry is sent as plain prompt
 * text — the server never sees an invented command.
 */

import type { SkillDescriptor } from '@moonshot-ai/protocol';

export type SlashActionId = 'plan' | 'goal' | 'new' | 'fork' | 'undo' | 'compact';

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
  { id: 'fork', name: 'fork', description: 'Fork this session into a copy', needsSession: true },
  { id: 'undo', name: 'undo', description: 'Undo the last turn', needsSession: true },
  { id: 'compact', name: 'compact', description: 'Compact older context into a summary', needsSession: true },
];

/** `reference`-type skills exist for the model, not for users (server 40912). */
export function isSkillActivatable(skill: SkillDescriptor): boolean {
  return skill.type !== 'reference';
}

export function buildSlashItems(
  skills: readonly SkillDescriptor[],
  options: { hasSession: boolean },
): SlashItem[] {
  const skillItems: SlashItem[] = skills.map((skill) => ({
    kind: 'skill',
    name: skill.name,
    description: skill.description,
    disabled: !isSkillActivatable(skill),
    skill,
  }));
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

/** Exact command resolution for submit-time: `/name args…` → the item. */
export function resolveSlashCommand(
  items: readonly SlashItem[],
  text: string,
): { item: SlashItem; args: string } | null {
  const parsed = parseSlashDraft(text);
  if (parsed === null || parsed.query === '') return null;
  const name = parsed.query.toLowerCase();
  const item = items.find((candidate) => candidate.name.toLowerCase() === name);
  if (item === undefined || item.disabled === true) return null;
  return { item, args: parsed.args };
}
