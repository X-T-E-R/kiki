import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEventBus } from '#/app/event/eventBus';
import { type ApprovalRequest, ISessionApprovalService } from '#/session/approval/approval';
import { SessionApprovalService } from '#/session/approval/approvalService';
import { ISessionInteractionService, type InteractionResolution } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import { InteractionResolvedEvent } from '#/session/interaction/interactionOps';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';

const display: ToolInputDisplay = { kind: 'command', command: 'bash' };

const noopEventBus: IEventBus = {
  _serviceBrand: undefined,
  publish: () => undefined,
  subscribe: () => ({ dispose: () => undefined }),
};

function makeRequest(id: string): ApprovalRequest {
  return { id, toolName: 'bash', action: 'run', display };
}

describe('SessionApprovalService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IEventBus, noopEventBus);
    ix.set(ISessionStateService, new SessionStateService());
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
    ix.set(ISessionApprovalService, new SyncDescriptor(SessionApprovalService));
    ix.get(ISessionInteractionService).acquireConsumer('test-consumer');
  });
  afterEach(() => disposables.dispose());

  it('cancels immediately when no approval consumer is present', async () => {
    const interaction = ix.get(ISessionInteractionService);
    interaction.releaseConsumer('test-consumer');

    await expect(ix.get(ISessionApprovalService).request(makeRequest('no-consumer'))).resolves.toEqual({
      decision: 'cancelled',
    });
    expect(interaction.listPending()).toEqual([]);
  });

  it('cancels pending approvals when the last consumer disconnects', async () => {
    const interaction = ix.get(ISessionInteractionService);
    interaction.acquireConsumer('backup-consumer');
    const pending = ix.get(ISessionApprovalService).request(makeRequest('disconnect'));

    interaction.releaseConsumer('test-consumer');
    expect(interaction.listPending('approval')).toHaveLength(1);
    interaction.releaseConsumer('backup-consumer');

    await expect(pending).resolves.toEqual({ decision: 'cancelled' });
    expect(interaction.listPending()).toEqual([]);
  });

  it('fails closed when scoped consumers do not cover the approval origin', async () => {
    const interaction = ix.get(ISessionInteractionService);
    const approvals = ix.get(ISessionApprovalService);
    const agents = new Set(['child-a']);
    interaction.releaseConsumer('test-consumer');
    interaction.acquireConsumer('external-root', {
      kind: 'agent_lineages',
      agents: () => agents,
    });

    const covered = approvals.request({ ...makeRequest('covered'), agentId: 'child-a' });
    await expect(
      approvals.request({ ...makeRequest('other-child'), agentId: 'child-b' }),
    ).resolves.toEqual({ decision: 'cancelled' });
    await expect(approvals.request(makeRequest('main'))).resolves.toEqual({
      decision: 'cancelled',
    });
    expect(interaction.listPending('approval').map((entry) => entry.id)).toEqual(['covered']);

    approvals.decide('covered', { decision: 'approved' });
    await expect(covered).resolves.toEqual({ decision: 'approved' });
  });

  it('request parks until decide resolves it', async () => {
    const svc = ix.get(ISessionApprovalService);
    const req = makeRequest('r1');
    const p = svc.request(req);
    expect(svc.listPending()).toEqual([req]);
    svc.decide('r1', { decision: 'approved' });
    await expect(p).resolves.toEqual({ decision: 'approved' });
    expect(svc.listPending()).toEqual([]);
  });

  it('decide on unknown id is a no-op', () => {
    const svc = ix.get(ISessionApprovalService);
    expect(() => svc.decide('missing', { decision: 'rejected' })).not.toThrow();
  });

  it('enqueue parks a request and returns it with its id without blocking', () => {
    const svc = ix.get(ISessionApprovalService);
    const enqueued = svc.enqueue(makeRequest('r1'));
    expect(enqueued).toEqual({ ...makeRequest('r1'), id: 'r1' });
    expect(svc.listPending()).toEqual([makeRequest('r1')]);
    svc.decide('r1', { decision: 'approved' });
    expect(svc.listPending()).toEqual([]);
  });

  it('mints distinct interaction ids when the provider reuses a toolCallId within one step', async () => {
    const svc = ix.get(ISessionApprovalService);
    const interaction = ix.get(ISessionInteractionService);
    const req = (): ApprovalRequest => ({
      toolCallId: 'Bash_0',
      toolName: 'bash',
      action: 'run',
      display,
    });

    const first = svc.request(req());
    const second = svc.request(req());

    const pending = interaction.listPending();
    expect(pending.map((i) => (i.payload as ApprovalRequest).toolCallId)).toEqual([
      'Bash_0',
      'Bash_0',
    ]);
    const ids = pending.map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.startsWith('approval_'))).toBe(true);

    svc.decide(ids[0]!, { decision: 'approved' });
    svc.decide(ids[1]!, { decision: 'rejected' });
    await expect(first).resolves.toEqual({ decision: 'approved' });
    await expect(second).resolves.toEqual({ decision: 'rejected' });
  });

  it('a toolCallId repeated across steps still gets a fresh id after the first request resolved', async () => {
    const svc = ix.get(ISessionApprovalService);
    const interaction = ix.get(ISessionInteractionService);
    const req = (): ApprovalRequest => ({
      toolCallId: 'Bash_0',
      toolName: 'bash',
      action: 'run',
      display,
    });

    const first = svc.request(req());
    const firstId = interaction.listPending()[0]!.id;
    svc.decide(firstId, { decision: 'approved' });
    await expect(first).resolves.toEqual({ decision: 'approved' });

    const second = svc.request(req());
    const secondId = interaction.listPending()[0]!.id;
    expect(secondId).not.toBe(firstId);
    svc.decide(secondId, { decision: 'approved' });
    await expect(second).resolves.toEqual({ decision: 'approved' });
  });

  it('round-trips exact external option ids and cancels unknown ids', async () => {
    const svc = ix.get(ISessionApprovalService);
    const request = (id: string) => svc.request({
      id,
      toolName: 'external',
      action: 'run',
      display: {
        kind: 'external_permission',
        summary: 'Run external tool',
        options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow_once' }],
      },
    });

    const exact = request('external-exact');
    svc.decide('external-exact', {
      decision: 'approved',
      selectedOptionId: 'allow-once',
    });
    await expect(exact).resolves.toEqual({
      decision: 'approved',
      selectedOptionId: 'allow-once',
    });

    const unknown = request('external-unknown');
    svc.decide('external-unknown', {
      decision: 'approved',
      selectedOptionId: 'unknown',
    });
    await expect(unknown).resolves.toEqual({ decision: 'cancelled' });
  });

  it('keeps SSH credentials out of wire resolution, transcript interaction, and public approvals', async () => {
    const svc = ix.get(ISessionApprovalService);
    const interaction = ix.get(ISessionInteractionService);
    const resolved: InteractionResolution[] = [];
    disposables.add(interaction.onDidResolve((event) => resolved.push(event)));
    const secret = 'TEST_ONLY_SECRET_51e84d';
    const parked = svc.request({ ...makeRequest('ssh-login'), ssh: {
      kind: 'login', hostname: 'example.test', user: 'tester', port: 22,
    } });
    expect(JSON.stringify(svc.listPending())).not.toContain(secret);
    svc.decideSsh('ssh-login', { decision: 'approved' }, { password: secret, save: 'session' });
    await expect(parked).resolves.toEqual({ decision: 'approved' });
    expect(JSON.stringify(resolved)).not.toContain(secret);
    const wire = new InteractionResolvedEvent({ id: resolved[0]!.id, response: resolved[0]!.response });
    expect(JSON.stringify(wire)).not.toContain(secret);
    expect(JSON.stringify(interaction.listPending())).not.toContain(secret);
    expect(svc.takeSshCredential('ssh-login')).toEqual({ password: secret, save: 'session' });
    expect(svc.takeSshCredential('ssh-login')).toBeUndefined();
    const aborted = svc.request({ ...makeRequest('ssh-aborted'), ssh: {
      kind: 'login', hostname: 'example.test', user: 'tester', port: 22,
    } });
    svc.decideSsh('ssh-aborted', { decision: 'approved' }, { password: secret });
    await aborted;
    svc.clearSshCredential('ssh-aborted');
    expect(svc.takeSshCredential('ssh-aborted')).toBeUndefined();
  });

  it('listPending surfaces the minted interaction id so hosts can decide', async () => {
    const svc = ix.get(ISessionApprovalService);

    const parked = svc.request({ toolCallId: 'Bash_0', toolName: 'bash', action: 'run', display });
    const pending = svc.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toMatch(/^approval_/);
    expect(pending[0]!.toolCallId).toBe('Bash_0');

    svc.decide(pending[0]!.id!, { decision: 'approved' });
    await expect(parked).resolves.toEqual({ decision: 'approved' });
  });
});
