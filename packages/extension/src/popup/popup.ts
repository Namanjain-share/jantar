/**
 * The popup's script (popup.js, loaded by popup.html): draws the popup in
 * `#app` for the tab it was opened for (app.ts).
 */
import { mountPopup, tabFromSearch } from './app.js';

const root = document.getElementById('app');
if (root) void mountPopup({ root, tabId: tabFromSearch(location.search), close: () => window.close() });
