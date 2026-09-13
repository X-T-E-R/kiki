/**
 * tool-pipeline — snapshot carries a completed Read → Edit (diff card) →
 * Write-create chain as journaled messages; on prompt, two live sequences:
 *   1) three consecutive tool calls (Read + Edit + Bash) → one "Steps · 3" group;
 *   2) a tool/approval/tool boundary (Glob → approval → Bash) where the
 *      pending approval separates the tools; resolving archives it and allows regrouping.
 * The Edit uses real old/new strings with >6 unchanged lines between two
 * changes so the DiffCard shows two hunks and a "… unchanged lines" separator.
 */

import {
  approvalFrame,
  assistantMsg,
  commitAssistant,
  fid,
  sessionRecord,
  streamSteps,
  toolResultMsg,
  turnEnd,
  turnStart,
  userMsg,
  workChanged,
} from './helpers.mjs';

const SID = 'session_fixture_pipeline';
const READ1 = fid('call');
const EDIT1 = fid('call');
const WRITE1 = fid('call');
const LIVE_READ = fid('call');
const LIVE_EDIT = fid('call');
const LIVE_BASH = fid('call');
const LIVE_VERIFY = fid('call');
const BOUND_GLOB = fid('call');
const BOUND_BASH = fid('call');

const FILE = 'C:/fixture/workshop/plan.ts';

const EDIT_BEFORE = [
  'export const plan = {',
  "  name: 'kiki',",
  '  version: 1,',
  '  steps: [',
  "    'scaffold',",
  "    'wire',",
  "    'test',",
  "    'ship',",
  '  ],',
  '  owner: process.env.USER,',
  '  retries: 0,',
  '};',
  '',
].join('\n');

const EDIT_AFTER = EDIT_BEFORE.replace('version: 1', 'version: 2').replace('retries: 0', 'retries: 2');

const WRITE_CONTENT = ['# notes', '', '- alpha', '- beta', ''].join('\n');

const messages = [
  userMsg(SID, 'Read plan.ts, bump the version, and start a notes file.', 30),
  assistantMsg(SID, [
    'On it — reading the file first.',
    { toolUse: { id: READ1, name: 'Read', input: { file_path: FILE } } },
  ], 29),
  toolResultMsg(SID, READ1, { kind: 'file_content', path: FILE, content: EDIT_BEFORE }, 29),
  assistantMsg(SID, [
    { toolUse: { id: EDIT1, name: 'Edit', input: { file_path: FILE, old_string: 'version: 1', new_string: 'version: 2' } } },
  ], 28),
  toolResultMsg(SID, EDIT1, 'Replaced 1 occurrence in ' + FILE, 28),
  assistantMsg(SID, [
    { toolUse: { id: WRITE1, name: 'Write', input: { file_path: 'C:/fixture/workshop/notes.md', content: WRITE_CONTENT } } },
    'Done — plan bumped and notes created.',
  ], 27),
  toolResultMsg(SID, WRITE1, 'File created: C:/fixture/workshop/notes.md', 27),
];

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: tool pipeline' })],
  snapshots: { [SID]: { messages } },
  onPrompt: [
    turnStart(1),
    workChanged(true),
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    // Sequence 1: four consecutive non-shell tools with no non-tool block between them.
    {
      frame: {
        type: 'tool.call.started',
        payload: {
          turnId: 1, toolCallId: LIVE_READ, name: 'Read',
          args: { file_path: FILE },
          display: { kind: 'file_io', operation: 'read', path: FILE },
        },
      },
    },
    { delay: 350 },
    { frame: { type: 'tool.result', payload: { turnId: 1, toolCallId: LIVE_READ, output: { kind: 'file_content', path: FILE, content: EDIT_AFTER } } } },
    { delay: 250 },
    {
      frame: {
        type: 'tool.call.started',
        payload: {
          turnId: 1, toolCallId: LIVE_EDIT, name: 'Edit',
          args: { file_path: FILE, old_string: 'version: 1', new_string: 'version: 2' },
          description: 'Bump version to 2',
          display: { kind: 'file_io', operation: 'edit', path: FILE, before: EDIT_BEFORE, after: EDIT_AFTER },
        },
      },
    },
    { delay: 300 },
    { frame: { type: 'tool.result', payload: { turnId: 1, toolCallId: LIVE_EDIT, output: `Replaced 1 occurrence in ${FILE}` } } },
    { delay: 250 },
    {
      frame: {
        type: 'tool.call.started',
        payload: {
          turnId: 1, toolCallId: LIVE_BASH, name: 'Glob',
          args: { pattern: 'src/**/*.ts' },
          display: { kind: 'file_io', operation: 'list', path: 'C:/fixture/workshop/src' },
        },
      },
    },
    { delay: 250 },
    { frame: { type: 'tool.result', payload: { turnId: 1, toolCallId: LIVE_BASH, output: ['src/plan.ts', 'src/notes.ts'] } } },
    { delay: 250 },
    {
      frame: {
        type: 'tool.call.started',
        payload: {
          turnId: 1, toolCallId: LIVE_VERIFY, name: 'Read',
          args: { file_path: FILE },
          display: { kind: 'file_io', operation: 'read', path: FILE },
        },
      },
    },
    { delay: 250 },
    { frame: { type: 'tool.result', payload: { turnId: 1, toolCallId: LIVE_VERIFY, output: { kind: 'file_content', path: FILE, content: EDIT_AFTER } } } },
    { delay: 200 },
    { frame: { type: 'assistant.delta', offset: 0, payload: { turnId: 1, delta: 'Preparing the gated boundary.' } } },
    { delay: 200 },
    // Sequence 2: tool / approval / tool boundary — approval must flush the group.
    {
      frame: {
        type: 'tool.call.started',
        payload: {
          turnId: 1, toolCallId: BOUND_GLOB, name: 'Glob',
          args: { pattern: '**/*.ts' },
          display: { kind: 'file_io', operation: 'list', path: 'C:/fixture/workshop' },
        },
      },
    },
    { delay: 200 },
    { frame: { type: 'tool.result', payload: { turnId: 1, toolCallId: BOUND_GLOB, output: ['plan.ts', 'notes.md'] } } },
    { delay: 200 },
    { frame: approvalFrame({ toolName: 'Edit', action: `Editing ${FILE}`, display: { kind: 'file_io', operation: 'edit', path: FILE, before: EDIT_BEFORE, after: EDIT_AFTER }, toolCallId: BOUND_GLOB }) },
    { waitFor: 'approval' },
    { delay: 300 },
    {
      frame: {
        type: 'tool.call.started',
        payload: {
          turnId: 1, toolCallId: BOUND_BASH, name: 'Bash',
          args: { command: 'echo "boundary ok"' },
          display: { kind: 'command', command: 'echo "boundary ok"' },
        },
      },
    },
    { delay: 300 },
    { frame: { type: 'tool.result', payload: { turnId: 1, toolCallId: BOUND_BASH, output: { kind: 'command_output', exit_code: 0, stdout: 'boundary ok\n' } } } },
    { delay: 200 },
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 2 } } },
    ...streamSteps('assistant.delta', 1, 'Both sequences completed: four tools folded and the approval boundary split the final tool.', { per: 24 }),
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 2 } } },
    turnEnd(1),
    commitAssistant('$SID', 'Both sequences completed: four tools folded and the approval boundary split the final tool.'),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
