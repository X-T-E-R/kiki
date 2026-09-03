import type { HostFs } from '@kiki/agent-profiles/hostFs';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

export function agentProfilesHostFs(fs: IHostFileSystem): HostFs {
  return {
    readFile: (path) => fs.readText(path),
    readdir: (path) => fs.readdir(path),
    stat: (path) => fs.stat(path),
    realpath: (path) => fs.realpath(path),
  };
}
