import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// @aurum/core is TypeScript source in the workspace, so it must be bundled, not externalized.
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin({ exclude: ['@aurum/core'] })] },
  preload: { plugins: [externalizeDepsPlugin({ exclude: ['@aurum/core'] })] },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
});
