import { describe, expect, it } from 'vitest';

import { openFileCommandFor, openInAppCommandFor, revealFileCommandFor } from '../src/lib/fileLaunch';

describe('fileLaunch', () => {
  describe('win32 explorer /select, quoting', () => {
    it('revealFileCommandFor quotes only the path and uses verbatim arguments', () => {
      const cmd = revealFileCommandFor('C:\\some dir\\sub\\file.txt', 'win32');
      expect(cmd.command).toBe('explorer.exe');
      expect(cmd.args).toEqual(['/select,"C:\\some dir\\sub\\file.txt"']);
      expect(cmd.windowsVerbatimArguments).toBe(true);
    });

    it('openInAppCommandFor (finder) quotes only the path and uses verbatim arguments', () => {
      const cmd = openInAppCommandFor(
        'finder',
        'C:\\some dir\\sub\\file.txt',
        { isDirectory: false },
        'win32',
      );
      expect(cmd.command).toBe('explorer.exe');
      expect(cmd.args).toEqual(['/select,"C:\\some dir\\sub\\file.txt"']);
      expect(cmd.windowsVerbatimArguments).toBe(true);
    });

    it('openInAppCommandFor (finder) opens directories without /select,', () => {
      const cmd = openInAppCommandFor(
        'finder',
        'C:\\some dir\\sub',
        { isDirectory: true },
        'win32',
      );
      expect(cmd.command).toBe('explorer.exe');
      expect(cmd.args).toEqual(['C:\\some dir\\sub']);
      expect(cmd.windowsVerbatimArguments).toBeUndefined();
    });

    it('drops a trailing backslash so it cannot escape the closing quote', () => {
      const cmd = revealFileCommandFor('C:\\some dir\\sub\\', 'win32');
      expect(cmd.args).toEqual(['/select,"C:\\some dir\\sub"']);
    });

    it('paths without spaces keep the same quoting', () => {
      const cmd = revealFileCommandFor('C:\\proj\\file.txt', 'win32');
      expect(cmd.args).toEqual(['/select,"C:\\proj\\file.txt"']);
      expect(cmd.windowsVerbatimArguments).toBe(true);
    });
  });

  describe('win32 cmd /c start quoting', () => {
    it('openFileCommandFor quotes the target so `&` cannot split the command', () => {
      const cmd = openFileCommandFor('C:\\work\\a&b.txt', undefined, {}, 'win32');
      expect(cmd.command).toBe('cmd');
      expect(cmd.args).toEqual(['/c', 'start', '""', '"C:\\work\\a&b.txt"']);
      expect(cmd.shell).toBeUndefined();
    });

    it('openFileCommandFor doubles embedded quotes instead of ending the argument', () => {
      const cmd = openFileCommandFor('C:\\my "dir"\\file.txt', undefined, {}, 'win32');
      expect(cmd.args).toEqual(['/c', 'start', '""', '"C:\\my ""dir""\\file.txt"']);
    });

    it('openFileCommandFor keeps the empty title first', () => {
      const cmd = openFileCommandFor('C:\\proj\\file.txt', undefined, {}, 'win32');
      expect(cmd.args[2]).toBe('""');
      expect(cmd.args[3]).toBe('"C:\\proj\\file.txt"');
    });
  });
});
