/**
 * message-long-answer — one persona conversation in `delivery: message` whose
 * bodies are long enough to cross the wire's bounded-content thresholds:
 *
 *   - turn 1: the model sends nothing and ends on a ~20 000-character ordinary
 *     reply, so the message view speaks that reply (a promoted final reply).
 *     Its frame is bounded as a frame (assistant prose keeps a 16 KiB text
 *     preview), so the row continues from `text`.
 *   - turn 2: a successful `SendMessage` whose own text is ~20 000 characters.
 *     Tool arguments are not prose on the wire, so the preview is the 1 KiB
 *     one and the row continues from `input.text`.
 *   - turn 3: a short ordinary reply with nothing cut.
 *
 * The scenario declares which frames the fixture bounds, and the fixture
 * applies the production `boundedEntity` / `readContentSegment` to exactly
 * those, so previews, refs and segment reads come from the real functions
 * rather than a fixture re-implementation. All text is synthetic.
 *
 *   node scripts/visual-proof-message-long-answer.mjs
 */

import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_message_long';
const WS = 'wd_fixture_000000000000';
const PERSONA = { id: 'lin-lan', name: '林岚' };

/** Unique tail markers: a body is whole only when its own marker is on the page. */
export const TAIL = {
  reply: 'END-OF-FINAL-REPLY-9f3c',
  message: 'END-OF-SENT-MESSAGE-4b17',
};

/** Deterministic synthetic prose of exactly `chars` characters, ending in `tail`. */
function body(chars, tail) {
  const line = '发布清单逐条核对：签名证书、changelog、回归结果、公告草稿与回滚步骤。\n';
  let text = '';
  let index = 0;
  while (text.length + line.length < chars - tail.length) {
    index += 1;
    text += `${String(index).padStart(3, '0')} ${line}`;
  }
  return text.padEnd(chars - tail.length, '·') + tail;
}

export const BODIES = {
  reply: body(20_000, TAIL.reply),
  message: body(20_000, TAIL.message),
};

const SHORT_REPLY = '好，就按周五发：周四冻结，周五上午打 tag，我不会直接推送。';

function turnItem(turnId, prompt, steps, minutesAgo) {
  return {
    kind: 'turn',
    turnId,
    ordinal: Number(turnId),
    state: 'completed',
    origin: { kind: 'user' },
    prompt,
    startedAt: ts(minutesAgo),
    endedAt: ts(minutesAgo - 1),
    steps,
  };
}

function step(turnId, ordinal, frames, minutesAgo) {
  return {
    kind: 'step',
    stepId: `${turnId}.${ordinal}`,
    turnId,
    ordinal,
    state: 'completed',
    startedAt: ts(minutesAgo),
    endedAt: ts(minutesAgo - 1),
    frames,
  };
}

const ask = (frameId, text) => ({ kind: 'text', frameId, role: 'user', text });

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
      // The frames the fixture cuts with the production functions: the long
      // ordinary reply (assistant prose) and the SendMessage call (tool args).
      bounded_content: { frames: ['t1-reply', 't2-send'] },
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          seq: 12,
          items: [
            turnItem('1', '把 0.31 的发布清单完整给我。', [
              step('1', 1, [
                ask('t1-ask', '把 0.31 的发布清单完整给我。'),
                { kind: 'text', frameId: 't1-reply', role: 'assistant', text: BODIES.reply },
              ], 40),
            ], 40),
            turnItem('2', '再发一条消息版本的清单。', [
              step('2', 1, [
                ask('t2-ask', '再发一条消息版本的清单。'),
                {
                  kind: 'tool', frameId: 't2-send', toolCallId: 't2-send', name: 'SendMessage', state: 'done',
                  input: { text: BODIES.message },
                  output: JSON.stringify({
                    message_id: 'msg_long_1', delivered_to: ['user'], attachments: [],
                    sender: { persona_id: PERSONA.id, name: PERSONA.name, session_id: SID },
                  }),
                },
              ], 30),
            ], 30),
            turnItem('3', '那就按周五发，别再改清单了。', [
              step('3', 1, [
                ask('t3-ask', '那就按周五发，别再改清单了。'),
                { kind: 'text', frameId: 't3-reply', role: 'assistant', text: SHORT_REPLY },
              ], 20),
            ], 20),
          ],
        },
      },
    },
  },
};
