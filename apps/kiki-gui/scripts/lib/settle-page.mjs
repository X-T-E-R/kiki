/**
 * Park the pointer away from hover targets, wait for webfonts and running
 * finite animations, and allow final layout/paint frames to settle before
 * capturing a screenshot.
 */
export async function settlePage(
  page,
  {
    parkPointer = true,
    waitMs = 400,
    afterParkMs = 200,
    rafFrames = 0,
  } = {},
) {
  if (parkPointer) {
    await page.mouse.move(2, 2);
  }
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations()
        .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    );
  }).catch(() => undefined);
  if (rafFrames > 0) {
    await page.evaluate(async (count) => {
      for (let i = 0; i < count; i += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }, rafFrames).catch(() => undefined);
  }
  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }
  if (parkPointer) {
    await page.mouse.move(1, 1);
    if (afterParkMs > 0) {
      await page.waitForTimeout(afterParkMs);
    }
  }
}
