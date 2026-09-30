/**
 * Fixture stand-in for the worktree routes (kap-server routes/worktrees.ts)
 * and the session-create `isolation` option. State is per scenario:
 *
 *   worktrees: WorktreeRecord[]          // registry rows, wire shape
 *   worktreeInspections: { [id]: WorktreeInspection-without-inspectedAt }
 *   worktreeRemoveFailures: { [id]: 'failed' | 'failed_busy' }  // removal fails, checkout kept
 *   gitRoots: [absolute folder, …]       // workspace roots reported as Git checkouts
 *
 * Removal follows the server's order of checks: active owner → retained_in_use,
 * a scripted failure → failed / failed_busy (state remove_failed), loss without
 * a matching confirmation → retained_dirty / retained_unpushed / retained_ignored,
 * a confirmation that differs from the last inspection → the "inspection changed"
 * error. GC removes only archived-for-7-days, loss-free rows.
 */

const DAY = 86_400_000;

function inspectionOf(server, id) {
  const seeded = server.worktreeInspections.get(id);
  return { inspectedAt: Date.now(), failed: false, dirtyFiles: 0, untrackedFiles: 0, aheadOfBase: 0, unpushedCommits: 0, ignoredNonDisposable: [], ...seeded };
}

function lossOf(inspection) {
  return { dirty: inspection.dirtyFiles > 0, ignored: inspection.ignoredNonDisposable.length > 0, unpushed: inspection.unpushedCommits > 0 };
}

function ownerSession(server, record) {
  return server.sessions.get(record.owner.sessionId)?.record;
}

function removeOutcome(server, record, request, trigger, dryRun) {
  if (record.state === 'removed') return 'removed';
  const owner = ownerSession(server, record);
  if (owner !== undefined && owner.archived !== true) return 'retained_in_use';
  const failure = server.worktreeRemoveFailures.get(record.id);
  const inspection = inspectionOf(server, record.id);
  const loss = lossOf(inspection);
  if (trigger === 'user' && request.confirmLoss !== undefined) {
    const previous = record.lastInspection;
    const matches = previous !== undefined && !previous.failed
      && previous.dirtyFiles === inspection.dirtyFiles && previous.unpushedCommits === inspection.unpushedCommits
      && JSON.stringify(previous.ignoredNonDisposable) === JSON.stringify(inspection.ignoredNonDisposable)
      && Object.entries(loss).every(([key, value]) => request.confirmLoss[key] === value);
    if (!matches) throw Object.assign(new Error('worktree inspection changed; inspect again before confirming loss'), { code: 40001 });
  }
  if (loss.dirty && request.confirmLoss?.dirty !== true) return 'retained_dirty';
  if (loss.unpushed && request.confirmLoss?.unpushed !== true) return 'retained_unpushed';
  if (loss.ignored && request.confirmLoss?.ignored !== true) return 'retained_ignored';
  if (dryRun) return 'removed';
  return failure ?? 'removed';
}

function finish(server, record, outcome, trigger) {
  const next = {
    ...record,
    state: outcome === 'removed' ? 'removed' : outcome.startsWith('failed') ? 'remove_failed' : record.state,
    removal: { requestedAt: Date.now(), trigger, outcome },
    updatedAt: Date.now(),
  };
  server.worktreeRecords.set(record.id, next);
  return outcome;
}

/** Reset per-scenario state; called from FixtureServer.loadScenario. */
export function loadWorktrees(server, data) {
  server.worktreeRecords = new Map((structuredClone(data.worktrees ?? [])).map((record) => [record.id, record]));
  server.worktreeInspections = new Map(Object.entries(structuredClone(data.worktreeInspections ?? {})));
  server.worktreeRemoveFailures = new Map(Object.entries(data.worktreeRemoveFailures ?? {}));
  server.gitRoots = new Set((data.gitRoots ?? []).map((root) => root.replaceAll('\\', '/').replace(/\/+$/, '')));
  server.lastSessionCreate = null;
}

