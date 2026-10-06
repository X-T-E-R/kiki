/**
 * Session-level background work, projected without pulling in every agent's
 * transcript.
 *
 * The rail's background list follows one owner. A whole-session view needs the
 * union, and the two obvious ways to get it are both wrong:
 *
 *   - `GET /sessions/{id}/tasks` resolves MAIN's task service only, so it is
 *     the main agent's list wearing a session name.
 *   - subscribing to every agent through the controller would request a
 *     transcript per agent (`requestedTranscriptGrades`), which is the whole
 *     session's message bodies to draw a few rows of task metadata.
 *
 * So the projection reads the task collections the controller already keeps
 * resident for the agents it has published, and says how much of the tree
 * those rows actually cover. An agent nobody has opened has no task rows here;
 * the caller shows that as partial coverage rather than as "no background
 * work running", which is a different claim.
 *
 * Ownership is provenance, not inference: a task lands in the graph under the
 * agent whose own task collection it came from. `task.agent_id` names the
 * subagent a `kind: 'subagent'` task *spawned*, so it must not be read as the
 * owner, and a subagent row is already the agent itself — counting the two
 * would double every dispatch.
 */

import type { AgentForest } from '@kiki/session-core/session';
import type { Task } from '@kiki/protocol';

export interface SessionTaskRow {
  readonly task: Task;
  /** The agent whose task collection this row came from. */
  readonly ownerAgentId: string;
  /** ms; undefined when the task recorded no start. */
  readonly startedAt: number | undefined;
  /** ms; undefined while running, and when no end was recorded. */
  readonly endedAt: number | undefined;
  /** The source could not attribute this row to an owner. */
  readonly ownerUnknown: boolean;
  /**
   * Whether the owning scope is live, or reconstructed from the session's own
   * record. A `persisted` row is the last thing recorded: a task that was
   * running when the owner went cold is not running now, and the graph draws
   * the difference rather than reading a cold record as a live run.
   */
  readonly source?: 'live' | 'persisted' | undefined;
}

export interface SessionTaskProjection {
  /** Every row, ordered by owner (tree order) then start time. */
  readonly rows: readonly SessionTaskRow[];
  /** How much of the tree these rows can speak for. */
  readonly coverage: SessionTaskCoverage;
}

export interface SessionTaskCoverage {
  /** Agents whose task collections are represented here. */
  readonly covered: number;
  /**
   * Agents in the session, as the server counted them. Undefined until the
   * server has said: the agents this client has loaded are not the session's
   * agent count, so the local tree is never used as a stand-in.
   */
  readonly total: number | undefined;
  /**
   * The server has not established how many owners this session has, so no
   * fraction of it can honestly be printed. Distinct from `partial`, which is
   * a known shortfall against a known total.
   */
  readonly totalKnown: boolean;
  /**
   * Some agents in the tree have no task collection resident yet. The counts
   * below describe the covered agents only, and the caller must say so.
   */
  readonly partial: boolean;
  /**
   * A collection that reported fewer rows than it holds, so even the covered
   * agents are not complete.
   */
  readonly windowed: boolean;
}

const parseTime = (iso: string | undefined): number | undefined => {
  if (iso === undefined || iso === '') return undefined;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? undefined : value;
};

/**
 * How the whole-tree read went, as the graph needs to talk about it.
 *
 * `ready` is the only state that speaks for the tree. `pending` and `failed`
 * are both reported: a reader must be able to tell "no background work" from
 * "the background work has not been read yet", and a failed read that quietly
 * showed an empty list would say the first when it means the third.
 */
export type SessionTaskRead =
  | { readonly status: 'pending' }
  | { readonly status: 'failed'; readonly detail?: string }
  | { readonly status: 'ready'; readonly value: SessionTaskSummary };

/** Depth-first tree order, so grouped rows follow the dispatch hierarchy. */
export function treeOrder(forest: AgentForest): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const child of forest.byId[id]?.childIds ?? []) visit(child);
  };
  for (const root of forest.roots) visit(root.agentId);
  for (const id of Object.keys(forest.byId)) visit(id);
  return out;
}

