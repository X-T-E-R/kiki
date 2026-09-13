import {
  bootstrap,
  IBootstrapService,
  IConfigService,
  ISessionIndex,
  applyPrintModeConfigDefaults,
  logSeed,
  resolveLoggingConfig,
  type BootstrapInput,
} from '@kiki/agent-core-v2';
import { createKlient } from '@kiki/klient/memory';
import type { Klient } from '@kiki/klient';

export { PRINT_MAX_TURNS_DEFAULT, PRINT_WAIT_CEILING_S_DEFAULT, setClampedTimeout } from '@kiki/agent-core-v2';
export type { AgentTaskConfig, PrintBackgroundMode } from '@kiki/agent-core-v2';

/** In-process print host. Sessions, prompts and resource policy remain on the returned facade. */
export interface PrintClientHost {
  readonly klient: Klient;
  readonly osHomeDir: string;
  dispose(): Promise<void>;
}

export async function createPrintClient(input: BootstrapInput & { homeDir: string }): Promise<PrintClientHost> {
  const { app } = bootstrap(input, [
    ...logSeed(resolveLoggingConfig({ homeDir: input.homeDir, env: process.env })),
  ]);
  try {
    const config = app.accessor.get(IConfigService);
    await config.ready;
    await applyPrintModeConfigDefaults(config);
    await app.accessor.get(ISessionIndex).prepare();
    const klient = createKlient({ scope: app });
    let disposing: Promise<void> | undefined;
    return {
      klient,
      osHomeDir: app.accessor.get(IBootstrapService).osHomeDir,
      dispose: () => disposing ??= klient.close().finally(() => app.dispose()),
    };
  } catch (error) {
    app.dispose();
    throw error;
  }
}
