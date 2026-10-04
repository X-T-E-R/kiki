import { describe, expect, it } from 'vitest';
import { ISessionManager, ISessionActivityView, type Scope } from '@kiki/agent-core-v2';
import { Emitter } from '@kiki/agent-core-v2/_base/event';
import type { ISessionScopeHandle } from '@kiki/agent-core-v2/_base/di/scope';
import type { SessionActivityState, SessionActivityChangedEvent } from '@kiki/agent-core-v2/session/sessionActivity/sessionActivity';
import { SpaceSummaryProjection } from '../src/services/connections/spaceSummary';

describe('thin space summary projection', () => {
  it('counts busy and pending threads once and changes revision only on lifecycle/activity events', () => {
    const created = new Emitter<{ sessionId: string }>(); const closed = new Emitter<{ sessionId: string }>();
    const entries = new Map<string, { handle: ISessionScopeHandle; state: SessionActivityState; changed: Emitter<SessionActivityChangedEvent> }>();
    const add = (id: string, state: SessionActivityState) => {
      const changed = new Emitter<SessionActivityChangedEvent>();
      const entry = { handle: undefined as unknown as ISessionScopeHandle, state, changed };
      entry.handle = { id, accessor: { get(service: unknown) {
        if (service !== ISessionActivityView) throw new Error('Summary must not read agents, transcripts or indexes');
        return { state: () => entry.state, onDidChange: changed.event };
      } } } as unknown as ISessionScopeHandle;
      entries.set(id, entry); return entry;
    };
    add('busy-and-approval', { busy: true, mainTurnActive: false, pendingInteraction: 'approval' });
    add('busy-main', { busy: true, mainTurnActive: true, pendingInteraction: 'none' });
    const question = add('idle-question', { busy: false, mainTurnActive: false, pendingInteraction: 'question' });
    const manager = { list: () => [...entries.values()].map((entry) => entry.handle), get: (id: string) => entries.get(id)?.handle, onDidCreateSession: created.event, onDidCloseSession: closed.event };
    const core = { accessor: { get(service: unknown) {
      if (service !== ISessionManager) throw new Error('Summary must not scan the session index'); return manager;
    } } } as unknown as Scope;
    const projection = new SpaceSummaryProjection(core);
    const initial = projection.read();
    expect(initial).toMatchObject({ online: true, busy_sessions: 2, needs_you_sessions: 2 });
    expect(Buffer.byteLength(JSON.stringify(initial))).toBeLessThan(1024);
    expect(projection.read().revision).toBe(initial.revision);
    question.state = { busy: true, mainTurnActive: true, pendingInteraction: 'question' };
    question.changed.fire({ state: question.state, cause: 'turn_started' });
    const active = projection.read(); expect(active).toMatchObject({ busy_sessions: 3, needs_you_sessions: 2 }); expect(active.revision).not.toBe(initial.revision);
    entries.delete('busy-main'); closed.fire({ sessionId: 'busy-main' });
    const afterClose = projection.read(); expect(afterClose).toMatchObject({ busy_sessions: 2, needs_you_sessions: 2 }); expect(afterClose.revision).not.toBe(active.revision);
    add('new-idle', { busy: false, mainTurnActive: false, pendingInteraction: 'none' }); created.fire({ sessionId: 'new-idle' });
    expect(projection.read().revision).not.toBe(afterClose.revision);
    const beforeDispose = projection.read().revision; projection.dispose();
    question.changed.fire({ state: question.state, cause: 'interaction' }); expect(projection.read().revision).toBe(beforeDispose);
    for (const entry of entries.values()) entry.changed.dispose(); created.dispose(); closed.dispose();
  });
});
