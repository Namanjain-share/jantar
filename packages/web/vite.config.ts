import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.mjs';
import { pwaPlugin } from './build/pwa-plugin.js';

const shared = sharedConfig({ browser: true });
const root = dirname(fileURLToPath(import.meta.url));

// The daemon serves dist/ itself (same origin as /v1), so the dev server
// proxies API and WebSocket calls to a locally running jantard.
export default defineConfig({
  plugins: [react(), tailwindcss(), ...pwaPlugin({ root })],
  resolve: shared.resolve,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    // No data: URIs (fonts included), so the CSP keeps img-src and font-src to 'self'.
    assetsInlineLimit: 0,
    // Safari 16.4 is the iOS Web Push floor and Tailwind v4's minimum.
    target: ['es2022', 'safari16.4'],
    cssTarget: ['safari16.4'],
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/v1': { target: 'http://127.0.0.1:7420', ws: true, changeOrigin: false },
    },
  },
  test: {
    ...shared.test,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // Components import CSS; tests do not need it.
    css: false,
  },
});
