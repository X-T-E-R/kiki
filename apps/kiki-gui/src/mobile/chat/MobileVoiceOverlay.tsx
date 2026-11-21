import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';

import { Icon } from '../../components/icons';
import { useI18n } from '../../i18n';
import { useLayerHistory } from '../../lib/layerHistory';
import { floatingSurfaceZIndex, registerOverlay } from '../../lib/uiBusy';

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike | undefined;
}

interface SpeechRecognitionEventLike {
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike | undefined;
  };
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function resolveSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

interface MobileVoiceOverlayProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmitText: (text: string) => void;
}

export function MobileVoiceOverlay({ open, onClose, onSubmitText }: MobileVoiceOverlayProps) {
  const { t, locale } = useI18n();
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const recRef = useRef<SpeechRecognitionInstance | null>(null);

  useLayerHistory('mobile-voice-overlay', open, onClose);

  const stopRecognition = useCallback(() => {
    try {
      recRef.current?.stop();
    } catch {
      // Ignore already-stopped errors.
    }
    recRef.current = null;
    setListening(false);
  }, []);

  const startRecognition = useCallback(() => {
    const Ctor = resolveSpeechRecognition();
    if (Ctor === null) {
      setUnavailable(true);
      setListening(false);
      return;
    }
    setUnavailable(false);
    stopRecognition();
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = locale === 'zh' ? 'zh-CN' : 'en-US';
    recognition.onresult = (event) => {
      const parts: string[] = [];
      for (let i = 0; i < event.results.length; i += 1) {
        const piece = event.results[i]?.[0]?.transcript;
        if (piece !== undefined) parts.push(piece);
      }
      setTranscript(parts.join(' ').trim());
    };
    recognition.onerror = () => { setListening(false); };
    recognition.onend = () => { setListening(false); };
    recRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }, [locale, stopRecognition]);

  useEffect(() => {
    if (!open) return undefined;
    const unregister = registerOverlay('mobile-voice-overlay');
    setTranscript('');
    startRecognition();
    return () => {
      unregister();
      stopRecognition();
    };
  }, [open, startRecognition, stopRecognition]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('mobile.chat.voice')}
      data-mobile-voice-overlay
      style={{ zIndex: floatingSurfaceZIndex(null) }}
      className="fixed inset-0 flex flex-col items-center justify-between bg-paper/96 px-6 pb-[calc(28px+var(--kiki-safe-bottom-inset))] pt-[calc(24px+var(--kiki-safe-top-inset))] backdrop-blur-xl"
    >
      <div className="h-8" />

      <div className="flex max-w-[340px] flex-col items-center gap-4 text-center">
        <div
          className={`flex h-20 w-20 items-center justify-center rounded-full transition-transform duration-300 ${
            listening ? 'scale-105 bg-accent/15 text-accent' : 'bg-ink/[0.06] text-ink-soft'
          }`}
        >
          <Mic className="h-8 w-8" strokeWidth={1.75} aria-hidden="true" />
        </div>
        <h2 className="font-display text-[26px] font-medium leading-[1.2] text-ink">
          {unavailable
            ? t('mobile.voice.unavailable')
            : transcript !== ''
              ? transcript
              : listening
                ? t('mobile.voice.listening')
                : t('mobile.voice.start')}
        </h2>
      </div>

      <div className="kiki-mobile-glass-pill flex items-center gap-3 rounded-full p-2">
        <button
          type="button"
          aria-label={t('mobile.voice.cancel')}
          onClick={() => {
            stopRecognition();
            onClose();
          }}
          className="flex h-12 w-12 items-center justify-center rounded-full bg-ink/[0.06] text-ink-soft"
        >
          <Icon name="close" size={16} />
        </button>

        <button
          type="button"
          aria-label={listening ? t('mobile.chat.abort') : t('mobile.voice.start')}
          onClick={() => {
            if (listening) stopRecognition();
            else startRecognition();
          }}
          className={`flex h-14 w-14 items-center justify-center rounded-full transition-colors ${
            listening ? 'bg-accent text-primary-foreground' : 'bg-ink text-paper'
          }`}
        >
          {listening ? <MicOff className="h-5 w-5" aria-hidden="true" /> : <Mic className="h-5 w-5" aria-hidden="true" />}
        </button>

        <button
          type="button"
          disabled={transcript.trim() === ''}
          aria-label={t('mobile.voice.send')}
          onClick={() => {
            const payload = transcript.trim();
            if (payload === '') return;
            stopRecognition();
            onClose();
            onSubmitText(payload);
          }}
          className="flex h-12 w-12 items-center justify-center rounded-full bg-ink text-paper disabled:opacity-35"
        >
          <Icon name="arrowUp" size={16} />
        </button>
      </div>
    </div>
  );
}
