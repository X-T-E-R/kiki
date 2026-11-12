import { visibleWidth } from '@kiki/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { ChoicePickerComponent, type ChoiceOption } from '#/tui/components/dialogs/choice-picker';
import { EditorSelectorComponent } from '#/tui/components/dialogs/editor-selector';
import { PermissionSelectorComponent } from '#/tui/components/dialogs/permission-selector';
import { SettingsSelectorComponent } from '#/tui/components/dialogs/settings-selector';
import { ThemeSelectorComponent } from '#/tui/components/dialogs/theme-selector';
import { currentTheme } from '#/tui/theme';
import { darkColors } from '#/tui/theme/colors';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

describe('ChoicePickerComponent', () => {
  it('uses the model-dialog header vocabulary (capitalized keys, "type to search")', () => {
    const picker = new ChoicePickerComponent({
      title: 'Add provider',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
      searchable: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(120).map(strip);

    const titleIdx = lines.findIndex((l) => l.includes('Add provider'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    // Title carries the same "(type to search)" suffix as /model and /provider.
    expect(lines[titleIdx]).toContain('(type to search)');
    expect(lines[titleIdx]).not.toContain('type to filter');
    // Hint sits directly under the title and uses lowercase key vocabulary.
    const hint = lines[titleIdx + 1];
    expect(hint).toContain('↑↓ navigate');
    expect(hint).toContain('Enter select');
    expect(hint).toContain('Esc cancel');
    expect(hint).not.toContain('enter select');
    expect(hint).not.toContain('esc cancel');
    // Blank line separates the hint from the body, like the model dialog.
    expect(lines[titleIdx + 2]).toBe('');
  });

  it('wraps complete hint segments at narrow widths and keeps the 100-column hint unchanged', () => {
    const picker = new ChoicePickerComponent({
      title: 'Pick a model',
      options: [
        { value: 'alpha', label: 'Alpha' },
        { value: 'beta', label: 'Beta' },
      ],
      searchable: true,
      pageSize: 1,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    for (const width of [20, 40, 50, 100]) {
      const lines = picker.render(width).map(strip);
      const titleIdx = lines.findIndex((line) => line.includes('Pick a model'));
      const blankIdx = lines.indexOf('', titleIdx + 1);
      const hintLines = lines.slice(titleIdx + 1, blankIdx);

      for (const segment of ['↑↓ navigate', '←→ page', 'Enter select', 'Esc cancel']) {
        expect(hintLines.some((line) => line.includes(segment)), `width=${String(width)}`).toBe(true);
      }
      expect(hintLines.at(-1)).toContain('Esc cancel');
      for (const line of lines) {
        expect(visibleWidth(line), `width=${String(width)} line=${line}`).toBeLessThanOrEqual(width);
      }
      if (width === 100) {
        expect(hintLines).toEqual([
          ' ↑↓ navigate · ←→ page · Enter select · Esc cancel',
        ]);
      }
    }

    picker.handleInput('a');
    const queryLines = picker.render(40).map(strip);
    const titleIdx = queryLines.findIndex((line) => line.includes('Pick a model'));
    const blankIdx = queryLines.indexOf('', titleIdx + 1);
    const hintLines = queryLines.slice(titleIdx + 1, blankIdx);
    expect(hintLines.at(-1)).toContain('Esc clear');
    expect(hintLines.some((line) => line.includes('Esc clear'))).toBe(true);
    expect(queryLines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it('wraps supplied hint segments without merging explicit lines', () => {
    const picker = new ChoicePickerComponent({
      title: 'Select an action',
      hint: 'Ctrl+A all · Esc cancel\nEnter select · Esc reject',
      options: [{ value: 'a', label: 'Alpha' }],
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = picker.render(24).map(strip);
    const titleIdx = lines.findIndex((line) => line.includes('Select an action'));
    const blankIdx = lines.indexOf('', titleIdx + 1);
    const hintLines = lines.slice(titleIdx + 1, blankIdx);

    expect(hintLines).toEqual([
      ' Ctrl+A all · Esc cancel',
      ' Enter select',
      ' Esc reject',
    ]);
  });

  it('renders optional descriptions below choice labels', () => {
    const picker = new ChoicePickerComponent({
      title: 'Select permission mode',
      options: [
        {
          value: 'manual',
          label: 'Manual',
          description: 'Ask before commands, edits, and other risky actions.',
        },
        {
          value: 'auto',
          label: 'Auto',
          description: 'Automatically approve tool actions and plan transitions.',
        },
      ],
      currentValue: 'manual',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = picker.render(120).map(strip);

    expect(out).toContain('  ❯ Manual ← current');
    expect(out).toContain('    Ask before commands, edits, and other risky actions.');
    expect(out).toContain('    Automatically approve tool actions and plan transitions.');
  });

  it('renders domain selector wrappers with their configured options', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    const editor = new EditorSelectorComponent({
      currentValue: 'vim',
      onSelect,
      onCancel,
    });
    expect(editor.render(120).map(strip)).toContain('  ❯ Vim ← current');

    const theme = new ThemeSelectorComponent({
      currentValue: 'light',
      onSelect,
      onCancel,
    });
    expect(theme.render(120).map(strip)).toContain('  ❯ Light ← current');

    const permission = new PermissionSelectorComponent({
      currentValue: 'manual',
      onSelect,
      onCancel,
    });
    expect(permission.render(120).map(strip)).toContain('  ❯ Manual ← current');

    const settings = new SettingsSelectorComponent({
      onSelect,
      onCancel,
    });
    const settingsOutput = settings.render(120).map(strip);
    expect(settingsOutput).toContain('  ❯ Model');
    expect(settingsOutput).toContain('    Switch the active model and thinking mode.');
  });

  it('routes Space into the query for searchable lists instead of selecting', () => {
    const onSelect = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Select a provider',
      options: [
        { value: 'openai', label: 'OpenAI' },
        { value: 'azure', label: 'Azure OpenAI' },
      ],
      searchable: true,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(' ');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects on Space when the list is not searchable', () => {
    const onSelect = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Pick one',
      options: [{ value: 'a', label: 'Alpha' }],
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(' ');
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('renders the selected option description in descriptionTone, others in textMuted', () => {
    const options: ChoiceOption[] = [
      { value: 'none', label: 'No attachment', description: 'Text feedback only' },
      {
        value: 'logs+codebase',
        label: 'Logs + codebase',
        description: 'Include your codebase for deeper diagnosis.',
        descriptionTone: 'warning',
      },
    ];

    const renderDescLine = (currentValue: string): string | undefined => {
      const picker = new ChoicePickerComponent({
        title: 'Share diagnostic info?',
        options,
        currentValue,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });
      return picker.render(120).find((line) => strip(line).includes('Include your codebase'));
    };

    const warningLine = currentTheme.fg('warning', '    Include your codebase for deeper diagnosis.');
    const mutedLine = currentTheme.fg('textMuted', '    Include your codebase for deeper diagnosis.');

    // Selected option: description uses the configured tone.
    expect(renderDescLine('logs+codebase')).toBe(warningLine);
    // Unselected option: description falls back to textMuted.
    expect(renderDescLine('none')).toBe(mutedLine);
  });
});
