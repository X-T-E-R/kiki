import { afterEach, describe, expect, it } from 'vitest';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IWorkAdmissionService } from '#/app/workAdmission/workAdmission';
import { WorkAdmissionService } from '#/app/workAdmission/workAdmissionService';
import { deferred } from '../../deferred';

const containers: DisposableStore[] = [];
afterEach(async () => {
  for (const container of containers.splice(0)) await container.dispose();
});

function host() {
  const disposables = new DisposableStore();
  containers.push(disposables);
  const services = createServices(disposables, { strict: true, additionalServices: reg => reg.define(IWorkAdmissionService, WorkAdmissionService) });
  return { admission: services.get(IWorkAdmissionService) };
}

describe('work admission', () => {
  it('fences synchronously and joins preparation already waiting before the fence', async () => {
    const ctx = host();
    const prepared = deferred<void>();
    const completed = deferred<void>();
    const work = ctx.admission.run('rest-prompt', async () => {
      await prepared.promise;
      await ctx.admission.run('engine-prompt', () => completed.promise);
    });
    ctx.admission.fence('switch-1');
    expect(() => ctx.admission.acquire('mcp-prompt')).toThrow('Waiting to send');
    let joined = false;
    const joining = ctx.admission.joined().then(() => { joined = true; });
    prepared.resolve();
    await Promise.resolve();
    expect(joined).toBe(false);
    completed.resolve();
    await work;
    await joining;
    expect(joined).toBe(true);
    ctx.admission.reopen('switch-1');
    ctx.admission.acquire('new-input').dispose();
  });

  it('keeps accepted queued work valid but detaches automatic new work from its preparation', async () => {
    const ctx = host();
    const completed = deferred<void>();
    const admission = ctx.admission.acquire('accepted-prompt');
    admission.hold(completed.promise);
    admission.dispose();
    ctx.admission.fence('switch-2');
    admission.run(() => {
      ctx.admission.acquire('queued-launch').dispose();
      expect(() => ctx.admission.detach(() => ctx.admission.acquire('new-agent-run'))).toThrow('Waiting to send');
    });
    expect(ctx.admission.state().pending).toHaveLength(1);
    completed.resolve();
    await ctx.admission.joined();
    expect(() => admission.run(() => undefined)).toThrow('has ended');
    expect(() => ctx.admission.reopen('different-switch')).toThrow('identity changed');
  });

  it('keeps one switch owner until that owner reopens admission', () => {
    const { admission } = host();
    expect(() => admission.fence('')).toThrow('Another server switch');
    admission.fence('switch-owner');
    admission.fence('switch-owner');
    expect(() => admission.fence('switch-other')).toThrow('Another server switch');
    expect(() => admission.reopen('switch-other')).toThrow('identity changed');
    expect(admission.state()).toEqual({ operationId: 'switch-owner', pending: [] });
    admission.reopen('switch-owner');
    expect(admission.state()).toEqual({ operationId: undefined, pending: [] });
  });

  it('releases a failed preparation and each held completion or early hold disposal exactly once', async () => {
    const { admission } = host();
    await expect(admission.run('failed-prepare', () => { throw new Error('prepare failed'); })).rejects.toThrow('prepare failed');
    expect(admission.state().pending).toHaveLength(0);
    const first = deferred<void>();
    const second = deferred<void>();
    const work = admission.acquire('accepted');
    const hold1 = work.hold(first.promise);
    const hold2 = work.hold(second.promise);
    work.dispose();
    work.dispose();
    admission.fence('switch-rejection');
    first.reject(new Error('completion failed'));
    await Promise.resolve();
    hold1.dispose();
    expect(admission.state().pending).toHaveLength(1);
    hold2.dispose();
    hold2.dispose();
    await admission.joined();
    second.resolve();
    await Promise.resolve();
    expect(admission.state().pending).toHaveLength(0);
    expect(() => work.hold(Promise.resolve())).toThrow('has ended');
  });

  it('joins every independent admission without leaking a mutable state view', async () => {
    const { admission } = host();
    const first = admission.acquire('first');
    const second = admission.acquire('second');
    const view = admission.state();
    expect(view.pending.map(item => item.kind)).toEqual(['first', 'second']);
    admission.fence('switch-all');
    let joined = false;
    const joining = admission.joined().then(() => { joined = true; });
    first.dispose();
    await Promise.resolve();
    expect(joined).toBe(false);
    expect(admission.state().pending.map(item => item.kind)).toEqual(['second']);
    expect(view.pending.map(item => item.kind)).toEqual(['first', 'second']);
    second.dispose();
    await joining;
    expect(joined).toBe(true);
  });

  it('does not let an ended asynchronous preparation reopen work through its old context', async () => {
    const { admission } = host();
    const later = deferred<void>();
    const work = admission.acquire('preparation');
    const lateAttempt = work.run(async () => {
      await later.promise;
      admission.acquire('late-work').dispose();
    });
    work.dispose();
    admission.fence('switch-stale');
    later.resolve();
    await expect(lateAttempt).rejects.toThrow('Waiting to send');
    await admission.joined();
    expect(admission.state().pending).toHaveLength(0);
  });
});
