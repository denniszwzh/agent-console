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
  server: {
    // Dev only: forward API calls to the local Agent Console server.
    proxy: { '/api': 'http://127.0.0.1:4317', '/auth': 'http://127.0.0.1:4317' },
  },
});
