import { dirname, resolve } from 'node:path';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const NB_SEARCH_ACL_TIMEOUT_MS = 15000;
const ACL_SCRIPT = "$ErrorActionPreference='Stop'; $paths=ConvertFrom-Json $env:NB_SEARCH_ACL_PATHS; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544'); foreach($p in $paths){$item=Get-Item -LiteralPath $p -Force; $walk=$item; while($null -ne $walk){if(($walk.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'reparse'}; $walk=$walk.Parent}; $acl=Get-Acl -LiteralPath $p; $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; if($allowed -notcontains $owner){throw 'owner'}; foreach($r in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $allowed -notcontains $r.IdentityReference.Value){throw 'permissions'}}}; [Console]::Write('ok')";

export class NbSearchLocalFileError extends Error {
  constructor(readonly issue: 'LOCAL_CONFIG_BUSY' | 'LOCAL_CREDENTIALS_UNREADABLE' | 'LOCAL_CREDENTIALS_UNSAFE' | 'LOCAL_CONFIG_CHANGED' | 'LOCAL_CREDENTIALS_TIMEOUT') {
    super(issue);
    this.name = 'NbSearchLocalFileError';
  }
}

/** Read-only, non-reflective helper for nb-search CLI credential file protections. */
export class NbSearchCredentialFileStore {
  constructor(
    private readonly fs: IHostFileSystem,
    private readonly processes: IHostProcessService,
  ) {}

  async read(path: string, protectedFile: boolean): Promise<string | undefined> {
    try {
      await this.rejectLinks(path);
      const stat = await this.statIfPresent(path);
      if (stat === undefined) return undefined;
      if (!stat.isFile || stat.size > MAX_FILE_BYTES) throw new NbSearchLocalFileError('LOCAL_CREDENTIALS_UNREADABLE');
      if (protectedFile) await this.assertProtected([dirname(path), path]);
      const bytes = await this.fs.readBytes(path, MAX_FILE_BYTES + 1);
      if (bytes.length > MAX_FILE_BYTES) throw new NbSearchLocalFileError('LOCAL_CREDENTIALS_UNREADABLE');
      await this.rejectLinks(path);
      const after = await this.fs.lstat(path);
      if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
        throw new NbSearchLocalFileError('LOCAL_CONFIG_CHANGED');
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    } catch (error) {
      throw error instanceof NbSearchLocalFileError ? error : new NbSearchLocalFileError('LOCAL_CREDENTIALS_UNREADABLE');
    }
  }

  async assertUnlocked(home: string): Promise<void> {
    try {
      if (await this.statIfPresent(resolve(home, '.config-access.lock')) !== undefined) {
        throw new NbSearchLocalFileError('LOCAL_CONFIG_BUSY');
      }
    } catch (error) {
      throw error instanceof NbSearchLocalFileError ? error : new NbSearchLocalFileError('LOCAL_CONFIG_BUSY');
    }
  }

  private async statIfPresent(path: string) {
    try {
      return await this.fs.lstat(path);
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'os.fs.not_found') return undefined;
      throw error;
    }
  }

  private async rejectLinks(path: string): Promise<void> {
    let current = resolve(path);
    for (;;) {
      if ((await this.statIfPresent(current))?.isSymbolicLink) throw new NbSearchLocalFileError('LOCAL_CREDENTIALS_UNSAFE');
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  private async assertProtected(paths: readonly string[]): Promise<void> {
    if (process.platform !== 'win32') {
      for (const path of paths) {
        const stat = await this.fs.lstat(path);
        if (stat.mode === undefined || (stat.mode & 0o077) !== 0
          || (process.getuid !== undefined && stat.uid !== process.getuid())) {
          throw new NbSearchLocalFileError('LOCAL_CREDENTIALS_UNSAFE');
        }
      }
      return;
    }
    let processHandle: IHostProcess | undefined;
    let completed = false;
    let expired = false;
    let released = false;
    const release = (): void => {
      if (processHandle === undefined || released) return;
      released = true;
      const owned = processHandle;
      if (!completed) void Promise.resolve().then(() => owned.kill('SIGKILL')).catch(() => {});
      void Promise.resolve().then(() => owned.dispose()).catch(() => {});
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        release();
        reject(new NbSearchLocalFileError('LOCAL_CREDENTIALS_TIMEOUT'));
      }, NB_SEARCH_ACL_TIMEOUT_MS);
    });
    const inspection = (async () => {
      processHandle = await this.processes.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT], {
        env: { NB_SEARCH_ACL_PATHS: JSON.stringify(paths.map((path) => resolve(path))) }, windowsHide: true,
      });
      if (expired) {
        release();
        throw new NbSearchLocalFileError('LOCAL_CREDENTIALS_TIMEOUT');
      }
      processHandle.stderr.resume();
      processHandle.stdin.end();
      let output = '';
      for await (const chunk of processHandle.stdout) {
        output += String(chunk);
        if (output.length > 16) throw new NbSearchLocalFileError('LOCAL_CREDENTIALS_UNSAFE');
      }
      const exitCode = await processHandle.wait();
      completed = true;
      if (exitCode !== 0 || output !== 'ok') throw new NbSearchLocalFileError('LOCAL_CREDENTIALS_UNSAFE');
    })();
    try {
      await Promise.race([inspection, deadline]);
    } finally {
      clearTimeout(timer);
      release();
    }
  }
}
