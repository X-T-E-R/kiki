import type { FuseState, FuseV1Options } from '@electron/fuses';

export declare const REQUIRED_ELECTRON_FUSES: Readonly<Record<number, FuseState>>;

export declare function verifyFuseConfig(
  fuseWire: Partial<Record<FuseV1Options, FuseState>>,
  options?: { readonly packaged?: boolean },
): { readonly ok: boolean; readonly failures: string[] };

export declare function verifyElectronBinaryFuses(
  binaryPath: string,
  options?: { readonly packaged?: boolean },
): Promise<{
  readonly binaryPath: string;
  readonly fuseWire: Record<number, FuseState>;
  readonly ok: boolean;
  readonly failures: string[];
}>;
