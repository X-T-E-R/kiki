import { describe, expect, it } from 'vitest';

import {
  closeTerminalResponseSchema,
  createTerminalRequestSchema,
  listTerminalsResponseSchema,
  terminalSchema,
} from '../rest/terminal';

const sampleTerminal = {
  id: 'term_01HX',
  session_id: 'sess_01',
  cwd: '/tmp/example',
  shell: '/bin/zsh',
  cols: 120,
  rows: 32,
  status: 'running' as const,
  created_at: '2026-06-04T10:30:00.000Z',
};

describe('terminal REST schemas', () => {
  it('parses terminal resources and list responses', () => {
    expect(terminalSchema.parse(sampleTerminal)).toEqual(sampleTerminal);
    expect(listTerminalsResponseSchema.parse({ items: [sampleTerminal] }).items).toHaveLength(1);
  });

  it.each([
    ['empty request', {}, {}],
    ['relative cwd override', { cwd: 'packages/server', cols: 100 }, { cwd: 'packages/server', cols: 100 }],
  ] as const)('accepts createTerminalRequest (%s)', (_label, input, expected) => {
    expect(createTerminalRequestSchema.parse(input)).toEqual(expected);
  });

  it.each(['/tmp/outside', 'C:\\outside', '\\outside', ''])(
    'rejects invalid or absolute create cwd (%s)',
    (cwd) => {
      expect(createTerminalRequestSchema.safeParse({ cwd }).success).toBe(false);
    },
  );

  it('requires closed: true and rejects false success receipts', () => {
    expect(closeTerminalResponseSchema.parse({ closed: true })).toEqual({ closed: true });
    expect(closeTerminalResponseSchema.safeParse({ closed: false }).success).toBe(false);
  });
});
