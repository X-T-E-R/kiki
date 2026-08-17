/**
 * Pure agent-tree / transcript-merge / history-cursor helpers for the GUI.
 * Callers (UI, controller) stay outside this module; nothing here mutates
 * inputs or depends on a not-yet-landed wire candidate.
 */

export const MAIN_AGENT_ID = 'main';

/**
 * `running | suspended | completed | failed` match `SubagentBlock.status`.
 * `cancelled` and `background` are roster/task adapter extensions.
 */
export type AgentStatus =
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'background';

/**
 * Live session-view card. Structurally compatible with `SubagentBlock`
 * (same status union plus optional adapter fields). `parentAgentId` lets a
 * live-only source seed the parent link without a roster.
 */
export interface AgentLiveSource {
  readonly subagentId: string;
  readonly parentAgentId?: string;
  readonly parentToolCallId?: string;
  readonly name: string;
  readonly label?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly status: string;
  readonly summary?: string;
  readonly error?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly toolCallCount?: number;
}

/**
 * REST roster descriptor. Minimal camelCase shape that a future wire adapter
 * can populate; `parentAgentId` is the authority for parent links.
 */
export interface AgentRosterDescriptor {
  readonly agentId: string;
  readonly parentAgentId?: string;
  readonly parentToolCallId?: string;
  readonly name?: string;
  readonly label?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly status?: string;
  readonly busy?: boolean;
  readonly toolCallCount?: number;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly summary?: string;
  readonly error?: string;
}

/**
 * Task-list fallback (protocol `Task`, `AgentTaskInfo`, or a thin adapter).
 * Accepts both camelCase and the REST snake_case fields already on `Task`.
 */
export interface AgentTaskItem {
  readonly id?: string;
  readonly agentId?: string;
  readonly kind?: string;
  readonly description?: string;
  readonly name?: string;
  readonly status?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly thinking_effort?: string;
  readonly startedAt?: string;
  readonly started_at?: string;
  readonly endedAt?: string;
  readonly completed_at?: string;
  readonly summary?: string;
  readonly output_preview?: string;
  readonly parentAgentId?: string;
  readonly parent_agent_id?: string;
  readonly parentToolCallId?: string;
  readonly parent_tool_call_id?: string;
  readonly detached?: boolean;
}

export interface AgentTreeNode {
  readonly agentId: string;
  readonly parentAgentId?: string;
  readonly parentToolCallId?: string;
  readonly name: string;
  readonly label: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly status: AgentStatus;
  readonly busy: boolean;
  readonly toolCallCount: number;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly childIds: readonly string[];
}

export interface AgentForest {
  readonly roots: readonly AgentTreeNode[];
  readonly byId: Readonly<Record<string, AgentTreeNode>>;
}

export interface AgentTimelineBlock {
  readonly id: string;
  readonly kind: string;
  readonly turnId?: string;
  readonly streaming?: boolean;
  readonly status?: string;
  readonly text?: string;
  readonly agentRefs?: unknown;
}

export interface AgentTranscriptPage {
  readonly blocks: readonly AgentTimelineBlock[];
  readonly hasMore: boolean;
  readonly oldestTurnId?: string;
  readonly seq?: number;
  readonly busy?: boolean;
  readonly toolCallCount?: number;
}

export interface AgentLiveTranscript {
  readonly blocks: readonly AgentTimelineBlock[];
  readonly busy?: boolean;
  readonly toolCallCount?: number;
}

export interface AgentTranscriptFallback {
  readonly blocks?: readonly AgentTimelineBlock[];
  readonly busy?: boolean;
  readonly toolCallCount?: number;
}

export type AgentLiveTranscriptInput = readonly AgentTimelineBlock[] | AgentLiveTranscript;

export interface MergedAgentTranscript {
  readonly blocks: readonly AgentTimelineBlock[];
  readonly hasMore: boolean;
  readonly oldestTurnId?: string;
  readonly seq?: number;
  readonly busy: boolean;
  readonly toolCallCount: number;
}

export interface AgentHistoryCursor {
  readonly hasMore: boolean;
  readonly oldestTurnId?: string;
  readonly seq?: number;
}

