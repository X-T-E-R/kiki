import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const mode = process.argv[2];
if (!['sync', 'simulator', 'device'].includes(mode)) {
  throw new Error('Usage: build-ios.mjs sync|simulator|device');
}

execFileSync(
  process.execPath,
  [join(root, 'node_modules/@capacitor/cli/bin/capacitor'), 'sync', 'ios'],
  { cwd: root, stdio: 'inherit' },
);

if (mode === 'sync') {
  process.exit(0);
}

if (process.platform !== 'darwin') {
  throw new Error('Building the iOS app requires macOS with Xcode installed.');
}

const projectPath = join(root, 'ios/App/App.xcodeproj');
const configuration = mode === 'device' ? 'Release' : 'Debug';
const defaultDestination = mode === 'device' ? 'generic/platform=iOS' : 'generic/platform=iOS Simulator';
const destination = process.env.IOS_DESTINATION || defaultDestination;
const derivedDataPath = process.env.IOS_DERIVED_DATA || join(root, 'ios/App/build');

const args = [
  '-project', projectPath,
  '-scheme', 'App',
  '-configuration', configuration,
  '-destination', destination,
  '-derivedDataPath', derivedDataPath,
];

if (process.env.DEVELOPMENT_TEAM) {
  args.push(`DEVELOPMENT_TEAM=${process.env.DEVELOPMENT_TEAM}`);
} else if (mode === 'device') {
  args.push('CODE_SIGNING_ALLOWED=NO');
} else {
  // Ad-hoc sign Simulator builds so iOS Keychain APIs (SecItemAdd/SecItemCopyMatching) work without -34018.
  args.push('CODE_SIGN_IDENTITY=-');
}

args.push('build');

execFileSync('xcodebuild', args, { cwd: root, stdio: 'inherit' });
