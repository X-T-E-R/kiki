import { OFFICECLI_VERSION } from '../lib/binary.mjs';
const response = await fetch('https://api.github.com/repos/iOfficeAI/OfficeCLI/releases/latest', { headers: { 'User-Agent': 'kiki-office-release-check', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error(`GitHub release lookup returned ${response.status}`);
const release = await response.json();
const latest = String(release.tag_name).replace(/^v/, '');
if (latest !== OFFICECLI_VERSION) {
  process.stdout.write(`New official OfficeCLI release available: ${release.tag_name}; pinned: v${OFFICECLI_VERSION}. No update was performed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Pinned OfficeCLI v${OFFICECLI_VERSION} is the latest official release.\n`);
}