interface DraftNode {
  agentId: string;
  parentAgentId: string | undefined;
  rosterParentAgentId: string | undefined;
  parentToolCallId: string | undefined;
  name: string | undefined;
  label: string | undefined;
  model: string | undefined;
  thinkingEffort: string | undefined;
  status: AgentStatus | undefined;
  busy: boolean | undefined;
  toolCallCount: number;
  startedAt: string | undefined;
  endedAt: string | undefined;
  summary: string | undefined;
  error: string | undefined;
}

export function compareAgentIds(a: string, b: string): number {
  if (a === b) return 0;
  if (a === MAIN_AGENT_ID) return -1;
  if (b === MAIN_AGENT_ID) return 1;
  const na = /^agent-(\d+)$/.exec(a);
  const nb = /^agent-(\d+)$/.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]);
  if (na) return -1;
  if (nb) return 1;
  return a < b ? -1 : 1;
}

function createById(): Record<string, AgentTreeNode> {
  return Object.create(null) as Record<string, AgentTreeNode>;
}

function emptyForest(): AgentForest {
  return {
    roots: Object.freeze([]),
    byId: Object.freeze(createById()),
  };
}

/**
 * Content-level forest equality for identity stabilization: consumers that
 * rebuild the forest on every publish (SessionView's useMemo over the whole
 * session state) can keep returning the PREVIOUS forest object while nothing
 * material changed, so memoized transcript rows keyed on `forest` identity
 * are not broken by unrelated streaming deltas.
 */
export function agentTreeNodesEqual(a: AgentTreeNode, b: AgentTreeNode): boolean {
  if (a === b) return true;
  return (
    a.agentId === b.agentId &&
    a.parentAgentId === b.parentAgentId &&
    a.parentToolCallId === b.parentToolCallId &&
    a.name === b.name &&
    a.label === b.label &&
    a.model === b.model &&
    a.thinkingEffort === b.thinkingEffort &&
    a.status === b.status &&
    a.busy === b.busy &&
    a.toolCallCount === b.toolCallCount &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.summary === b.summary &&
    a.error === b.error &&
    a.childIds.length === b.childIds.length &&
    a.childIds.every((id, index) => id === b.childIds[index])
  );
}

export function agentForestsEqual(a: AgentForest, b: AgentForest): boolean {
  if (a === b) return true;
  if (a.roots.length !== b.roots.length) return false;
  const aIds = Object.keys(a.byId);
  const bIds = Object.keys(b.byId);
  if (aIds.length !== bIds.length) return false;
  for (const id of aIds) {
    const aNode = a.byId[id];
    const bNode = b.byId[id];
    if (aNode === undefined || bNode === undefined || !agentTreeNodesEqual(aNode, bNode)) {
      return false;
    }
  }
  return a.roots.every((root, index) => root.agentId === b.roots[index]?.agentId);
}

