export type TestSunsetSpec =
  | { readonly kind: 'permanent' }
  | { readonly kind: 'flagRemoved'; readonly flag: string }
  | { readonly kind: 'symbolRemoved'; readonly file: string; readonly symbol: string }
  | { readonly kind: 'routeRemoved'; readonly method: string; readonly path: string }
  | { readonly kind: 'expires'; readonly date: string; readonly ticket: string };

export interface TestContractSpec {
  readonly invariant: string;
  readonly mechanism: string;
  readonly covers: string | readonly string[];
  readonly sunset_when: string;
  readonly sunset: TestSunsetSpec;
  readonly tags?: readonly string[];
}

export interface NormalizedTestContract {
  readonly invariant: string;
  readonly mechanism: string;
  readonly covers: readonly string[];
  readonly sunset_when: string;
  readonly sunset: Readonly<TestSunsetSpec>;
  readonly tags: readonly string[];
}

export declare function defineTestContract(spec: TestContractSpec): NormalizedTestContract;
export declare function getRegisteredTestContracts(): NormalizedTestContract[];
