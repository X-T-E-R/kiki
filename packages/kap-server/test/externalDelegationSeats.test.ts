import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalDelegationSeatManager } from '../src/mcp/externalDelegationSeats';

const mocks = vi.hoisted(() => ({
  provision: vi.fn(),
  resume: vi.fn(),
  documents: new Map<string, {
    version: 2;
    ownership: 'dedicated';
    principalId: string;
    delegationToken: string;
  }>(),
}));

vi.mock('@moonshot-ai/agent-core-v2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/agent-core-v2')>();
  return { ...actual, resumeSessionById: mocks.resume };
});

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
  mocks.resume.mockImplementation(async (_accessor, sessionId) => ({
    accessor: {
      get: () => ({
        read: async () => mocks.documents.get(sessionId),
        revoke: async () => {
          mocks.documents.delete(sessionId);
        },
      }),
    },
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
    expect(await manager.resolveBearer(first.delegationToken)).toEqual({
      sessionId: first.sessionId,
      delegationToken: first.delegationToken,
      workspacePath: workspace,
    });
    expect(await manager.resolve(first.sessionId, `${first.delegationToken}x`)).toBeUndefined();
    expect(await manager.resolveBearer(`${first.delegationToken}x`)).toBeUndefined();
    expect(onWorkspaceServed).toHaveBeenCalledTimes(2);

    const restored = new ExternalDelegationSeatManager({} as never, homeDir, vi.fn());
    expect(await restored.list()).toHaveLength(1);
    expect(await restored.revoke(first.seatId)).toMatchObject({ seatId: first.seatId });
    expect(await restored.resolve(first.sessionId, first.delegationToken)).toBeUndefined();
  });
});
