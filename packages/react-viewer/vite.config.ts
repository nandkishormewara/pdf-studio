/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Library build. pdfjs-dist, pdf-lib and React stay external: the host app installs them, and its
// Vite build resolves the `pdfjs-dist/build/pdf.worker.min.mjs?url` import to a hashed worker file.
const external = [/^react($|\/)/, /^react-dom($|\/)/, /^pdfjs-dist($|\/)/, /^pdf-lib($|\/)/];

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom', 'pdfjs-dist', 'pdf-lib'] },
  build: {
    lib: { entry: resolve(import.meta.dirname, 'src/index.ts'), formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { external: (id) => external.some((re) => re.test(id)) },
    sourcemap: true,
    emptyOutDir: false, // dist/types is written by tsc first
  },
  server: { fs: { allow: ['../..'] } },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
});
