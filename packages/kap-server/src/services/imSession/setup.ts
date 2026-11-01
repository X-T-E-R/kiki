import { imSetupCatalogSchema, type ImPasteResult, type ImSetupCatalog, type ImSetupProvider } from '@kiki/protocol';
import { ImSessionSetup as CoreImSessionSetup, imSetupCatalog as coreImSetupCatalog, type ImSetupOperations } from '@kiki-dsh/im-bridge-core/setup';
import {
  SESSION_CAPABILITIES,
  SESSION_SETUP,
  discoverMatrix,
  discordInstallUrl,
  exchangeMatrixLogin,
  exchangeSlackOAuth,
  matrixPasswordLogin,
  matrixSsoUrl,
  slackManifestInstallUrl,
  slackOAuthUrl,
} from '@nb-im/core';

const setupOperations: ImSetupOperations = {
  descriptors: {
    discord: { ...SESSION_SETUP.discord, capabilities: SESSION_CAPABILITIES.discord },
    slack: { ...SESSION_SETUP.slack, capabilities: SESSION_CAPABILITIES.slack },
    matrix: { ...SESSION_SETUP.matrix, capabilities: SESSION_CAPABILITIES.matrix },
  },
  discordInstallUrl,
  slackManifestInstallUrl,
  slackOAuthUrl,
  exchangeSlackOAuth,
  discoverMatrix,
  matrixSsoUrl,
  exchangeMatrixLogin,
  matrixPasswordLogin,
};

export function imSetupCatalog(): ImSetupCatalog {
  return imSetupCatalogSchema.parse(coreImSetupCatalog(setupOperations));
}

export class ImSessionSetup extends CoreImSessionSetup {
  constructor(save: (provider: ImSetupProvider, fields: Readonly<Record<string, string>>, instanceId?: string) => Promise<ImPasteResult>) {
    super(save, setupOperations);
  }
}
