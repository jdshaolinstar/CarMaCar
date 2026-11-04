import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // Lets a second checkout that shares node_modules keep its own bundling cache.
  cacheDir: process.env.VITE_CACHE_DIR,
  // main.ts awaits the platform connection at the top level.
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), metro: resolve(__dirname, 'metro.html') } },
  },
});
