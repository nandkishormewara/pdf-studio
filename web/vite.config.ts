import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Minifying drops the libraries' licence headers; their full texts ship in THIRD-PARTY-NOTICES.txt
// (written by scripts/third-party-notices.mjs). This keeps a pointer to it at the top of each script.
const notice = '/*! PDF Studio. Includes open-source software: see THIRD-PARTY-NOTICES.txt */\n'
const noticeBanner = (): Plugin => ({
  name: 'third-party-notice-banner',
  apply: 'build',
  generateBundle(_, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type === 'chunk') file.code = notice + file.code
    }
  },
})

// https://vite.dev/config/
// BASE_PATH lets the app be served from a sub-path, e.g. /pdf-studio/ on GitHub Pages.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), noticeBanner()],
})
