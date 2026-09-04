import { describe, expect, it } from 'vitest';

import {
  analyzeDangerousBash,
  DANGEROUS_BASH_PARSE_OPTIONS,
} from '#/agent/permission/dangerousBash/analyzeDangerousBash';
import { BashParserService } from '#/app/bashParser/bashParserService';

const parser = new BashParserService();

function analyze(source: string) {
  return analyzeDangerousBash(source, (command) =>
    parser.parse(command, DANGEROUS_BASH_PARSE_OPTIONS),
  );
}

describe('analyzeDangerousBash', () => {
  it.each([
    ['shutdown -h now', 'shutdown'],
    ['reboot', 'reboot'],
    ['rm -rf /tmp/build', 'rm -rf'],
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'dd'],
    ['sudo reboot', 'reboot'],
    ['sudo -u root reboot', 'reboot'],
    ['/sbin/poweroff', 'poweroff'],
    ['echo ok && shutdown now', 'shutdown'],
    ['if halt; then echo x; fi', 'halt'],
    ['echo $(reboot)', 'reboot'],
    ['init 0', 'init'],
    ['telinit 6', 'telinit'],
    ['mkfs.ext4 /dev/sda1', 'mkfs.ext4'],
    ['wipefs -a /dev/sda', 'wipefs'],
    ['Restart-Computer -Force', 'restart-computer'],
    ['Stop-Computer', 'stop-computer'],
    ['bcdedit /set x y', 'bcdedit'],
    ['diskpart /s script.txt', 'diskpart'],
    ['format C:', 'format'],
    ['SHUTDOWN /s /t 0', 'shutdown'],
    ['shut\\down -h now', 'shutdown'],
    ['systemctl poweroff', 'systemctl poweroff'],
    ['systemctl --user reboot', 'systemctl reboot'],
    ['bash -c "shutdown now"', 'shutdown'],
    ['rm -fr dir', 'rm -rf'],
    ['rm -r -f dir', 'rm -rf'],
    ['rm -R --force dir', 'rm -rf'],
    ['rm --recursive --force dir', 'rm -rf'],
    ['rm -rfv dir', 'rm -rf'],
    ['sudo rm -rf dir', 'rm -rf'],
    ['sudo -u root rm --recursive --force dir', 'rm -rf'],
    ['echo ok && rm -rf dir', 'rm -rf'],
    ['env rm -rf dir', 'rm -rf'],
    ['env FOO=bar rm -rf dir', 'rm -rf'],
    ['env -i FOO=bar shutdown now', 'shutdown'],
    ['nohup rm -rf dir', 'rm -rf'],
    ['exec reboot', 'reboot'],
    ['command reboot', 'reboot'],
    ['builtin shutdown now', 'shutdown'],
    ['nice -n 5 poweroff', 'poweroff'],
    ['nice --adjustment=5 shutdown now', 'shutdown'],
    ['busybox poweroff', 'poweroff'],
    ['busybox rm -rf dir', 'rm -rf'],
    ['eval "shutdown now"', 'shutdown'],
    ['eval rm -rf dir', 'rm -rf'],
    ['bash -lc "shutdown now"', 'shutdown'],
    ['bash -c "env rm -rf dir"', 'rm -rf'],
    ["bash -c 'eval \"shutdown now\"'", 'shutdown'],
  ] as const)('flags `%s` as `%s`', (command, matched) => {
    expect(analyze(command)).toEqual({ kind: 'dangerous', command: matched });
  });

  it.each([
    'init 3',
    'dd if=/dev/zero of=/dev/null bs=1M count=1',
    'echo shutdown',
    'systemctl status sshd',
    'bash -c "echo ok"',
    'rm -r dir',
    'rm -f file',
    'rm -i file',
    'rm --recursive dir',
    'rm --force file',
    'rm dir',
    'env FOO=bar echo ok',
    'command -v rm',
    'command echo ok',
    'nohup echo ok',
    'nice echo ok',
    'busybox --list',
    'eval "echo ok"',
    'gh --body "$(cat <<\'EOF\'\nit\'s $(broken ` text\nEOF\n)"',
  ])('does not flag `%s`', (command) => {
    expect(analyze(command)).toBeUndefined();
  });

  it('uses the hardened parser budget', () => {
    expect(DANGEROUS_BASH_PARSE_OPTIONS).toEqual({ timeoutMs: 500, maxNodes: 10_000 });
  });

  it.each(['$CMD --force', 'bash -c "echo $HOME"', 'echo "unterminated', 'env $FLAGS'])(
    'treats `%s` as unanalyzable',
    (command) => {
      expect(analyze(command)).toEqual({ kind: 'unanalyzable' });
    },
  );
});
