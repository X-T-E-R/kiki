/**
 * Fixture stand-in for the native SSH REST surface (kap-server routes/ssh.ts;
 * contract: analyses/2026-09-28-kiki-ssh-rest-contract.md). Wired routes only:
 * host list/discover/CRUD, config sync, connection approval, write-back,
 * status, disconnect, session join/leave, and the SSH-only approval POST.
 *
 * Scenario seeds (all optional):
 *   ssh: {
 *     hosts:        SshHost[]            — Kiki hosts (source "kiki")
 *     config:       string[]             — aliases "discovered" in ~/.ssh/config
 *     syncConfig:   boolean              — sync_ssh_config, default true
 *     syncSource:   'home'|'base'|'default' — where that value is stored
 *     approval:     boolean              — connection approval, default true
 *     status:       { [id]: state }      — connection state per host
 *     session:      { [sessionId]: string[] }  — joined host ids
 *     temporary:    { [sessionId]: SshHost[] } — session-only user@host targets
 *     writeBackTaken: string[]           — aliases already in ~/.ssh/config
 *     hostKeys:     { [id]: SshHostKeys } — the payload `GET
 *                   /ssh/hosts/{id}:host-keys` returns for that host; a host
 *                   without an entry is a fixture error, so every state a walk
 *                   reaches is written down here instead of being invented.
 *   }
 *
 * The SSH approval POST records the body shape (never the secret values) in
 * `server.sshSubmissions` for walker assertions, then resolves the approval.
 */

function state(server) {
  if (server.ssh === undefined || server.ssh.scenario !== server.scenario?.name) {
    const seed = structuredClone(server.scenario?.data.ssh ?? {});
    server.ssh = {
      scenario: server.scenario?.name,
      hosts: seed.hosts ?? [],
      config: seed.config ?? [],
      sync: seed.syncConfig ?? true,
      syncSource: seed.syncSource ?? 'home',
      approval: seed.approval ?? true,
      status: seed.status ?? {},
      session: seed.session ?? {},
      temporary: seed.temporary ?? {},
      hostKeys: seed.hostKeys ?? {},
      written: new Set(seed.writeBackTaken ?? []),
    };
    server.sshSubmissions = [];
  }
  return server.ssh;
}

