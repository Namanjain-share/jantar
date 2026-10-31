/**
 * prismjs ships no types and the repo adds no @types package: just what
 * lib/highlight uses (tokens.ts has the token shape). The language
 * components are side-effect scripts that extend the global Prism, so they
 * export nothing.
 */
declare module 'prismjs/components/prism-core.js' {
  interface Token {
    type: string;
    content: Stream;
    alias?: string | string[];
  }
  type Stream = string | Token | Array<string | Token>;

  const Prism: {
    languages: Record<string, object | undefined>;
    tokenize(text: string, grammar: object): Stream;
    /** Run the callbacks added for `name` (markup-templating's before- and after-tokenize). */
    hooks: { run(name: string, env: object): void };
  };
  export default Prism;
}

declare module 'prismjs/components/*';
