// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { I18nProvider } from '../../i18n';
import { MobileVoiceOverlay } from './MobileVoiceOverlay';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

interface FakeRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: { length: number; [index: number]: { length: number; 0?: { transcript: string } } } }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

let instances: FakeRecognition[] = [];
let container: HTMLDivElement;
let root: Root;
const win = window as unknown as { SpeechRecognition?: new () => FakeRecognition };

beforeEach(() => {
  instances = [];
  win.SpeechRecognition = class implements FakeRecognition {
    continuous = false;
    interimResults = false;
    lang = '';
    onresult: FakeRecognition['onresult'] = null;
    onerror: FakeRecognition['onerror'] = null;
    onend: FakeRecognition['onend'] = null;
    start() {}
    stop() {
      this.onerror?.({ error: 'aborted' });
      this.onend?.();
    }
    constructor() {
      instances.push(this);
    }
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  delete win.SpeechRecognition;
});

describe('MobileVoiceOverlay', () => {
  it('surfaces permission denial and recognition failure distinctly from manual stop', () => {
    act(() => {
      root.render(
        <I18nProvider>
          <MobileVoiceOverlay open={true} onClose={() => {}} onSubmitText={() => {}} />
        </I18nProvider>,
      );
    });

    const first = instances.at(-1)!;
    expect(container.querySelector('[data-voice-error]')).toBeNull();

    act(() => {
      first.onerror?.({ error: 'not-allowed' });
    });
    const heading = container.querySelector('h2')!;
    expect(heading.getAttribute('data-voice-error')).toBe('permission');

    const toggleButton = container.querySelectorAll('button')[1]!;
    act(() => {
      toggleButton.click();
    });
    const second = instances.at(-1)!;
    expect(heading.getAttribute('data-voice-error')).toBeNull();

    act(() => {
      toggleButton.click();
    });
    expect(heading.getAttribute('data-voice-error')).toBeNull();

    act(() => {
      toggleButton.click();
    });
    const third = instances.at(-1)!;
    act(() => {
      third.onerror?.({ error: 'audio-capture' });
    });
    expect(heading.getAttribute('data-voice-error')).toBe('failed');
    expect(second).not.toBe(third);
  });
});