export function buildAgentForest(
  subagentBlocks: readonly AgentLiveSource[],
  roster?: readonly AgentRosterDescriptor[],
  taskItems?: readonly AgentTaskItem[],
): AgentForest {
  const drafts = new Map<string, DraftNode>();

  for (const task of taskItems ?? []) {
    const agentId = taskAgentId(task);
    if (agentId === undefined) continue;
    const draft = ensureDraft(drafts, agentId);
    applyTaskFallback(draft, task);
  }

  for (const entry of roster ?? []) {
    if (!present(entry.agentId)) continue;
    const draft = ensureDraft(drafts, entry.agentId);
    applyRoster(draft, entry);
  }

  for (const block of subagentBlocks) {
    if (!present(block.subagentId)) continue;
    const draft = ensureDraft(drafts, block.subagentId);
    applyLiveBlock(draft, block);
  }

  if (drafts.size === 0) return emptyForest();

  for (const draft of drafts.values()) {
    const hintedParent = draft.rosterParentAgentId ?? draft.parentAgentId;
    if (hintedParent === MAIN_AGENT_ID && !drafts.has(MAIN_AGENT_ID)) {
      ensureDraft(drafts, MAIN_AGENT_ID);
    }
  }

  const parentOf = new Map<string, string | undefined>();
  for (const draft of drafts.values()) {
    parentOf.set(draft.agentId, resolveParent(draft, drafts));
  }
  breakCycles(parentOf);

  const childIds = new Map<string, string[]>();
  for (const agentId of drafts.keys()) childIds.set(agentId, []);
  const rootIds: string[] = [];
  for (const [agentId, parentId] of parentOf) {
    if (parentId === undefined) {
      rootIds.push(agentId);
      continue;
    }
    childIds.get(parentId)!.push(agentId);
  }

  for (const children of childIds.values()) children.sort(compareAgentIds);
  rootIds.sort(compareAgentIds);

  if (drafts.has(MAIN_AGENT_ID) && !parentOf.get(MAIN_AGENT_ID)) {
    const synthetic = drafts.get(MAIN_AGENT_ID)!;
    if (synthetic.status === undefined) {
      const kids = childIds.get(MAIN_AGENT_ID) ?? [];
      synthetic.status = kids.some((id) => {
        const child = drafts.get(id);
        return child !== undefined && isActiveStatus(child.status ?? 'completed');
      })
        ? 'running'
        : 'completed';
    }
  }

  const byId = createById();
  for (const draft of drafts.values()) {
    const parentAgentId = parentOf.get(draft.agentId);
    const name = present(draft.name) ? draft.name : draft.agentId;
    const status = draft.status ?? (draft.endedAt !== undefined ? 'completed' : 'running');
    const node: AgentTreeNode = {
      agentId: draft.agentId,
      parentAgentId,
      parentToolCallId: draft.parentToolCallId,
      name,
      label: present(draft.label) ? draft.label : name,
      model: draft.model,
      thinkingEffort: draft.thinkingEffort,
      status,
      busy: busyFromStatus(status, draft.busy),
      toolCallCount: draft.toolCallCount,
      startedAt: draft.startedAt,
      endedAt: draft.endedAt,
      summary: draft.summary,
      error: draft.error,
      childIds: childIds.get(draft.agentId) ?? [],
    };
    byId[draft.agentId] = node;
  }

  return {
    roots: rootIds.map((id) => byId[id]!),
    byId,
  };
}

export function agentPath(forest: AgentForest, agentId: string): readonly AgentTreeNode[] {
  const start = forest.byId[agentId];
  if (start === undefined) return [];
  const upward: AgentTreeNode[] = [];
  const seen = new Set<string>();
  let current: AgentTreeNode | undefined = start;
  while (current !== undefined) {
    if (seen.has(current.agentId)) break;
    seen.add(current.agentId);
    upward.push(current);
    const parentId: string | undefined = current.parentAgentId;
    current = parentId === undefined ? undefined : forest.byId[parentId];
  }
  return upward.reverse();
}

export function agentChildren(forest: AgentForest, agentId: string): readonly AgentTreeNode[] {
  const node = forest.byId[agentId];
  if (node === undefined) return [];
  return node.childIds.flatMap((id) => {
    const child = forest.byId[id];
    return child === undefined ? [] : [child];
  });
}

export function agentSiblings(forest: AgentForest, agentId: string): readonly AgentTreeNode[] {
  const node = forest.byId[agentId];
  if (node === undefined) return [];
  if (node.parentAgentId === undefined) {
    return forest.roots.filter((root) => root.agentId !== agentId);
  }
  return agentChildren(forest, node.parentAgentId).filter((sibling) => sibling.agentId !== agentId);
}

export function mergeAgentTranscript(
  serverPage: AgentTranscriptPage,
  liveBlocks: AgentLiveTranscriptInput = [],
  fallbackCaptured?: AgentTranscriptFallback,
): MergedAgentTranscript {
  const live = normalizeLiveInput(liveBlocks);
  const fallbackBlocks = fallbackCaptured?.blocks ?? [];

  const merged = mergeBlocksById(serverPage.blocks, live.blocks);
  const withFallback = appendMissing(merged, fallbackBlocks);

  const derivedCount = countToolBlocks(withFallback);
  const toolCallCount = Math.max(
    derivedCount,
    serverPage.toolCallCount ?? 0,
    live.toolCallCount ?? 0,
    fallbackCaptured?.toolCallCount ?? 0,
  );

  return {
    blocks: withFallback,
    hasMore: serverPage.hasMore,
    oldestTurnId: serverPage.oldestTurnId,
    seq: serverPage.seq,
    busy: resolveBusy(serverPage, live, fallbackCaptured, live.blocks),
    toolCallCount,
  };
}

