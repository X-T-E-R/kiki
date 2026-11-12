import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { EditLineRange, EditOperation } from './editService';

export interface FileEditInput {
  readonly path: string;
  readonly displayPath: string;
  readonly edits: readonly EditOperation[];
}

export type FileEditResult =
  | { readonly ok: true; readonly replacements: number; readonly changedLines: readonly EditLineRange[] }
  | { readonly ok: false; readonly error: string; readonly editIndex?: number };

export interface IFileEditService {
  readonly _serviceBrand: undefined;

  edit(input: FileEditInput, fs?: IHostFileSystem): Promise<FileEditResult>;
}

export const IFileEditService: ServiceIdentifier<IFileEditService> =
  createDecorator<IFileEditService>('fileEditService');