/**
 * A row as the session reported it, with the owner the server attributed it
 * to. This is the whole-tree read's shape: it names the owning agent, so an
 * unopened agent's background work is attributable without the reader having
 * opened that agent.
 */
export interface SessionTaskSummaryRow {
  readonly task: Task;
  readonly ownerAgentId: string;
  /** The server could not attribute this row to an owner. */
  readonly ownerUnknown?: boolean;
  /** The owning scope is live, or reconstructed from the session record. */
  readonly source?: 'live' | 'persisted' | undefined;
}

export interface SessionTaskSummary {
  readonly rows: readonly SessionTaskSummaryRow[];
  /** Owners whose read has settled (completed or failed), across all pages. */
  readonly agentsReported: number;
  /** Owners the session has. */
  readonly agentsTotal: number;
  /**
   * The server could not enumerate every owner it knows about, so the
   * denominator is only the owners it managed to list — this is not the tree.
   *
   * Named for the server's own reason, not for a client-side read budget: the
   * whole-tree endpoint has no cap, and telling a reader that background work
   * exceeded "one read's worth" would invent a limit the service does not have.
   */
  readonly inventoryIncomplete: boolean;
  /**
   * The read failed for at least one owner. Distinct from a windowed read: this
   * is work that is *missing*, not work that has not arrived yet.
   */
  readonly readFailed: boolean;
  /** A further page exists for the same session. */
  readonly hasMore: boolean;
  /** Owners still being read: known to exist, not yet accounted for. */
  readonly pendingOwners?: number;
  /** Owners whose read failed: their work is missing, not absent. */
  readonly failedOwners?: number;
  /** Owners the server has read to completion across all pages so far. */
  readonly ownersSettled?: readonly string[];
  /** Owners read from the session record rather than a live scope. */
  readonly ownersPersisted?: readonly string[];
  /** A continuation page failed; the rows on screen are still true. */
  readonly lastError?: string;
}

/**
 * The session's background work, from the best source available.
 *
 * The tree summary is the one that knows about agents nobody has opened, so it
 * wins whenever it has arrived. The controller's resident collections are the
 * fallback for a session whose summary has not loaded (or cannot): they cover
 * whatever the reader has already visited, which is fewer agents but real.
 * Neither path is ever presented as the whole tree without its coverage.
 */
