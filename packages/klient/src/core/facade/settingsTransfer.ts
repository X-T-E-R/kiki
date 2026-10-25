import type {
  SettingsTransferApplyResult,
  SettingsTransferCatalog,
  SettingsTransferExportInput,
  SettingsTransferPackage,
  SettingsTransferPreview,
  SettingsTransferPreviewInput,
} from '@kiki/protocol';
import type { Caller } from './global.js';

export interface GlobalSettingsTransferFacade {
  catalog(): Promise<SettingsTransferCatalog>;
  export(input: SettingsTransferExportInput): Promise<SettingsTransferPackage>;
  preview(input: SettingsTransferPreviewInput): Promise<SettingsTransferPreview>;
  apply(input: { previewId: string }): Promise<SettingsTransferApplyResult>;
  cancel(input: { previewId: string }): Promise<void>;
}

export function createGlobalSettingsTransfer(call: Caller): GlobalSettingsTransferFacade {
  return {
    catalog: () => call('settingsTransferService', 'catalog', []) as Promise<SettingsTransferCatalog>,
    export: (input) => call('settingsTransferService', 'export', [input]) as Promise<SettingsTransferPackage>,
    preview: (input) => call('settingsTransferService', 'preview', [input]) as Promise<SettingsTransferPreview>,
    apply: (input) => call('settingsTransferService', 'apply', [input]) as Promise<SettingsTransferApplyResult>,
    cancel: (input) => call('settingsTransferService', 'cancel', [input]) as Promise<void>,
  };
}
