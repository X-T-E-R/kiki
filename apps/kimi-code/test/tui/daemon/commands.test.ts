import { describe, expect, it } from 'vitest';

import {
  daemonAutocompleteCommands,
  daemonCommandHelp,
  parseDaemonSlashInput,
  resolveDaemonCommand,
  validateDaemonCommandArgs,
} from '#/tui/daemon/commands';

describe('daemon command registry', () => {
  it.each([
    ['h', 'help'],
    ['?', 'help'],
    ['q', 'exit'],
    ['thinking', 'effort'],
  ])('normalizes supported alias /%s to /%s', (alias, canonical) => {
    const resolved = resolveDaemonCommand(alias, '');

    expect(resolved).toMatchObject({ name: canonical, invokedAs: alias });
  });

  it.each([
    ['config', 'settings'],
    ['experimental', 'experiments'],
    ['rename', 'title'],
    ['disconnect', 'logout'],
    ['export', 'export-md'],
  ])('normalizes disabled alias /%s to /%s', (alias, canonical) => {
    expect(resolveDaemonCommand(alias, '')).toMatchObject({
      name: canonical,
      status: 'disabled',
    });
  });

  it('validates command arguments before dispatch', () => {
    const exit = resolveDaemonCommand('q', 'now');
    const permission = resolveDaemonCommand('permission', 'root');

    expect(exit).toBeDefined();
    expect(permission).toBeDefined();
    expect(validateDaemonCommandArgs(exit as never)).toBe('/q does not accept arguments.');
    expect(validateDaemonCommandArgs(permission as never)).toBe(
      '/permission expects manual, yolo, or auto.',
    );
  });

  it('canonicalizes the token without collapsing argument whitespace', () => {
    expect(parseDaemonSlashInput('/SkIlL:ReviewSkill   first  \t second   ')).toEqual({
      token: 'skill:reviewskill',
      rawToken: 'SkIlL:ReviewSkill',
      args: 'first  \t second',
    });
  });

  it('installs supported, disabled, skill, and agent commands in autocomplete', () => {
    const commands = daemonAutocompleteCommands(
      new Map([
        [
          'skill:reviewskill',
          {
            commandName: 'skill:ReviewSkill',
            name: 'ReviewSkill',
            description: 'Review changes',
          },
        ],
      ]),
      new Map([['reviewer', 'Reviewer']]),
    );

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'help', aliases: ['h', '?'] }),
        expect.objectContaining({
          name: 'settings',
          aliases: ['config'],
          description: expect.stringContaining('disabled'),
        }),
        expect.objectContaining({ name: 'skill:ReviewSkill', description: 'Review changes' }),
        expect.objectContaining({ name: 'Reviewer', argumentHint: '<prompt>' }),
      ]),
    );
    expect(daemonCommandHelp()).toContain('Supported:');
    expect(daemonCommandHelp()).toContain('Disabled:');
  });
});