export function prependOlderAgentPage(
  current: AgentTranscriptPage,
  older: AgentTranscriptPage,
): AgentTranscriptPage {
  if (older.blocks.length === 0) {
    return {
      blocks: current.blocks.slice(),
      hasMore: false,
      oldestTurnId: current.oldestTurnId,
      seq: current.seq,
      busy: current.busy,
      toolCallCount: current.toolCallCount,
    };
  }

  const currentIds = new Set(current.blocks.map((block) => block.id));
  const prepended: AgentTimelineBlock[] = [];
  for (const block of older.blocks) {
    if (currentIds.has(block.id)) continue;
    prepended.push(block);
  }

  const cursor = advanceAgentHistoryCursor(current, older);
  return {
    blocks: [...prepended, ...current.blocks],
    hasMore: cursor.hasMore,
    oldestTurnId: cursor.oldestTurnId,
    seq: cursor.seq,
    busy: current.busy,
    toolCallCount: current.toolCallCount,
  };
}

export interface AgentHistoryCache {
  readonly agentId: string;
  readonly page: AgentTranscriptPage;
}

export function applyNewestAgentPage(
  current: AgentHistoryCache | null,
  agentId: string,
  newest: AgentTranscriptPage,
): AgentHistoryCache {
  if (current === null || current.agentId !== agentId) {
    return { agentId, page: newest };
  }
  const nextBlocks = pairTranscriptBlocks(current.page.blocks, newest.blocks);
  return {
    agentId,
    page: {
      ...current.page,
      blocks: nextBlocks,
      hasMore: current.page.hasMore,
      oldestTurnId: current.page.oldestTurnId ?? newest.oldestTurnId,
      seq: newest.seq ?? current.page.seq,
      busy: newest.busy,
      toolCallCount: Math.max(
        current.page.toolCallCount ?? 0,
        newest.toolCallCount ?? 0,
        countToolBlocks(nextBlocks),
      ),
    },
  };
}

export function resetAgentHistoryCache(
  current: AgentHistoryCache | null,
  agentId: string,
): AgentHistoryCache | null {
  if (current === null || current.agentId === agentId) return current;
  return null;
}

export function advanceAgentHistoryCursor(
  current: AgentHistoryCursor,
  older: Pick<AgentTranscriptPage, 'hasMore' | 'oldestTurnId' | 'seq' | 'blocks'>,
): AgentHistoryCursor {
  if (older.blocks.length === 0) {
    return {
      hasMore: false,
      oldestTurnId: current.oldestTurnId,
      seq: current.seq,
    };
  }
  return {
    hasMore: older.hasMore,
    oldestTurnId: older.oldestTurnId ?? firstTurnId(older.blocks) ?? current.oldestTurnId,
    seq: current.seq ?? older.seq,
  };
}

function ensureDraft(drafts: Map<string, DraftNode>, agentId: string): DraftNode {
  const existing = drafts.get(agentId);
  if (existing !== undefined) return existing;
  const created: DraftNode = {
    agentId,
    parentAgentId: undefined,
    rosterParentAgentId: undefined,
    parentToolCallId: undefined,
    name: undefined,
    label: undefined,
    model: undefined,
    thinkingEffort: undefined,
    status: undefined,
    busy: undefined,
    toolCallCount: 0,
    startedAt: undefined,
    endedAt: undefined,
    summary: undefined,
    error: undefined,
  };
  drafts.set(agentId, created);
  return created;
}

