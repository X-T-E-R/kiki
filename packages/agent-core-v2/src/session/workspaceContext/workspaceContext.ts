import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionWorkspaceContext {
  readonly _serviceBrand: undefined;

  readonly workDir: string;
  readonly additionalDirs: readonly string[];
  resolve(rel: string): string;
  isWithin(absPath: string): boolean;
}

export const ISessionWorkspaceContext: ServiceIdentifier<ISessionWorkspaceContext> =
  createDecorator<ISessionWorkspaceContext>('sessionWorkspaceContext');
