// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { translate } from '@kiki/session-core/i18n';

import { classifyDiagnosticCategory } from '../components/agent-panel/failureText';
import { isUnconfiguredModelError, pushActionableModelOrErrorToast } from '../lib/modelConfigError';
import { clearToasts, getToasts } from '../lib/toasts';
import {
  assistantScopeTarget,
  clearMobileAssistant,
  MOBILE_ASSISTANT_STORAGE_KEY,
  readMobileAssistant,
  writeMobileAssistant,
} from './mobileAssistantStore';

describe('mobileAssistantStore', () => {
  afterEach(() => {
    localStorage.clear();
    clearToasts();
  });

  it('keeps one binding per space and tracks the most recent one', () => {
    writeMobileAssistant({ spaceKey: 'local', personaId: 'kiki', sessionId: 's-1' });
    writeMobileAssistant({ spaceKey: 'remote:gpu', personaId: 'nia', sessionId: 's-2' });

    expect(readMobileAssistant('local')).toEqual({ spaceKey: 'local', personaId: 'kiki', sessionId: 's-1' });
    expect(readMobileAssistant('remote:gpu')?.sessionId).toBe('s-2');
    expect(readMobileAssistant()).toEqual({ spaceKey: 'remote:gpu', personaId: 'nia', sessionId: 's-2' });

    clearMobileAssistant('remote:gpu');
    expect(readMobileAssistant('remote:gpu')).toBeUndefined();
    expect(readMobileAssistant()).toBeUndefined();
    expect(readMobileAssistant('local')?.personaId).toBe('kiki');
  });

  it('ignores malformed or foreign-version payloads', () => {
    localStorage.setItem(MOBILE_ASSISTANT_STORAGE_KEY, '{"version":2,"bySpace":{"local":{"personaId":"x","sessionId":"y"}}}');
    expect(readMobileAssistant('local')).toBeUndefined();
    localStorage.setItem(MOBILE_ASSISTANT_STORAGE_KEY, 'not json');
    expect(readMobileAssistant()).toBeUndefined();
  });

  it('moves a concrete scope to the computer the assistant started on', () => {
    expect(assistantScopeTarget('main', 'remote:abc')).toBe('remote:abc');
    expect(assistantScopeTarget('remote:abc', 'remote:abc')).toBeUndefined();
    expect(assistantScopeTarget(undefined, 'remote:abc')).toBeUndefined();
  });

  it('retains the newly selected binding in memory when localStorage rejects a write', () => {
    writeMobileAssistant({ spaceKey: 'local', personaId: 'kiki', sessionId: 's-old' });
    const origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
    try {
      writeMobileAssistant({ spaceKey: 'local', personaId: 'nia', sessionId: 's-new' });
      expect(readMobileAssistant('local')).toEqual({ spaceKey: 'local', personaId: 'nia', sessionId: 's-new' });
      expect(readMobileAssistant()).toEqual({ spaceKey: 'local', personaId: 'nia', sessionId: 's-new' });
    } finally {
      Storage.prototype.setItem = origSetItem;
    }
    writeMobileAssistant({ spaceKey: 'local', personaId: 'nia', sessionId: 's-persisted' });
    expect(readMobileAssistant('local')?.sessionId).toBe('s-persisted');
  });

  it('turns raw 50001 model-unconfigured backend errors into localized guidance with a Configure model action', () => {
    const raw50001 = new Error(
      'model and thinking effort are required to bind profile "agent" (no default model configured). Provide both model and thinking, or configure a model with a resolvable default effort. (code 50001)',
    );
    expect(isUnconfiguredModelError(raw50001)).toBe(true);
    expect(classifyDiagnosticCategory({ message: raw50001.message, code: '50001' })).toBe('auth');

    const openSettings = vi.fn();
    pushActionableModelOrErrorToast(raw50001, (key) => translate('zh', key), openSettings);
    const toasts = getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.text).toBe('请先在设置中配置模型服务后再开始对话。');
    expect(toasts[0]?.action?.label).toBe('配置模型');
    toasts[0]?.action?.run();
    expect(openSettings).toHaveBeenCalledTimes(1);

    expect(translate('zh', 'mobile.assistant.computerLabel')).toBe('当前空间');
    expect(translate('zh', 'mobile.assistant.modelDefault')).toBe('跟随默认');
    expect(translate('zh', 'mobile.space.localPhone')).toBe('本机');
  });
});
