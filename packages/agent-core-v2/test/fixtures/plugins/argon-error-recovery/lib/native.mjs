import { ARGON_MODEL_ALIAS, nativeRecoveryFor } from './recovery.mjs';

const pluginId = 'argon-error-recovery';
const fileIndexHeading = '## Files read (content not carried)';
const fileIndexSection = /^## Files read \(content not carried\)[ \t]*\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/gm;

function existingFileIndex(history) {
  for (const message of history.toReversed()) {
    if (message.origin?.kind !== 'compaction_summary') continue;
    for (const part of message.content.toReversed()) {
      if (part.type !== 'text') continue;
      const section = [...part.text.matchAll(fileIndexSection)].at(-1)?.[0]?.trim();
      if (section !== undefined && section.slice(fileIndexHeading.length).trim().length > 0) return section;
    }
  }
  return undefined;
}

async function disposeRegistrations(registrations) {
  const failures = [];
  for (const registration of registrations.toReversed()) {
    try {
      await registration.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Failed to dispose Argon extension ports');
}

export function registerArgonExtensionPorts(ports) {
  const registrations = [
    ports.registerRecoveryPolicy(pluginId, nativeRecoveryFor),
    ports.registerCompactionPolicy({
      pluginId,
      matches: ({ modelAlias, protocol }) => modelAlias === ARGON_MODEL_ALIAS && protocol === 'anthropic',
      buildSummaryGuidance: async ({ history, signal }) => {
        signal.throwIfAborted();
        const preservedFileIndexMarkdown = existingFileIndex(history);
        if (preservedFileIndexMarkdown === undefined) return undefined;
        return {
          additionalInstructions: 'Keep the existing transcript file index as historical context; do not infer entries or treat it as current file contents.',
          preservedFileIndexMarkdown,
        };
      },
    }),
  ];
  let disposal;
  return {
    dispose() {
      if (disposal === undefined) disposal = disposeRegistrations(registrations);
      return disposal;
    },
  };
}

export default function apply(ctx) {
  const ports = ctx.get('kiki.extensionPorts');
  if (ports) {
    const d = registerArgonExtensionPorts(ports);
    ctx.effect(() => () => d.dispose());
  }
}
