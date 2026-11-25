import { createHash } from 'node:crypto';
import { normalize } from 'pathe';

import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import { FORKED_FROM_KEY, PROMOTED_FROM_KEY } from '#/session/sessionMetadata/sessionMetadata';

import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  CREATED_BY_SESSION_ID_KEY,
  PARENT_SESSION_ID_KEY,
  type SessionSummary,
} from './sessionIndex';

export const SESSION_GROUP_ID_KEY = 'kiki.group_id';
export const SESSION_GROUP_DETACHED_KEY = 'kiki.group_detached';
export const SESSION_GROUP_GENERATION_KEY = 'kiki.group_gen';
export const SESSION_GROUP_ORIGIN_KEY = 'kiki.group_origin';

export const RESERVED_SESSION_GROUP_KEYS = [
  SESSION_GROUP_ID_KEY,
  SESSION_GROUP_DETACHED_KEY,
  SESSION_GROUP_GENERATION_KEY,
  SESSION_GROUP_ORIGIN_KEY,
] as const;

export interface SessionGroupOrigin {
  readonly homeId: string;
  readonly hostId: string;
  readonly bridgeId?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionGroupId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\0]/.test(value);
}

export function isSessionGroupDetached(custom: Record<string, unknown> | undefined): boolean {
  return custom?.[SESSION_GROUP_DETACHED_KEY] === true;
}

export function parseSessionGroupGeneration(custom: Record<string, unknown> | undefined): number {
  const raw = custom?.[SESSION_GROUP_GENERATION_KEY];
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

export function explicitSessionGroupId(custom: Record<string, unknown> | undefined): string | undefined {
  if (isSessionGroupDetached(custom)) return undefined;
  const candidate = custom?.[SESSION_GROUP_ID_KEY];
  return isValidSessionGroupId(candidate) ? candidate : undefined;
}

export function parseSessionGroupOrigin(custom: Record<string, unknown> | undefined): SessionGroupOrigin | undefined {
  const raw = custom?.[SESSION_GROUP_ORIGIN_KEY];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const homeId = record['homeId'] ?? record['home_id'];
  const hostId = record['hostId'] ?? record['host_id'];
  const bridgeId = record['bridgeId'] ?? record['bridge_id'];
  if (typeof homeId !== 'string' || homeId.length === 0 || typeof hostId !== 'string' || hostId.length === 0) {
    return undefined;
  }
  return {
    homeId,
    hostId,
    ...(typeof bridgeId === 'string' && bridgeId.length > 0 ? { bridgeId } : {}),
  };
}

export function stripSessionGroupControls(custom: Record<string, unknown> | undefined): Record<string, unknown> {
  if (custom === undefined) return {};
  const next: Record<string, unknown> = { ...custom };
  for (const key of RESERVED_SESSION_GROUP_KEYS) delete next[key];
  return next;
}

export function preserveReservedSessionGroupKeys(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...incoming };
  for (const key of RESERVED_SESSION_GROUP_KEYS) {
    delete next[key];
    if (existing !== undefined && Object.hasOwn(existing, key) && existing[key] !== undefined) {
      next[key] = existing[key];
    }
  }
  return next;
}

export function deriveSessionGroupToken(
  originKey: string,
  openerSessionId: string,
  generation = 0,
): string {
  const digest = createHash('sha256')
    .update('kiki.session-group.v1\0')
    .update(originKey)
    .update('\0')
    .update(openerSessionId)
    .update('\0')
    .update(String(generation))
    .digest('base64url')
    .slice(0, 22);
  return `grp_${digest}`;
}

export async function resolveHomeGroupOrigin(
  homeDir: string,
  storage?: IFileSystemStorageService,
): Promise<string> {
  if (storage !== undefined) {
    try {
      const raw = await storage.read('server', 'home-id');
      const trimmed = raw === undefined ? undefined : Buffer.from(raw).toString('utf8').trim();
      if (trimmed !== undefined && UUID_PATTERN.test(trimmed)) return `home:${trimmed.toLowerCase()}`;
    } catch {}
  }
  const normalized = normalize(homeDir);
  const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  return `dir:${createHash('sha256').update(key).digest('base64url').slice(0, 22)}`;
}

function localBareSessionId(value: unknown, selfId: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value === selfId || value.includes(':')) return undefined;
  return value;
}

export function legacyLocalParentIdOf(summary: Pick<SessionSummary, 'id' | 'custom'>): string | undefined {
  const custom = summary.custom;
  if (custom === undefined) return undefined;
  const createdBy = localBareSessionId(custom[CREATED_BY_SESSION_ID_KEY], summary.id);
  if (createdBy !== undefined) return createdBy;
  if (custom[CHILD_SESSION_KIND_KEY] === CHILD_SESSION_KIND) {
    const parent = localBareSessionId(custom[PARENT_SESSION_ID_KEY], summary.id);
    if (parent !== undefined) return parent;
  }
  const promoted = custom[PROMOTED_FROM_KEY];
  if (promoted !== null && typeof promoted === 'object' && !Array.isArray(promoted)) {
    const promotedParent = localBareSessionId((promoted as Record<string, unknown>)['sessionId'], summary.id);
    if (promotedParent !== undefined) return promotedParent;
  }
  const forked = custom[FORKED_FROM_KEY];
  if (forked !== null && typeof forked === 'object' && !Array.isArray(forked)) {
    const forkedParent = localBareSessionId((forked as Record<string, unknown>)['sessionId'], summary.id);
    if (forkedParent !== undefined) return forkedParent;
  }
  return undefined;
}

