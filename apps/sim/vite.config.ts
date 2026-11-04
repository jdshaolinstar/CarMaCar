import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // main.ts awaits the platform connection at the top level.
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), metro: resolve(__dirname, 'metro.html') } },
  },
});
