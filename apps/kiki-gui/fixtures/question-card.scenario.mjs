/**
 * question-card — on prompt, kiki asks a two-part question (single-select
 * with an Other path + a multi-select), waits for the answer, then confirms.
 */

import {
  commitAssistant,
  fid,
  sessionRecord,
  streamSteps,
  turnEnd,
  turnStart,
  workChanged,
} from './helpers.mjs';

const SID = 'session_fixture_question';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: question card' })],
  snapshots: { [SID]: { messages: [] } },
  onPrompt: [
    turnStart(1),
    workChanged(true),
    { delay: 600 },
    {
      frame: {
        type: 'event.question.requested',
        payload: {
          question_id: fid('question'),
          session_id: '$SID',
          turn_id: 1,
          tool_call_id: fid('call'),
          created_at: new Date().toISOString(),
          questions: [
            {
              id: 'q1',
              header: 'Scope',
              question: 'Which workspace should the fixture target?',
              options: [
                { id: 'frontend', label: 'Frontend only', description: 'apps/kiki-gui sources' },
                { id: 'backend', label: 'Backend only', description: 'kap-server transport' },
                { id: 'both', label: 'Both (Recommended)', description: 'Full-stack pass' },
              ],
              allow_other: true,
              other_label: 'Somewhere else',
              other_description: 'Name the directory…',
            },
            {
              id: 'q2',
              header: 'Checks',
              question: 'Which checks should run before the report?',
              multi_select: true,
              options: [
                { id: 'typecheck', label: 'Typecheck' },
                { id: 'lint', label: 'Lint' },
                { id: 'tests', label: 'Unit tests' },
                { id: 'visual', label: 'Visual proof' },
              ],
            },
          ],
        },
      },
    },
    workChanged(true, 'question'),
    { waitFor: 'question' },
    { delay: 500 },
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 2 } } },
    ...streamSteps('assistant.delta', 1, 'Locked in — targeting your picks and running the checks now.', { per: 22 }),
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 2 } } },
    turnEnd(1),
    commitAssistant('$SID', 'Locked in — targeting your picks and running the checks now.'),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
