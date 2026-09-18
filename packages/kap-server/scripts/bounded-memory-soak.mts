import assert from 'node:assert/strict';

import { AgentTranscript } from '@kiki/transcript';

const sessionCount = Number(process.env['KIKI_SOAK_SESSIONS'] ?? 200);
const turnsPerSession = Number(process.env['KIKI_SOAK_TURNS'] ?? 500);
const maxLiveSessions = Number(process.env['KIKI_SOAK_MAX_LIVE'] ?? 8);
const tailTurns = Number(process.env['KIKI_SOAK_TAIL_TURNS'] ?? 20);
const maxAgentBytes = Number(process.env['KIKI_SOAK_MAX_AGENT_BYTES'] ?? 16 << 20);
const live = new Map<string, AgentTranscript>();
const samples: number[] = [];
let maxResidentTurns = 0;
let maxResidentBytes = 0;

for (let sessionOrdinal = 0; sessionOrdinal < sessionCount; sessionOrdinal += 1) {
  const sessionId = `session-${sessionOrdinal}`;
  const transcript = new AgentTranscript('main', { tailTurns, maxBytes: maxAgentBytes });
  live.set(sessionId, transcript);
  for (let ordinal = 0; ordinal < turnsPerSession; ordinal += 1) {
    transcript.apply([{
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId: `t${ordinal}`,
        ordinal,
        state: 'completed',
        origin: { kind: 'user' },
        prompt: `session ${sessionOrdinal} turn ${ordinal} ${'x'.repeat(256)}`,
        steps: [],
      },
    }]);
  }
  while (live.size > maxLiveSessions) live.delete(live.keys().next().value!);
  for (const resident of live.values()) {
    const report = resident.residentReport();
    maxResidentTurns = Math.max(maxResidentTurns, report.turns);
    maxResidentBytes = Math.max(maxResidentBytes, report.estimatedBytes);
    assert.equal(report.overBudget, false);
  }
  if (sessionOrdinal % 10 === 0) {
    globalThis.gc?.();
    samples.push(process.memoryUsage().rss);
  }
}

const active = new AgentTranscript('main', { tailTurns, maxBytes: 1_024 });
active.apply([{
  op: 'turn.upsert',
  turn: {
    kind: 'turn',
    turnId: 't0',
    ordinal: 0,
    state: 'running',
    origin: { kind: 'user' },
    prompt: 'x'.repeat(100_000),
    steps: [],
  },
}]);

assert.ok(live.size <= maxLiveSessions);
assert.ok(maxResidentTurns <= tailTurns);
assert.ok(maxResidentBytes <= maxAgentBytes);
assert.equal(active.getTurn('t0')?.state, 'running');
assert.equal(active.residentReport().overBudget, true);
const warm = samples.slice(Math.floor(samples.length / 2));
const rssSpread = warm.length === 0 ? 0 : Math.max(...warm) - Math.min(...warm);
assert.ok(rssSpread < 256 << 20, `steady RSS spread ${rssSpread} exceeded 256 MiB`);

process.stdout.write(`${JSON.stringify({
  sessionCount,
  turnsPerSession,
  maxLiveSessions: live.size,
  maxResidentTurns,
  maxResidentBytes,
  rssPeak: samples.length === 0 ? process.memoryUsage().rss : Math.max(...samples),
  rssSpread,
})}\n`);
