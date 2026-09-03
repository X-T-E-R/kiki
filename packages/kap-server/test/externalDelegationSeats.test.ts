import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalDelegationSeatManager } from '../src/mcp/externalDelegationSeats';

const provision = vi.hoisted(() => vi.fn());

vi.mock('../src/mcp/externalDelegationAuthority', () => ({
  ensureExternalDelegationSeatSession: provision,
}));

let homeDir: string;
let workspace: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'kiki-seat-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'kiki-seat-workspace-'));
  provision.mockImplementation(async (_core, input) => ({
    workspacePath: input.workspacePath,
    modelAlias: input.modelAlias ?? 'default-model',
    thinkingEffort: input.thinkingEffort ?? 'medium',
    permissionMode: input.permissionMode,
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
    const manager = new ExternalDelegationSeatManager({} as never, homeDir, onWorkspaceServed);

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
      principalId: 'cursor',
      sessionId: first.sessionId,
    });
    expect(await manager.resolve(first.sessionId, `${first.delegationToken}x`)).toBeUndefined();
    expect(onWorkspaceServed).toHaveBeenCalledTimes(2);

    const restored = new ExternalDelegationSeatManager({} as never, homeDir, vi.fn());
    expect(await restored.list()).toHaveLength(1);
    expect(await restored.revoke(first.seatId)).toMatchObject({ seatId: first.seatId });
    expect(await restored.resolve(first.sessionId, first.delegationToken)).toBeUndefined();
  });
});
