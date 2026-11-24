import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { I18nProvider } from './i18n'
import { harfBuzzShaper } from './sdk/hbShaper'
import { setTextShaper } from './sdk/unicodeText'
import notoRegular from '@expo-google-fonts/noto-sans-devanagari/400Regular/NotoSansDevanagari_400Regular.ttf?url'
import notoBold from '@expo-google-fonts/noto-sans-devanagari/700Bold/NotoSansDevanagari_700Bold.ttf?url'

// Hindi and other Devanagari text in saved marks becomes real, searchable PDF text (HarfBuzz + Noto Sans
// Devanagari, fetched only the first time such a mark is saved).
setTextShaper(harfBuzzShaper({ regular: notoRegular, bold: notoBold }))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
