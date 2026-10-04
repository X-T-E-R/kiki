import { describe, expect, it, vi } from 'vitest';
import type { Klient } from '@kiki/klient';
import { executeWebCommand } from '#/tui/daemon/web-command';

import {
  DAEMON_COMMANDS,
  daemonAutocompleteCommands,
  daemonCommandHelp,
  daemonSkillCommands,
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
    ['export', 'export-view'],
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
      '/permission expects manual, auto, review, or yolo.',
    );
  });

  it.each(['manual', 'auto', 'review', 'yolo'])('accepts the existing permission mode %s', (mode) => {
    const command = resolveDaemonCommand('permission', mode);
    if (command === undefined || !('definition' in command)) throw new Error('Permission command is unavailable');
    expect(validateDaemonCommandArgs(command)).toBeUndefined();
    expect(command.definition.argumentHint).toBe('[manual|auto|review|yolo]');
  });

  it('canonicalizes the token without collapsing argument whitespace', () => {
    expect(parseDaemonSlashInput('/SkIlL:ReviewSkill   first  \t second   ')).toEqual({
      token: 'skill:reviewskill',
      rawToken: 'SkIlL:ReviewSkill',
      args: 'first  \t second',
    });
  });

  it('uses bare prompt names while reserving builtin names and aliases', () => {
    const skills = daemonSkillCommands(['brainstorm', 'plan', 'q', 'web'].map((name) => ({
      name, path: `/workspace/.kiki/commands/${name}.md`, description: 'Discuss options',
      source: 'project', prompt_command: true, argument_hint: '<topic>',
    })));
    expect(skills.map((skill) => skill.commandName)).toEqual(['brainstorm', 'skill:plan', 'skill:q', 'skill:web']);
    expect(skills[0]).toMatchObject({ description: '[project] Discuss options', argumentHint: '<topic>' });
    const menu = daemonAutocompleteCommands(new Map(skills.map((skill) => [skill.commandName, skill])), new Map());
    expect(menu.find((item) => item.name === 'brainstorm')?.argumentHint).toBe('<topic>');
    expect(menu.filter((item) => item.name === 'plan')).toHaveLength(1);
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
        expect.objectContaining({
          name: 'export-view',
          description: '[supported in daemon TUI] Export loaded user and assistant text as Markdown',
        }),
        expect.objectContaining({ name: 'skill:ReviewSkill', description: 'Review changes' }),
        expect.objectContaining({ name: 'Reviewer', argumentHint: '<prompt>' }),
      ]),
    );
    expect(daemonCommandHelp()).toContain('Supported:');
    expect(daemonCommandHelp()).toContain('Export loaded user and assistant text as Markdown');
    expect(daemonCommandHelp()).toContain('Disabled in daemon TUI:');
  });

  it('generates help usage, aliases, and descriptions from the active catalog', () => {
    const help = daemonCommandHelp();
    for (const command of DAEMON_COMMANDS) {
      expect(help).toContain(`/${command.name}${command.argumentHint === undefined ? '' : ` ${command.argumentHint}`}`);
      expect(help).toContain(`\n  ${command.description}`);
      for (const alias of command.aliases) expect(help).toContain(`/${alias}`);
    }
    expect(help).toContain('/undo\n  Withdraw the last prompt');
    expect(help).not.toContain('/undo [');
    expect(help).toContain('type / in the input box');
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
      'persona',
    ]) {
      expect(statuses.get(name), name).toBe('supported');
    }
    expect(statuses.get('web')).toBe('supported');
    for (const name of ['add-dir', 'export-md', 'export-debug-zip', 'reload-tui']) {
      expect(statuses.get(name), name).toBe('disabled');
    }
    expect([...statuses.values()].filter((status) => status === 'supported').length).toBeGreaterThan(29);
  });
});


describe('daemon /web execution', () => {
  function client() {
    const status = { enabled: true, mode: 'temporary', url: 'http://example.test', insecure: false, sessions: [] };
    const web = { enable: vi.fn().mockResolvedValue(status), issueLink: vi.fn().mockResolvedValue({ url: 'http://example.test#access=once', expiresAt: 1 }), status: vi.fn().mockResolvedValue(status), disable: vi.fn().mockResolvedValue({ ...status, enabled: false }), revoke: vi.fn().mockResolvedValue(status) };
    return { web, klient: { rest: { webAccess: web } } as unknown as Klient };
  }
  it('opens a daemon-issued link in place and passes persistent/network configuration without stopping the TUI', async () => {
    const c = client(); const opened = await executeWebCommand(c.klient, '');
    expect(opened.openUrl).toBe('http://example.test#access=once'); expect(c.web.enable).toHaveBeenCalledWith({ mode: 'temporary' });
    const persistent = await executeWebCommand(c.klient, 'persistent --host 127.0.0.1 --port 0 --public-url https://example.test --no-open');
    expect(c.web.enable).toHaveBeenLastCalledWith({ mode: 'persistent', host: '127.0.0.1', port: 0, publicUrl: 'https://example.test' }); expect(persistent.openUrl).toBeUndefined();
  });
  it('uses authoritative status/off/revoke calls and rejects invalid arguments before daemon mutation', async () => {
    const c = client(); await executeWebCommand(c.klient, 'status'); await executeWebCommand(c.klient, 'off'); await executeWebCommand(c.klient, 'revoke');
    expect(c.web.status).toHaveBeenCalledOnce(); expect(c.web.disable).toHaveBeenCalledOnce(); expect(c.web.revoke).toHaveBeenCalledWith(undefined); expect(c.web.issueLink).not.toHaveBeenCalled();
    await expect(executeWebCommand(c.klient, 'persistent --port nope')).rejects.toThrow();
    await expect(executeWebCommand(c.klient, 'off --host 0.0.0.0')).rejects.toThrow();
    await expect(executeWebCommand(c.klient, 'unknown')).rejects.toThrow(); expect(c.web.enable).not.toHaveBeenCalled();
  });
});