function listHosts(ssh) {
  const byId = new Map();
  if (ssh.sync) for (const alias of ssh.config) byId.set(alias, { id: alias, name: alias, source: 'ssh-config' });
  for (const host of ssh.hosts) byId.set(host.id, { ...host, source: 'kiki' });
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function statusOf(ssh, id) {
  return { hostId: id, state: ssh.status[id] ?? 'idle', generation: 1 };
}

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Shape of an SSH submission with every secret replaced by its length. */
function redact(body) {
  const credential = body?.credential;
  if (credential === undefined) return { decision: body?.decision };
  const shape = {};
  for (const [key, value] of Object.entries(credential)) {
    if (key === 'save') shape.save = value;
    else if (key === 'answers') shape.answers = value.map((answer) => answer.length);
    else shape[key] = typeof value === 'string' ? value.length : value;
  }
  return { decision: body.decision, credential: shape };
}

/** Returns true when the request was handled. */
export function handleSsh(server, res, path, query, method, body) {
  const ssh = state(server);

  if (path === '/ssh/hosts' && method === 'GET') {
    server.envelope(res, { hosts: listHosts(ssh) });
    return true;
  }
  if (path === '/ssh/hosts:discover') {
    server.envelope(res, { hosts: ssh.config.map((alias) => ({ id: alias, name: alias, source: 'ssh-config' })) });
    return true;
  }
  if (path === '/ssh/config-sync') {
    if (method === 'PUT') {
      ssh.sync = body?.enabled === true;
      ssh.syncSource = 'home';
    }
    server.envelope(res, { enabled: ssh.sync, source: ssh.syncSource });
    return true;
  }
  if (path === '/ssh/connection-approval') {
    if (method === 'PUT') ssh.approval = body?.enabled !== false;
    server.envelope(res, { enabled: ssh.approval });
    return true;
  }

  const hostMatch = /^\/ssh\/hosts\/([^/:]+)(?::([a-z-]+))?$/.exec(path);
  if (hostMatch !== null) {
    const id = decodeURIComponent(hostMatch[1]);
    const action = hostMatch[2];
    const known = listHosts(ssh).find((host) => host.id === id);
    if (action === undefined && method === 'PUT') {
      if (!ALIAS.test(id)) { server.envelope(res, null, 40001, 'Invalid SSH host alias'); return true; }
      if (typeof body?.name !== 'string' || body.name.trim() === '') { server.envelope(res, null, 40001, 'SSH host name is required'); return true; }
      if (Array.isArray(body.roots) && body.roots.some((root) => !String(root).startsWith('/'))) {
        server.envelope(res, null, 40001, 'SSH roots must be absolute POSIX paths');
        return true;
      }
      const { source: _source, id: _id, ...input } = body;
      ssh.hosts = [...ssh.hosts.filter((host) => host.id !== id), { id, ...input }];
      server.envelope(res, { host: { id, ...input, source: 'kiki' } });
      return true;
    }
    if (action === undefined && method === 'DELETE') {
      ssh.hosts = ssh.hosts.filter((host) => host.id !== id);
      server.envelope(res, { removed: true });
      return true;
    }
    if (known === undefined) { server.envelope(res, null, 40424, 'Unknown SSH host'); return true; }
    if (action === 'status') { server.envelope(res, statusOf(ssh, id)); return true; }
    if (action === 'host-keys') {
      // Read-only over known_hosts; the seed carries finished payloads because
      // the fixture opens no connection and reads no real file.
      const seeded = ssh.hostKeys[id];
      if (seeded === undefined) { server.envelope(res, null, 40001, `fixture: no host keys seeded for ${id}`); return true; }
      server.envelope(res, { hostId: id, ...seeded });
      return true;
    }
    if (action === 'disconnect') {
      ssh.status[id] = 'disconnected';
      server.envelope(res, { disconnected: true });
      return true;
    }
    if (action === 'write-back') {
      if (known.source !== 'kiki' || known.hostname === undefined || known.user === undefined) {
        server.envelope(res, null, 40001, 'Only Kiki hosts with explicit hostname and user can be written back');
        return true;
      }
      if (ssh.written.has(id) || ssh.config.includes(id)) {
        server.envelope(res, null, 40001, `Host ${id} already exists in ~/.ssh/config`);
        return true;
      }
      ssh.written.add(id);
      server.envelope(res, { written: true });
      return true;
    }
  }

  const sessionMatch = /^\/sessions\/([^/:]+)\/ssh\/(hosts|approvals)(?:\/([^/]+))?$/.exec(path);
  if (sessionMatch === null) return false;
  const sessionId = sessionMatch[1];
  const session = server.sessions.get(sessionId);
  if (session === undefined) { server.envelope(res, null, 40401, 'session.not_found'); return true; }

  if (sessionMatch[2] === 'approvals') {
    const approvalId = sessionMatch[3];
    const approval = session.pendingApprovals.find((entry) => entry.approval_id === approvalId);
    if (approval === undefined || approval.ssh === undefined) {
      server.envelope(res, null, 40001, 'No pending SSH approval with this id');
      return true;
    }
    const decision = body?.decision;
    if (!['approved', 'rejected', 'cancelled'].includes(decision)) { server.envelope(res, null, 40001, 'validation_failed'); return true; }
    if (body.credential !== undefined && (decision !== 'approved' || approval.ssh.kind !== 'login')) {
      server.envelope(res, null, 40001, 'Credentials are only accepted when approving a login');
      return true;
    }
    const prompts = approval.ssh.prompts ?? [];
    if (prompts.length > 0 && decision === 'approved' && (body.credential?.answers?.length ?? -1) !== prompts.length) {
      server.envelope(res, null, 40001, 'answers must match prompts');
      return true;
    }
    server.sshSubmissions.push({ approval_id: approvalId, kind: approval.ssh.kind, ...redact(body) });
    session.pendingApprovals = session.pendingApprovals.filter((entry) => entry.approval_id !== approvalId);
    if (session.pendingApprovals.length === 0) session.record.pending_interaction = 'none';
    session.resolvedInteractions.set(approvalId, decision === 'approved' ? 'approved' : decision === 'cancelled' ? 'cancelled' : 'rejected');
    server.emit(sessionId, {
      type: 'event.approval.resolved',
      agentId: approval.agentId ?? 'main',
      payload: { approval_id: approvalId, tool_call_id: approval.tool_call_id, decision, resolved_at: new Date().toISOString() },
    });
    server.resolveWaiters(session, 'approval');
    // A queued follow-up (the next keyboard-interactive round) arrives after the answer.
    const next = (server.scenario?.data.sshFollowUps ?? {})[approvalId];
    if (next !== undefined && decision === 'approved') {
      setTimeout(() => {
        // emit() only broadcasts; record the round as pending like a real gate would.
        const frame = { type: 'event.approval.requested', agentId: 'main', payload: { ...next, session_id: sessionId } };
        server.applySideEffects(session, frame);
        server.emit(sessionId, frame);
      }, 300);
    }
    server.envelope(res, { resolved: true });
    return true;
  }

  const joined = (ssh.session[sessionId] ??= []);
  const temporary = ssh.temporary[sessionId] ?? [];
  const hostId = sessionMatch[3] === undefined ? undefined : decodeURIComponent(sessionMatch[3]);
  if (hostId === undefined && method === 'GET') {
    const all = [...listHosts(ssh), ...temporary.map((host) => ({ ...host, source: 'session' }))];
    server.envelope(res, {
      hosts: all.filter((host) => joined.includes(host.id)).map((host) => ({ host, status: statusOf(ssh, host.id) })),
    });
    return true;
  }
  if (hostId !== undefined && method === 'PUT') {
    const host = listHosts(ssh).find((entry) => entry.id === hostId);
    if (host === undefined) { server.envelope(res, null, 40424, 'Unknown SSH host'); return true; }
    if (!joined.includes(hostId)) joined.push(hostId);
    server.envelope(res, { host });
    return true;
  }
  if (hostId !== undefined && method === 'DELETE') {
    ssh.session[sessionId] = joined.filter((id) => id !== hostId);
    ssh.temporary[sessionId] = temporary.filter((host) => host.id !== hostId);
    server.envelope(res, { removed: true });
    return true;
  }
  return false;
}
