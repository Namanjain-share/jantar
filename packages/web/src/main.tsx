import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './App.js';
import { createApi } from './lib/api.js';
import { createConnection } from './lib/connection.js';
import { listenForInstallPrompt, registerServiceWorker } from './lib/pwa.js';
import { browserHistory, createRouter } from './lib/router.js';
import { applyTheme, themeStore } from './lib/theme.js';
import { createAppStore } from './store.js';
import { createToastStore } from './ui/context.js';
import { wireStateCache } from './ui/screens/board/cache.js';

applyTheme(themeStore.getState().pref);

const store = createAppStore();
// Paint the last known state at once, whichever screen opens first (a push opens a session).
wireStateCache(store);
const api = createApi();
const router = createRouter(browserHistory());
const toasts = createToastStore();
const connection = createConnection({ store, api });
// v0.5.3: the tones and the voice (lib/sounds.ts), its own chunk: import() below, as the first screen renders.
let sounds: typeof import('./lib/sounds.js') | undefined;

listenForInstallPrompt();
registerServiceWorker({
  onNavigate: (path) => router.getState().navigate(path),
  onUpdate: () => store.getState().setUpdateAvailable(true),
  // Before they load, no tap has unlocked audio either: the push keeps its sound.
  onChime: (group) => sounds?.chime(group) ?? false,
});
connection.start();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App store={store} api={api} router={router} toasts={toasts} connection={connection} />
    </StrictMode>,
  );
}

void import('./lib/sounds.js').then(
  (m) => {
    sounds = m;
    // Every tap from here on unlocks audio (iOS may need one again after the background) and primes speech.
    m.listenForTaps();
  },
  () => undefined,
);
