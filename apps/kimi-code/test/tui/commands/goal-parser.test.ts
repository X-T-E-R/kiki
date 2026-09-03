import { describe, expect, it } from 'vitest';

import { goalObjectiveLengthWarning, parseGoalCommand } from '#/tui/commands/goal-parser';

describe('parseGoalCommand', () => {
  it('parses status, control, create, replace, and queued goal forms', () => {
    expect(parseGoalCommand('')).toEqual({ kind: 'status' });
    expect(parseGoalCommand('pause')).toEqual({ kind: 'pause' });
    expect(parseGoalCommand('Ship feature X')).toEqual({
      kind: 'create',
      objective: 'Ship feature X',
      replace: false,
    });
    expect(parseGoalCommand('replace Ship feature Y')).toEqual({
      kind: 'create',
      objective: 'Ship feature Y',
      replace: true,
    });
    expect(parseGoalCommand('next Ship release notes')).toEqual({
      kind: 'next-add',
      objective: 'Ship release notes',
    });
    expect(parseGoalCommand('next manage')).toEqual({ kind: 'next-manage' });
  });

  it('keeps reserved and option-looking text after the delimiter', () => {
    expect(parseGoalCommand('-- cancel')).toEqual({
      kind: 'create',
      objective: 'cancel',
      replace: false,
    });
    expect(parseGoalCommand('-- --leading-option')).toEqual({
      kind: 'create',
      objective: '--leading-option',
      replace: false,
    });
  });

  it('rejects missing and oversized objectives with the existing messages', () => {
    expect(parseGoalCommand('next')).toEqual({
      kind: 'error',
      severity: 'hint',
      message:
        'Provide an upcoming goal objective, e.g. `/goal next Ship feature X`, or use `/goal next manage`.',
    });
    expect(parseGoalCommand('x'.repeat(4001))).toEqual({
      kind: 'error',
      restoreInput: true,
      message:
        'Goal objective is too long (max 4000 characters). Put long content in a file and reference the file path.',
    });
  });
});

describe('goalObjectiveLengthWarning', () => {
  it('warns for oversized create forms and ignores control or lookalike commands', () => {
    expect(goalObjectiveLengthWarning(`/goal ${'x'.repeat(4001)}`)).toContain(
      '(4001/4000 characters)',
    );
    expect(goalObjectiveLengthWarning(`/goal next ${'x'.repeat(4001)}`)).toBeDefined();
    expect(goalObjectiveLengthWarning('/goal pause')).toBeUndefined();
    expect(goalObjectiveLengthWarning(`/goalie ${'x'.repeat(4001)}`)).toBeUndefined();
  });
});
