import type { ImportSource, ImportPreviewInput, ImportPreview, ImportJob, ImportArchive, ImportDiscoveryInput, ImportDiscoveryPage, ImportListInput, ImportArchiveQuery, ImportReadInput, ImportReadPage, ImportStartInput } from '@kiki/protocol';
import type { Caller } from './global.js';

export interface GlobalImportsFacade {
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
export function createGlobalImports(call: Caller): GlobalImportsFacade {
  return {
    sources: () => call('pluginImportService', 'sources', []) as Promise<ImportSource[]>,
    discover: (input) => call('pluginImportService', 'discover', [input]) as Promise<ImportDiscoveryPage>,
    preview: (input) => call('pluginImportService', 'preview', [input]) as Promise<ImportPreview>,
    start: (input) => call('pluginImportService', 'start', [input]) as Promise<ImportJob>,
    jobs: (input) => call('pluginImportService', 'jobs', [input]) as Promise<{ items: ImportJob[]; cursor: string | null }>,
    job: (id) => call('pluginImportService', 'job', [id]) as Promise<ImportJob>,
    cancel: (id) => call('pluginImportService', 'cancel', [id]) as Promise<ImportJob>,
    resume: (id) => call('pluginImportService', 'resume', [id]) as Promise<ImportJob>,
    archives: (input) => call('pluginImportService', 'archives', [input]) as Promise<{ items: ImportArchive[]; cursor: string | null }>,
    read: (input) => call('pluginImportService', 'read', [input]) as Promise<ImportReadPage>,
  };
}
