/**
 * Prism core, then published as the global `Prism`: the language components
 * are plain scripts that extend whatever `Prism` is in scope. prism.ts
 * imports this after prism-env.ts and before any component.
 */
import Prism from 'prismjs/components/prism-core.js';

(globalThis as { Prism?: unknown }).Prism = Prism;

export default Prism;
