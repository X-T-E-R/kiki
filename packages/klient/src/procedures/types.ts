import type { z } from 'zod';

export interface ProcedureCodec<Canonical, Wire> {
  readonly schema: z.ZodType<Wire>;
  decode(value: Wire): Canonical;
  encode(value: Canonical): unknown;
}

export interface DelegationProcedureDefinition<
  Name extends string,
  Input,
  Output,
  McpInput,
  LegacyInput,
> {
  readonly name: Name;
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  readonly mcp: {
    readonly toolName: string;
    readonly description: string;
    readonly input: ProcedureCodec<Input, McpInput>;
    encodeOutput(value: Output, input: Input): unknown;
  };
  readonly legacy: {
    readonly input: ProcedureCodec<Input, LegacyInput>;
    encodeOutput(value: Output): unknown;
  };
}

export type AnyDelegationProcedure = DelegationProcedureDefinition<
  string,
  unknown,
  unknown,
  unknown,
  unknown
>;

export type ProcedureName<Table extends readonly AnyDelegationProcedure[]> = Table[number]['name'];

export type ProcedureByName<
  Table extends readonly AnyDelegationProcedure[],
  Name extends ProcedureName<Table>,
> = Extract<Table[number], { readonly name: Name }>;

export type ProcedureInput<
  Table extends readonly AnyDelegationProcedure[],
  Name extends ProcedureName<Table>,
> = ProcedureByName<Table, Name> extends DelegationProcedureDefinition<
  Name,
  infer Input,
  unknown,
  unknown,
  unknown
>
  ? Input
  : never;

export type ProcedureOutput<
  Table extends readonly AnyDelegationProcedure[],
  Name extends ProcedureName<Table>,
> = ProcedureByName<Table, Name> extends DelegationProcedureDefinition<
  Name,
  unknown,
  infer Output,
  unknown,
  unknown
>
  ? Output
  : never;

export function defineDelegationProcedure<
  const Name extends string,
  Input,
  Output,
  McpInput,
  LegacyInput,
>(
  definition: DelegationProcedureDefinition<Name, Input, Output, McpInput, LegacyInput>,
): DelegationProcedureDefinition<Name, Input, Output, McpInput, LegacyInput> {
  return definition;
}
