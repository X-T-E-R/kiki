import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ISessionManager } from '@kiki/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalDelegationSeatManager } from '../src/mcp/externalDelegationSeats';

const mocks = vi.hoisted(() => ({
  provision: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  documents: new Map<string, {
    version: 2;
    ownership: 'dedicated';
    principalId: string;
    delegationToken: string;
  }>(),
}));

vi.mock('../src/mcp/externalDelegationAuthority', () => ({
  ensureExternalDelegationSeatSession: mocks.provision,
}));

let homeDir: string;
let workspace: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'kiki-seat-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'kiki-seat-workspace-'));
  mocks.documents.clear();
  mocks.provision.mockImplementation(async (_core, input) => {
    mocks.documents.set(input.sessionId, {
      version: 2,
      ownership: 'dedicated',
      principalId: input.principalId,
      delegationToken: input.delegationToken,
    });
    return {
      workspacePath: input.workspacePath,
      modelAlias: input.modelAlias ?? 'default-model',
      thinkingEffort: input.thinkingEffort ?? 'medium',
      permissionMode: input.permissionMode,
    };
  });
  mocks.acquire.mockImplementation(async (sessionId) => ({
    handle: {
      accessor: {
        get: () => ({
          read: async () => mocks.documents.get(sessionId),
          revoke: async () => { mocks.documents.delete(sessionId); },
        }),
      },
    },
    dispose: mocks.release,
  }));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('ExternalDelegationSeatManager', () => {
  it('creates, persists, reuses, resolves, and revokes a seat', async () => {
    const onWorkspaceServed = vi.fn();
    const core = { accessor: { get: (id: unknown) => id === ISessionManager ? { acquire: mocks.acquire } : undefined } } as never;
    const manager = new ExternalDelegationSeatManager(core, homeDir, onWorkspaceServed);

    const first = await manager.create({ workspace, principal: 'cursor', mode: 'auto' });
    const second = await manager.create({
      workspace,
      principal: 'cursor',
      mode: 'yolo',
      model: 'model-b',
      thinking: 'high',
    });

    expect(second).toMatchObject({
      seatId: first.seatId,
      sessionId: first.sessionId,
      delegationToken: first.delegationToken,
      principal: 'cursor',
      mode: 'yolo',
      model: 'model-b',
      thinking: 'high',
    });
    const listed = await manager.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('delegationToken');
    expect(await manager.resolve(first.sessionId, first.delegationToken)).toEqual({
      seatId: first.seatId,
      principalId: 'cursor',
      sessionId: first.sessionId,
      workspacePath: workspace,
    });
    expect(await manager.resolveBearer(first.delegationToken)).toEqual({
      seatId: first.seatId,
      principalId: 'cursor',
      sessionId: first.sessionId,
      delegationToken: first.delegationToken,
      workspacePath: workspace,
    });
    expect(await manager.resolve(first.sessionId, `${first.delegationToken}x`)).toBeUndefined();
    expect(await manager.resolveBearer(`${first.delegationToken}x`)).toBeUndefined();
    expect(onWorkspaceServed).toHaveBeenCalledTimes(2);

    const restored = new ExternalDelegationSeatManager(core, homeDir, vi.fn());
    expect(await restored.list()).toHaveLength(1);
    expect(await restored.revoke(first.seatId)).toMatchObject({ seatId: first.seatId });
    expect(await restored.resolve(first.sessionId, first.delegationToken)).toBeUndefined();
    expect(mocks.acquire.mock.calls.length).toBe(mocks.release.mock.calls.length);
  });

  it('finds an existing seat with its true token without provisioning or touching the catalog', async () => {
    const onWorkspaceServed = vi.fn();
    const core = { accessor: { get: (id: unknown) => id === ISessionManager ? { acquire: mocks.acquire } : undefined } } as never;
    const manager = new ExternalDelegationSeatManager(core, homeDir, onWorkspaceServed);
    const first = await manager.create({ workspace, principal: 'cursor', mode: 'auto' });
    const catalogPath = join(homeDir, 'server', 'external-delegation-seats.json');
    const before = readFileSync(catalogPath, 'utf8');
    mocks.provision.mockClear();
    mocks.acquire.mockClear();
    mocks.release.mockClear();

    const found = await manager.find({ workspace, principal: 'cursor' });

    expect(found).toMatchObject({
      seatId: first.seatId,
      sessionId: first.sessionId,
      delegationToken: first.delegationToken,
      principal: first.principal,
      workspace: first.workspace,
      updatedAt: first.updatedAt,
    });
    expect(found?.delegationToken).toBe(first.delegationToken);
    expect(found?.seatId).toBe(first.seatId);
    expect(readFileSync(catalogPath, 'utf8')).toBe(before);
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(onWorkspaceServed).toHaveBeenCalledOnce();
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    await expect(manager.find({ workspace, principal: 'missing' })).resolves.toBeUndefined();

    mocks.documents.delete(first.sessionId);
    await expect(manager.find({ workspace, principal: 'cursor' })).rejects.toThrow('External delegation seat provision is unavailable.');
  });
});
