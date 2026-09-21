import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';

import { ProcessTerminal, TuiMainScreen } from '@kiki/pi-tui';

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
