import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Demo page: `npm run dev`, then open the printed URL.
export default defineConfig({
  root: resolve(import.meta.dirname, 'demo'),
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom', 'pdfjs-dist', 'pdf-lib'] },
  server: { fs: { allow: [resolve(import.meta.dirname, '../..')] } },
  build: { outDir: resolve(import.meta.dirname, 'dist-demo'), emptyOutDir: true },
});