function compareDeterministicMember(
  a: Pick<SessionSummary, 'createdAt' | 'id'>,
  b: Pick<SessionSummary, 'createdAt' | 'id'>,
): number {
  const aCreated = a.createdAt > 0 ? a.createdAt : Number.MAX_SAFE_INTEGER;
  const bCreated = b.createdAt > 0 ? b.createdAt : Number.MAX_SAFE_INTEGER;
  if (aCreated !== bCreated) return aCreated - bCreated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function selectGroupOpener<T extends Pick<SessionSummary, 'id' | 'createdAt' | 'custom'>>(
  members: readonly T[],
): T {
  const memberIds = new Set(members.map((member) => member.id));
  const roots = members.filter((member) => {
    const parent = legacyLocalParentIdOf(member);
    return parent === undefined || !memberIds.has(parent);
  });
  const pool = roots.length > 0 ? roots : members;
  let best = pool[0]!;
  for (let index = 1; index < pool.length; index += 1) {
    const candidate = pool[index]!;
    if (compareDeterministicMember(candidate, best) < 0) best = candidate;
  }
  return best;
}

export function resolveSessionGroupProjection(
  summaries: readonly SessionSummary[],
  originKey: string,
): SessionSummary[] {
  if (summaries.length === 0) return [];
  const byId = new Map<string, SessionSummary>();
  for (const summary of summaries) byId.set(summary.id, summary);

  const parentOf = new Map<string, string>();
  const explicitOf = new Map<string, string | undefined>();
  for (const summary of summaries) {
    parentOf.set(summary.id, summary.id);
    explicitOf.set(summary.id, explicitSessionGroupId(summary.custom));
  }

  const find = (id: string): string => {
    let root = id;
    while (parentOf.get(root) !== root) root = parentOf.get(root)!;
    let current = id;
    while (current !== root) {
      const next = parentOf.get(current)!;
      parentOf.set(current, root);
      current = next;
    }
    return root;
  };

  const tryUnion = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const tagA = explicitOf.get(ra);
    const tagB = explicitOf.get(rb);
    if (tagA !== undefined && tagB !== undefined && tagA !== tagB) return;
    const winner = ra < rb ? ra : rb;
    const loser = winner === ra ? rb : ra;
    parentOf.set(loser, winner);
    explicitOf.set(winner, tagA ?? tagB);
  };

  const ordered = [...summaries].sort(compareDeterministicMember);
  for (const child of ordered) {
    if (isSessionGroupDetached(child.custom)) continue;
    if (parseSessionGroupGeneration(child.custom) > 0) continue;
    const parentId = legacyLocalParentIdOf(child);
    if (parentId === undefined) continue;
    const parent = byId.get(parentId);
    if (parent === undefined) continue;
    const childExplicit = explicitSessionGroupId(child.custom);
    const parentExplicit = explicitSessionGroupId(parent.custom);
    const parentPostDetach =
      isSessionGroupDetached(parent.custom) || parseSessionGroupGeneration(parent.custom) > 0;
    if (parentPostDetach) {
      if (childExplicit === undefined) {
        const root = find(child.id);
        if (explicitOf.get(root) === undefined) {
          const seenAncestors = new Set<string>([child.id]);
          let ancestor = parent;
          while (!seenAncestors.has(ancestor.id)) {
            seenAncestors.add(ancestor.id);
            const nextParentId = legacyLocalParentIdOf(ancestor);
            if (nextParentId === undefined) break;
            const nextAncestor = byId.get(nextParentId);
            if (nextAncestor === undefined) break;
            ancestor = nextAncestor;
          }
          const ancestorExplicit =
            parseSessionGroupGeneration(ancestor.custom) === 0
              ? explicitSessionGroupId(ancestor.custom)
              : undefined;
          explicitOf.set(root, ancestorExplicit ?? deriveSessionGroupToken(originKey, ancestor.id, 0));
        }
      }
      continue;
    }
    if (childExplicit === undefined) {
      tryUnion(child.id, parent.id);
    } else if (parentExplicit === undefined) {
      tryUnion(child.id, parent.id);
    }
  }

  const components = new Map<string, SessionSummary[]>();
  for (const summary of summaries) {
    const root = find(summary.id);
    let bucket = components.get(root);
    if (bucket === undefined) {
      bucket = [];
      components.set(root, bucket);
    }
    bucket.push(summary);
  }

  const resolvedGroupById = new Map<string, string | undefined>();
  for (const [root, members] of components) {
    const explicitTag = explicitOf.get(root);
    if (explicitTag !== undefined) {
      for (const member of members) {
        resolvedGroupById.set(member.id, isSessionGroupDetached(member.custom) ? undefined : explicitTag);
      }
    } else if (members.length >= 2) {
      const opener = selectGroupOpener(members);
      const token = deriveSessionGroupToken(originKey, opener.id, 0);
      for (const member of members) resolvedGroupById.set(member.id, token);
    } else {
      resolvedGroupById.set(members[0]!.id, undefined);
    }
  }

  return summaries.map((summary) => {
    const nextGroupId = resolvedGroupById.get(summary.id);
    const nextDetached = isSessionGroupDetached(summary.custom) ? true : undefined;
    if (summary.groupId === nextGroupId && summary.groupDetached === nextDetached) return summary;
    return {
      ...summary,
      groupId: nextGroupId,
      groupDetached: nextDetached,
    };
  });
}
