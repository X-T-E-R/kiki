import { describe, expect, it, vi } from 'vitest';
import { registerMetaRoute } from '../src/routes/meta';
import { metaResponseSchema } from '../src/protocol/rest-meta';

const base = {
  serverVersion: 'test', serverId: 'server-a',
  serverHomeId: '46aca369-50e8-4fd3-9c45-606d084450ed',
  startedAt: '2026-06-04T10:30:00.000Z', enableTerminals: false,
  dangerousBypassAuth: false, externalDelegation: { state: 'active' as const },
  getExperimentalFlags: () => ({}), getFeatures: () => [],
};

describe('meta current registry space identity', () => {
  it.each(['main', 'h-remote'])('reports %s without replacing the UUID home identity', async (currentSpaceId) => {
    const get = vi.fn<Parameters<typeof registerMetaRoute>[0]['get']>();
    registerMetaRoute({ get }, { ...base, currentSpaceId });
    const [path, , handler] = get.mock.calls[0]!;
    expect(path).toBe('/meta');
    const send = vi.fn();
    await handler({ id: 'request-1' }, { send });
    const payload = send.mock.calls[0]![0] as { data: unknown };
    expect(metaResponseSchema.parse(payload.data)).toMatchObject({
      server_id: 'server-a', server_home_id: base.serverHomeId,
      current_space_id: currentSpaceId,
    });
  });

  it('does not invent a current space for an older metadata payload', () => {
    expect(metaResponseSchema.parse({
      server_version: 'old', server_id: 'old-server', started_at: base.startedAt,
      capabilities: { websocket: true, file_upload: true, fs_query: true, mcp: true, tasks: true, thread_communication: true },
      open_in_apps: [], dangerous_bypass_auth: false, external_delegation: base.externalDelegation,
    }).current_space_id).toBeUndefined();
  });
});
