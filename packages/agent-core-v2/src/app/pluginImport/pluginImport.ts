import type { ImportSource, ImportPreviewInput, ImportPreview, ImportJob, ImportArchive, ImportDiscoveryInput, ImportDiscoveryPage, ImportListInput, ImportArchiveQuery, ImportReadInput, ImportReadPage, ImportStartInput } from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';

export interface IPluginImportService {
  readonly _serviceBrand: undefined;
  sources(): Promise<ImportSource[]>;
  discover(input: ImportDiscoveryInput): Promise<ImportDiscoveryPage>;
  preview(input: ImportPreviewInput): Promise<ImportPreview>;
  start(input: ImportStartInput): Promise<ImportJob>;
  jobs(input?: ImportListInput): Promise<{ items: ImportJob[]; cursor: string | null }>;
  job(id: string): Promise<ImportJob>;
  cancel(id: string): Promise<ImportJob>;
  resume(id: string): Promise<ImportJob>;
  archives(input?: ImportArchiveQuery): Promise<{ items: ImportArchive[]; cursor: string | null }>;
  read(input: ImportReadInput): Promise<ImportReadPage>;
}
export const IPluginImportService = createDecorator<IPluginImportService>('pluginImportService');
