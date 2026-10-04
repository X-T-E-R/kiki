import { runCommand } from '../host';
import type { CapabilityEntry } from '../types';
import type { CapabilityEntryContext } from './context';
import { BROWSER_DRIVER_FILES, BROWSER_DRIVER_VERSION, browserResourcePaths, installedBrowserDriver, installedBrowserChrome, installBrowserDriver, installBrowserChrome, verifiedBrowserDriver } from './browserResourceStore';

export function createKikiBrowserEntry(ctx: CapabilityEntryContext, bundledDriver?: string): CapabilityEntry {
  const supported = ctx.platform === 'win32' && ctx.arch === 'x64';
  async function driver(): Promise<string | undefined> {
    return bundledDriver !== undefined && await verifiedBrowserDriver(bundledDriver) ? bundledDriver : installedBrowserDriver(ctx.kimiHomeDir);
  }
  return {
    id: 'kiki-browser', displayName: 'Browser control',
    description: 'Verified agent-browser driver and isolated Chrome for Testing on the Kiki service machine.', supported,
    detect: async () => {
      const command = await driver();
      const chrome = await installedBrowserChrome(ctx.kimiHomeDir);
      let valid = false;
      if (command !== undefined) {
        const probe = await runCommand(ctx.hostProcess, command, ['--version'], { timeout: 10_000 });
        valid = probe.code === 0 && probe.stdout.includes(`0.38.2 kiki-no-replay-r1 kiki-stdio-r1`);
      }
      return { version: valid ? BROWSER_DRIVER_VERSION : undefined, steps: [
        { id: 'driver', state: valid ? 'ok' : 'missing', detail: command },
        { id: 'chrome', state: chrome === undefined ? 'missing' : 'ok', detail: chrome?.version },
      ] };
    },
    install: async (report, signal, browserMode) => {
      if (!supported) throw new Error(`Managed browser installation is unavailable on ${ctx.platform}/${ctx.arch}`);
      if (await driver() === undefined) await installBrowserDriver(ctx.kimiHomeDir, report, ctx.fetchImpl, signal);
      signal?.throwIfAborted();
      if (browserMode !== 'driver-only') await installBrowserChrome(ctx.kimiHomeDir, report, ctx.fetchImpl, signal);
      signal?.throwIfAborted();
      return 'browser-components-installed';
    },
    plan: {
      artifact: { version: BROWSER_DRIVER_VERSION, url: BROWSER_DRIVER_FILES['agent-browser.exe']!.url,
        sha256: BROWSER_DRIVER_FILES['agent-browser.exe']!.sha256, metadataUrl: BROWSER_DRIVER_FILES['build.json']!.url, maxBytes: 32 * 1024 * 1024 },
      destination: browserResourcePaths(ctx.kimiHomeDir).root,
      note: 'Reuses the verified bundled driver or downloads the fixed Kiki derivative with SHA-256 checks and notices. Downloads Chrome for Testing from Google Stable metadata over HTTPS, without a publisher SHA-256; local executable hashes detect later changes. Installs only under Kiki home. No extensions, system services or package managers.',
    },
  };
}
