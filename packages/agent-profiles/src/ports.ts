export type { HostFs } from './hostFs';

export interface ModelAliasResolver {
  resolveId(alias: string): string | undefined;
}

export type ExecutorOptions = Readonly<Record<string, string | number | boolean>>;

export interface ExecutorValidator {
  validateExecutor(id: string, options: ExecutorOptions | undefined): string | undefined;
}
