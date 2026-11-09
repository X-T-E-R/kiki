import type { IPluginHostService } from '#/app/plugin/pluginHostService';
import { Error2, ErrorCodes } from '#/errors';
import type { AutoModelInput } from './autoModel';

export async function runAutoModelPlugin(
  hosts: IPluginHostService,
  selector: { readonly id: string; readonly tool: string },
  input: AutoModelInput,
  signal: AbortSignal,
): Promise<unknown> {
  const registration = (await hosts.list()).find((entry) => entry.pluginId === selector.id && entry.definition.name === selector.tool);
  if (registration === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Configured model selector plugin tool is not enabled.');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const result = await hosts.execute(selector.id, selector.tool, input, deadline,
    undefined, undefined, registration.definition).catch(() => {
      signal.throwIfAborted();
      throw new Error2(ErrorCodes.CONFIG_INVALID, deadline.aborted ? 'Model selector plugin timed out.' : 'Model selector plugin execution failed.');
    });
  if (result.isError) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Model selector plugin tool failed.');
  if (typeof result.output !== 'string' || Buffer.byteLength(result.output) > 8192) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'Model selector plugin must return at most 8192 bytes of JSON text.');
  }
  try {
    return JSON.parse(result.output) as unknown;
  } catch {
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'Model selector plugin returned invalid JSON.');
  }
}
