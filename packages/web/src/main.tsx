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

listenForInstallPrompt();
registerServiceWorker({
  onNavigate: (path) => router.getState().navigate(path),
  onUpdate: () => store.getState().setUpdateAvailable(true),
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
