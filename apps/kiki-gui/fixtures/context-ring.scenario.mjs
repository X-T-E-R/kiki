/**
 * context-ring — one idle session for the composer's context-usage ring + the
 * custom right-click menu:
 *
 *   - a ring-mount snapshot: 180k of 262k (amber) with a lifetime usage total.
 *     The ring colours against the auto-compaction point, here the legacy
 *     min(0.85·U, U − 50k) = 212,144: amber from 80% of it (169,715), red at it;
 *   - a prompt script that pauses mid-stream then streams the assistant answer
 *     while an `agent.status.updated` frame flips the context tokens to 220k,
 *     past the point (red) — proving the ring recolors live while the turn runs;
 *   - compaction is available at these ratios and fires the session's /compact
 *     action from the detail card's button.
 */

import { sessionRecord, streamSteps, turnEnd, turnStart, workChanged } from './helpers.mjs';

const SID = 'session_fixture_context_ring';
const MODEL = 'fixture/kiki-pro';

const ANSWER = 'The context ring recolors live as the window fills.';

const agentPanel = {
  context: 'live',
  live: true,
  owner: { profile: 'agent', agent_id: 'main' },
  available: true,
  profile: {
    name: 'agent',
    description: 'Fixture general-purpose agent.',
    source: 'builtin',
    model: MODEL,
    thinking_effort: 'high',
    profile_source: 'registered',
    subagent_policy: 'advisory',
  },
  targets: [],
  metrics: {
    main: {
      inputTokens: 234_800,
      outputTokens: 15_800,
      cacheReadTokens: 97_000,
      cacheWriteTokens: 24_000,
      totalTokens: 250_600,
      totalCostUsd: 0.8421,
      contextTokens: 180_000,
      contextLimit: 262_144,
      compactionCount: 0,
      usageSource: 'live',
      usageComplete: true,
      usagePartial: false,
      costPartial: true,
    },
  },
};

export default {
  agentPanel,
  models: [{ id: MODEL, provider_id: 'fixture', remote_id: 'kiki-pro', display_name: 'Kiki Pro', max_context_size: 262_144 }],
  sessions: [
    sessionRecord(SID, {
      title: 'Fixture: context ring',
      agent_config: { model: MODEL },
      usage: {
        input_tokens: 122_000,
        output_tokens: 15_800,
        cache_read_tokens: 97_000,
        cache_creation_tokens: 24_000,
        total_cost_usd: 0.8421,
        accounting: {
          version: 2,
          subject: { session_id: SID, scope: 'session' },
          covered_at: Date.now(),
          complete: true,
          tokens: { input_other: 122_000, output: 15_800, input_cache_read: 97_000, input_cache_creation: 24_000 },
          cost_usd_estimated: 0.8421,
          cost_unknown: true,
        },
        context_tokens: 180_000,
        context_limit: 262_144,
        turn_count: 9,
      },
    }),
  ],
  snapshots: {
    [SID]: {
      messages: [
        {
          id: 'msg_ring_history',
          session_id: SID,
          role: 'assistant',
          content: [{ type: 'text', text: 'Seeded history for the ring walker.' }],
          created_at: new Date(Date.now() - 120_000).toISOString(),
        },
      ],
      has_more: false,
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          meta: { agent: { model: MODEL, contextTokens: 180_000, maxContextTokens: 262_144, permission: 'manual' } },
          items: [],
        },
      },
    },
  },
  onPrompt: [
    turnStart(7),
    workChanged(true),
    // Mid-stream: the context passes the danger threshold while the answer is
    // still streaming — the ring must flip amber → red in place.
    { delay: 120 },
    {
      frame: {
        type: 'agent.status.updated',
        payload: { contextTokens: 220_000, maxContextTokens: 262_144 },
      },
    },
    ...streamSteps('assistant.delta', 7, ANSWER, { per: 10, delay: 30 }),
    turnEnd(7),
    workChanged(false),
  ],
};