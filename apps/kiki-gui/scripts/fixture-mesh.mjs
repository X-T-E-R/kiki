/**
 * Fixture stand-in for the session Mesh REST surface (kap-server routes/mesh.ts).
 *
 * Scenario seeds (all optional):
 *   mesh: {
 *     sessions: {
 *       [sessionId]: {
 *         nodes?: LeasedPeerNode[],
 *         seats?: LeasedSeat[],
 *         workspaceCopies?: LeasedWorkspaceCopy[],
 *         portTunnels?: LeasedPortTunnel[],
 *       }
 *     },
 *     takeovers: {
 *       [targetId]: {
 *         holder: 'human' | 'orchestrator',
 *         epoch?: number,
 *         ttlMs?: number,
 *         reason?: string,
 *       }
 *     }
 *   }
 */

function state(server) {
  if (server.mesh === undefined || server.mesh.scenario !== server.scenario?.name) {
    const seed = structuredClone(server.scenario?.data.mesh ?? {});
    server.mesh = {
      scenario: server.scenario?.name,
      sessions: seed.sessions ?? {},
      takeovers: seed.takeovers ?? {},
      revision: 1,
    };
  }
  return server.mesh;
}

function projectSession(mesh, sessionId) {
  const entry = mesh.sessions[sessionId] ?? {};
  const lease = {
    sessionId,
    revision: mesh.revision,
    epoch: 1,
    updatedAt: Date.now(),
    nodes: entry.nodes ?? [],
    seats: entry.seats ?? [],
    workspaceCopies: entry.workspaceCopies ?? [],
    portTunnels: entry.portTunnels ?? [],
  };
  return {
    sessionId,
    revision: mesh.revision,
    contextBlock: null,
    byteLength: 0,
    lease,
  };
}

export function handleMesh(server, res, path, method, body) {
  const mesh = state(server);

  const leaseMatch = /^\/mesh\/sessions\/([^/]+)\/leases(?:\/(unpin|renew))?$/.exec(path);
  if (leaseMatch !== null) {
    const sessionId = decodeURIComponent(leaseMatch[1]);
    const action = leaseMatch[2];
    if (action === undefined && method === 'GET') {
      server.envelope(res, projectSession(mesh, sessionId));
      return true;
    }
    if (action === 'unpin' && method === 'POST') {
      const entry = (mesh.sessions[sessionId] ??= { nodes: [], seats: [], workspaceCopies: [], portTunnels: [] });
      const kind = body?.kind;
      const id = body?.id;
      if (kind === 'node') entry.nodes = (entry.nodes ?? []).filter((n) => n.nodeId !== id);
      else if (kind === 'seat') entry.seats = (entry.seats ?? []).filter((s) => s.seatId !== id);
      else if (kind === 'workspace_copy') entry.workspaceCopies = (entry.workspaceCopies ?? []).filter((c) => c.copyId !== id);
      else if (kind === 'port_tunnel') entry.portTunnels = (entry.portTunnels ?? []).filter((t) => t.tunnelId !== id);
      mesh.revision += 1;
      server.envelope(res, projectSession(mesh, sessionId));
      return true;
    }
    if (action === 'renew' && method === 'POST') {
      mesh.revision += 1;
      server.envelope(res, projectSession(mesh, sessionId));
      return true;
    }
  }

  const tunnelMatch = /^\/mesh\/tunnels\/([^/]+)$/.exec(path);
  if (tunnelMatch !== null && method === 'DELETE') {
    const tunnelId = decodeURIComponent(tunnelMatch[1]);
    let closed = false;
    for (const entry of Object.values(mesh.sessions)) {
      if (Array.isArray(entry.portTunnels)) {
        const before = entry.portTunnels.length;
        entry.portTunnels = entry.portTunnels.filter((t) => t.tunnelId !== tunnelId);
        if (entry.portTunnels.length !== before) closed = true;
      }
    }
    server.envelope(res, { closed });
    return true;
  }

  const takeoverMatch = /^\/mesh\/takeover\/([^/]+)$/.exec(path);
  if (takeoverMatch !== null && method === 'GET') {
    const targetId = decodeURIComponent(takeoverMatch[1]);
    const seeded = mesh.takeovers[targetId];
    if (seeded === undefined || seeded === null) {
      server.envelope(res, { lease: null, epoch: 0 });
      return true;
    }
    const now = Date.now();
    const epoch = seeded.epoch ?? 1;
    const ttlMs = seeded.ttlMs ?? 300_000;
    server.envelope(res, {
      lease: {
        targetId,
        holder: seeded.holder ?? 'human',
        epoch,
        acquiredAt: seeded.acquiredAt ?? (now - 5_000),
        expiresAt: seeded.expiresAt ?? (now + ttlMs),
        ...(seeded.reason === undefined ? {} : { reason: seeded.reason }),
      },
      epoch,
    });
    return true;
  }

  return false;
}