function applyTaskFallback(draft: DraftNode, task: AgentTaskItem): void {
  const status = normalizeStatus(task.status, task.detached === true);
  draft.parentAgentId = draft.parentAgentId ?? cleanId(task.parentAgentId ?? task.parent_agent_id);
  draft.parentToolCallId =
    draft.parentToolCallId ?? cleanId(task.parentToolCallId ?? task.parent_tool_call_id);
  draft.name = draft.name ?? firstPresent(task.name, task.description);
  draft.model = draft.model ?? firstPresent(task.model);
  draft.thinkingEffort = draft.thinkingEffort ?? firstPresent(task.thinkingEffort, task.thinking_effort);
  draft.status = draft.status ?? status;
  draft.startedAt = draft.startedAt ?? firstPresent(task.startedAt, task.started_at);
  draft.endedAt = draft.endedAt ?? firstPresent(task.endedAt, task.completed_at);
  draft.summary = draft.summary ?? firstPresent(task.summary, task.output_preview);
  if (task.detached === true && draft.busy === undefined && status === 'background') {
    draft.busy = true;
  }
}

function applyRoster(draft: DraftNode, entry: AgentRosterDescriptor): void {
  const rosterParent = cleanId(entry.parentAgentId);
  if (rosterParent !== undefined) draft.rosterParentAgentId = rosterParent;
  draft.parentAgentId = rosterParent ?? draft.parentAgentId;
  draft.parentToolCallId = firstPresent(entry.parentToolCallId) ?? draft.parentToolCallId;
  draft.name = firstPresent(entry.name, entry.label) ?? draft.name;
  draft.label = firstPresent(entry.label) ?? draft.label;
  // Roster is the authority over task fallback when it actually has a value.
  draft.model = firstPresent(entry.model) ?? draft.model;
  draft.thinkingEffort = firstPresent(entry.thinkingEffort) ?? draft.thinkingEffort;
  draft.status = normalizeStatus(entry.status) ?? draft.status;
  if (entry.busy !== undefined) draft.busy = entry.busy;
  if (entry.toolCallCount !== undefined) {
    draft.toolCallCount = Math.max(draft.toolCallCount, entry.toolCallCount);
  }
  draft.startedAt = firstPresent(entry.startedAt) ?? draft.startedAt;
  draft.endedAt = firstPresent(entry.endedAt) ?? draft.endedAt;
  draft.summary = firstPresent(entry.summary) ?? draft.summary;
  draft.error = firstPresent(entry.error) ?? draft.error;
}

function applyLiveBlock(draft: DraftNode, block: AgentLiveSource): void {
  draft.parentAgentId = draft.parentAgentId ?? cleanId(block.parentAgentId);
  draft.parentToolCallId = firstPresent(block.parentToolCallId) ?? draft.parentToolCallId;
  draft.name = firstPresent(block.name) ?? draft.name;
  draft.label = firstPresent(block.label) ?? draft.label;
  draft.model = firstPresent(block.model) ?? draft.model;
  draft.thinkingEffort = firstPresent(block.thinkingEffort) ?? draft.thinkingEffort;
  const status = normalizeStatus(block.status);
  if (status !== undefined) {
    draft.status = status;
    // Live status is authoritative over a stale roster/task busy bit.
    draft.busy = isActiveStatus(status);
  }
  if (block.toolCallCount !== undefined) {
    draft.toolCallCount = Math.max(draft.toolCallCount, block.toolCallCount);
  }
  draft.startedAt = firstPresent(block.startedAt) ?? draft.startedAt;
  draft.endedAt = firstPresent(block.endedAt) ?? draft.endedAt;
  draft.summary = firstPresent(block.summary) ?? draft.summary;
  draft.error = firstPresent(block.error) ?? draft.error;
}

function resolveParent(draft: DraftNode, drafts: Map<string, DraftNode>): string | undefined {
  const preferred = draft.rosterParentAgentId ?? draft.parentAgentId;
  if (preferred === undefined || preferred === draft.agentId) return undefined;
  if (!drafts.has(preferred)) return undefined;
  return preferred;
}

