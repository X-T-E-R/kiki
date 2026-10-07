/**
 * What a Recipe's script hooks will actually run.
 *
 * A shell command is the one thing in a Recipe package that executes, so it is
 * shown as itself: the command verbatim in the reading mono face, the event that
 * fires it, the package it came from, and the resource files that ship beside
 * it. Nothing is summarized into "this package runs scripts", because that is
 * exactly the sentence that cannot be checked against the manifest.
 *
 * The layout follows what a reader does with it. Event first — it decides
 * whether the hook matters at all — then the command on its own line where it
 * can be compared character by character against the source, then provenance in
 * the quiet ink scale, because that is reference material rather than the thing
 * being decided. Resource files are grouped into one list under all the
 * commands instead of repeating under each one: a package that ships three
 * scripts over two files should read as two files.
 *
 * This is a read view. It never edits, and the code it shows opens in the
 * existing editor rather than in a second code surface.
 */

import { useI18n } from '../../i18n';
import {
  recipeHookEventKey, recipeHookResourceFiles, recipeHookScriptsByEvent, recipeHookFileSize,
} from '../../lib/recipeHooks';
import type { RecipeHookPreview, RecipeScriptPreview } from '../../lib/recipes';

/** A resource file line: path, size, and how many commands read it. */
function ResourceFiles({ scripts }: { scripts: readonly RecipeScriptPreview[] }) {
  const { t } = useI18n();
  const files = recipeHookResourceFiles(scripts);
  if (files.length === 0) {
    return <p className="text-[12px] leading-5 text-ink-faint" data-recipe-hook-files="none">{t('st.recipeHook.filesNone')}</p>;
  }
  return (
    <div className="space-y-1 pt-0.5" data-recipe-hook-files>
      <p className="text-[11px] text-ink-faint">{t('st.recipeHook.resources')}</p>
      <ul className="divide-y divide-hairline border-y border-hairline">
        {files.map((file) => (
          <li key={file.path} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5" data-recipe-hook-file={file.path}>
            <span className="min-w-0 break-all font-mono text-[11.5px] text-ink-soft">{file.path}</span>
            <span className="shrink-0 font-mono text-[11px] text-ink-faint">
              {recipeHookFileSize(file.bytes)}
              {file.count > 1 ? ` · ${t('st.recipeHook.fileUsedBy', { count: String(file.count) })}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One command: the event line above it, provenance and conditions below. */
function HookScript({ script, index }: { script: RecipeScriptPreview; index: number }) {
  const { t } = useI18n();
  return (
    <li className="space-y-1" data-recipe-hook-script={index}>
      {/*
        The command is the object. It gets its own block at reading size rather
        than a truncated inline span, because deciding about a shell command
        means reading all of it, and a clipped command is not a decision anyone
        can make.
      */}
      <code className="block overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[12px] leading-5 text-ink">
        {script.command}
      </code>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        {/*
          Provenance is spelled in full here, not shortened to its last path
          segment. Everywhere else a Recipe's locator is a label; for a command
          it is the answer to "who wrote this and what am I trusting", and every
          package ends its locator in `recipe.toml`.
        */}
        <span className="min-w-0 break-all text-[11.5px] text-ink-soft" data-recipe-hook-source>{script.source}</span>
        {script.matcher === undefined ? null : (
          <span className="font-mono text-[11px] text-ink-faint" data-recipe-hook-matcher>
            {t('st.recipeHook.matcher', { matcher: script.matcher })}
          </span>
        )}
        {script.timeout === undefined ? null : (
          <span className="font-mono text-[11px] text-ink-faint" data-recipe-hook-timeout>
            {t('st.recipeHook.timeout', { seconds: String(script.timeout) })}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * The whole script section, or nothing at all.
 *
 * A package with no scripts declares none, and gets no section: an empty
 * "scripts" heading on an ordinary prompt package would be UI the person has to
 * read past in order to learn there is nothing there.
 */
export function RecipeHookScripts({ hooks, headingLevel = 'h4' }: {
  hooks: RecipeHookPreview | undefined;
  headingLevel?: 'h4' | 'h5';
}) {
  const { t } = useI18n();
  if (hooks === undefined || hooks.scripts.length === 0) return null;
  const Heading = headingLevel;
  const groups = recipeHookScriptsByEvent(hooks.scripts);
  return (
    <section className="space-y-2.5" data-recipe-hooks>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <Heading className="text-[13px] font-medium text-ink">{t('st.recipeHook.title')}</Heading>
        <span className="font-mono text-[11px] text-ink-faint" data-recipe-hook-count>
          {t('st.recipeHook.scriptCount', { count: String(hooks.scripts.length) })}
        </span>
      </div>
      {groups.map((group) => (
        <div key={group.event} className="space-y-2" data-recipe-hook-event={group.event}>
          {/* An event this build has no wording for is shown as the package
              spelled it, rather than as a dictionary key. */}
          <p className="text-[12px] font-medium text-ink-soft">
            {recipeHookEventKey(group.event) === undefined ? group.event : t(recipeHookEventKey(group.event)!)}
          </p>
          <ul className="space-y-2.5">
            {group.scripts.map((script, index) => <HookScript key={`${group.event}-${index}`} script={script} index={index} />)}
          </ul>
        </div>
      ))}
      <ResourceFiles scripts={hooks.scripts} />
    </section>
  );
}

/**
 * The one paragraph that says what agreeing means, plus the scripts it covers.
 *
 * It is written to be read once and believed: the scripts run in this
 * application, not in a sandbox, so they can reach whatever files and network
 * this session can reach. Naming that is not a warning bolted onto a button —
 * it is the part of the decision a person cannot get from the command text
 * alone. Everything else about the package keeps its existing confirmation.
 */
export function RecipeHookConsentBody({ hooks, name }: {
  hooks: RecipeHookPreview;
  /** The package name, so the question is about this object and not a class of package. */
  name: string;
}) {
  const { t } = useI18n();
  return (
    <div className="mt-3 space-y-3" data-recipe-hook-consent>
      <p className="text-[13px] leading-relaxed text-ink" data-recipe-hook-consent-lead>
        {t('st.recipeHook.consentLead', { name })}
      </p>
      <p className="text-[12.5px] leading-relaxed text-ink-soft" data-recipe-hook-consent-power>
        {t('st.recipeHook.consentPower')}
      </p>
      <RecipeHookScripts hooks={hooks} headingLevel="h5" />
      <p className="text-[12px] leading-5 text-ink-faint" data-recipe-hook-consent-once>
        {t('st.recipeHook.consentOnce')}
      </p>
    </div>
  );
}
