import type {
  SettingsTransferApplyResult,
  SettingsTransferCatalog,
  SettingsTransferExportInput,
  SettingsTransferPackage,
  SettingsTransferPreview,
  SettingsTransferPreviewInput,
} from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';

export interface ISettingsTransferService {
  readonly _serviceBrand: undefined;
  catalog(): Promise<SettingsTransferCatalog>;
  export(input: SettingsTransferExportInput): Promise<SettingsTransferPackage>;
  preview(input: SettingsTransferPreviewInput): Promise<SettingsTransferPreview>;
  apply(input: { previewId: string }): Promise<SettingsTransferApplyResult>;
  cancel(input: { previewId: string }): Promise<void>;
}

export const ISettingsTransferService = createDecorator<ISettingsTransferService>('settingsTransferService');
