/**
 * Pure agent-tree / transcript-merge / history-cursor helpers for the GUI.
 * Callers (UI, controller) stay outside this module; nothing here mutates
 * inputs or depends on a not-yet-landed wire candidate.
 */

export const MAIN_AGENT_ID = 'main';

/**
 * Snapshot/live states plus the detached-task `background` presentation state.
 */
export type AgentStatus =
  | 'unknown'
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'background';

const STATUS_AUTHORITY = {
  roster: 1,
  live: 2,
  task: 3,
} as const;

export interface AgentTokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface AgentUsageSummary {
  readonly byModel?: Readonly<Record<string, AgentTokenUsage>>;
  readonly currentTurn?: AgentTokenUsage;
  readonly total?: AgentTokenUsage;
}

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
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly usage?: AgentUsageSummary;
  readonly status: string;
  readonly description?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly toolCallCount?: number;
  readonly toolCallCountKnown?: boolean;
  readonly toolCallCountAuthoritative?: boolean;
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
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly usage?: AgentUsageSummary;
  readonly status?: string;
  readonly busy?: boolean;
  readonly toolCallCount?: number;
  readonly toolCallCountKnown?: boolean;
  readonly toolCallCountAuthoritative?: boolean;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly disposedAt?: string;
  readonly description?: string;
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
  readonly error?: string;
  readonly stateReason?: string;
  readonly state_reason?: string;
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
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly usage?: AgentUsageSummary;
  readonly status: AgentStatus;
  readonly busy: boolean;
  readonly toolCallCount: number;
  readonly toolCallCountKnown?: boolean;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly description?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly childIds: readonly string[];
}

