import { describe, expect, it } from 'vitest';

import { parseGoalCommand } from '#/tui/commands/index';

describe('parseGoalCommand', () => {
  it('treats empty and status as status', () => {
    expect(parseGoalCommand('')).toEqual({ kind: 'status' });
    expect(parseGoalCommand('status')).toEqual({ kind: 'status' });
  });

  it('parses control subcommands', () => {
    expect(parseGoalCommand('pause')).toEqual({ kind: 'pause' });
    expect(parseGoalCommand('resume')).toEqual({ kind: 'resume' });
    expect(parseGoalCommand('cancel')).toEqual({ kind: 'cancel' });
  });

  it('treats `clear` as an objective, not a subcommand (cancel is the remove action)', () => {
    expect(parseGoalCommand('clear')).toMatchObject({ kind: 'create', objective: 'clear' });
  });

  it('parses a plain objective', () => {
    expect(parseGoalCommand('Ship feature X')).toMatchObject({
      kind: 'create',
      objective: 'Ship feature X',
      replace: false,
    });
  });

  it('keeps option-looking tokens as part of the objective (no goal flags)', () => {
    expect(parseGoalCommand('--retry-strategy Ship feature X')).toMatchObject({
      kind: 'create',
      objective: '--retry-strategy Ship feature X',
    });
  });

  it('treats text after -- as the objective', () => {
    expect(parseGoalCommand('-- --leading-option is part of the goal')).toMatchObject({
      kind: 'create',
      objective: '--leading-option is part of the goal',
    });
    expect(parseGoalCommand('-- cancel')).toMatchObject({ kind: 'create', objective: 'cancel' });
  });

  it('parses replace as the first argument', () => {
    expect(parseGoalCommand('replace Ship feature Y')).toMatchObject({
      kind: 'create',
      objective: 'Ship feature Y',
      replace: true,
    });
  });

  it('parses next as an upcoming-goal command', () => {
    expect(parseGoalCommand('next Ship release notes')).toEqual({
      kind: 'next-add',
      objective: 'Ship release notes',
    });
    expect(parseGoalCommand('next manage')).toEqual({ kind: 'next-manage' });
    expect(parseGoalCommand('next -- manage release notes')).toEqual({
      kind: 'next-add',
      objective: 'manage release notes',
    });
  });

  it('shows a hint for /goal next without an objective', () => {
    expect(parseGoalCommand('next')).toEqual({
      kind: 'error',
      severity: 'hint',
      message:
        'Provide an upcoming goal objective, e.g. `/goal next Ship feature X`, or use `/goal next manage`.',
    });
  });

  it('rejects objectives longer than 4000 characters with a file-reference hint', () => {
    expect(parseGoalCommand('x'.repeat(4001))).toEqual({
      kind: 'error',
      restoreInput: true,
      message:
        'Goal objective is too long (max 4000 characters). Put long content in a file and reference the file path.',
    });
    expect(parseGoalCommand(`next ${'x'.repeat(4001)}`)).toEqual({
      kind: 'error',
      restoreInput: true,
      message:
        'Goal objective is too long (max 4000 characters). Put long content in a file and reference the file path.',
    });
  });
});