function breakCycles(parentOf: Map<string, string | undefined>): void {
  const remaining = new Set(parentOf.keys());
  while (remaining.size > 0) {
    const start = remaining.values().next().value;
    if (start === undefined) break;
    const stack: string[] = [];
    const indexOf = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && remaining.has(current)) {
      const seenAt = indexOf.get(current);
      if (seenAt !== undefined) {
        const cycle = stack.slice(seenAt);
        const cut = cycle.reduce((max, id) => (compareAgentIds(id, max) > 0 ? id : max));
        parentOf.set(cut, undefined);
        break;
      }
      indexOf.set(current, stack.length);
      stack.push(current);
      current = parentOf.get(current);
    }
    for (const id of stack) remaining.delete(id);
  }
}

function taskAgentId(task: AgentTaskItem): string | undefined {
  return cleanId(task.agentId);
}

function normalizeStatus(raw: string | undefined, detached = false): AgentStatus | undefined {
  if (!present(raw)) {
    return detached ? 'background' : undefined;
  }
  switch (raw) {
    case 'running':
    case 'queued':
    case 'working':
    case 'in_progress':
      return detached ? 'background' : 'running';
    case 'suspended':
      return 'suspended';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'killed':
      return 'cancelled';
    case 'background':
      return 'background';
    default:
      return detached ? 'background' : undefined;
  }
}

function isActiveStatus(status: AgentStatus): boolean {
  return status === 'running' || status === 'suspended' || status === 'background';
}

/** Terminal statuses are never busy; running/suspended/background stay active. */
function busyFromStatus(status: AgentStatus, hinted?: boolean): boolean {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return false;
  return hinted ?? isActiveStatus(status);
}

function normalizeLiveInput(input: AgentLiveTranscriptInput): AgentLiveTranscript {
  if (!Array.isArray(input) && 'blocks' in input) return input;
  return { blocks: input };
}

const SEMANTIC_KINDS = new Set(['user', 'assistant', 'thinking', 'system']);

function overlayDefined(base: AgentTimelineBlock, overlay: AgentTimelineBlock): AgentTimelineBlock {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) next[key] = value;
  }
  return next as unknown as AgentTimelineBlock;
}

function mergeServerAndLive(
  server: AgentTimelineBlock,
  live: AgentTimelineBlock,
): AgentTimelineBlock {
  const next = overlayDefined(server, live);
  if (SEMANTIC_KINDS.has(server.kind) && server.streaming !== true) {
    return {
      ...next,
      id: server.id,
      text: server.text ?? live.text,
      streaming: false,
      turnId: server.turnId ?? live.turnId,
    };
  }
  return { ...next, id: server.id };
}

export function isLiveLikeBlock(block: AgentTimelineBlock): boolean {
  return (
    /^(?:assistant|thinking)-live-/.test(block.id) ||
    /^user-turn-/.test(block.id) ||
    /^system-turn-/.test(block.id)
  );
}

export function blockTurnId(block: AgentTimelineBlock): string | undefined {
  if (present(block.turnId)) return block.turnId;
  const live = /^(?:assistant|thinking)-live-(.+?)(?:-final-.+)?$/.exec(block.id);
  if (live?.[1] !== undefined) return live[1];
  const turnPrompt = /^(?:user|system)-turn-(.+)-prompt(?:-reminder-\d+)?$/.exec(block.id);
  if (turnPrompt?.[1] !== undefined) return turnPrompt[1];
  const agentTurn = /^user-agent-turn-(.+)-prompt(?:-reminder-\d+)?$/.exec(block.id);
  if (agentTurn?.[1] !== undefined) return agentTurn[1];
  return undefined;
}

function pairGroupKey(block: AgentTimelineBlock): string | undefined {
  if (!SEMANTIC_KINDS.has(block.kind)) return undefined;
  const turnId = blockTurnId(block);
  if (turnId === undefined) return undefined;
  return `${turnId}:${block.kind}`;
}

/**
 * Pair two transcript windows without collapsing REST↔REST or live↔live.
 * Exact ids merge first; leftover semantic blocks pair 1:1 by (turnId, kind)
 * in encounter order.
 */
function combinePaired(left: AgentTimelineBlock, right: AgentTimelineBlock): AgentTimelineBlock {
  const leftLive = isLiveLikeBlock(left);
  const rightLive = isLiveLikeBlock(right);
  if (leftLive && !rightLive) return mergeServerAndLive(right, left);
  if (rightLive && !leftLive) return mergeServerAndLive(left, right);
  return { ...overlayDefined(left, right), id: left.id };
}

