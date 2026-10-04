import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { x as extractTar } from 'tar';

import { extractBinaryZip } from '#/os/backends/node-local/binaryArchive';
import { isComputerMcpConfig } from '#/mcpCore/computer';
import type { GlobalMcpServerConfig } from '#/app/mcpManagement/mcpManagement';
import { downloadToFile, type FetchLike } from '../host';
import type { CapabilityEntry, CapabilityInstallReporter } from '../types';
import type { CapabilityEntryContext } from './context';
import { computerArtifact, type ComputerArtifact } from './computerArtifacts';

export function computerMcpConfig(platform: NodeJS.Platform, binary: string): GlobalMcpServerConfig {
  return { name: 'kiki-computer', transport: 'stdio', command: binary,
    args: platform === 'darwin' ? ['mcp', '--direct'] : ['mcp'], executor: 'local' };
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

export async function verifyComputerFiles(directory: string, artifact: ComputerArtifact): Promise<boolean> {
  try {
    for (const [relative, expected] of Object.entries(artifact.files)) {
      const file = path.join(directory, relative);
      const before = await lstat(file);
      if (!before.isFile() || before.isSymbolicLink()) return false;
      let parent = path.dirname(file);
      while (parent !== path.dirname(directory)) {
        const stat = await lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
        if (parent === directory) break;
        parent = path.dirname(parent);
      }
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      const after = await lstat(file);
      if (hash.digest('hex') !== expected || before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== after.size || before.mtimeMs !== after.mtimeMs) return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function releaseFetch(fetchImpl: typeof fetch): FetchLike {
  return async (url, init) => {
    let current = url;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetchImpl(current, { signal: init?.signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      if (location === null) throw new Error('Release redirect has no location');
      const next = new URL(location, current);
      if (next.protocol !== 'https:' || next.username || next.password ||
          !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)) {
        throw new Error('Release redirect left the approved GitHub asset origins');
      }
      await response.body?.cancel();
      current = next.href;
    }
    throw new Error('Too many release redirects');
  };
}

export function createKikiComputerEntry(ctx: CapabilityEntryContext): CapabilityEntry {
  const artifact = ctx.computerArtifact ?? computerArtifact(ctx.platform, ctx.arch);
  const root = path.join(ctx.kimiHomeDir, 'capabilities', 'kiki-computer');
  const destination = artifact === undefined ? undefined : path.join(root, artifact.directory);
  const binary = artifact === undefined || destination === undefined ? undefined :
    path.join(destination, artifact.directory, artifact.executable);

  async function installed(): Promise<boolean> {
    return artifact !== undefined && destination !== undefined && binary !== undefined &&
      await verifyComputerFiles(path.join(destination, artifact.directory), artifact) &&
      (ctx.platform === 'win32' || await access(binary, constants.X_OK).then(() => true, () => false));
  }

  async function configureMcp(): Promise<string> {
    if (ctx.computerMcp === undefined || binary === undefined) throw new Error('MCP management is unavailable');
    const servers = await ctx.computerMcp.listServers();
    if (servers.some((server) => isComputerMcpConfig(server.config))) return 'existing-mcp-config-reused';
    if (servers.some((server) => server.name === 'kiki-computer')) {
      throw new Error('MCP name kiki-computer is already configured for another command; existing configuration was preserved');
    }
    await ctx.computerMcp.addServer(computerMcpConfig(ctx.platform, binary));
    return 'mcp-configured';
  }

  async function install(report: CapabilityInstallReporter): Promise<string> {
    if (artifact === undefined || destination === undefined) throw new Error(`No pinned cua-driver package for ${ctx.platform}/${ctx.arch}`);
    if (await installed()) return configureMcp();
    if (await exists(destination)) throw new Error('Computer driver installation exists but is unverified; refusing download or overwrite');
    await mkdir(root, { recursive: true });
    const staging = await mkdtemp(path.join(root, '.install-'));
    let ownsDestination = false;
    try {
      const archive = path.join(staging, ctx.platform === 'win32' ? 'release.zip' : 'release.tar.gz');
      report('download', 0);
      await downloadToFile(artifact.url, archive, (percent) => report('download', percent),
        releaseFetch(ctx.fetchImpl ?? fetch), { sha256: artifact.sha256, maxBytes: artifact.maxBytes });
      report('extract');
      const extracted = path.join(staging, 'extracted');
      await mkdir(extracted);
      if (ctx.platform === 'win32') await extractBinaryZip(archive, extracted);
      else await extractTar({ file: archive, cwd: extracted, strict: true, preservePaths: false,
        filter: (name, entry) => {
          const relative = name.startsWith(`${artifact.directory}/`) ? name.slice(artifact.directory.length + 1) : undefined;
          const type = 'type' in entry ? entry.type : undefined;
          if (type === 'Directory') return name === artifact.directory || name === `${artifact.directory}/` ||
            (relative !== undefined && Object.keys(artifact.files).some((file) => file.startsWith(relative.endsWith('/') ? relative : `${relative}/`)));
          if (type !== 'File' || relative === undefined || artifact.files[relative] === undefined) {
            throw new Error('Release archive contains an unexpected entry');
          }
          return true;
        },
      });
      const packageDirectory = path.join(extracted, artifact.directory);
      if (!(await verifyComputerFiles(packageDirectory, artifact))) throw new Error('Extracted computer driver files do not match the pinned release');
      if (ctx.platform !== 'win32') {
        for (const name of Object.keys(artifact.files)) {
          if (name.endsWith('cua-driver') || name.endsWith('cua-cursor-theme')) await chmod(path.join(packageDirectory, name), 0o755);
        }
      }
      report('install');
      await mkdir(destination);
      ownsDestination = true;
      await rename(packageDirectory, path.join(destination, artifact.directory));
      if (!(await installed())) throw new Error('Installed computer driver did not pass verification');
    } catch (error) {
      if (ownsDestination) await rm(destination, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    report('mcp');
    return configureMcp();
  }

  return {
    id: 'kiki-computer', displayName: 'Computer control',
    description: 'Pinned open-source cua-driver MCP on the current Kiki service machine.',
    supported: artifact !== undefined,
    plan: artifact === undefined || binary === undefined ? undefined : {
      artifact, destination: binary,
      note: 'cua-driver 0.32.0, MIT driver with bundled third-party notices. Installs only into Kiki home; no services, system permissions, perception or Spaces packages. Existing MCP configurations are preserved. Component verification does not confirm desktop access.',
    },
    detect: async () => {
      const verified = await installed();
      return { version: verified ? artifact?.version : undefined,
        steps: [{ id: 'component', state: verified ? 'ok' : 'missing',
          detail: verified ? binary : 'Pinned driver files and notices are not installed or did not pass verification' },
          { id: 'desktop-access', state: 'missing', optional: true,
            detail: 'Not checked by installation. Connect MCP and use its actual permission and observation tools.' }],
      };
    },
    install,
  };
}
