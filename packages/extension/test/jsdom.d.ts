/**
 * The few parts of jsdom's API the page-read test uses (jsdom ships no
 * types and @types/jsdom is not a dependency): a window built from HTML at
 * a URL, with `eval` for running a tier's serialized reader in it.
 */
declare module 'jsdom' {
  export class JSDOM {
    constructor(html: string, options?: { url?: string; runScripts?: 'dangerously' | 'outside-only'; pretendToBeVisual?: boolean });
    readonly window: Window & typeof globalThis;
  }
}
