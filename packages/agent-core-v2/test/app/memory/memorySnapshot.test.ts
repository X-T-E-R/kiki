import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IConfigService } from '#/app/config/config';
import { AgentMemorySnapshot, IAgentMemorySnapshot } from '#/app/memory/memorySnapshot';
import { IMemoryStore, type MemoryStoreSnapshot } from '#/app/memory/memoryStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { NOTE_SECTIONS, type TodoNotes } from '#/session/todo/todoNotes';

const scope = { kind: 'workspace', workspaceId: 'wd_example_0123456789ab' } as const;
const unit = {
  id: 'm_example_state', type: 'reference', title: 'Artifact status',
  body: 'Artifacts a and b exist; publication of c failed. Check c before retrying; keep a and b.',
  revision: 'example-revision-1', status: 'active', pinned: false,
  created: '2026-10-01T00:00:00Z', updated: '2026-10-01T00:00:00Z',
  source: { writer: 'import' }, reason: 'Observed artifact state', scope,
} as const;
let ix: TestInstantiationService;
let notes: TodoNotes;
let view: MemoryStoreSnapshot;
let enabled: boolean;
let budget: number;
let requestedAgent: string | undefined;

beforeEach(() => {
  notes = {};
  view = { generation: '1', entries: [unit] };
  enabled = true;
  budget = 2_000;
  requestedAgent = undefined;
  ix = new TestInstantiationService();
  ix.stub(IConfigService, { get: <T>() => ({ enabled, approval: 'auto', budget, workspaces: {} }) as T });
  ix.stub(ISessionContext, { sessionId: 'example-session', workspaceId: scope.workspaceId });
  ix.stub(IAgentScopeContext, { agentId: 'example-child' });
  ix.stub(ISessionTodoService, { getNotes: (agentId) => { requestedAgent = agentId; return { notes }; } });
  ix.stub(IMemoryStore, {
    onDidChange: Event.None as Event<import('#/app/memory/memoryStore').MemoryStoreChange>,
    checkpoint: async () => view.generation,
    snapshot: async (scopes) => ({ ...view, entries: view.entries.filter((entry) => scopes.some((visible) => JSON.stringify(visible) === JSON.stringify(entry.scope))) }),
  });
  ix.set(IAgentMemorySnapshot, new SyncDescriptor(AgentMemorySnapshot));
});
afterEach(async () => { await ix.dispose(); });

describe('task-linked complete Memory worksets', () => {
  it.each(NOTE_SECTIONS)('recovers an explicit Memory reference retained in notes.%s', async (section) => {
    notes = { [section]: `Retained link [${unit.id}]` };
    const snapshot = ix.get(IAgentMemorySnapshot);
    const text = await snapshot.refreshIfDirty('Please resume that batch');
    expect(requestedAgent).toBe('example-child');
    expect(text).toContain(unit.body);
    expect(text!.length).toBeLessThanOrEqual(2_000);
    expect(text!.split(unit.body)).toHaveLength(2);
  });

  it('deduplicates note references before the 20-ID limit without searching evidence prose', async () => {
    notes = { decided: '[m_example_missing] '.repeat(25), evidence: `UNRELATED_EVIDENCE_TEXT [${unit.id}]` };
    const snapshot = ix.get(IAgentMemorySnapshot);
    expect(await snapshot.refreshIfDirty('Please resume that batch')).toContain(unit.body);
    expect(snapshot.advisorRequest).not.toContain('UNRELATED_EVIDENCE_TEXT');
    expect(snapshot.advisorRequest?.match(/\[m_example_missing\]/g)).toHaveLength(1);
    notes = { evidence: Array.from({ length: 20 }, (_, index) => `[m_example_${index}]`).join(' ') + ` [${unit.id}]` };
    expect(await snapshot.refreshIfDirty('Please resume that batch')).not.toContain(unit.body);
    expect(snapshot.advisorRequest?.match(/\[m_example_\d+\]/g)).toHaveLength(20);
  });

  it('refreshes linked bodies while preserving inactive, expiry, scope, removal and off boundaries', async () => {
    notes = { files: `[${unit.id}]` };
    const snapshot = ix.get(IAgentMemorySnapshot);
    expect(await snapshot.refreshIfDirty('Please resume that batch')).toContain(unit.body);
    const corrected = { ...unit, body: 'Publication of c succeeded; do not repeat the publication.', revision: 'example-revision-2' };
    view = { generation: '2', entries: [corrected] };
    const changed = await snapshot.refreshIfDirty('Please resume that batch');
    expect(changed).toContain(corrected.body);
    expect(changed).not.toContain(unit.body);
    for (const status of ['pending', 'archived', 'superseded'] as const) {
      view = { generation: status, entries: [{ ...corrected, status }] };
      expect(await snapshot.refreshIfDirty('Please resume that batch')).not.toContain(corrected.body);
    }
    view = { generation: 'expired', entries: [{ ...corrected, validity: { until: '2000-01-01T00:00:00Z', check: 'Check the current artifact state.' } }] };
    expect(await snapshot.refreshIfDirty('Please resume that batch')).not.toContain(corrected.body);
    view = { generation: '3', entries: [corrected] };
    snapshot.configurePersona({ id: 'example-persona', shared: [] });
    expect(await snapshot.refreshIfDirty('Please resume that batch')).not.toContain(corrected.body);
    snapshot.configurePersona();
    expect(await snapshot.refreshIfDirty('Please resume that batch')).toContain(corrected.body);
    notes = {};
    expect(await snapshot.refreshIfDirty('Please resume that batch')).not.toContain(corrected.body);
    notes = { evidence: `[${unit.id}]` };
    expect(await snapshot.refreshIfDirty('Please resume that batch')).toContain(corrected.body);
    budget = 0;
    expect(await snapshot.refreshIfDirty('Please resume that batch')).toBe('');
    budget = 2_000;
    enabled = false;
    expect(await snapshot.refreshIfDirty('Please resume that batch')).not.toContain(corrected.body);
  });
});
