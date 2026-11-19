import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { assertSeaEntitlements } from './04-sign.mjs';
import { run } from './exec.mjs';
import { nativeBinPath, targetTriple } from './paths.mjs';

const execFileAsync = promisify(execFile);

async function inspectCodesign(executable) {
  const { stdout, stderr } = await execFileAsync('codesign', ['-dv', '--verbose=2', executable], {
    encoding: 'utf8',
  });
  return `${stdout}${stderr}`;
}

async function readEntitlementsXml(executable) {
  const { stdout } = await execFileAsync('codesign', ['-d', '--entitlements', ':-', executable], {
    encoding: 'utf8',
  });
  return stdout;
}

export async function runVerifyStep({ requireGatekeeper = false } = {}) {
  if (process.platform !== 'darwin') {
    console.log('Verify step skipped (not macOS)');
    return;
  }

  const target = targetTriple();
  const executable = nativeBinPath(target);

  console.log(`==> codesign --verify --strict --verbose=2 ${executable}`);
  await run('codesign', ['--verify', '--strict', '--verbose=2', executable]);

  console.log(`==> codesign -dv ${executable}`);
  const details = await inspectCodesign(executable);
  process.stdout.write(details);

  if (/\bflags=.*\bruntime\b/.test(details)) {
    console.log(`==> Verifying SEA Hardened Runtime entitlements on ${executable}`);
    const entitlementsXml = await readEntitlementsXml(executable);
    assertSeaEntitlements(entitlementsXml, executable);
  }

  if (requireGatekeeper) {
    // spctl in 'install' mode simulates the Gatekeeper online check — only a
    // fully notarized binary passes. Ad-hoc signed binaries fail, so this is
    // only run under the release profile.
    console.log(`==> spctl -a -vvv -t install ${executable}`);
    await run('spctl', ['-a', '-vvv', '-t', 'install', executable]);
  } else {
    console.log('Skipping spctl check (requireGatekeeper=false)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const requireGatekeeper = process.env.KIKI_VERIFY_GATEKEEPER === '1';
  await runVerifyStep({ requireGatekeeper });
}
