/**
 * context-ring — one idle session for the composer's context-usage ring + the
 * custom right-click menu:
 *
 *   - a ring-mount snapshot: ~57% context (amber) with a lifetime usage total;
 *   - a prompt script that pauses mid-stream then streams the assistant answer
 *     while an `agent.status.updated` frame flips the context tokens to ~80%
 *     (red) — proving the ring recolors live while the turn runs;
 *   - compaction is available at these ratios and fires the session's /compact
 *     action from the detail card's button.
 */

import { sessionRecord, streamSteps, turnEnd, turnStart, workChanged } from './helpers.mjs';

const SID = 'session_fixture_context_ring';

const ANSWER = 'The context ring recolors live as the window fills.';

export default {
  sessions: [
    sessionRecord(SID, {
      title: 'Fixture: context ring',
      usage: {
        input_tokens: 122_000,
        output_tokens: 15_800,
        cache_read_tokens: 97_000,
        cache_creation_tokens: 24_000,
        total_cost_usd: 0.8421,
        context_tokens: 150_000,
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