import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/metrics': {
        target: 'http://127.0.0.1:9400',
        ws: true,
        rewrite: (path) => path.replace(/^\/api\/metrics/, '/metrics'),
      },
      '/api': {
        target: 'http://127.0.0.1:9400',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
