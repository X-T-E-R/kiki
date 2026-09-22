/**
 * subagent-context-meter — one session whose child agent carries its own
 * context-window reading (warn ratio) and projected lifetime token totals, so
 * the agent workspace's composer footer ring and detail card can be rendered
 * and screenshotted without a live model. Both mount points render the same
 * Composer: the preview-workspace tab (open the subagent card from the main
 * transcript) and the fullscreen /s/<session>/agent/<id> route.
 *
 * The child's numbers arrive two ways, matching production:
 *   - seeded into the transcript snapshot meta (a fresh fullscreen load reads
 *     the agent transcript response before any live frame), and
 *   - replayed as an agent.status.updated frame during the prompt script
 *     (the live path once the spawn flow has run).
 */

import { sessionRecord, turnEnd, workChanged } from './helpers.mjs';

const SID = 'session_fixture_subagent_context_meter';

// 148k of 262k ≈ 56% — the warn (amber) band, so the ring shows its details
// hint; the lifetime totals exercise every cumulative row except cost, which
// per-agent projections deliberately do not price.
const CHILD_CONTEXT = { contextTokens: 148_000, maxContextTokens: 262_144 };
const CHILD_USAGE = {
  total: { inputOther: 152_000, output: 12_400, inputCacheRead: 96_000, inputCacheCreation: 8_200 },
};

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: subagent context meter' })],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      agent_transcripts: {
        'agent-research': {
          agent_id: 'agent-research',
          has_more: false,
          meta: { agent: { ...CHILD_CONTEXT, usage: CHILD_USAGE } },
          items: [
            {
              kind: 'turn',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'Inspect the protocol events and report concrete facts.',
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              steps: [
                {
                  kind: 'step',
                  stepId: 't1.1',
                  turnId: 't1',
                  ordinal: 1,
                  state: 'completed',
                  startedAt: new Date().toISOString(),
                  endedAt: new Date().toISOString(),
                  frames: [
                    { kind: 'text', frameId: 'research-answer', role: 'assistant', text: 'Protocol map complete.' },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  },
  onPrompt: [
    { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' } } } },
    workChanged(true),
    {
      frame: {
        type: 'subagent.spawned',
        payload: {
          subagentId: 'agent-research',
          subagentName: 'Researcher',
          parentToolCallId: 'call-agent-research',
          description: 'Map the protocol surface',
          runInBackground: false,
          model: 'kimi-code/k3',
          thinkingEffort: 'high',
        },
      },
    },
    { frame: { type: 'subagent.started', payload: { subagentId: 'agent-research' } } },
    {
      frame: {
        type: 'turn.started',
        agentId: 'agent-research',
        payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'Inspect the protocol events and report concrete facts.' },
      },
    },
    {
      frame: {
        type: 'assistant.delta',
        agentId: 'agent-research',
        payload: { turnId: 1, delta: 'Protocol map complete.' },
      },
    },
    {
      frame: {
        type: 'agent.status.updated',
        agentId: 'agent-research',
        payload: { ...CHILD_CONTEXT, usage: CHILD_USAGE },
      },
    },
    { frame: { type: 'turn.ended', agentId: 'agent-research', payload: { turnId: 1, reason: 'completed', durationMs: 1450 } } },
    {
      frame: {
        type: 'subagent.completed',
        payload: { subagentId: 'agent-research', resultSummary: 'Protocol map complete.' },
      },
    },
    turnEnd(1),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
