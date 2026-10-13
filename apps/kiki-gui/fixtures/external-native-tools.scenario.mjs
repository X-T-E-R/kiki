/**
 * External harness rows whose display is already the native projection:
 * a command with its cwd, several reads, a write, a search, a failed command,
 * two diffs, and an unknown tool that stays generic.
 */

import { assistantMsg, sessionRecord, toolResultMsg, userMsg } from './helpers.mjs';

const SID = 'session_fixture_external_native';

const read = (id, path) => ({
  toolUse: {
    id, name: 'view_file', input: { AbsolutePath: path },
    display: { kind: 'file_io', operation: 'read', path },
  },
});

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: external native tools' })],
  snapshots: {
    [SID]: {
      messages: [
        userMsg(SID, 'Show the harness tools.', 5),
        assistantMsg(SID, [
          read('external:agy:view-1', '/workspace/example/a.ts'),
          read('external:agy:view-2', '/workspace/example/b.ts'),
          read('external:agy:view-3', '/workspace/example/c.ts'),
          {
            toolUse: {
              id: 'external:agy:run', name: 'run_command',
              input: { CommandLine: 'rg -n tool src', Cwd: '/workspace/example' },
              display: { kind: 'command', command: 'rg -n tool src', cwd: '/workspace/example' },
            },
          },
          {
            toolUse: {
              id: 'external:agy:write', name: 'write_to_file',
              input: { TargetFile: '/workspace/example/out.ts' },
              display: { kind: 'file_io', operation: 'write', path: '/workspace/example/out.ts' },
            },
          },
          {
            toolUse: {
              id: 'external:agy:search', name: 'grep_search',
              input: { Query: 'tool', SearchPath: '/workspace/example' },
              display: { kind: 'search', query: 'tool', scope: '/workspace/example' },
            },
          },
          {
            toolUse: {
              id: 'external:agy:fail', name: 'run_command',
              input: { CommandLine: 'rg -n missing src', Cwd: '/workspace/example' },
              display: { kind: 'command', command: 'rg -n missing src', cwd: '/workspace/example' },
            },
          },
          {
            toolUse: {
              id: 'external:agy:diffs', name: 'replace_file_content',
              input: {},
              display: {
                kind: 'generic',
                summary: '/workspace/example/a.ts, /workspace/example/b.ts',
                detail: {
                  diffs: [
                    { path: '/workspace/example/a.ts', before: 'alpha', after: 'beta' },
                    { path: '/workspace/example/b.ts', before: 'one', after: 'two' },
                  ],
                },
              },
            },
          },
          {
            toolUse: {
              id: 'external:codex:files', name: 'File change',
              input: { changes: ['/workspace/example/a.ts', '/workspace/example/b.ts'] },
              display: {
                kind: 'generic',
                summary: '/workspace/example/a.ts, /workspace/example/b.ts',
                detail: {
                  paths: ['/workspace/example/a.ts', '/workspace/example/b.ts'],
                  operation: 'edit',
                },
              },
            },
          },
          {
            toolUse: {
              id: 'external:agy:widget', name: 'widget',
              input: { widget: { id: 7 } },
              display: { kind: 'generic', summary: 'widget' },
            },
          },
          'Done.',
        ], 4),
        toolResultMsg(SID, 'external:agy:fail', {
          kind: 'external_tool_output', protocol: 'acp-v1', text: 'exit 1', status: 'failed',
        }, 4, true),
      ],
    },
  },
};
