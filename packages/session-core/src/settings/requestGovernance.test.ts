import { describe, expect, it } from 'vitest';
import { agentActivitySnapshotSchema, requestConcurrencyRuleSchema } from '@kiki/protocol';
import { agentActivityRows, concurrencyRulesPatch, replaceConcurrencyResourceRules } from './requestGovernance';

describe('concurrency rule helpers', () => {
  const request = requestConcurrencyRuleSchema.parse({ id: 'request-cap', resource: 'model_request', scope: 'global', subagentsOnly: false, maxConcurrent: 8, overflow: 'queue', enabled: true });
  const agent = requestConcurrencyRuleSchema.parse({ id: 'agent-cap', resource: 'agent_execution', scope: 'each_session', executors: ['external-example'], profiles: ['worker'], models: ['model-example'], roles: ['subagent'], subagentsOnly: false, maxConcurrent: 2, overflow: 'reject', enabled: true });
  it('preserves request rules and agent selectors in a complete config write', () => {
    const updated = replaceConcurrencyResourceRules([request, agent], 'agent_execution', [{ ...agent, enabled: false }]);
    expect(updated[0]).toEqual(request);
    expect(concurrencyRulesPatch(updated).rules?.[1]).toEqual({
      id: 'agent-cap', resource: 'agent_execution', scope: 'each_session', executors: ['external-example'], profiles: ['worker'], models: ['model-example'], roles: ['subagent'], providers: undefined,
      subagents_only: false, max_concurrent: 2, overflow: 'reject', max_wait_ms: undefined, enabled: false,
    });
    expect(replaceConcurrencyResourceRules(updated, 'agent_execution', [])).toEqual([request]);
    expect(() => replaceConcurrencyResourceRules([request], 'agent_execution', [{ ...agent, id: request.id }])).toThrow('already exists');
  });
  it('returns one dimension without changing unknown identity or main/subagent columns', () => {
    const totals = { active: 2, queued: 0, main: 1, subagent: 1, independent: 0, queuedMain: 0, queuedSubagent: 0, queuedIndependent: 0 };
    const snapshot = agentActivitySnapshotSchema.parse({ ...totals, domainId: 'this-service', runtimeEpoch: 'example', seq: 1, asOf: '2026-01-01', coverage: 'this_process', unit: 'agent_execution', agents: [], waiting: [], rules: [], dimensions: [
      { ...totals, dimension: 'model', id: null }, { ...totals, dimension: 'executor', id: 'external-example' },
    ] });
    expect(agentActivityRows(snapshot, 'model')).toEqual([{ ...totals, dimension: 'model', id: null }]);
  });
});
