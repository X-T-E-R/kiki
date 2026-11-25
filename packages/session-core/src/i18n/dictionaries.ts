import { en } from './en';
import { zh } from './zh';

export function initialDictionaries(): {
  en: Partial<Record<keyof typeof en | keyof typeof zh, string>>;
  zh: Partial<Record<keyof typeof en | keyof typeof zh, string>>;
} {
  return { en, zh };
}
