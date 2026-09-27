import type { KimiRegion } from '@kiki/oauth';

import type { IPluginService } from '#/app/plugin/plugin';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { VerifiedArtifact } from '../verifiedArtifacts';

export interface CapabilityEntryContext {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly kimiHomeDir: string;
  readonly userHomeDir: string;
  readonly plugins: IPluginService;
  readonly hostProcess: IHostProcessService;
  readonly fetchImpl?: typeof fetch;
  readonly applicationsDir?: string;
  readonly webbridgeBaseUrl?: string;
  readonly webbridgeArtifact?: VerifiedArtifact;
  readonly windowsCuExecutableSha256?: string;
  readonly detectProbeTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly resolveRegion?: () => KimiRegion | Promise<KimiRegion>;
}
