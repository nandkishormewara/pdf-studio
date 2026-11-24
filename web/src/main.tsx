import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { I18nProvider } from './i18n'
import { harfBuzzShaper } from './sdk/hbShaper'
import { setTextShaper } from './sdk/unicodeText'
import devanagariRegular from '@expo-google-fonts/noto-sans-devanagari/400Regular/NotoSansDevanagari_400Regular.ttf?url'
import devanagariBold from '@expo-google-fonts/noto-sans-devanagari/700Bold/NotoSansDevanagari_700Bold.ttf?url'
import arabicRegular from '@expo-google-fonts/noto-sans-arabic/400Regular/NotoSansArabic_400Regular.ttf?url'
import arabicBold from '@expo-google-fonts/noto-sans-arabic/700Bold/NotoSansArabic_700Bold.ttf?url'
import hebrewRegular from '@expo-google-fonts/noto-sans-hebrew/400Regular/NotoSansHebrew_400Regular.ttf?url'
import hebrewBold from '@expo-google-fonts/noto-sans-hebrew/700Bold/NotoSansHebrew_700Bold.ttf?url'

// Hindi (Devanagari), Arabic and Hebrew text in saved marks becomes real, searchable PDF text (HarfBuzz + Noto Sans
// fonts). Each script's fonts are fetched only the first time a mark in that script is saved, and the saved PDF
// carries only the glyphs it uses.
setTextShaper(harfBuzzShaper({
  devanagari: { regular: devanagariRegular, bold: devanagariBold, name: 'NotoSansDevanagari' },
  arabic: { regular: arabicRegular, bold: arabicBold, name: 'NotoSansArabic' },
  hebrew: { regular: hebrewRegular, bold: hebrewBold, name: 'NotoSansHebrew' },
}))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
