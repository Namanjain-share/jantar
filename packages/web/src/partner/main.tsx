/**
 * v0.11 People: her app's entry (`p.html`), a separate bundle from the
 * owner's. It imports her screens, her API client and shared kit and style
 * modules only: no owner screen, shell, store, API client, connection or
 * router (test/partner/import-graph.test.ts, T15).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.js';
import { createPersonApi } from './api.js';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App api={createPersonApi()} />
    </StrictMode>,
  );
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // Her own worker (sw/p-sw.js): her shell, her chunks, and /p… URLs only.
  void navigator.serviceWorker.register('/p-sw.js', { scope: '/' }).catch(() => undefined);
}
