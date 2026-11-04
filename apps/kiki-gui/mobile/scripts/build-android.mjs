import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { commandForExecFile } from '../../../kimi-code/scripts/native/exec.mjs';

const root = resolve(import.meta.dirname, '..');
const variant = process.argv[2];
if (!['debug', 'release'].includes(variant)) throw new Error('Usage: build-android.mjs debug|release');
execFileSync(process.execPath, [join(root, 'node_modules/@capacitor/cli/bin/capacitor'), 'sync', 'android'], { cwd: root, stdio: 'inherit' });
const tasks = ['--no-daemon', variant === 'release' ? 'assembleRelease' : 'assembleDebug'];
const gradle = process.platform === 'win32'
  ? commandForExecFile(join(root, 'android/gradlew.bat'), tasks)
  : { command: 'bash', args: [join(root, 'android/gradlew'), ...tasks] };
execFileSync(gradle.command, gradle.args, { ...gradle.options, cwd: join(root, 'android'), stdio: 'inherit' });
