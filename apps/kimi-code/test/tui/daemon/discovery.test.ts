import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  discoverDaemon,
  ensureDaemon,
  resolveDaemonHome,
} from '#/tui/daemon/discovery';

const mocks = vi.hoisted(() => ({
  ensureServer: vi.fn(),
  findReachableServer: vi.fn(),
  resolveKikiHome: vi.fn(),
}));

vi.mock('#/kiki/serve', () => ({
  ensureServer: mocks.ensureServer,
  findReachableServer: mocks.findReachableServer,
}));

vi.mock('#/kiki/home', () => ({
  resolveKikiHome: mocks.resolveKikiHome,
}));

describe('daemon discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveKikiHome.mockReturnValue('C:\\home\\.kiki');
  });

  it('uses the shared Kiki home resolver', () => {
    const env = { KIKI_HOME: 'C:\\custom' };

    expect(resolveDaemonHome(env)).toBe('C:\\home\\.kiki');
    expect(mocks.resolveKikiHome).toHaveBeenCalledWith(undefined, env);
  });

  it('discovers through the shared server registry and token contract', async () => {
    mocks.findReachableServer.mockResolvedValue({
      url: 'http://127.0.0.1:57580',
      token: 'token',
      serverId: 'server-1',
    });

    await expect(discoverDaemon('C:\\home', 'C:\\repo')).resolves.toEqual({
      url: 'http://127.0.0.1:57580',
      token: 'token',
      serverId: 'server-1',
    });
    expect(mocks.findReachableServer).toHaveBeenCalledWith('C:\\home', 'C:\\repo');
  });

  it('uses kiki serve ensure semantics with the same home and workspace', async () => {
    mocks.ensureServer.mockResolvedValue({
      url: 'http://127.0.0.1:57580',
      token: 'token',
      serverId: 'server-1',
    });

    await expect(
      ensureDaemon({ homeDir: 'C:\\home', workspacePath: 'C:\\repo' }),
    ).resolves.toEqual({
      url: 'http://127.0.0.1:57580',
      token: 'token',
      serverId: 'server-1',
    });
    expect(mocks.ensureServer).toHaveBeenCalledWith({
      homeDir: 'C:\\home',
      workspace: 'C:\\repo',
    });
  });
});
