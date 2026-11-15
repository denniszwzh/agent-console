import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('./src/web'),
  base: '/',
  plugins: [react()],
  build: {
    outDir: here('./dist/web'),
    emptyOutDir: true,
    // Served from localhost only; Mermaid's big diagram chunks are lazy-loaded.
    chunkSizeWarningLimit: 2000,
  },
});
