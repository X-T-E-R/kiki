import type { HostProcessServiceLike } from '@kiki/acp-client';
import type { HarnessMcpLease } from '#/app/agentExecutor/harnessMcp';

export function harnessContextProcess(processes: HostProcessServiceLike, currentLease: () => HarnessMcpLease | undefined): HostProcessServiceLike {
  return {
    spawn: async (command, args, options) => {
      const lease = currentLease();
      if (lease === undefined) return processes.spawn(command, args, options);
      const server = lease.server;
      const env = 'command' in server ? Object.fromEntries(server.env.map(({ name, value }) => [name, value])) : {};
      return processes.spawn(command, [...args ?? [], ...lease.processArgs ?? []], {
        ...options, env: { ...options?.env, ...env, ...lease.processEnv },
      });
    },
  };
}