interface AgentTranscriptMetaFields {
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly usage?: AgentUsageSummary;
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

export interface AgentTranscriptPage extends AgentTranscriptMetaFields {
  readonly blocks: readonly AgentTimelineBlock[];
  readonly hasMore: boolean;
  readonly oldestTurnId?: string;
  readonly seq?: number;
  readonly busy?: boolean;
  readonly toolCallCount?: number;
}

export interface AgentLiveTranscript extends AgentTranscriptMetaFields {
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

export interface MergedAgentTranscript extends AgentTranscriptMetaFields {
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
  contextTokens: number | undefined;
  maxContextTokens: number | undefined;
  usage: AgentUsageSummary | undefined;
  status: AgentStatus | undefined;
  statusAuthority: number;
  statusStartedAt: number | undefined;
  statusEndedAt: number | undefined;
  taskId: string | undefined;
  disposedAt: number | undefined;
  busy: boolean | undefined;
  toolCallCount: number;
  toolCallCountKnown: boolean;
  toolCallCountAuthoritative: boolean;
  startedAt: string | undefined;
  endedAt: string | undefined;
  description: string | undefined;
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

/**
 * Sibling/root ordering for the rail: newest-started first so freshly spawned
 * agents surface at the top. Nodes without a usable startedAt sink below
 * timestamped ones, and ties (or fully untimestamped sets) keep the stable
 * agent-id order — `main` always leads a root list.
 */
function compareDraftsByRecency(a: DraftNode, b: DraftNode): number {
  if (a.agentId === MAIN_AGENT_ID || b.agentId === MAIN_AGENT_ID) {
    return compareAgentIds(a.agentId, b.agentId);
  }
  const aTime = a.startedAt === undefined ? Number.NaN : Date.parse(a.startedAt);
  const bTime = b.startedAt === undefined ? Number.NaN : Date.parse(b.startedAt);
  const aHas = Number.isFinite(aTime);
  const bHas = Number.isFinite(bTime);
  if (aHas && bHas && aTime !== bTime) return bTime - aTime;
  if (aHas !== bHas) return aHas ? -1 : 1;
  return compareAgentIds(a.agentId, b.agentId);
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
function tokenUsageEqual(a: AgentTokenUsage | undefined, b: AgentTokenUsage | undefined): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.inputOther === b.inputOther &&
      a.output === b.output &&
      a.inputCacheRead === b.inputCacheRead &&
      a.inputCacheCreation === b.inputCacheCreation)
  );
}

function usageSummaryEqual(a: AgentUsageSummary | undefined, b: AgentUsageSummary | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (!tokenUsageEqual(a.currentTurn, b.currentTurn) || !tokenUsageEqual(a.total, b.total)) return false;
  const aModels = Object.keys(a.byModel ?? {});
  const bModels = Object.keys(b.byModel ?? {});
  return (
    aModels.length === bModels.length &&
    aModels.every((model) => tokenUsageEqual(a.byModel?.[model], b.byModel?.[model]))
  );
}

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
    a.contextTokens === b.contextTokens &&
    a.maxContextTokens === b.maxContextTokens &&
    usageSummaryEqual(a.usage, b.usage) &&
    a.status === b.status &&
    a.busy === b.busy &&
    a.toolCallCount === b.toolCallCount &&
    a.toolCallCountKnown === b.toolCallCountKnown &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.description === b.description &&
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

/**
 * Structurally share an agent forest across roster/live rebuilds. Unchanged
 * historical branches keep their node references; a changed descendant also
 * refreshes each ancestor reference so a memoized row can compare only its
 * node and still know whether any nested row needs new props.
 */
export function stabilizeAgentForest(
  previous: AgentForest | undefined,
  next: AgentForest,
): AgentForest {
  if (previous === undefined || previous === next) return next;

  const byId = createById();
  const visiting = new Set<string>();
  const stabilizeNode = (agentId: string): AgentTreeNode | undefined => {
    const cached = byId[agentId];
    if (cached !== undefined) return cached;
    const nextNode = next.byId[agentId];
    if (nextNode === undefined) return undefined;
    if (visiting.has(agentId)) {
      byId[agentId] = nextNode;
      return nextNode;
    }
    visiting.add(agentId);
    const previousNode = previous.byId[agentId];
    let descendantsStable = previousNode !== undefined;
    for (const childId of nextNode.childIds) {
      const child = stabilizeNode(childId);
      if (child === undefined || child !== previous.byId[childId]) descendantsStable = false;
    }
    visiting.delete(agentId);
    const stable =
      previousNode !== undefined &&
      descendantsStable &&
      agentTreeNodesEqual(previousNode, nextNode)
        ? previousNode
        : nextNode;
    byId[agentId] = stable;
    return stable;
  };

  for (const root of next.roots) stabilizeNode(root.agentId);
  for (const agentId of Object.keys(next.byId)) stabilizeNode(agentId);

  const roots = next.roots.map((root) => byId[root.agentId]!);
  const previousIds = Object.keys(previous.byId);
  const nextIds = Object.keys(next.byId);
  const allNodesStable =
    previousIds.length === nextIds.length &&
    nextIds.every((agentId) => byId[agentId] === previous.byId[agentId]);
  const rootsStable =
    roots.length === previous.roots.length &&
    roots.every((root, index) => root === previous.roots[index]);
  if (allNodesStable && rootsStable) return previous;
  return { roots: rootsStable ? previous.roots : roots, byId };
}

export function buildAgentForest(
  subagentBlocks: readonly AgentLiveSource[],
  roster?: readonly AgentRosterDescriptor[],
  taskItems?: readonly AgentTaskItem[],
): AgentForest {
  const drafts = new Map<string, DraftNode>();

  for (const task of latestTasksByAgent(taskItems ?? [])) {
    const agentId = taskAgentId(task)!;
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

  const byRecency = (a: string, b: string): number =>
    compareDraftsByRecency(drafts.get(a)!, drafts.get(b)!);
  for (const children of childIds.values()) children.sort(byRecency);
  rootIds.sort(byRecency);

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
    const status = draft.status ?? 'unknown';
    const node: AgentTreeNode = {
      agentId: draft.agentId,
      parentAgentId,
      parentToolCallId: draft.parentToolCallId,
      name,
      label: present(draft.label) ? draft.label : name,
      model: draft.model,
      thinkingEffort: draft.thinkingEffort,
      contextTokens: draft.contextTokens,
      maxContextTokens: draft.maxContextTokens,
      usage: draft.usage,
      status,
      busy: busyFromStatus(status, draft.busy),
      toolCallCount: draft.toolCallCount,
      toolCallCountKnown: draft.toolCallCountKnown,
      startedAt: draft.startedAt,
      endedAt: draft.endedAt,
      description: draft.description,
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
    model: live.model ?? serverPage.model,
    thinkingEffort: live.thinkingEffort ?? serverPage.thinkingEffort,
    contextTokens: live.contextTokens ?? serverPage.contextTokens,
    maxContextTokens: live.maxContextTokens ?? serverPage.maxContextTokens,
    usage: live.usage ?? serverPage.usage,
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
      ...current,
      blocks: current.blocks.slice(),
      hasMore: false,
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
    ...current,
    blocks: [...prepended, ...current.blocks],
    hasMore: cursor.hasMore,
    oldestTurnId: cursor.oldestTurnId,
    seq: cursor.seq,
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
      model: newest.model ?? current.page.model,
      thinkingEffort: newest.thinkingEffort ?? current.page.thinkingEffort,
      contextTokens: newest.contextTokens ?? current.page.contextTokens,
      maxContextTokens: newest.maxContextTokens ?? current.page.maxContextTokens,
      usage: newest.usage ?? current.page.usage,
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
    contextTokens: undefined,
    maxContextTokens: undefined,
    usage: undefined,
    status: undefined,
    statusAuthority: 0,
    statusStartedAt: undefined,
    statusEndedAt: undefined,
    taskId: undefined,
    disposedAt: undefined,
    busy: undefined,
    toolCallCount: 0,
    toolCallCountKnown: false,
    toolCallCountAuthoritative: false,
    startedAt: undefined,
    endedAt: undefined,
    description: undefined,
    summary: undefined,
    error: undefined,
  };
  drafts.set(agentId, created);
  return created;
}

function applyToolCallCount(
  draft: DraftNode,
  count: number | undefined,
  known: boolean | undefined,
  authoritative: boolean | undefined,
): void {
  if (authoritative === true) {
    draft.toolCallCount = count ?? 0;
    draft.toolCallCountKnown = count !== undefined && known !== false;
    draft.toolCallCountAuthoritative = true;
    return;
  }
  if (draft.toolCallCountAuthoritative || count === undefined) return;
  draft.toolCallCount = Math.max(draft.toolCallCount, count);
  if (known !== false) draft.toolCallCountKnown = true;
}

function applyTaskFallback(draft: DraftNode, task: AgentTaskItem): void {
  const status = normalizeStatus(task.status, task.detached === true);
  const startedAt = firstPresent(task.startedAt, task.started_at);
  const endedAt = firstPresent(task.endedAt, task.completed_at);
  draft.parentAgentId = draft.parentAgentId ?? cleanId(task.parentAgentId ?? task.parent_agent_id);
  draft.parentToolCallId =
    draft.parentToolCallId ?? cleanId(task.parentToolCallId ?? task.parent_tool_call_id);
  draft.name = draft.name ?? firstPresent(task.name, task.description);
  draft.description = firstPresent(task.description) ?? draft.description;
  const accepted =
    status === undefined
      ? draft.status === undefined && draft.disposedAt === undefined
      : applyStatus(draft, status, STATUS_AUTHORITY.task, startedAt, endedAt).accepted;
  if (!accepted) return;
  draft.model = firstPresent(task.model) ?? draft.model;
  draft.thinkingEffort = firstPresent(task.thinkingEffort, task.thinking_effort) ?? draft.thinkingEffort;
  draft.startedAt ??= startedAt;
  draft.endedAt ??= endedAt;
  draft.summary = draft.summary ?? firstPresent(task.summary, task.output_preview);
  draft.error = draft.error ?? firstPresent(task.error, task.stateReason, task.state_reason);
  if (status !== undefined && status !== 'unknown') {
    draft.taskId = cleanId(task.id) ?? draft.taskId;
  }
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
  draft.description = firstPresent(entry.description) ?? draft.description;
  applyToolCallCount(
    draft,
    entry.toolCallCount,
    entry.toolCallCountKnown,
    entry.toolCallCountAuthoritative,
  );
  const disposedAt = parseStatusTimestamp(entry.disposedAt);
  if (disposedAt !== undefined && (draft.disposedAt === undefined || disposedAt > draft.disposedAt)) {
    draft.disposedAt = disposedAt;
    if (
      draft.status !== undefined &&
      isActiveStatus(draft.status) &&
      (draft.statusStartedAt === undefined || draft.statusStartedAt <= disposedAt)
    ) {
      draft.status = 'unknown';
      draft.statusAuthority = STATUS_AUTHORITY.roster;
      clearRunFields(draft);
      draft.busy = false;
    }
  }
  const status = normalizeStatus(entry.status);
  const accepted =
    status === undefined
      ? draft.status === undefined && draft.disposedAt === undefined
      : applyStatus(draft, status, STATUS_AUTHORITY.roster, entry.startedAt, entry.endedAt)
          .accepted;
  if (!accepted) return;
  draft.model = firstPresent(entry.model) ?? draft.model;
  draft.thinkingEffort = firstPresent(entry.thinkingEffort) ?? draft.thinkingEffort;
  draft.contextTokens = entry.contextTokens ?? draft.contextTokens;
  draft.maxContextTokens = entry.maxContextTokens ?? draft.maxContextTokens;
  draft.usage = entry.usage ?? draft.usage;
  if (entry.busy !== undefined) draft.busy = entry.busy;
  draft.startedAt ??= firstPresent(entry.startedAt);
  draft.endedAt ??= firstPresent(entry.endedAt);
  draft.summary = firstPresent(entry.summary) ?? draft.summary;
  draft.error = firstPresent(entry.error) ?? draft.error;
}

function applyLiveBlock(draft: DraftNode, block: AgentLiveSource): void {
  draft.parentAgentId = draft.parentAgentId ?? cleanId(block.parentAgentId);
  draft.parentToolCallId = firstPresent(block.parentToolCallId) ?? draft.parentToolCallId;
  draft.name = firstPresent(block.name) ?? draft.name;
  draft.label = firstPresent(block.label) ?? draft.label;
  draft.description = firstPresent(block.description) ?? draft.description;
  applyToolCallCount(
    draft,
    block.toolCallCount,
    block.toolCallCountKnown,
    block.toolCallCountAuthoritative,
  );
  const status = normalizeStatus(block.status);
  const accepted =
    status === undefined
      ? draft.status === undefined && draft.disposedAt === undefined
      : applyStatus(draft, status, STATUS_AUTHORITY.live, block.startedAt, block.endedAt)
          .accepted;
  if (!accepted) return;
  draft.model = firstPresent(block.model) ?? draft.model;
  draft.thinkingEffort = firstPresent(block.thinkingEffort) ?? draft.thinkingEffort;
  draft.contextTokens = block.contextTokens ?? draft.contextTokens;
  draft.maxContextTokens = block.maxContextTokens ?? draft.maxContextTokens;
  draft.usage = block.usage ?? draft.usage;
  if (status !== undefined) draft.busy = isActiveStatus(status);
  draft.startedAt ??= firstPresent(block.startedAt);
  draft.endedAt ??= firstPresent(block.endedAt);
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

function latestTasksByAgent(tasks: readonly AgentTaskItem[]): readonly AgentTaskItem[] {
  const latest = new Map<string, AgentTaskItem>();
  for (const task of tasks) {
    const agentId = taskAgentId(task);
    if (agentId === undefined) continue;
    const current = latest.get(agentId);
    if (current === undefined || taskRunIsNewer(task, current)) {
      latest.set(agentId, task);
    }
  }
  return [...latest.values()];
}

function taskRunIsNewer(candidate: AgentTaskItem, current: AgentTaskItem): boolean {
  const candidateStartedAt = parseStatusTimestamp(firstPresent(candidate.startedAt, candidate.started_at));
  const currentStartedAt = parseStatusTimestamp(firstPresent(current.startedAt, current.started_at));
  const candidateEndedAt = parseStatusTimestamp(firstPresent(candidate.endedAt, candidate.completed_at));
  const currentEndedAt = parseStatusTimestamp(firstPresent(current.endedAt, current.completed_at));
  const candidateId = cleanId(candidate.id);
  const currentId = cleanId(current.id);
  const distinctTasks =
    candidateId !== undefined && currentId !== undefined && candidateId !== currentId;
  if (distinctTasks) {
    if (candidateStartedAt !== undefined && currentEndedAt !== undefined && candidateStartedAt > currentEndedAt) {
      return true;
    }
    if (currentStartedAt !== undefined && candidateEndedAt !== undefined && currentStartedAt > candidateEndedAt) {
      return false;
    }
  }
  if (candidateStartedAt !== currentStartedAt) {
    if (candidateStartedAt === undefined) return false;
    if (currentStartedAt === undefined) return true;
    return candidateStartedAt > currentStartedAt;
  }
  const candidateStatus = normalizeStatus(candidate.status, candidate.detached === true);
  const currentStatus = normalizeStatus(current.status, current.detached === true);
  const candidateRank = candidateStatus === undefined ? -1 : statusRank(candidateStatus);
  const currentRank = currentStatus === undefined ? -1 : statusRank(currentStatus);
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  if (candidateEndedAt !== currentEndedAt) {
    if (candidateEndedAt === undefined) return false;
    if (currentEndedAt === undefined) return true;
    return candidateEndedAt > currentEndedAt;
  }
  if (candidateId !== currentId) {
    if (candidateId === undefined) return false;
    if (currentId === undefined) return true;
    return candidateId > currentId;
  }
  return taskTieKey(candidate) > taskTieKey(current);
}

function taskTieKey(task: AgentTaskItem): string {
  return JSON.stringify([
    cleanId(task.id) ?? '',
    task.kind ?? '',
    task.description ?? '',
    task.name ?? '',
    task.status ?? '',
    task.model ?? '',
    firstPresent(task.thinkingEffort, task.thinking_effort) ?? '',
    firstPresent(task.startedAt, task.started_at) ?? '',
    firstPresent(task.endedAt, task.completed_at) ?? '',
    firstPresent(task.summary, task.output_preview) ?? '',
    cleanId(task.parentAgentId ?? task.parent_agent_id) ?? '',
    cleanId(task.parentToolCallId ?? task.parent_tool_call_id) ?? '',
    task.detached === true,
  ]);
}

function parseStatusTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeStatus(raw: string | undefined, detached = false): AgentStatus | undefined {
  if (!present(raw)) {
    return detached ? 'background' : undefined;
  }
  switch (raw) {
    case 'unknown':
      return 'unknown';
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
    case 'timed_out':
    case 'lost':
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

function statusRank(status: AgentStatus): number {
  if (status === 'unknown') return 0;
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return 2;
  return 1;
}

function activeStatusSpecificity(status: AgentStatus): number {
  return status === 'suspended' ? 2 : isActiveStatus(status) ? 1 : 0;
}

function sourceGenerationIsDisposed(
  draft: DraftNode,
  status: AgentStatus,
  startedAt: string | undefined,
): boolean {
  if (statusRank(status) === 2 || draft.disposedAt === undefined) return false;
  const sourceStartedAt = parseStatusTimestamp(startedAt);
  return sourceStartedAt === undefined || sourceStartedAt <= draft.disposedAt;
}

function clearRunFields(draft: DraftNode): void {
  draft.model = undefined;
  draft.thinkingEffort = undefined;
  draft.contextTokens = undefined;
  draft.maxContextTokens = undefined;
  draft.usage = undefined;
  draft.busy = undefined;
  draft.startedAt = undefined;
  draft.endedAt = undefined;
  draft.summary = undefined;
  draft.error = undefined;
}

function applyStatus(
  draft: DraftNode,
  status: AgentStatus,
  authority: number,
  startedAt?: string,
  endedAt?: string,
): { readonly accepted: boolean; readonly newGeneration: boolean } {
  const currentRank = draft.status === undefined ? -1 : statusRank(draft.status);
  const nextRank = statusRank(status);
  const nextStartedAt = parseStatusTimestamp(startedAt);
  const nextEndedAt = parseStatusTimestamp(endedAt);
  if (sourceGenerationIsDisposed(draft, status, startedAt)) {
    return { accepted: false, newGeneration: false };
  }
  const comparableRuns = currentRank > 0 && nextRank > 0;
  const startsAfterDisposal =
    isActiveStatus(status) &&
    nextStartedAt !== undefined &&
    draft.disposedAt !== undefined &&
    nextStartedAt > draft.disposedAt &&
    (draft.statusStartedAt === undefined || draft.statusStartedAt <= draft.disposedAt);
  const nextRunIsNewer =
    startsAfterDisposal ||
    (comparableRuns &&
      nextStartedAt !== undefined &&
      draft.statusEndedAt !== undefined &&
      nextStartedAt > draft.statusEndedAt);
  const identityFreeTerminalForTask =
    authority < STATUS_AUTHORITY.task && nextRank === 2 && draft.taskId !== undefined;
  if (identityFreeTerminalForTask) return { accepted: false, newGeneration: false };
  const currentRunIsNewer =
    comparableRuns &&
    draft.statusStartedAt !== undefined &&
    nextEndedAt !== undefined &&
    draft.statusStartedAt >= nextEndedAt;
  if (!nextRunIsNewer && currentRunIsNewer) {
    return { accepted: false, newGeneration: false };
  }
  const currentSpecificity =
    draft.status === undefined ? -1 : activeStatusSpecificity(draft.status);
  const nextSpecificity = activeStatusSpecificity(status);
  const equalRankIsLowerPriority =
    nextRank === currentRank &&
    (nextRank === 1
      ? nextSpecificity < currentSpecificity ||
        (nextSpecificity === currentSpecificity && authority < draft.statusAuthority)
      : authority < draft.statusAuthority);
  const lowerPriority = nextRank < currentRank || equalRankIsLowerPriority;
  if (!nextRunIsNewer && lowerPriority) {
    return { accepted: false, newGeneration: false };
  }
  if (nextRunIsNewer) {
    clearRunFields(draft);
    draft.taskId = undefined;
    draft.statusStartedAt = nextStartedAt;
    draft.statusEndedAt = nextEndedAt;
  } else if (nextRank > 0) {
    draft.statusStartedAt ??= nextStartedAt;
    draft.statusEndedAt = nextEndedAt ?? draft.statusEndedAt;
  }
  draft.status = status;
  draft.statusAuthority = authority;
  return { accepted: true, newGeneration: nextRunIsNewer };
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

function canonicalTurnId(turnId: string): string {
  return /^t\d+$/.test(turnId) ? turnId.slice(1) : turnId;
}

export function blockTurnId(block: AgentTimelineBlock): string | undefined {
  if (present(block.turnId)) return canonicalTurnId(block.turnId);
  const live = /^(?:assistant|thinking)-live-(.+?)(?:-final-.+)?$/.exec(block.id);
  if (live?.[1] !== undefined) return canonicalTurnId(live[1]);
  const turnPrompt = /^(?:user|system)-turn-(.+)-prompt(?:-reminder-\d+)?$/.exec(block.id);
  if (turnPrompt?.[1] !== undefined) return canonicalTurnId(turnPrompt[1]);
  const agentTurn = /^user-agent-turn-(.+)-prompt(?:-reminder-\d+)?$/.exec(block.id);
  if (agentTurn?.[1] !== undefined) return canonicalTurnId(agentTurn[1]);
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
  if (leftLive !== rightLive) {
    const live = leftLive ? left : right;
    const server = leftLive ? right : left;
    const merged = mergeServerAndLive(server, live);
    const sameTurnContent =
      SEMANTIC_KINDS.has(server.kind) &&
      server.kind === live.kind &&
      blockTurnId(server) === blockTurnId(live) &&
      server.text === live.text;
    return sameTurnContent
      ? { ...merged, id: live.id, turnId: live.turnId ?? merged.turnId }
      : merged;
  }
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
