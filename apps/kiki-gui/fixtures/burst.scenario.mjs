import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_burst';

/**
 * Main-thread starvation stress: one prompt triggers a 20k-frame
 * tool.call.delta storm (the uncoalesced-burst freeze of the hardening
 * audit). The walker submits a second prompt MID-burst and measures how
 * quickly the POST initiates. A parks on a release gate after the storm so
 * the second prompt deterministically lands in the server queue; releasing
 * runs the promotion path end to end.
 *
 * paceMs=150 (was 25): chunks of 500 still arrive back-to-back within a
 * chunk — the coalescing stress is unchanged — but a 25ms inter-chunk gap
 * outruns this class of machine (60-107ms of client work per chunk), so the
 * backlog grew without bound and the walker's mid-burst POST raced seconds of
 * queued flood on BOTH the pre-shell baseline and the shell branch (3.3s vs
 * 3.6s at frame ~15-31k of 40k — machine-bound, not slice-bound). 150ms lets
 * the client keep up chunk-by-chunk, so the latency budget measures real
 * steady-state responsiveness and the drain guard stops flaking.
 */
export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: burst' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  onPrompt: (text) => {
    if (text.startsWith('B:')) {
      return [
        { frame: { type: 'turn.started', payload: { turnId: 2, origin: { kind: 'user' }, prompt: text } } },
        {
          frame: {
            type: 'assistant.delta',
            offset: 0,
            payload: { turnId: 2, delta: 'Second prompt landed after the burst — exactly once.' },
          },
        },
        { frame: { type: 'turn.ended', payload: { turnId: 2, reason: 'completed', durationMs: 120 } } },
        { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
        { frame: { type: 'event.session.work_changed', payload: { busy: false, pending_interaction: 'none' } } },
      ];
    }
    return [
      { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' }, prompt: text } } },
      { frame: { type: 'event.session.work_changed', payload: { busy: true, pending_interaction: 'none' } } },
      {
        frame: {
          type: 'tool.call.started',
          payload: {
            turnId: 1,
            toolCallId: 'burst-tool',
            name: 'Write',
            description: 'Stream a heavy argument payload',
          },
        },
      },
      {
        spam: {
          count: 20_000,
          paceMs: 150,
          frame: {
            type: 'tool.call.delta',
            payload: { turnId: 1, toolCallId: 'burst-tool', name: 'Write', argumentsPart: 'chunk-$I ' },
          },
        },
      },
      { waitFor: 'release' },
      { frame: { type: 'tool.result', payload: { turnId: 1, toolCallId: 'burst-tool', output: 'write complete' } } },
      {
        frame: {
          type: 'assistant.delta',
          offset: 0,
          payload: { turnId: 1, delta: 'Burst survived — the composer stayed responsive.' },
        },
      },
      { frame: { type: 'turn.ended', payload: { turnId: 1, reason: 'completed', durationMs: 900 } } },
      { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
      { frame: { type: 'event.session.work_changed', payload: { busy: false, pending_interaction: 'none' } } },
    ];
  },
};