/** Host folder browser listing: a `.git` entry for seeded Git roots. */
export function browseFolder(server, path) {
  const root = String(path ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
  const entries = server.gitRoots?.has(root) ? [{ name: '.git', path: `${root}/.git`, is_dir: true }] : [];
  return { path: root, parent: null, entries: [...entries, { name: 'src', path: `${root}/src`, is_dir: true }] };
}

/**
 * `POST /sessions` with `isolation`: registers a ready worktree for the new
 * session and returns the `Session.worktree` projection plus the checkout cwd.
 * Non-Git sources fail like the server does.
 */
export function createWorktreeForSession(server, sessionId, workspace, isolation) {
  const sourceRoot = String(workspace.root).replaceAll('\\', '/');
  if (!server.gitRoots.has(sourceRoot.replace(/\/+$/, ''))) {
    throw Object.assign(new Error('worktree source must be a git root'), { code: 50001 });
  }
  const suffix = Math.random().toString(16).slice(2, 8);
  const id = `wt_fx_${suffix}`;
  const branch = isolation.branch ?? `kiki/new-session-${suffix}`;
  const path = `C:/Users/fixture/.kiki/worktrees/1a2b3c4d/${suffix}`;
  const now = Date.now();
  server.worktreeRecords.set(id, {
    id, version: 1,
    repo: { fingerprint: '1a2b3c4d', commonDir: `${sourceRoot}/.git`, sourceRoot, workspaceId: workspace.id },
    path, branch, branchCreated: true,
    base: { mode: 'head', ref: 'HEAD', commit: '0f3c9a1' },
    owner: { kind: 'session', sessionId },
    state: 'ready', createdAt: now, updatedAt: now,
  });
  return { cwd: path, worktree: { worktree_id: id, branch, source_root: sourceRoot, base_ref: 'HEAD' } };
}

/** Handle `/worktrees…`; returns true when it answered. */
export function handleWorktrees(server, res, path, query, body, method) {
  if (path !== '/worktrees' && !path.startsWith('/worktrees/') && !path.startsWith('/worktrees:')) return false;
  const records = server.worktreeRecords;
  if (path === '/worktrees' && method === 'GET') {
    const workspaceId = query.get('workspace_id');
    const state = query.get('state');
    const worktrees = [...records.values()].filter((record) =>
      (workspaceId === null || record.repo.workspaceId === workspaceId) && (state === null || record.state === state));
    server.envelope(res, { worktrees });
    return true;
  }
  if (path === '/worktrees:gc' && method === 'POST') {
    const dryRun = body?.dryRun === true;
    const candidates = [];
    for (const record of [...records.values()]) {
      if (!['ready', 'remove_failed'].includes(record.state)) continue;
      const owner = ownerSession(server, record);
      if (owner !== undefined && owner.archived !== true) continue;
      const archivedAt = Date.parse(owner?.archived_at ?? owner?.updated_at ?? '') || record.updatedAt;
      if (Date.now() - archivedAt < 7 * DAY) continue;
      const outcome = removeOutcome(server, record, {}, 'gc', dryRun);
      candidates.push({ id: record.id, outcome: dryRun ? outcome : finish(server, record, outcome, 'gc') });
    }
    server.envelope(res, { candidates });
    return true;
  }
  const match = /^\/worktrees\/([^/:]+)(?::(inspect|remove))?$/.exec(path);
  const record = match === null ? undefined : records.get(decodeURIComponent(match[1]));
  if (match === null || record === undefined) {
    server.envelope(res, null, 40001, 'worktree not found');
    return true;
  }
  if (match[2] === undefined && method === 'GET') {
    server.envelope(res, record);
    return true;
  }
  if (match[2] === 'inspect' && method === 'POST') {
    const inspection = inspectionOf(server, record.id);
    records.set(record.id, { ...record, lastInspection: inspection, updatedAt: Date.now() });
    server.envelope(res, inspection);
    return true;
  }
  if (match[2] === 'remove' && method === 'POST') {
    try {
      const outcome = removeOutcome(server, record, body ?? {}, 'user', false);
      server.envelope(res, { outcome: finish(server, record, outcome, 'user') });
    } catch (error) {
      server.envelope(res, null, error.code ?? 40001, error.message);
    }
    return true;
  }
  server.envelope(res, null, 40001, 'unsupported worktree action');
  return true;
}
