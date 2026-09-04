import { describe, expect, it } from 'vitest';

import {
  DAEMON_COMMANDS,
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
    ['rename', 'title'],
    ['config', 'settings'],
    ['disconnect', 'logout'],
    ['experimental', 'experiments'],
    ['export', 'export-md'],
  ])('normalizes supported alias /%s to /%s', (alias, canonical) => {
    const resolved = resolveDaemonCommand(alias, '');

    expect(resolved).toMatchObject({ name: canonical, invokedAs: alias });
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
          description: expect.stringContaining('supported'),
        }),
        expect.objectContaining({ name: 'skill:ReviewSkill', description: 'Review changes' }),
        expect.objectContaining({ name: 'Reviewer', argumentHint: '<prompt>' }),
      ]),
    );
    expect(daemonCommandHelp()).toContain('Supported:');
    expect(daemonCommandHelp()).toContain('Disabled:');
  });

  it('keeps the required daemon parity commands supported', () => {
    const statuses = new Map(DAEMON_COMMANDS.map((command) => [command.name, command.status]));
    for (const name of [
      'compact',
      'tasks',
      'fork',
      'plugins',
      'provider',
      'reload',
      'login',
      'logout',
      'mcp',
      'goal',
      'settings',
      'undo',
    ]) {
      expect(statuses.get(name), name).toBe('supported');
    }
    expect([...statuses.values()].filter((status) => status === 'supported').length).toBeGreaterThan(29);
  });
});
