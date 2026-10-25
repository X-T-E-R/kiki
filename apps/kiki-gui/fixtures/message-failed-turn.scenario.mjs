/**
 * message-failed-turn — one persona conversation in `delivery: message` whose
 * first turn failed after the model had already written ordinary text:
 *
 *   - turn 1: the provider filtered the response. The turn is `failed`, its
 *     partial text stays in the process, and the session view carries no prompt
 *     record for it — so nothing on the page can say "this failed" except the
 *     turn's own state.
 *   - turn 2: a normal completion that ends on an ordinary reply, which the
 *     message view speaks.
 *
 * The point of the pair is that a failure does not silence the turn after it,
 * and that a failed turn is not read as speech — nor as a cancel, nor as
 * "没有回复". All text is synthetic.
 *
 *   node scripts/visual-proof-message-failed.mjs
 */

import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_message_failed';
const WS = 'wd_fixture_000000000000';
const PERSONA = { id: 'lin-lan', name: '林岚' };

/** The cut-off text, and the answer that follows it. */
export const PARTIAL = '发布清单我核到一半：签名证书那边还在等小蓝回话，changelog 三条也';
export const ANSWER = '先给结论：周四冻结，周五上午打 tag，我不会直接推送。';

function turnItem({ turnId, prompt, state, error, frames, minutesAgo }) {
  return {
    kind: 'turn',
    turnId,
    ordinal: Number(turnId),
    state,
    error,
    origin: { kind: 'user' },
    prompt,
    startedAt: ts(minutesAgo),
    endedAt: ts(minutesAgo - 1),
    steps: [{
      kind: 'step',
      stepId: `${turnId}.1`,
      turnId,
      ordinal: 1,
      state,
      startedAt: ts(minutesAgo),
      endedAt: ts(minutesAgo - 1),
      frames: frames.map((frame) => ({ role: 'assistant', ...frame })),
    }],
  };
}

export default {
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
  ],
  personas: [{
    definition: {
      id: PERSONA.id, name: PERSONA.name, title: '发布协调',
      job: '负责每个版本的发布节奏：列清单、盯阻塞、写发布说明。',
      modelAlias: 'fixture/kiki-pro', thinkingEffort: 'high', delivery: 'message',
      description: '你是林岚，负责 Kiki 的发布协调。说话简短，先给结论。',
    },
  }],
  sessions: [sessionRecord(SID, {
    title: '0.31 发布清单',
    workspace_id: WS,
    delivery: 'message',
    metadata: { cwd: 'C:/fixture/bots/lin-lan', bot_persona_id: PERSONA.id },
    agent_config: { model: 'fixture/kiki-pro', persona: { id: PERSONA.id, name: PERSONA.name } },
  })],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          seq: 8,
          items: [
            turnItem({
              turnId: '1',
              prompt: '把 0.31 的发布清单整理一下。',
              state: 'failed',
              error: 'provider filtered the response',
              frames: [{ kind: 'text', frameId: 't1-text', text: PARTIAL }],
              minutesAgo: 40,
            }),
            turnItem({
              turnId: '2',
              prompt: '先给结论。',
              state: 'completed',
              frames: [{ kind: 'text', frameId: 't2-text', text: ANSWER }],
              minutesAgo: 20,
            }),
          ],
        },
      },
    },
  },
};
