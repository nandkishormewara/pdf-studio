/**
 * UI translations. English strings are the keys (gettext style): `t('Open')`, `t('Page {n}', { n })`.
 * Missing translations fall back to English, so a new string never shows a raw key.
 *
 * Add a language: create `xx.ts` exporting `Record<string, string>`, add it to LANGUAGES.
 * `npm run i18n:check` lists strings that are missing from each dictionary.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import ar from './ar';
import hi from './hi';
import ms from './ms';

export interface Language {
  code: string;
  name: string; // in its own language
  dir: 'ltr' | 'rtl';
  strings: Record<string, string>;
}

export const LANGUAGES: Language[] = [
  { code: 'en', name: 'English', dir: 'ltr', strings: {} },
  { code: 'hi', name: 'हिन्दी', dir: 'ltr', strings: hi },
  { code: 'ar', name: 'العربية', dir: 'rtl', strings: ar },
  { code: 'ms', name: 'Bahasa Melayu', dir: 'ltr', strings: ms },
];

export type Translate = (text: string, vars?: Record<string, string | number>) => string;

const format = (s: string, vars?: Record<string, string | number>) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;

const Ctx = createContext<{ lang: Language; t: Translate; setLang: (code: string) => void }>({
  lang: LANGUAGES[0],
  t: format,
  setLang: () => {},
});

function initialLanguage(): string {
  try {
    const saved = localStorage.getItem('pdfstudio.lang');
    if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  } catch { /* storage unavailable */ }
  const nav = (navigator.language || 'en').slice(0, 2);
  return LANGUAGES.some((l) => l.code === nav) ? nav : 'en';
}

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: string }) {
  const [code, setCode] = useState(() => initial ?? initialLanguage());
  const lang = LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];

  useEffect(() => {
    document.documentElement.lang = lang.code;
    document.documentElement.dir = lang.dir;
  }, [lang]);

  const t = useCallback<Translate>((text, vars) => format(lang.strings[text] ?? text, vars), [lang]);
  const setLang = useCallback((c: string) => {
    setCode(c);
    try { localStorage.setItem('pdfstudio.lang', c); } catch { /* storage unavailable */ }
  }, []);
  const value = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useT = () => useContext(Ctx).t;
export const useLanguage = () => useContext(Ctx);
