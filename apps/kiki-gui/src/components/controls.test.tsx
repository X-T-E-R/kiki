// @vitest-environment jsdom

/**
 * InlineError text formatting. Every call site of this primitive hands it a
 * caught value, so the component's only job is the one-line question "what
 * does the screen say now". It renders through the shared `errorText`
 * pipeline, which means: an error that carries a dictionary issue speaks the
 * active locale, a recorded reason keeps its own wording, a wire code stays
 * visible beside the reason, and a value with no readable message degrades to
 * the locale's "Unknown error" instead of `[object Object]`.
 *
 * Locale is pinned to English here (Node's built-in navigator reports the OS
 * language) except in the one case whose whole point is the other language.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalizedError } from '@kiki/session-core/i18n';
import { I18nProvider } from '../i18n';
import { InlineError } from './controls';

/**
 * The provider reads the stored locale once per mount, so each render builds
 * its own root: switching language is a fresh mount, which is exactly what the
 * app's language control does.
 */
async function render(error: unknown, locale: 'en' | 'zh' = 'en') {
  localStorage.setItem('kiki.locale', locale);
  const own = document.createElement('div');
  document.body.append(own);
  const ownRoot = createRoot(own);
  await act(async () => {
    ownRoot.render(
      <I18nProvider>
        <InlineError error={error} />
      </I18nProvider>,
    );
  });
  const line = own.querySelector('[data-feedback-tone="error"]');
  const result = { line, text: line?.textContent ?? '' };
  await act(async () => ownRoot.unmount());
  own.remove();
  return result;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  localStorage.clear();
});

describe('InlineError', () => {
  it('renders the error as an alert and marks it as an error tone', async () => {
    const { line } = await render(new Error('Save failed'));
    expect(line?.getAttribute('role')).toBe('alert');
    expect((line as HTMLElement).dataset['feedbackTone']).toBe('error');
  });

  it('keeps a hand-written reason word for word', async () => {
    const { text } = await render(new Error('The local control connection is not ready.'));
    expect(text).toBe('The local control connection is not ready.');
  });

  it('translates an error that carries a dictionary issue, and follows the active locale', async () => {
    const error = new LocalizedError({ key: 'val.flagBool', params: { name: 'usage_export' } });
    const english = await render(error, 'en');
    expect(english.text).toBe('Experimental flag "usage_export" must be true or false.');

    const chinese = await render(error, 'zh');
    expect(chinese.text).toBe('实验开关“usage_export”必须为 true 或 false。');
  });

  it('keeps the recorded reason and the wire code beside it', async () => {
    // The shape kap-server's REST path rejects with: a numeric code plus the
    // server's own wording. Neither half is dropped on the way to the screen.
    const wire = Object.assign(new Error('session not found'), { code: 40401 });
    const { text } = await render(wire);
    expect(text).toBe('session not found (40401)');
  });

  it('reads a rejected envelope instead of printing [object Object]', async () => {
    const { text } = await render({ code: 40401, msg: 'session.not_found' });
    expect(text).not.toBe('[object Object]');
    expect(text).toContain('session.not_found');
    expect(text).toContain('40401');
  });

  it('falls back to the locale sentence when there is no readable message', async () => {
    expect((await render(undefined, 'en')).text).toBe('Unknown error');
    expect((await render(undefined, 'zh')).text).toBe('未知错误');
  });
});
