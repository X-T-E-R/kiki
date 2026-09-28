import { definitions } from './lib/definitions.mjs';
import { createOfficeCore } from './lib/office.mjs';
import { installPinnedBinary } from './lib/binary.mjs';

export const installPrerequisite = installPinnedBinary;

export function register(api) {
  for (const definition of definitions) {
    api.registerTool(definition, async (args, context) => {
      const core = createOfficeCore({ scope: {
        workspaceRoot: context.workspaceRoot,
        approvedPaths: context.approvedPaths,
        binaryPath: context.settings?.officecliPath,
      } });
      const result = await core.run(definition.name, args, context);
      if (result.success && result.data?.image) return {
        output: [{ type: 'text', text: `Rendered page ${result.data.page} of ${args.file}.` },
          { type: 'image_url', imageUrl: { url: result.data.image } }],
      };
      if (result.success && result.data?.html) return { output: result.data.html };
      return { output: result.success ? result.data?.text ?? result.data : JSON.stringify(result.error), isError: !result.success };
    });
  }
}
