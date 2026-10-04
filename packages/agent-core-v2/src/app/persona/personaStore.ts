import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type {
  PersonaDefinition,
  PersonaDelivery,
  PersonaMemoryDefinition,
  PersonaSnapshot,
} from '@kiki/agent-profiles/personaFile';

export type {
  PersonaDefinition,
  PersonaDelivery,
  PersonaMemoryDefinition,
  PersonaSharedMemoryScope,
  PersonaSnapshot,
} from '@kiki/agent-profiles/personaFile';

export type PersonaCardFormat = 'png' | 'json' | 'charx';
export type PersonaAvatarMime = 'image/png' | 'image/jpeg' | 'image/webp';
export type PersonaAvatarShape = 'circle' | 'square';
export type PersonaMemoryIntegrationStatus = 'committed' | 'pending' | 'failed';

export interface PersonaSummary {
  readonly id: string;
  readonly name: string;
  readonly title?: string;
  readonly job?: string;
  readonly revision: string;
  readonly archived: boolean;
  readonly homeSessionId?: string;
  readonly pinned?: boolean;
  readonly hidden?: boolean;
  readonly avatarMime?: PersonaAvatarMime;
  readonly avatarShape?: PersonaAvatarShape;
}

export interface PersonaState {
  readonly version: 1;
  readonly archived: boolean;
  readonly homeSessionId?: string;
  readonly pinned?: boolean;
  readonly hidden?: boolean;
  readonly pausedCronTasks?: readonly { readonly workspaceId: string; readonly taskId: string; readonly wasPaused: boolean }[];
  readonly [key: string]: unknown;
}

export type PersonaStatePatch = Partial<Omit<PersonaState, 'version'>>;

export interface PersonaLifecycleHooks {
  beforeArchive(id: string, state: PersonaState, record: (patch: PersonaStatePatch) => Promise<void>): Promise<PersonaStatePatch>;
  beforeDelete(id: string): Promise<void>;
}

export interface PersonaPutInput {
  readonly definition?: PersonaDefinition;
  readonly id?: string;
  readonly name?: string;
  readonly title?: string;
  readonly job?: string;
  readonly profile?: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly greeting?: string;
  readonly greetings?: readonly string[];
  readonly roomGreeting?: string;
  readonly delivery?: PersonaDelivery;
  readonly memory?: PersonaMemoryDefinition;
  readonly skills?: readonly string[];
  readonly tags?: readonly string[];
  readonly notes?: string;
  readonly homeWorkspace?: string;
  readonly description?: string;
  readonly examples?: string;
  readonly extensions?: unknown;
  readonly expectedRevision?: string;
  readonly createOnly?: boolean;
}

export interface PersonaDuplicateOptions {
  readonly id?: string;
  readonly name?: string;
}

export interface PersonaListOptions {
  readonly includeArchived?: boolean;
}

export interface PersonaAvatarInput {
  readonly data: Uint8Array;
  readonly mimeType?: string;
  readonly shape?: PersonaAvatarShape;
}

export interface PersonaAvatar {
  readonly data: Uint8Array;
  readonly mimeType: PersonaAvatarMime;
  readonly extension: 'png' | 'jpg' | 'webp';
  readonly width: number;
  readonly height: number;
  readonly shape?: PersonaAvatarShape;
}

export interface PersonaImportInput {
  readonly data: Uint8Array | string;
  readonly format?: PersonaCardFormat;
  readonly filename?: string;
}

export interface PersonaMemoryImportEntry {
  readonly title: string;
  readonly body: string;
  readonly pinned: boolean;
  readonly type: 'reference';
}

export interface PersonaMemoryHooks {
  importLorebook(personaId: string, entries: readonly PersonaMemoryImportEntry[]): Promise<void>;
  deletePersonaNamespaces(personaId: string): Promise<void>;
}

export interface PersonaAvatarPreview {
  readonly data: string;
  readonly mimeType: PersonaAvatarMime;
}

export interface PersonaImportPreview {
  readonly format: PersonaCardFormat;
  readonly definition: PersonaDefinition;
  readonly examples?: string;
  readonly avatar?: PersonaAvatarPreview;
  readonly avatarMimeType?: PersonaAvatarMime;
  readonly memoryEntries: readonly PersonaMemoryImportEntry[];
  readonly ignoredFields: readonly string[];
  readonly extensions?: unknown;
}

export interface PersonaImportResult {
  readonly snapshot: PersonaSnapshot;
  readonly memory: {
    readonly status: PersonaMemoryIntegrationStatus;
    readonly count: number;
    readonly error?: string;
  };
}

export interface PersonaDeleteResult {
  readonly memory: {
    readonly status: PersonaMemoryIntegrationStatus;
    readonly error?: string;
  };
}

export interface PersonaExport {
  readonly format: PersonaCardFormat;
  readonly extension: `.${PersonaCardFormat}`;
  readonly mimeType: 'image/png' | 'application/json' | 'application/zip';
  readonly data: Uint8Array;
  readonly memoryScopes?: readonly string[];
}

export interface PersonaExportOptions {
  readonly includeMemory?: boolean;
}

export interface IPersonaStore {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<void>;
  get(id: string): Promise<PersonaSnapshot | undefined>;
  list(options?: PersonaListOptions): Promise<readonly PersonaSummary[]>;
  put(input: PersonaPutInput | PersonaDefinition): Promise<PersonaSnapshot>;
  duplicate(id: string, options?: PersonaDuplicateOptions | string): Promise<PersonaSnapshot>;
  archive(id: string, archived?: boolean): Promise<PersonaState>;
  getState(id: string): Promise<PersonaState>;
  updateState(id: string, patch: PersonaStatePatch, validate?: (current: PersonaState) => Promise<void>): Promise<PersonaState>;
  claimHomeSession(id: string, sessionId: string, expectedHomeSessionId?: string): Promise<PersonaState>;
  setLifecycleHooks(hooks: PersonaLifecycleHooks | undefined): void;
  delete(id: string, expectedRevision?: string): Promise<PersonaDeleteResult>;
  previewImport(input: PersonaImportInput): Promise<PersonaImportPreview>;
  importCard(input: PersonaImportInput, options?: { readonly id?: string }): Promise<PersonaImportResult>;
  exportCard(id: string, format: PersonaCardFormat, options?: PersonaExportOptions): Promise<PersonaExport>;
  getAvatar(id: string): Promise<PersonaAvatar | undefined>;
  putAvatar(id: string, input: PersonaAvatarInput | Uint8Array): Promise<PersonaAvatar>;
  deleteAvatar(id: string): Promise<boolean>;
  setMemoryHooks(hooks: PersonaMemoryHooks | undefined): void;
}

export const IPersonaStore: ServiceIdentifier<IPersonaStore> = createDecorator<IPersonaStore>('personaStore');