export function pairTranscriptBlocks(
  primary: readonly AgentTimelineBlock[],
  incoming: readonly AgentTimelineBlock[],
): AgentTimelineBlock[] {
  const incomingById = new Map<string, AgentTimelineBlock>();
  for (const block of incoming) incomingById.set(block.id, block);

  const usedIncoming = new Set<string>();
  const next: AgentTimelineBlock[] = [];

  for (const left of primary) {
    const exact = incomingById.get(left.id);
    if (exact !== undefined) {
      next.push(combinePaired(left, exact));
      usedIncoming.add(exact.id);
    } else {
      next.push(left);
    }
  }

  const unpairedIncoming = incoming.filter((block) => !usedIncoming.has(block.id));
  const unpairedPrimary = next
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => !incomingById.has(block.id));

  const incomingBuckets = new Map<string, AgentTimelineBlock[]>();
  for (const block of unpairedIncoming) {
    const key = pairGroupKey(block);
    if (key === undefined) continue;
    const bucket = incomingBuckets.get(key) ?? [];
    bucket.push(block);
    incomingBuckets.set(key, bucket);
  }

  const pairedIncoming = new Set<string>();
  const primaryBuckets = new Map<string, number>();
  for (const { block, index } of unpairedPrimary) {
    const key = pairGroupKey(block);
    if (key === undefined) continue;
    const matchBucket = incomingBuckets.get(key);
    if (matchBucket === undefined) continue;
    const leftLive = isLiveLikeBlock(block);
    const restLikeIncoming = matchBucket.filter((candidate) => isLiveLikeBlock(candidate) !== leftLive);
    const ordinal = primaryBuckets.get(key) ?? 0;
    primaryBuckets.set(key, ordinal + 1);
    const match = restLikeIncoming[ordinal];
    if (match === undefined) continue;
    next[index] = combinePaired(block, match);
    pairedIncoming.add(match.id);
  }

  for (const block of unpairedIncoming) {
    if (pairedIncoming.has(block.id) || usedIncoming.has(block.id)) continue;
    next.push(block);
  }
  return next;
}

function mergeBlocksById(
  server: readonly AgentTimelineBlock[],
  live: readonly AgentTimelineBlock[],
): AgentTimelineBlock[] {
  return pairTranscriptBlocks(server, live);
}

function appendMissing(
  base: readonly AgentTimelineBlock[],
  extra: readonly AgentTimelineBlock[],
): AgentTimelineBlock[] {
  if (extra.length === 0) return base.slice();
  return pairTranscriptBlocks(base, extra);
}

function resolveBusy(
  server: AgentTranscriptPage,
  live: AgentLiveTranscript,
  fallback: AgentTranscriptFallback | undefined,
  liveBlocks: readonly AgentTimelineBlock[],
): boolean {
  if (live.busy !== undefined) return live.busy;
  if (liveBlocks.length > 0) return deriveBusy(liveBlocks);
  // Captured live fallback outranks a stale REST page when no live signal exists.
  if (fallback?.busy !== undefined) return fallback.busy;
  if (server.busy !== undefined) return server.busy;
  return deriveBusy(server.blocks) || deriveBusy(fallback?.blocks ?? []);
}

function deriveBusy(blocks: readonly AgentTimelineBlock[]): boolean {
  return blocks.some(
    (block) => block.streaming === true || (block.kind === 'tool' && block.status === 'running'),
  );
}

export function countToolBlocks(blocks: readonly { readonly kind: string }[]): number {
  let count = 0;
  for (const block of blocks) {
    if (block.kind === 'tool') count += 1;
  }
  return count;
}

function firstTurnId(blocks: readonly AgentTimelineBlock[]): string | undefined {
  for (const block of blocks) {
    if (present(block.turnId)) return block.turnId;
  }
  return undefined;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

function cleanId(value: string | undefined): string | undefined {
  return present(value) ? value : undefined;
}

function firstPresent(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (present(value)) return value;
  }
  return undefined;
}
