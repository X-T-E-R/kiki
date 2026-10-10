/**
 * What a Recipe package says and provides.
 *
 * The order is the argument the package makes, so the reading order follows it:
 * what it does to this model, then the prompt prose itself, then where every
 * part came from. Provenance is deliberately last — it is real information, but
 * it is not what a person needs in order to decide whether to use the package.
 *
 * Everything shown here is the package's own resolved content, read from the
 * server. The GUI does not recompute inheritance, budget clipping or field
 * validity: a preview says what the package declares, and the model page says
 * what the model ended up with, and the two are not the same claim.
 */

import { useState } from 'react';

import { useI18n } from '../../i18n';
import {
  RECIPE_POSITIONS, recipeDiagnosticText, recipeFileNames,
  recipeRevisionShort, type RecipeDetail, type RecipePosition,
} from '../../lib/recipes';
import { Hint } from '../controls';
import { SettingsSegmented } from './SettingsPrimitives';

/** The prompt slots, in the order the engine assembles them. */
const SLOTS = [
  { id: 'system', key: 'st.recipe.slot.system' },
  { id: 'steering', key: 'st.recipe.slot.steering' },
] as const;

export function RecipeDetailBody({ detail, initialPosition = 'main' }: {
  detail: RecipeDetail;
  initialPosition?: RecipePosition;
}) {
  const { t } = useI18n();
  const [position, setPosition] = useState<RecipePosition>(initialPosition);
  const branch = detail.resolved.branches[position === 'sub' ? 'sub' : position];
  const modelLeaves = Object.keys(detail.resolved.model).toSorted();
  const originsFor = (slot: string) => detail.resolved.origins.filter((origin) => origin.position === (position === 'sub' ? 'sub' : position) && origin.slot === slot);

  return (
    <div className="min-w-0 space-y-6" data-recipe-package={detail.summary.installation_id}>
      {/*
        The package name is the object here, so it gets display type and the
        path below it stays quiet. A TOML path as the headline is what makes a
        Recipe read as a config fragment rather than a recipe.
      */}
      <header className="space-y-1">
        <h3 className="font-display text-[28px] leading-9 tracking-tight text-ink" data-recipe-package-name>
          {detail.summary.name}
        </h3>
        <p className="font-mono text-[11.5px] text-ink-faint" data-recipe-package-version>
          {detail.summary.version} · {recipeRevisionShort(detail.resolved.revision)} ·{' '}
          {detail.summary.update_mode === 'follow' ? t('st.recipe.modeFollow') : t('st.recipe.modePinned')}
        </p>
        {detail.summary.description !== undefined ? (
          <p className="pt-1 text-[13px] leading-6 text-ink-soft">{detail.summary.description}</p>
        ) : null}
      </header>

      {detail.summary.last_error !== undefined ? (
        <p role="status" className="text-[12px] leading-5 text-amber-ink" data-recipe-package-stale>
          {t('st.recipe.updateFailedStillUsing', {
            version: detail.summary.version,
            reason: recipeDiagnosticText(detail.summary.last_error),
          })}
        </p>
      ) : null}
      {detail.summary.health === 'unavailable' ? (
        <p role="alert" className="text-[12px] leading-5 text-danger" data-recipe-package-unavailable>{t('st.recipe.packageUnavailable')}</p>
      ) : null}

      <section className="space-y-2" data-recipe-effects>
        <h4 className="text-[13px] font-medium text-ink">{t('st.recipe.effects')}</h4>
        <p className="text-[12px] leading-5 text-ink-soft">{t('st.recipe.promptsReplaced')}</p>
        {modelLeaves.length === 0 ? (
          <p className="text-[12px] leading-5 text-ink-faint">{t('st.recipe.noParameterOverrides')}</p>
        ) : (
          <dl className="divide-y divide-hairline border-y border-hairline" data-recipe-model-overrides>
            {modelLeaves.map((leaf) => {
              const origin = detail.resolved.model_origins[leaf];
              return (
                <div key={leaf} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2" data-recipe-model-leaf={leaf}>
                  <dt className="min-w-0 break-all font-mono text-[11.5px] text-ink-faint">{leaf}</dt>
                  <dd className="min-w-0 flex-1 break-words text-right font-mono text-[12px] text-ink">
                    {renderLeaf(detail.resolved.model[leaf])}
                  </dd>
                  {origin === undefined ? null : (
                    <p className="w-full text-[11px] text-ink-faint">{origin.manifest_id} {origin.version}{origin.file === undefined ? '' : ` · ${origin.file}`}</p>
                  )}
                </div>
              );
            })}
          </dl>
        )}
      </section>

      <section className="space-y-3" data-recipe-content>
        <h4 className="text-[13px] font-medium text-ink">{t('st.recipe.promptContent')}</h4>
        <SettingsSegmented<RecipePosition>
          ariaLabel={t('st.recipe.readAs')}
          value={position}
          dataAttr="data-recipe-read-position"
          onChange={setPosition}
          choices={RECIPE_POSITIONS.map((value) => ({
            value,
            label: t(value === 'main' ? 'st.modelScope.main' : value === 'sub' ? 'st.recipe.position.subShared' : 'st.modelScope.independent'),
          }))}
        />
        {position === 'sub' ? <Hint>{t('st.recipe.sharedIsSubHint')}</Hint> : null}

        {SLOTS.map(({ id, key }) => {
          const text = branch[id];
          if (text === undefined || text === '') return null;
          return (
            <div key={id} className="space-y-1.5" data-recipe-slot={id}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <h5 className="text-[12px] font-medium text-ink-soft">{t(key)}</h5>
                {originsFor(id).length === 0 ? null : (
                  <span className="text-[11px] text-ink-faint" data-recipe-slot-origins={id}>
                    {originsFor(id).map((origin) => origin.file ?? `${origin.manifest_id} ${origin.version}`).join(' · ')}
                  </span>
                )}
              </div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-ink/[0.035] px-3 py-2 font-mono text-[12px] leading-5 text-ink-soft">{text}</pre>
            </div>
          );
        })}

        {branch.anchor === undefined ? null : (
          <div className="space-y-1.5" data-recipe-slot="anchor">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <h5 className="text-[12px] font-medium text-ink-soft">{t('st.recipe.slot.anchor')}</h5>
              {/* Scoped on purpose: the anchor replaces this Recipe's own system
                  section, never the whole system prompt. */}
              <span className="text-[11px] text-ink-faint">
                {t('st.recipe.anchorWindow', { steps: branch.anchor.steps, scope: t(`st.recipe.scope.${branch.anchor.scope}`) })}
              </span>
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-ink/[0.035] px-3 py-2 font-mono text-[12px] leading-5 text-ink-soft">{branch.anchor.content}</pre>
          </div>
        )}

        <CadenceSummary branch={branch} />

        {Object.keys(branch.fields).length === 0 ? null : (
          <div className="space-y-2" data-recipe-slot="fields">
            <h5 className="text-[12px] font-medium text-ink-soft">{t('st.recipe.slotFields')}</h5>
            <dl className="divide-y divide-hairline border-y border-hairline">
              {Object.entries(branch.fields).toSorted(([a], [b]) => a.localeCompare(b)).map(([id, value]) => (
                <div key={id} className="space-y-0.5 py-2">
                  <dt className="break-all font-mono text-[11.5px] text-ink-faint">{id}</dt>
                  <dd className="break-words text-[12px] leading-5 text-ink-soft">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {SLOTS.every(({ id }) => branch[id] === undefined || branch[id] === '')
          && branch.anchor === undefined && Object.keys(branch.fields).length === 0
          ? (
            <p className="text-[12px] leading-5 text-ink-faint" data-recipe-no-prompts>
              {t('st.recipe.noPromptForIdentity')}
            </p>
          )
          : null}
      </section>

      <section className="space-y-2" data-recipe-source>
        <h4 className="text-[13px] font-medium text-ink">{t('st.recipe.sourceAndVersion')}</h4>
        <dl className="space-y-1.5">
          <Row label={t('st.recipe.sourceLabel')} value={detail.summary.source.locator} mono selectable />
          {detail.summary.source.sha256 === undefined ? null : (
            <Row label={t('st.recipe.sha256')} value={detail.summary.source.sha256} mono selectable />
          )}
          <Row label={t('st.recipe.revisionFull')} value={detail.resolved.revision} mono selectable />
          {detail.summary.copied_from === undefined ? null : (
            <Row label={t('st.recipe.copiedFrom')} value={detail.summary.copied_from} />
          )}
          {detail.resolved.dependencies.length === 0 ? null : (
            <div className="space-y-1">
              <dt className="text-[11.5px] text-ink-faint">{t('st.recipe.parentChain')}</dt>
              <dd className="space-y-0.5">
                {detail.resolved.dependencies.map((dependency) => (
                  <p key={dependency.source.locator} className="break-all font-mono text-[11px] text-ink-soft">
                    {dependency.manifest_id} {dependency.version} · {dependency.source.locator}
                  </p>
                ))}
              </dd>
            </div>
          )}
          {detail.used_by.length === 0 ? null : (
            <Row label={t('st.recipe.usedBy')} value={detail.used_by.join(', ')} mono selectable />
          )}
        </dl>
        <div className="space-y-1 pt-1">
          <p className="text-[11.5px] text-ink-faint">{t('st.recipe.packageFiles')}</p>
          <p className="break-all font-mono text-[11px] text-ink-soft">{recipeFileNames(detail.files).join(' · ')}</p>
        </div>
        {detail.history.length === 0 ? null : (
          <div className="space-y-1 pt-1">
            <p className="text-[11.5px] text-ink-faint">{t('st.recipe.history')}</p>
            <ul className="space-y-0.5" data-recipe-history>
              {detail.history.map((revision) => (
                <li key={revision} className="break-all font-mono text-[11px] text-ink-soft">{recipeRevisionShort(revision)}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Steer cadence as three separate values.
 *
 * Each is shown with its own current value, including the engine defaults for
 * the ones this package never declared: a single "timing" summary would hide the
 * difference between a declared `false` and an undeclared one.
 */
function CadenceSummary({ branch }: { branch: RecipeDetail['resolved']['branches']['main'] }) {
  const { t } = useI18n();
  return (
    <div className="space-y-1.5" data-recipe-cadence>
      <h5 className="text-[12px] font-medium text-ink-soft">{t('st.modelPrompt.cadence')}</h5>
      <dl className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-[12px] text-ink-faint">{t('st.modelPrompt.cadenceTurn')}</dt>
          <dd className="text-[12px] text-ink">{boolText(branch.steering_on_turn, true)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-[12px] text-ink-faint">{t('st.modelPrompt.cadenceInput')}</dt>
          <dd className="text-[12px] text-ink">{boolText(branch.steering_on_input, true)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-[12px] text-ink-faint">{t('st.modelPrompt.cadenceInterval')}</dt>
          <dd className="font-mono text-[12px] text-ink">{branch.steering_interval_steps ?? 0}</dd>
        </div>
      </dl>
    </div>
  );
}

function Row({ label, value, mono = false, selectable = false }: {
  label: string; value: string; mono?: boolean; selectable?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[11.5px] text-ink-faint">{label}</dt>
      <dd className={`break-all text-[12px] leading-5 text-ink-soft ${mono ? 'font-mono' : ''} ${selectable ? 'select-text' : ''}`}>{value}</dd>
    </div>
  );
}

/**
 * Render a declared parameter leaf.
 *
 * `false`, `0` and `[]` are real values and print as themselves. A truthiness
 * test would print them as "not set", which is how a parameter that is
 * deliberately turned off ends up looking like one that was never declared.
 */
function renderLeaf(value: unknown): string {
  if (value === false) return 'false';
  if (value === true) return 'true';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  return JSON.stringify(value);
}

/** A declared boolean, or the engine default when the package stayed silent. */
function boolText(value: boolean | undefined, fallback: boolean): string {
  if (value === undefined) return String(fallback);
  return value ? 'on' : 'off';
}
