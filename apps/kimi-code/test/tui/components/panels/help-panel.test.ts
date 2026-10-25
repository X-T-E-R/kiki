import { describe, it, expect, vi } from 'vitest';
import { visibleWidth } from '@kiki/pi-tui';

import { HelpPanelComponent, type HelpPanelCommand } from '#/tui/components/dialogs/help-panel';

function cmd(
  name: string,
  description: string,
  aliases: string[] = [],
  extra?: Partial<HelpPanelCommand>,
): HelpPanelCommand {
  return {
    name,
    aliases,
    description,
    ...extra,
  };
}

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('HelpPanelComponent', () => {
  it('renders keyboard shortcuts + slash commands sections', () => {
    const panel = new HelpPanelComponent({
      commands: [cmd('exit', 'Exit', ['quit', 'q'])],
      onClose: () => {},
      maxVisible: 100,
    });
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/help/);
    expect(out).toMatch(/Keyboard shortcuts/);
    expect(out).toMatch(/Shift\+Tab/);
    expect(out).toMatch(/Ctrl\+O/);
    expect(out).toMatch(/Shift\+Enter \/ Ctrl\+J/);
    expect(out).toMatch(/Slash commands/);
    expect(out).toMatch(/\/exit \(\/quit, \/q\)/);
    expect(out).toMatch(/Exit/);
  });

  it('sorts unprefixed commands before skill commands and by name within each group', () => {
    const panel = new HelpPanelComponent({
      commands: [
        cmd('zebra', 'Z'),
        cmd('skill:bravo', 'B'),
        cmd('alpha', 'A'),
        cmd('kiki-profile', 'P'),
      ],
      onClose: () => {},
    });
    const out = strip(panel.render(80).join('\n'));
    const alphaIdx = out.indexOf('/alpha');
    const profileIdx = out.indexOf('/kiki-profile');
    const zebraIdx = out.indexOf('/zebra');
    const skillBravoIdx = out.indexOf('/skill:bravo');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(profileIdx);
    expect(profileIdx).toBeLessThan(zebraIdx);
    expect(zebraIdx).toBeLessThan(skillBravoIdx);
  });

  it('groups builtin commands by task and renders usage with argument hints', () => {
    const panel = new HelpPanelComponent({
      commands: [
        cmd('model', 'Switch LLM model', [], { argumentHint: '[model]' }),
        cmd('sessions', 'Browse and resume sessions', ['resume']),
        cmd('tasks', 'Browse background tasks', [], {
          argumentHint: '[stop|output] [task-id]',
        }),
      ],
      onClose: () => {},
      maxVisible: 100,
    });
    const out = strip(panel.render(80).join('\n'));
    expect(out).toContain('Sessions & history');
    expect(out).toContain('Model & modes');
    expect(out).toContain('Agents & tasks');
    expect(out).toContain('/model [model]');
    expect(out).toContain('/tasks [stop|output] [task-id]');
    expect(out).toContain('/sessions (/resume)');
    // Task grouping beats declaration order.
    expect(out.indexOf('/sessions')).toBeLessThan(out.indexOf('/model'));
    expect(out.indexOf('/model')).toBeLessThan(out.indexOf('/tasks'));
  });

  it('parks disabled commands in a marked trailing group', () => {
    const panel = new HelpPanelComponent({
      commands: [
        cmd('model', 'Switch LLM model'),
        cmd('add-dir', 'Start a session with another directory', [], { disabled: true }),
      ],
      onClose: () => {},
      maxVisible: 100,
    });
    const out = strip(panel.render(80).join('\n'));
    expect(out).toContain('Disabled in daemon TUI');
    expect(out.indexOf('/model')).toBeLessThan(out.indexOf('Disabled in daemon TUI'));
    expect(out.indexOf('Disabled in daemon TUI')).toBeLessThan(out.indexOf('/add-dir'));
  });

  it('renders the discovery note between commands and shortcuts', () => {
    const panel = new HelpPanelComponent({
      commands: [cmd('exit', 'Exit the application')],
      note: 'Skills and agent profiles: type / in the input box.\nLocal docs: /home/u/docs',
      onClose: () => {},
      maxVisible: 100,
    });
    const out = strip(panel.render(80).join('\n'));
    expect(out.indexOf('/exit')).toBeLessThan(out.indexOf('type / in the input box'));
    expect(out.indexOf('Local docs: /home/u/docs')).toBeGreaterThan(-1);
    expect(out.indexOf('Local docs:')).toBeLessThan(out.indexOf('Keyboard shortcuts'));
  });

  it('wraps long descriptions in full instead of truncating them', () => {
    const description =
      'Manage browser access without leaving the TUI and every flag stays readable';
    const panel = new HelpPanelComponent({
      commands: [cmd('web', description)],
      onClose: () => {},
      maxVisible: 100,
    });
    const out = strip(panel.render(48).join('\n'));
    expect(out.replaceAll(/\s+/g, ' ')).toContain(description);
    expect(out).not.toContain('…');
  });

  it('stays within width and keeps content complete on narrow terminals', () => {
    const panel = new HelpPanelComponent({
      commands: [
        cmd('tasks', 'Browse background tasks', [], {
          argumentHint: '[stop|output] [task-id]',
        }),
        cmd('permission', 'Select permission mode', [], {
          argumentHint: '[manual|auto|review|yolo]',
        }),
      ],
      onClose: () => {},
      maxVisible: 100,
    });
    for (const line of panel.render(24)) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
    // At 30 columns every hint token fits a row, so wrapped usage reassembles.
    const out = strip(panel.render(30).join('\n')).replaceAll(/\s+/g, ' ');
    expect(out).toContain('/tasks [stop|output] [task-id]');
    expect(out).toContain('/permission [manual|auto|review|yolo]');
    expect(out).toContain('Select permission mode');
    // The fixed hint wraps at narrow widths instead of losing the
    // scroll/page keys to truncation.
    for (const narrow of [24, 30]) {
      const hintOut = strip(panel.render(narrow).join('\n')).replaceAll(/\s+/g, ' ');
      expect(hintOut).toContain('Esc / Enter / q cancel · ↑↓ scroll · PgUp/PgDn page');
    }
  });

  it('Escape fires onClose', () => {
    const onClose = vi.fn();
    const panel = new HelpPanelComponent({
      commands: [],
      onClose,
    });
    panel.handleInput('\u001B'); // Esc
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('q / Enter also close the panel', () => {
    const onClose = vi.fn();
    const panel = new HelpPanelComponent({
      commands: [],
      onClose,
    });
    panel.handleInput('q');
    panel.handleInput('\r');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('clips to maxVisible with a "showing X-Y of Z" tail', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, `Desc ${String(i)}`));
    const panel = new HelpPanelComponent({
      commands: many,
      onClose: () => {},
      maxVisible: 6,
    });
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/showing 1-6 of/);
  });

  it('arrow keys shift the scroll window', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, 'd'));
    const panel = new HelpPanelComponent({
      commands: many,
      onClose: () => {},
      maxVisible: 6,
    });
    panel.handleInput('\u001B[B'); // ↓
    panel.handleInput('\u001B[B'); // ↓
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/showing 3-8 of/);
    panel.handleInput('\u001B[A'); // ↑
    const out2 = strip(panel.render(80).join('\n'));
    expect(out2).toMatch(/showing 2-7 of/);
  });
});
