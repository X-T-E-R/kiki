import type { ILogService } from '@kiki/agent-core-v2/_base/log/log';
import {
  migrateConfigCredentials,
  migrateThinkingEffortMaxToHigh as migrateEffort,
} from '@kiki/agent-core-v2/app/config/migrations';

import { withConfigWrite } from './toml';

const silentLog: ILogService = {
  _serviceBrand: undefined,
  level: 'off',
  setLevel() {},
  async flush() {},
  error() {},
  warn() {},
  info() {},
  debug() {},
  child() { return this; },
};

export async function migrateThinkingEffortMaxToHigh(configPath: string, homeDir: string): Promise<void> {
  await withConfigWrite(configPath, async (store, configKey) => {
    await migrateConfigCredentials(store, configKey, silentLog);
    await migrateEffort(store, configKey, homeDir, true);
  });
}
