import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Production build only: embed the CSP as a <meta> too, so it holds even if the header injection in main/index.ts
// does not apply to file:// pages. (Not in dev: the Vite dev server needs inline scripts for HMR.)
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'";
const metaCsp = () => ({
  name: 'aurum-meta-csp',
  apply: 'build' as const,
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' as const }],
});

// @aurum/core is TypeScript source in the workspace, so it must be bundled, not externalized.
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin({ exclude: ['@aurum/core'] })] },
  preload: { plugins: [externalizeDepsPlugin({ exclude: ['@aurum/core'] })] },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), metaCsp()],
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
});
