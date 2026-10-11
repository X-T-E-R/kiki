/**
 * tool-media — a tool result whose picture is reported the way an external
 * harness reports it: as a canonical attachment id on the result, with the
 * host's own media route serving the bytes. No content part carries the image,
 * so the timeline can only show it by reading the result's attachment — which
 * is exactly the consumer this scenario exists to prove.
 *
 * The bytes are a real PNG under `fixtures/media-bytes/`, generated locally,
 * so the thumbnail that renders and the original that downloads are the same
 * file and not two mocked successes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  commitAssistant,
  fid,
  sessionRecord,
  streamSteps,
  turnEnd,
  turnStart,
  workChanged,
} from './helpers.mjs';

const SID = 'session_fixture_tool_media';
const CALL = fid('call');
const FILE_ID = 'f_fixture_tool_media';
// The live adapters name a result's attachments after its frame.
const ATTACHMENT_ID = `tool-${CALL}.att1`;
const COVER = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'media-bytes', 'cover.png'),
).toString('base64');
const REPLY = 'Painted one picture for you.';
const TAIL = 'The render is attached to the tool result above.';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: tool media original' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  // The composer's frozen profile-domain read: without a seeded profile the
  // model domain is "unknown" and sending stays disabled.
  agentPanel: {
    context: 'live',
    owner: { profile: 'agent', agent_id: 'main' },
    available: true,
    profile: {
      name: 'agent',
      description: 'Fixture general-purpose agent.',
      source: 'builtin',
      model: 'fixture/kiki-pro',
      thinking_effort: 'high',
      profile_source: 'registered',
      subagent_policy: 'advisory',
    },
    targets: [],
  },
  // Session media bytes: `/sessions/<id>/media/<file id>` and its `/preview`.
  mediaFiles: {
    [FILE_ID]: { base64: COVER, mime: 'image/png', name: 'render.png' },
  },
  onPrompt: [
    turnStart(1),
    workChanged(true),
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    ...streamSteps('assistant.delta', 1, REPLY, { per: 20, delay: 20 }),
    { delay: 200 },
    {
      frame: {
        type: 'tool.call.started',
        payload: {
          turnId: 1,
          toolCallId: CALL,
          name: 'external_paint',
          args: { prompt: 'a fixture poster' },
        },
      },
    },
    { delay: 250 },
    {
      frame: {
        type: 'tool.result',
        payload: {
          turnId: 1,
          toolCallId: CALL,
          name: 'external_paint',
          output: 'painted',
          attachmentIds: [ATTACHMENT_ID],
          attachments: [
            {
              attachmentId: ATTACHMENT_ID,
              mediaType: 'image/png',
              name: 'render.png',
              size: Buffer.from(COVER, 'base64').length,
              source: { kind: 'session_media', fileId: FILE_ID },
            },
          ],
        },
      },
    },
    { delay: 250 },
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 2 } } },
    ...streamSteps('assistant.delta', 1, TAIL, { per: 20, delay: 20 }),
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 2 } } },
    turnEnd(1),
    commitAssistant('$SID', `${REPLY}\n\n${TAIL}`),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
