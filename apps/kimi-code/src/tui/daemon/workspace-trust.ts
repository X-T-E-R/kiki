import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';

import { loadMcpServers } from '@kiki/agent-core-v2/app/mcpConfig/configLoader';
import { HostFileSystem } from '@kiki/agent-core-v2/os/backends/node-local/hostFsService';
import { ProcessTerminal, TuiMainScreen } from '@kiki/pi-tui';
import type { WorkspaceTrustMcpServerInfo } from '@kiki/node-sdk';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import {
  TrustPromptComponent,
  type TrustPromptChoice,
} from '#/tui/components/dialogs/trust-prompt';
import { CHROME_GUTTER } from '#/tui/constant/rendering';

interface TrustRecord {
  readonly root: string;
  readonly trustedAt: number;
}

/**
 * The project MCP servers trusting this workDir would enable, in the same
 * safe field shape the SDK's `getWorkspaceTrustInfo` reports. Computed from
 * the same pure config loader the engine's `workspaceMcpConfig` uses, with
 * project files included vs skipped; best-effort — an unreadable or invalid
 * project file degrades to an empty list rather than blocking the gate.
 * User-level entries are not gated, so only project-only additions are
 * listed (the same subtraction the SDK route applies).
 */
export async function gatedMcpServers(
  homeDir: string,
  workDir: string,
): Promise<readonly WorkspaceTrustMcpServerInfo[]> {
  try {
    const fs = new HostFileSystem();
    const [withProject, userOnly] = await Promise.all([
      loadMcpServers({ fs, cwd: workDir, homeDir, includeProject: true }),
      loadMcpServers({ fs, cwd: workDir, homeDir, includeProject: false }),
    ]);
    return Object.entries(withProject)
      .filter(([name, config]) => {
        if (name in userOnly && userOnly[name] === config) return false;
        return config.enabled !== false;
      })
      .map(([name, config]): WorkspaceTrustMcpServerInfo => {
        if (config.transport === 'stdio') {
          return {
            name,
            transport: 'stdio',
            command: config.command,
            args: config.args,
            cwd: config.cwd,
          };
        }
        return { name, transport: config.transport, url: config.url };
      })
      .toSorted((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function runWorkspaceTrustGate(options: {
  readonly homeDir: string;
  readonly workDir: string;
}): Promise<boolean> {
  if (await isWorkspaceTrusted(options.homeDir, options.workDir)) return true;

  const terminal = new ProcessTerminal();
  const ui = new TuiMainScreen(terminal);
  const container = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const choice = new Promise<TrustPromptChoice>((resolveChoice) => {
    const prompt = new TrustPromptComponent({
      workDir: options.workDir,
      gatedMcpServers: [],
      onSelect: resolveChoice,
    });
    container.addChild(prompt);
    ui.addChild(container);
    ui.setFocus(prompt);
    void gatedMcpServers(options.homeDir, options.workDir).then((servers) => {
      prompt.setGatedMcpServers(servers);
      prompt.invalidateRender();
    });
  });
  ui.start();
  try {
    if ((await choice) !== 'trust') return false;
    await trustWorkspace(options.homeDir, options.workDir);
    return true;
  } finally {
    await terminal.drainInput();
    ui.stop();
  }
}

export async function isWorkspaceTrusted(homeDir: string, workDir: string): Promise<boolean> {
  const canonicalKey = workspaceTrustKey(canonicalWorkspaceRoot(workDir));
  return hasTrustRecord(homeDir, canonicalKey);
}

export async function trustWorkspace(homeDir: string, workDir: string): Promise<void> {
  const root = canonicalWorkspaceRoot(workDir);
  const target = join(homeDir, 'workspace-trust', workspaceTrustKey(root));
  const temp = `${target}.${randomUUID()}.tmp`;
  await mkdir(join(homeDir, 'workspace-trust'), { recursive: true, mode: 0o700 });
  await writeFile(temp, JSON.stringify({ root, trustedAt: Date.now() } satisfies TrustRecord), {
    mode: 0o600,
  });
  await rename(temp, target);
}

export function canonicalWorkspaceRoot(workDir: string): string {
  const windowsShaped = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/u.test(workDir);
  const absolute = windowsShaped
    ? win32.resolve(workDir).replaceAll('\\', '/')
    : resolve(workDir);
  const normalized = absolute.replaceAll('\\', '/').replace(/\/+$/u, '');
  return windowsShaped ? normalized.toLowerCase() : normalized;
}

export function workspaceTrustKey(workDir: string): string {
  const normalized = workDir.replaceAll('\\', '/').replace(/\/+$/u, '');
  const base = normalized.split('/').pop() ?? normalized;
  const slug = base
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replaceAll(/^-+|-+$/gu, '');
  const safeSlug = slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `wd_${safeSlug}_${hash}`;
}

async function hasTrustRecord(homeDir: string, key: string): Promise<boolean> {
  try {
    const record = JSON.parse(
      await readFile(join(homeDir, 'workspace-trust', key), 'utf8'),
    ) as Partial<TrustRecord>;
    return typeof record.root === 'string' && typeof record.trustedAt === 'number';
  } catch {
    return false;
  }
}
