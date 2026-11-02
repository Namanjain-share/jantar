/**
 * v0.12 People: her app (p.html), built after the owner's into the same
 * dist/ (`pnpm build` runs both), as its own module graph: none of his
 * chunks change, and her chunks (prefixed `p-`) hold no module of his
 * screens, shell, store, API client, connection or router
 * (test/partner/import-graph.test.ts, T15). Its manifest
 * (.vite/p-manifest.json) names her chunk set; the daemon's people host
 * serves those files and no other asset.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { sharedConfig } from '../../vitest.shared.mjs';
import { PERSON_MANIFEST, personPwaPlugin } from './build/pwa-plugin.js';

const shared = sharedConfig({ browser: true });
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss(), ...personPwaPlugin({ root })],
  resolve: shared.resolve,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    assetsInlineLimit: 0,
    target: ['es2022', 'safari16.4'],
    cssTarget: ['safari16.4'],
    manifest: PERSON_MANIFEST,
    rollupOptions: {
      input: { p: join(root, 'p.html') },
      output: {
        entryFileNames: 'assets/p-[hash].js',
        chunkFileNames: 'assets/p-[name]-[hash].js',
        assetFileNames: 'assets/p-[name]-[hash][extname]',
      },
    },
  },
});
