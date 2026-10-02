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
const CALL = fid('call');
const QUESTIONS = [
  {
    id: 'q1', header: 'Scope',
    question: 'Which workspace should the fixture target when preparing the paper toolkit and its supporting examples?',
    options: [
      { id: 'frontend', label: 'Frontend only', description: 'apps/kiki-gui sources' },
      { id: 'backend', label: 'Backend only', description: 'kap-server transport' },
      { id: 'both', label: 'Both (Recommended)', description: 'Full-stack pass' },
    ],
    allow_other: true, other_label: 'Somewhere else', other_description: 'Name the directory…',
  },
  {
    id: 'q2', header: 'Checks', question: 'Which checks should run before the report?', multi_select: true,
    options: [
      { id: 'typecheck', label: 'Typecheck' }, { id: 'lint', label: 'Lint' },
      { id: 'tests', label: 'Unit tests' }, { id: 'visual', label: 'Visual proof' },
    ],
  },
];

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: question card' })],
  snapshots: { [SID]: { messages: [] } },
  // The composer's frozen profile-domain read: without a seeded profile the
  // unseeded default leaves the model domain "unknown" and send disabled.
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
  onPrompt: [
    turnStart(1),
    workChanged(true),
    { delay: 600 },
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    { frame: { type: 'tool.call.started', payload: { turnId: 1, toolCallId: CALL, name: 'AskUserQuestion', args: { questions: QUESTIONS } } } },
    {
      frame: {
        type: 'event.question.requested',
        payload: {
          question_id: fid('question'), session_id: '$SID', turn_id: 1, tool_call_id: CALL,
          created_at: new Date().toISOString(), questions: QUESTIONS,
        },
      },
    },
    workChanged(true, 'question'),
    { waitFor: 'question' },
    { frame: { type: 'tool.result', payload: { turnId: 1, toolCallId: CALL, output: { answers: {
      [QUESTIONS[0].question]: 'Both (Recommended)', [QUESTIONS[1].question]: 'Typecheck, Visual proof',
    } } } } },
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
