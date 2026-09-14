import { collection } from '#/_base/di/collection';

export interface ConfigWriteValidator {
  readonly domain: string;
  validate(value: unknown): void;
}

export const ConfigWriteValidatorContribution = collection<ConfigWriteValidator>('config-write-validator');
