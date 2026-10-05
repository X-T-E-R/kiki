/**
 * people-spaces-clock — pins the fixture clock BEFORE any module that reads it.
 *
 * `fixtures/helpers.mjs` reads `KIKI_FIXTURE_EPOCH` once, at module evaluation,
 * and its own default epoch sits in January — which would put "Jan 1" in the
 * sidebar of a public frame. A runner therefore has to set the variable before
 * helpers.mjs is evaluated, which a plain assignment in the runner body cannot
 * do: ES module imports are hoisted, so `import … from './fixtures/helpers.mjs'`
 * (transitively, via the scene builders) evaluates before any statement in the
 * importing file.
 *
 * This module exists so that a single `import './people-spaces-clock.mjs';` as
 * the FIRST import of the runner is enough: ES modules evaluate in source order,
 * so this body runs before the scene and fixture-server graphs below it.
 */

if (process.env.KIKI_FIXTURE_EPOCH === undefined) {
  // A fixed recent date keeps relative copy ("9 min ago") stable across runs
  // while making the rendered times read as a plausible current day.
  process.env.KIKI_FIXTURE_EPOCH = '2026-10-05T10:40:00.000Z';
}