export function projectSessionTasks(input: {
  readonly forest: AgentForest;
  /** Whole-tree summary from the server, once loaded. */
  readonly summary?: SessionTaskSummary | undefined;
  /** Per-agent collections the controller already holds. */
  readonly ownerStates?: Readonly<Record<string, readonly Task[] | undefined>>;
  /** Resident task collection coverage, keyed by owner agent. */
  readonly coverage?: Readonly<Record<string, { readonly returned: number; readonly total: number; readonly hasMore: boolean } | undefined>>;
  /**
   * The session's own agent inventory, counted by the server from its metadata
   * rather than from the roster this client happens to hold.
   *
   * This is the only honest denominator before the whole-tree task read
   * arrives: the loaded forest is a page of the session's agents, and a session
   * that has not loaded its older agents has a shorter forest than it had
   * agents. It counts every dispatched agent, main among them, which is the
   * same owner set the task read reports — so it is used as-is.
   *
   * Optional because the snapshot field is optional: an older server sends no
   * counts, and then the coverage says the total is not established instead of
   * substituting the loaded count for the real one.
   */
  readonly agentTotal?: number | undefined;
}): SessionTaskProjection {
  const { forest, summary, ownerStates, coverage, agentTotal } = input;
  const order = treeOrder(forest);
  const rank = new Map(order.map((id, index) => [id, index] as const));
  const rows: SessionTaskRow[] = [];
  const seenTaskIds = new Set<string>();
  let covered = 0;
  let windowed = false;
  if (summary !== undefined) {
    covered = summary.agentsReported;
    windowed = summary.inventoryIncomplete || summary.hasMore;
    for (const entry of summary.rows) {
      if (seenTaskIds.has(entry.task.id)) continue;
      seenTaskIds.add(entry.task.id);
      rows.push({
        task: entry.task,
        // An unattributed row still belongs somewhere: it keeps the session's
        // own id so it sorts with the tree instead of vanishing.
        ownerAgentId: entry.ownerAgentId,
        startedAt: parseTime(entry.task.started_at ?? entry.task.created_at),
        endedAt: parseTime(entry.task.completed_at),
        ownerUnknown: entry.ownerUnknown === true,
        source: entry.source,
      });
    }
  } else {
    for (const ownerAgentId of order) {
      const tasks = ownerStates?.[ownerAgentId];
      if (tasks === undefined) continue;
      covered += 1;
      if (coverage?.[ownerAgentId]?.hasMore === true) windowed = true;
      for (const task of tasks) {
        // One task belongs to one owner. A task id seen under two collections
        // is a shared row, not two pieces of work.
        if (seenTaskIds.has(task.id)) continue;
        seenTaskIds.add(task.id);
        rows.push({
          task,
          ownerAgentId,
          startedAt: parseTime(task.started_at ?? task.created_at),
          endedAt: parseTime(task.completed_at),
          ownerUnknown: false,
          source: undefined,
        });
      }
    }
  }
  const sortRank = (row: SessionTaskRow) => rank.get(row.ownerAgentId) ?? Number.MAX_SAFE_INTEGER;
  rows.sort((a, b) =>
    sortRank(a) - sortRank(b) ||
    (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER) ||
    a.task.id.localeCompare(b.task.id));
  // The denominator, in order of authority:
  //
  // 1. The whole-tree read's own owner count. It counted the owners it
  //    inventoried, so it is the number this coverage is a fraction of.
  // 2. The session's agent inventory, counted over every agent the session
  //    dispatched. This is what makes a cold or partially-loaded session
  //    report its real size instead of the size of the page that is open.
  // 3. Nothing. There is no third option that is a guess in the reader's
  //    favour: the loaded forest is a page of the session's agents, so using
  //    it as the total would claim full coverage for a partial view (and
  //    understate a 60-agent session as 8), and zero would claim no agents at
  //    all. The coverage is marked unknown and the graph says so.
  //
  // Both server counts are on one footing and neither is adjusted: an owner is
  // an agent that can own background work, and main is one of them. The read
  // inventories `new Set(['main', ...live])` and reports `total_owners` as that
  // set's size, and the resident fallback counts main from the same tree the
  // read counts it in. Subtracting one here would put the two sources a whole
  // agent apart, so a main-only session would read as "0 of 0" instead of a
  // complete read of its one owner.
  const total = summary?.agentsTotal ?? agentTotal;
  return {
    rows,
    coverage: {
      covered,
      total,
      // Without a server count there is nothing to be partial *against*: the
      // local tree is not the session, so `covered < order.length` would be
      // comparing a real count against a partial one and calling the result
      // incomplete.
      partial: total === undefined ? false : covered < total,
      windowed,
      /** The server has not said how many owners the session has. */
      totalKnown: total !== undefined,
    },
  };
}

const STATUS_OF: Record<Task['status'], 'running' | 'done' | 'failed' | 'stopped'> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  cancelled: 'stopped',
};

export type SessionTaskState = 'running' | 'done' | 'failed' | 'stopped';

/** The row's own state. A task with no recorded start is still a real row. */
export function taskRowState(row: SessionTaskRow): SessionTaskState {
  return STATUS_OF[row.task.status];
}

/** A task that exists only to represent a dispatch: the agent row says it. */
export function isDispatchTask(task: Task): boolean {
  return task.kind === 'subagent';
}

/** Background work rows for one branch, dispatch rows removed. */
export function backgroundRowsOf(rows: readonly SessionTaskRow[]): readonly SessionTaskRow[] {
  return rows.filter((row) => !isDispatchTask(row.task));
}
