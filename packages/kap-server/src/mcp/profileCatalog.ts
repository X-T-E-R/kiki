export interface DispatchProfileCatalogEntry {
  readonly profileName: string;
  readonly description?: string;
  readonly whenToUse?: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly allowedModels?: readonly string[];
  readonly alternativeModels: readonly {
    readonly alias: string;
    readonly when: string;
    readonly thinkingEffort?: string;
  }[];
  readonly tools?: string;
}

export function renderProfileCatalogEntries(
  entries: readonly DispatchProfileCatalogEntry[],
): string {
  return entries
    .map((entry) => {
      const details = [entry.description, entry.whenToUse].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const header =
        details.length === 0
          ? `- ${entry.profileName}`
          : `- ${entry.profileName}: ${details.join(' ')}`;
      const lines = [header];
      if (entry.modelAlias !== undefined) lines.push(`  Model alias: ${entry.modelAlias}`);
      if (entry.thinkingEffort !== undefined) {
        lines.push(`  Thinking effort: ${entry.thinkingEffort}`);
      }
      if (entry.allowedModels !== undefined && entry.allowedModels.length > 0) {
        lines.push(`  Allowed models: ${entry.allowedModels.join(', ')}`);
      }
      if (entry.alternativeModels.length > 0) {
        lines.push(
          `  Alternative models: ${entry.alternativeModels
            .map((model) =>
              model.thinkingEffort === undefined
                ? `${model.alias} — ${model.when}`
                : `${model.alias} (thinking_effort=${model.thinkingEffort}) — ${model.when}`,
            )
            .join('; ')}`,
        );
      }
      if (entry.tools !== undefined) lines.push(`  Tools: ${entry.tools}`);
      return lines.join('\n');
    })
    .join('\n');
}
