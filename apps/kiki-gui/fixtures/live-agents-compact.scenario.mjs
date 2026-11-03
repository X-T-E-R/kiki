/**
 * live-agents-compact — the Usage → Live agents section with a realistic
 * fleet: five sessions in the live inventory, named the ways a real home names
 * them — two ordinary titles, one very long title, one untitled session, and
 * one archived session whose metadata the proof withholds so the GUI must fall
 * back to its localized short label. Every session opens `running`; the proof
 * drives pause / cancel / resume through the real klient dispatcher.
 *
 * Builds on usage-dashboard so the request side of the Live tab, the sidebar
 * and the rest of /usage stay populated exactly as that fixture has them.
 */

import { sessionRecord, ts } from './helpers.mjs';
import base from './usage-dashboard.scenario.mjs';

const K2 = 'k2-thinking';
const SONNET = 'claude-sonnet-4.5';

export const ZETA = 'session_fixture_usage_zeta';
export const ETA = 'session_fixture_usage_eta';
export const LONG = 'session_7d3f2a91-5c4e-4b8a-9f61-2e0d8c7b6a54';
export const UNTITLED = 'session_0b9e4c17-a2d8-4f53-8e6c-91d4b7a3f028';
export const MISSING = 'session_c58a1e3b-7f02-4d69-b4e1-3a9f6d20e7c5';
export const LONG_TITLE = 'Rebuild the usage export pipeline so CSV, JSON and the dashboard read one ledger, then backfill the cache-hit columns for every model since July';

const startedAgo = (ms) => new Date(Date.now() - ms).toISOString();

function counts(main, subagent, queuedSubagent = 0) {
  return {
    active: main + subagent,
    queued: queuedSubagent,
    main,
    subagent,
    independent: 0,
    queuedMain: 0,
    queuedSubagent,
    queuedIndependent: 0,
  };
}

const agents = [
  { sessionId: ZETA, agentId: 'main', role: 'main', phase: 'running', startedAt: startedAgo(120_000), executorId: 'native', profileId: 'general', modelId: K2 },
  { sessionId: ZETA, agentId: 'agent-research', parentAgentId: 'main', role: 'subagent', phase: 'running', startedAt: startedAgo(45_000), executorId: 'native', profileId: 'explore', modelId: K2 },
  { sessionId: ETA, agentId: 'agent-explore-2', parentAgentId: 'main', role: 'subagent', phase: 'tool_waiting', startedAt: startedAgo(80_000), executorId: 'native', profileId: 'explore', modelId: SONNET },
  { sessionId: LONG, agentId: 'main', role: 'main', phase: 'running', startedAt: startedAgo(600_000), executorId: 'native', profileId: 'general', modelId: K2 },
  { sessionId: UNTITLED, agentId: 'main', role: 'main', phase: 'running', startedAt: startedAgo(30_000), executorId: 'native', profileId: 'general', modelId: SONNET },
  { sessionId: MISSING, agentId: 'main', role: 'main', phase: 'running', startedAt: startedAgo(240_000), executorId: 'native', profileId: 'general', modelId: K2 },
];

export const liveAgentGovernance = {
  domainId: 'this-service',
  runtimeEpoch: 'ep_fixture_live_agents',
  seq: 21,
  asOf: new Date().toISOString(),
  coverage: 'this_process',
  unit: 'agent_execution',
  ...counts(4, 2, 1),
  dimensions: [
    { dimension: 'executor', id: 'native', ...counts(4, 2, 1) },
    { dimension: 'profile', id: 'general', ...counts(4, 0) },
    { dimension: 'profile', id: 'explore', ...counts(0, 2, 1) },
    { dimension: 'model', id: K2, ...counts(3, 1, 1) },
    { dimension: 'model', id: SONNET, ...counts(1, 1) },
    { dimension: 'role', id: 'main', ...counts(4, 0) },
    { dimension: 'role', id: 'subagent', ...counts(0, 2, 1) },
    { dimension: 'session', id: ZETA, ...counts(1, 1, 1) },
    { dimension: 'session', id: ETA, ...counts(0, 1) },
    { dimension: 'session', id: LONG, ...counts(1, 0) },
    { dimension: 'session', id: UNTITLED, ...counts(1, 0) },
    { dimension: 'session', id: MISSING, ...counts(1, 0) },
  ],
  agents,
  waiting: [
    { attemptId: 'wait-sub-1', sessionId: ZETA, agentId: 'agent-sub-queued', role: 'subagent', waitedMs: 14_000, blockingRules: ['kimi-cap'], executorId: 'native', profileId: 'explore', modelId: K2 },
  ],
  rules: [],
};

export const extraSessions = [
  sessionRecord(LONG, {
    title: LONG_TITLE,
    busy: true,
    main_turn_active: true,
    agent_config: { model: 'kimi/k2-thinking' },
    created_at: ts(90),
    updated_at: ts(1),
  }),
  sessionRecord(UNTITLED, {
    title: '',
    busy: true,
    main_turn_active: true,
    agent_config: { model: 'anthropic/claude-sonnet-4.5' },
    created_at: ts(12),
    updated_at: ts(1),
  }),
  // Archived, so no cached sidebar list carries it; the proof withholds its
  // one metadata read to exercise the unknown-name fallback.
  sessionRecord(MISSING, {
    title: 'Fixture: withheld metadata',
    archived: true,
    busy: true,
    main_turn_active: true,
    created_at: ts(400),
    updated_at: ts(4),
  }),
];

export default {
  ...base,
  liveAgentGovernance,
  executionControl: {
    [ZETA]: { phase: 'running', agents: [] },
    [ETA]: { phase: 'running', agents: [] },
    [LONG]: { phase: 'running', agents: [] },
    [UNTITLED]: { phase: 'running', agents: [] },
    [MISSING]: { phase: 'running', agents: [] },
  },
  sessions: [...base.sessions, ...extraSessions],
};
